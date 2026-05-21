"""Unit tests for Plan 2 skill-injection helpers (no server, no Ollama)."""

import os
import sys
import tempfile

import pytest

_TMP_HOME = tempfile.mkdtemp(prefix="kt_skills_index_p2_")
os.environ["HOME"] = _TMP_HOME
os.environ["USERPROFILE"] = _TMP_HOME

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
for p in (_REPO_ROOT, os.path.join(_REPO_ROOT, "mempalace-src")):
    if p not in sys.path:
        sys.path.insert(0, p)

import skill_store as ss  # noqa: E402
import app as app_module  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_skills(monkeypatch):
    import shutil
    monkeypatch.setattr(ss, "index_skill", lambda n, d, p: None)
    shutil.rmtree(ss.skills_root(), ignore_errors=True)
    yield


def test_skills_index_empty_is_blank():
    assert app_module._format_skills_index(15) == ""


def test_skills_index_pinned_first_and_no_body():
    ss.create_skill(name="zeta", description="z skill", body="## Contract\nSECRET\n",
                    category="ops")
    ss.create_skill(name="alpha", description="a skill", body="## Contract\nx\n",
                    category="ops")
    ss.set_pinned("zeta", True)
    out = app_module._format_skills_index(15)
    assert "<available_skills>" in out and "</available_skills>" in out
    assert "SECRET" not in out  # never the body
    assert out.index("zeta") < out.index("alpha")  # pinned first
    assert "skill_view" in out  # progressive-disclosure instruction present


def test_skills_index_respects_limit_and_char_cap():
    for i in range(8):
        ss.create_skill(name=f"s{i}", description="d" * 50, body="b\n")
    capped = app_module._format_skills_index(3)
    # limit=3 with 8 skills: exactly 3 skill lines + a "more skills" line.
    assert capped.count("- s") == 3
    assert "more skills" in capped
    big = app_module._format_skills_index(50)
    assert len(big) <= app_module.SKILLS_INDEX_CHAR_CAP + 310  # body + more-line + wrapper


def test_skills_index_excludes_archived():
    ss.create_skill(name="live", description="d", body="b\n")
    ss.create_skill(name="gone", description="d", body="b\n")
    ss.archive_skill("gone")
    out = app_module._format_skills_index(15)
    assert "live" in out and "gone" not in out


def test_skills_index_char_cap_truncates():
    # Long descriptions force the SKILLS_INDEX_CHAR_CAP break before `limit`.
    for i in range(15):
        ss.create_skill(name=f"s{i:02d}", description="x" * 250, body="b\n")
    out = app_module._format_skills_index(50)
    assert "more skills" in out  # truncation actually fired
    assert "<available_skills>" in out and "</available_skills>" in out
    assert len(out) <= app_module.SKILLS_INDEX_CHAR_CAP + 310


def _req(**kw):
    base = dict(model="m", messages=[{"role": "user", "content": "hi"}])
    base.update(kw)
    return app_module.ChatRequest(**base)


def test_compose_skill_message_gating():
    assert app_module._compose_skill_message(_req(use_skills=True)) is None
    ss.create_skill(name="k", description="d", body="b\n")
    assert app_module._compose_skill_message(_req(use_skills=False)) is None
    msg = app_module._compose_skill_message(_req(use_skills=True, skill_limit=15))
    assert msg["role"] == "system"
    assert "<available_skills>" in msg["content"] and "k:" in msg["content"]


def test_chatrequest_defaults():
    r = _req()
    assert r.use_skills is True
    assert r.skill_limit == 15


def test_conversation_search_filters_to_chat_transcripts(monkeypatch):
    fake = {
        "results": [
            {"wing": "personal", "room": "general", "similarity": 0.9,
             "text": "a chat", "source_file": "chat://m/s/2026-05-19T00:00:00"},
            {"wing": "personal", "room": "hall_facts", "similarity": 0.8,
             "text": "a fact", "source_file": "extract://x"},
            {"wing": "kt-skills", "room": "index", "similarity": 0.7,
             "text": "skill: d", "source_file": "skill:///p/SKILL.md"},
        ]
    }
    monkeypatch.setattr(app_module, "search_memories", lambda *a, **k: fake)
    res = app_module._exec_tool(
        "conversation_search", {"query": "anything", "n": 5}, "personal", None
    )
    assert res["count"] == 1
    assert res["hits"][0]["text"] == "a chat"
    assert all(h["text"] == "a chat" for h in res["hits"])

    miss = app_module._exec_tool(
        "conversation_search", {"query": ""}, "personal", None
    )
    assert miss.get("error")


def test_conversation_search_in_tools_list():
    names = {t["function"]["name"] for t in app_module.TOOLS}
    assert "conversation_search" in names


def test_aggregate_palace_excludes_kt_skills():
    meta = [
        {"wing": "personal", "room": "general"},
        {"wing": "personal", "room": "general"},
        {"wing": "kt-skills", "room": "index"},
        {"wing": "work", "room": "decisions"},
    ]
    wings, rooms = app_module._aggregate_palace(meta)
    assert "kt-skills" not in wings
    assert wings == {"personal": 2, "work": 1}
    assert "index" not in rooms  # the kt-skills row is skipped entirely


def test_conversation_search_clamps_n_to_ten(monkeypatch):
    # 15 chat-source hits returned; tool must cap at 10 even if caller asks 50.
    fake_hits = [
        {"wing": "personal", "room": "general", "similarity": 0.5,
         "text": f"chat #{i}", "source_file": f"chat://m/s/2026-05-19T00:00:{i:02d}"}
        for i in range(15)
    ]
    monkeypatch.setattr(
        app_module, "search_memories", lambda *a, **k: {"results": fake_hits}
    )
    res = app_module._exec_tool(
        "conversation_search", {"query": "x", "n": 50}, "personal", None
    )
    assert res["count"] == 10


def test_compose_skill_message_includes_inline_patch_hint():
    ss.create_skill(name="hp", description="d", body="b\n")
    msg = app_module._compose_skill_message(_req(use_skills=True))
    assert "If a loaded skill is wrong" in msg["content"]
    assert "skill_manage" in msg["content"]
    assert "patch" in msg["content"]


def test_compose_skill_message_omits_hint_when_no_skills():
    # No skills => no message at all => hint trivially absent.
    assert app_module._compose_skill_message(_req(use_skills=True)) is None
