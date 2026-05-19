"""Integration-ish tests for the skill -> MemPalace index seam (Plan 1 bugfix).

These exercise the REAL index_skill (not the stub used elsewhere). They do not
require ChromaDB/embeddings: defect #1 is checked against the real sanitize_name,
defect #2 by faking tool_add_drawer's return.
"""

import logging
import os
import sys
import tempfile

import pytest

_TMP_HOME = tempfile.mkdtemp(prefix="kt_skill_index_")
os.environ["HOME"] = _TMP_HOME
os.environ["USERPROFILE"] = _TMP_HOME

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
for p in (_REPO_ROOT, os.path.join(_REPO_ROOT, "mempalace-src")):
    if p not in sys.path:
        sys.path.insert(0, p)

import skill_store as ss  # noqa: E402
from mempalace.config import sanitize_name  # noqa: E402


def test_index_wing_name_passes_sanitize_name():
    # Defect #1 regression: the wing the index writes to MUST be accepted by
    # MemPalace's sanitize_name (this is exactly what '_skills' violated).
    assert sanitize_name(ss.SKILL_INDEX_WING, "wing") == ss.SKILL_INDEX_WING
    assert sanitize_name(ss.SKILL_INDEX_ROOM, "room") == ss.SKILL_INDEX_ROOM


def test_index_skill_warns_on_failed_add(monkeypatch, caplog):
    # Defect #2 regression: a {'success': False} return must be logged, not
    # silently ignored, and must not raise.
    import mempalace.mcp_server as mcp

    monkeypatch.setattr(
        mcp, "tool_add_drawer",
        lambda **kw: {"success": False, "error": "wing contains invalid characters"},
    )
    with caplog.at_level(logging.WARNING):
        ss.index_skill("demo", "desc", "/tmp/x/SKILL.md")  # must not raise
    assert any("skill index write failed" in r.message for r in caplog.records)


def test_index_skill_silent_on_success(monkeypatch, caplog):
    import mempalace.mcp_server as mcp

    captured = {}

    def fake_add(**kw):
        captured.update(kw)
        return {"success": True, "drawer_id": "d1"}

    monkeypatch.setattr(mcp, "tool_add_drawer", fake_add)
    with caplog.at_level(logging.WARNING):
        ss.index_skill("demo", "desc", "/tmp/x/SKILL.md")
    assert captured["wing"] == ss.SKILL_INDEX_WING
    assert captured["room"] == ss.SKILL_INDEX_ROOM
    assert captured["content"] == "demo: desc"
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_deindex_skill_removes_real_drawer():
    import skill_store as s
    from mempalace.mcp_server import tool_list_drawers

    s.create_skill(name="rs-deindex", description="real deindex check",
                   body="## Contract\nx\n", category="smoketest")
    before = tool_list_drawers(wing=s.SKILL_INDEX_WING, room=s.SKILL_INDEX_ROOM)
    assert any(
        (d.get("content_preview") or "").startswith("rs-deindex: ")
        for d in before.get("drawers", [])
    )
    s.deindex_skill("rs-deindex")
    after = tool_list_drawers(wing=s.SKILL_INDEX_WING, room=s.SKILL_INDEX_ROOM)
    assert not any(
        (d.get("content_preview") or "").startswith("rs-deindex: ")
        for d in after.get("drawers", [])
    )
