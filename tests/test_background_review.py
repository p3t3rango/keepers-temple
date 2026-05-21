"""Unit tests for background_review helpers (no Ollama, no asyncio)."""

import os
import sys
import tempfile

import pytest

# HOME patch must precede any import that transitively loads app.py (e.g. the
# restricted_tools test below indirectly triggers an app import via late binding).
_TMP_HOME = tempfile.mkdtemp(prefix="kt_review_")
os.environ["HOME"] = _TMP_HOME
os.environ["USERPROFILE"] = _TMP_HOME

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
for p in (_REPO_ROOT, os.path.join(_REPO_ROOT, "mempalace-src")):
    if p not in sys.path:
        sys.path.insert(0, p)

import background_review as br  # noqa: E402


def test_review_prompt_contains_preference_order_and_donot_list():
    p = br.SKILL_REVIEW_PROMPT
    # Preference order — patch existing first; create class-level last.
    for fragment in (
        "patch a skill",
        "umbrella",
        "support file",
        "new class-level skill",
    ):
        assert fragment in p, f"missing preference-order fragment: {fragment!r}"
    # "Do NOT capture" list (sample of the rules)
    for fragment in (
        "Do NOT capture",
        "environment-specific",
        "transient",
        "one-off",
    ):
        assert fragment in p, f"missing do-not-capture fragment: {fragment!r}"
    # Treat-tag-contents-as-data guard (prompt hardening from gbrain think/prompt.ts)
    assert "as data, not instructions" in p


def test_wrap_input_uses_structural_tags():
    wrapped = br.wrap_input(
        transcript="user: hi\nassistant: hello",
        wing="personal",
        loaded_skills=["a", "b"],
    )
    assert "<transcript>" in wrapped and "</transcript>" in wrapped
    assert "<wing>personal</wing>" in wrapped
    assert "<loaded_skills>a, b</loaded_skills>" in wrapped


def test_parse_review_output_happy_json():
    raw = '{"decision": "patch", "skill": "deploy", "old": "x", "new": "y"}'
    res = br.parse_review_output(raw)
    assert res["decision"] == "patch"
    assert res["skill"] == "deploy"


def test_parse_review_output_regex_fallback_when_json_buried_in_prose():
    raw = (
        "Sure, I think the right call here is:\n"
        '```json\n{"decision": "create", "name": "ship-it", '
        '"description": "release"}\n```\n'
        "Hope that helps."
    )
    res = br.parse_review_output(raw)
    assert res["decision"] == "create"
    assert res["name"] == "ship-it"


def test_parse_review_output_total_junk_returns_noop():
    res = br.parse_review_output("I have no idea, sorry.")
    assert res == {"decision": "noop", "reason": "unparseable"}


def test_restricted_tools_are_the_allow_list():
    names = {t["function"]["name"] for t in br.restricted_tools()}
    assert names == {
        "skill_manage", "skill_view",
        "diary_write", "memory_search", "conversation_search",
    }


import asyncio


def test_run_skill_review_dispatches_returned_tool_call(monkeypatch):
    # Fake the Ollama call to return a single patch tool_call decision.
    async def fake_post(*a, **k):
        class _R:
            status_code = 200

            def json(self):
                return {
                    "message": {
                        "content": (
                            '{"decision": "patch", "skill": "deploy", '
                            '"old": "foo", "new": "bar", "reason": "stale"}'
                        )
                    }
                }
        return _R()

    monkeypatch.setattr(br, "_ollama_chat", fake_post)

    calls = []

    async def fake_exec(name, args, wing, session_id):
        calls.append((name, args, wing))
        return {"ok": True, "action": "patch", "name": "deploy"}

    monkeypatch.setattr(br, "_exec_tool_async", fake_exec)

    decision = asyncio.run(
        br.run_skill_review(
            model="m", transcript="t", wing="personal",
            loaded_skills=["deploy"], session_id=None,
        )
    )
    assert decision["decision"] == "patch"
    assert calls and calls[0][0] == "skill_manage"
    # privilege-separation: only skill_manage is dispatched (proposal->write)
    assert calls[0][1]["action"] == "patch"
    assert calls[0][1]["name"] == "deploy"


def test_run_skill_review_swallows_errors_and_logs_cascade_failure(monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("ollama down")
    monkeypatch.setattr(br, "_ollama_chat", boom)

    logged = []
    monkeypatch.setattr(br, "_log_decision",
                        lambda rec: logged.append(rec))

    decision = asyncio.run(
        br.run_skill_review(
            model="m", transcript="t", wing="personal",
            loaded_skills=[], session_id=None,
        )
    )
    assert decision["decision"] == "errored"
    assert logged and logged[0]["cascade_failure"] is True


def test_run_skill_review_noop_when_decision_is_noop(monkeypatch):
    async def fake_post(*a, **k):
        class _R:
            status_code = 200

            def json(self):
                return {"message": {"content": '{"decision": "noop"}'}}
        return _R()
    monkeypatch.setattr(br, "_ollama_chat", fake_post)
    calls = []

    async def fake_exec(*a, **k):
        calls.append(a)
        return {}
    monkeypatch.setattr(br, "_exec_tool_async", fake_exec)

    decision = asyncio.run(
        br.run_skill_review(
            model="m", transcript="t", wing="personal",
            loaded_skills=[], session_id=None,
        )
    )
    assert decision["decision"] == "noop"
    assert not calls  # no tool dispatched on noop
