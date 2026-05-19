# Self-Improvement Loop — Plan 2: Skill Injection + Conversation Search

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface Plan 1's skills to the model every chat turn (and in the wake-up UI preview), add an agent-pulled `conversation_search` tool over prior chat transcripts, and keep the `kt-skills` palace index honest on archive/restore.

**Architecture:** A single pure formatter `_format_skills_index()` (app-level, depends on `skill_store`) feeds two consumers: a new system-message in the `/api/chat` composition (gated by `use_skills`) and the `GET /api/wakeup` endpoint (composed at the endpoint — `layers.py`/mempalace stays untouched, correct layering). `conversation_search` reuses `search_memories` filtered to `chat://` transcripts. `skill_store.deindex_skill` is wired into archive/restore so the palace index reflects only active skills. Pure helper boundaries (`_format_skills_index`, `_compose_skill_message`, `_aggregate_palace`) make everything unit-testable without mocking the streaming Ollama call.

**Tech Stack:** Python 3.9, FastAPI, Pydantic v2, pytest + `fastapi.testclient.TestClient`, MemPalace (`search_memories`, `tool_list_drawers`, `tool_delete_drawer`, `tool_add_drawer`).

---

## Spec

Implements `docs/superpowers/specs/2026-05-19-plan2-skill-injection-design.md`. Parent: `docs/superpowers/specs/2026-05-18-hermes-self-improvement-loop-design.md` (§5/§6/§12). Plan 2 is one cohesive subsystem (make skills/conversations reach the model + UI) — not decomposed further.

## Branch

PR #1 (Plan 1) is open and not yet merged. **Continue on branch `feat/skill-store`** (Plan 2 builds directly on Plan 1's `skill_store.py`/tools). Do not create a new branch unless PR #1 has been merged to `main` first (then branch `feat/skill-injection` off updated `main`). Verify with `git branch --show-current` (expect `feat/skill-store`) before Task 1.

## Anchors (current `feat/skill-store` variant — verify by grep, never trust raw line numbers; Plan 1 lesson)

- `ChatRequest` class — `grep -n "class ChatRequest" app.py` (~96); has `use_memory`, `use_identity`, `memory_limit` to parallel.
- Chat system-message composition — `grep -n "_format_memory_block(memory_hits)" app.py` (~2229); the skills message is appended immediately after the `if memory_block:` append and before `chat_msgs: list[dict] = []`.
- `TOOLS = [` list — `grep -n "^TOOLS = \[" app.py` (~1614); insert the new spec before its closing `]` (after the last existing tool dict).
- Sync `_exec_tool` fallthrough — `grep -n 'unknown tool: {name}' app.py` (~1963); insert the `conversation_search` branch before `return {"error": f"unknown tool: {name}"}`.
- `/api/wakeup` handler — `grep -n '@app.get("/api/wakeup")' app.py` (~1602); `get_wakeup` builds `text = stack.wake_up(wing=wing)`.
- `/api/stats` handler — `grep -n '@app.get("/api/stats")' app.py` (~548); `palace_stats` aggregates `wings`/`rooms` from `all_meta`.
- `skill_store.py` already has `index_skill`, `SKILL_INDEX_WING="kt-skills"`, `SKILL_INDEX_ROOM="index"`, `archive_skill`, `restore_skill`, `_skill_dir`, `_archived_skill_dir`, `logger`.
- Test conventions: `HOME` redirected to tmp before imports; autouse `_clean_skills` runtime-resolved via `ss.skills_root()`; `index_skill` stubbed in unit suites; real-seam tests in `tests/test_skill_index.py`.

## File Structure

- **Modify:** `skill_store.py` — add `deindex_skill`; call it from `archive_skill`; re-index in `restore_skill`.
- **Modify:** `app.py` — add `_format_skills_index`, `_compose_skill_message`, `_aggregate_palace`; `ChatRequest.use_skills`/`skill_limit`; chat-handler append; `conversation_search` TOOLS spec + `_exec_tool` branch; `/api/wakeup` composition; `/api/stats` exclusion.
- **Create:** `tests/test_skills_index.py` — unit tests for `_format_skills_index`, `_compose_skill_message`, `_aggregate_palace`, `conversation_search` (via `_exec_tool`).
- **Modify:** `tests/test_skill_store.py` — `deindex`/reindex lifecycle (stubbed seam).
- **Modify:** `tests/test_skill_index.py` — real-seam `deindex_skill` removes the `kt-skills/index` drawer.
- **Modify:** `tests/test_app_skills_endpoints.py` — `/api/wakeup` includes the block; `/api/stats` excludes `kt-skills`.

---

### Task 1: `deindex_skill` + archive/restore wiring

**Files:**
- Modify: `skill_store.py`
- Test: `tests/test_skill_store.py` (stubbed lifecycle), `tests/test_skill_index.py` (real seam)

- [ ] **Step 1: Write the failing lifecycle test — APPEND to `tests/test_skill_store.py`**

```python
def test_archive_deindexes_and_restore_reindexes(monkeypatch):
    calls = []
    monkeypatch.setattr(ss, "index_skill", lambda n, d, p: calls.append(("index", n)))
    monkeypatch.setattr(ss, "deindex_skill", lambda n: calls.append(("deindex", n)))
    ss.create_skill(name="lc", description="d", body="b\n", category="ops")
    ss.archive_skill("lc")
    ss.restore_skill("lc")
    assert ("deindex", "lc") in calls
    # restore re-indexes (index_skill called again after the create-time call)
    assert calls.count(("index", "lc")) >= 1
    assert calls.index(("deindex", "lc")) < calls.index(("index", "lc"), 1) \
        if calls.count(("index", "lc")) > 1 else True
```

- [ ] **Step 2: Run — expect FAIL**

Run: `.venv/bin/python -m pytest tests/test_skill_store.py::test_archive_deindexes_and_restore_reindexes -q`
Expected: FAIL — `AttributeError: module 'skill_store' has no attribute 'deindex_skill'`.

- [ ] **Step 3: Implement — in `skill_store.py`**

Add `deindex_skill` directly AFTER `index_skill`:

```python
def deindex_skill(name: str) -> None:
    """Best-effort: remove the skill's kt-skills/index drawer(s).

    Never raises (mirrors index_skill); WARNING-logs on failure. Matches by
    content prefix '<slug>: ' since the index drawer content is
    f"{slug}: {description}" (see index_skill).
    """
    slug = slugify(name)
    try:
        from mempalace.mcp_server import tool_list_drawers, tool_delete_drawer

        listing = tool_list_drawers(
            wing=SKILL_INDEX_WING, room=SKILL_INDEX_ROOM
        )
        drawers = listing.get("drawers", []) if isinstance(listing, dict) else []
        removed = 0
        for d in drawers:
            preview = (d.get("content_preview") or "")
            if preview.startswith(f"{slug}: "):
                res = tool_delete_drawer(d.get("drawer_id"))
                if isinstance(res, dict) and res.get("success"):
                    removed += 1
        if removed == 0:
            logger.warning("deindex_skill: no kt-skills drawer found for %r", slug)
    except Exception:
        logger.warning("deindex_skill errored for %r", slug, exc_info=True)
```

In `archive_skill`, after `_touch_usage(slug, archived=True)` and before `return`, add:

```python
    deindex_skill(slug)
```

In `restore_skill`, after `_touch_usage(slug, archived=False)` and before `return`, add (re-derive description/path from the restored SKILL.md):

```python
    try:
        meta, _ = parse_frontmatter((dest / "SKILL.md").read_text())
        index_skill(slug, meta.get("description", ""), str(dest / "SKILL.md"))
    except Exception:
        logger.warning("restore_skill: re-index failed for %r", slug, exc_info=True)
```

(`dest` is the active path `restore_skill` already computes when moving the dir back. If the variable is named differently, use the post-move active directory path that the existing code already has.)

- [ ] **Step 4: Run — expect PASS**

Run: `.venv/bin/python -m pytest tests/test_skill_store.py -q`
Expected: all passed.

- [ ] **Step 5: Write the real-seam test — APPEND to `tests/test_skill_index.py`**

```python
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
```

- [ ] **Step 6: Run real-seam + full suite — expect PASS**

Run: `.venv/bin/python -m pytest tests/test_skill_index.py tests/test_skill_store.py -q`
Expected: all passed.

- [ ] **Step 7: Commit**

```bash
git add skill_store.py tests/test_skill_store.py tests/test_skill_index.py
git commit -m "feat(skills): deindex_skill on archive, reindex on restore (FU-2)"
```

---

### Task 2: `_format_skills_index()` pure formatter

**Files:**
- Modify: `app.py`
- Test: `tests/test_skills_index.py`

- [ ] **Step 1: Write the failing test — create `tests/test_skills_index.py`**

```python
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
    assert capped.count("\n- ") <= 3 or "more skills" in capped
    big = app_module._format_skills_index(50)
    assert len(big) <= app_module.SKILLS_INDEX_CHAR_CAP + 200  # cap + wrapper slack
    assert "more skills" in big or len(big) <= app_module.SKILLS_INDEX_CHAR_CAP + 200


def test_skills_index_excludes_archived():
    ss.create_skill(name="live", description="d", body="b\n")
    ss.create_skill(name="gone", description="d", body="b\n")
    ss.archive_skill("gone")
    out = app_module._format_skills_index(15)
    assert "live" in out and "gone" not in out
```

- [ ] **Step 2: Run — expect FAIL**

Run: `.venv/bin/python -m pytest tests/test_skills_index.py -q`
Expected: FAIL — `AttributeError: module 'app' has no attribute '_format_skills_index'`.

- [ ] **Step 3: Implement — in `app.py`, immediately after `_format_memory_block` (grep `def _format_memory_block`)**

```python
SKILLS_INDEX_CHAR_CAP = 2000  # ~600 tokens, hard ceiling for the skills block


def _format_skills_index(limit: int) -> str:
    """Compact <available_skills> block: name+description only, pinned first.

    Best-effort: returns "" on any error or when there are no active skills.
    Body is never included (progressive disclosure via the skill_view tool).
    """
    try:
        skills = skill_store.list_skills(include_archived=False)
    except Exception:
        logger.warning("skills index: list_skills failed", exc_info=True)
        return ""
    if not skills:
        return ""
    skills.sort(key=lambda s: (not s.get("pinned"), s.get("category", ""),
                               s.get("name", "")))
    lines = []
    used = 0
    shown = 0
    for s in skills:
        if shown >= max(1, int(limit)):
            break
        line = f"- {s['name']}: {s.get('description', '')}"
        if used + len(line) + 1 > SKILLS_INDEX_CHAR_CAP:
            break
        lines.append(line)
        used += len(line) + 1
        shown += 1
    remaining = len(skills) - shown
    if remaining > 0:
        lines.append(f"… ({remaining} more skills; use skill_view to discover)")
    body = "\n".join(lines)
    return (
        "<available_skills>\n"
        f"{body}\n"
        "Before replying, scan the skills above. If one is relevant or even "
        "partially applies, you MUST load it with skill_view(name) before "
        "acting. Do not guess a procedure a skill already documents.\n"
        "</available_skills>"
    )
```

`logger` already exists in `app.py` if Plan 1 added it; if `grep -n "^logger = \|getLogger" app.py` finds none, add near the top imports: `import logging` then `logger = logging.getLogger(__name__)`.

- [ ] **Step 4: Run — expect PASS**

Run: `.venv/bin/python -m pytest tests/test_skills_index.py -q`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_skills_index.py
git commit -m "feat(skills): _format_skills_index formatter (pinned-first, capped, body-free)"
```

---

### Task 3: `ChatRequest` fields + `_compose_skill_message` + chat-handler injection

**Files:**
- Modify: `app.py`
- Test: `tests/test_skills_index.py`

- [ ] **Step 1: Write the failing test — APPEND to `tests/test_skills_index.py`**

```python
def _req(**kw):
    base = dict(model="m", messages=[{"role": "user", "content": "hi"}])
    base.update(kw)
    return app_module.ChatRequest(**base)


def test_compose_skill_message_gating():
    # no skills -> None even when enabled
    assert app_module._compose_skill_message(_req(use_skills=True)) is None
    ss.create_skill(name="k", description="d", body="b\n")
    # disabled -> None
    assert app_module._compose_skill_message(_req(use_skills=False)) is None
    # enabled + skills -> system message containing the block
    msg = app_module._compose_skill_message(_req(use_skills=True, skill_limit=15))
    assert msg["role"] == "system"
    assert "<available_skills>" in msg["content"] and "k:" in msg["content"]


def test_chatrequest_defaults():
    r = _req()
    assert r.use_skills is True
    assert r.skill_limit == 15
```

- [ ] **Step 2: Run — expect FAIL**

Run: `.venv/bin/python -m pytest tests/test_skills_index.py::test_compose_skill_message_gating tests/test_skills_index.py::test_chatrequest_defaults -q`
Expected: FAIL — `ChatRequest` has no `use_skills` / no `_compose_skill_message`.

- [ ] **Step 3a: Add `ChatRequest` fields — in `app.py` (after the `memory_limit` field, grep `memory_limit: int = Field`)**

```python
    use_skills: bool = True
    skill_limit: int = Field(default=15, ge=1, le=50)
```

- [ ] **Step 3b: Add `_compose_skill_message` — in `app.py` right after `_format_skills_index`**

```python
def _compose_skill_message(req: "ChatRequest"):
    """Return the skills system-message dict, or None when disabled/empty."""
    if not req.use_skills:
        return None
    block = _format_skills_index(req.skill_limit)
    if not block:
        return None
    return {"role": "system", "content": block}
```

- [ ] **Step 3c: Wire into the chat handler — in `app.py`**

Locate the memory-block append (`grep -n "_format_memory_block(memory_hits)" app.py`). Immediately AFTER the `if memory_block:` append block and BEFORE the `chat_msgs: list[dict] = []` line, insert:

```python
    _skill_msg = _compose_skill_message(req)
    if _skill_msg is not None:
        out_messages.append(_skill_msg)
```

- [ ] **Step 4: Run — expect PASS (full suite, both orderings)**

Run: `.venv/bin/python -m pytest tests/ -q`
Run: `.venv/bin/python -m pytest tests/test_skill_store.py tests/test_skills_index.py tests/test_app_skills_endpoints.py -q`
Expected: all passed, both orderings.

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_skills_index.py
git commit -m "feat(skills): inject skills index into /api/chat system prompt (use_skills/skill_limit)"
```

---

### Task 4: `conversation_search` tool

**Files:**
- Modify: `app.py`
- Test: `tests/test_skills_index.py`

- [ ] **Step 1: Write the failing test — APPEND to `tests/test_skills_index.py`**

```python
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
    assert miss.get("error")  # empty query rejected like sibling tools


def test_conversation_search_in_tools_list():
    names = {t["function"]["name"] for t in app_module.TOOLS}
    assert "conversation_search" in names
```

- [ ] **Step 2: Run — expect FAIL**

Run: `.venv/bin/python -m pytest tests/test_skills_index.py::test_conversation_search_filters_to_chat_transcripts tests/test_skills_index.py::test_conversation_search_in_tools_list -q`
Expected: FAIL — `{"error": "unknown tool: conversation_search"}` / not in TOOLS.

- [ ] **Step 3a: Add the TOOLS spec — in `app.py`, before the closing `]` of `TOOLS = [` (grep `^TOOLS = \[`; insert after the last tool dict)**

```python
    {
        "type": "function",
        "function": {
            "name": "conversation_search",
            "description": (
                "Search PRIOR CHAT TRANSCRIPTS (past conversations with this "
                "user) for relevant context. Distinct from memory_search "
                "(saved facts + skills) — use this when you need what was "
                "actually said in earlier sessions."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "n": {"type": "integer",
                          "description": "Max results 1-10 (default 5)."},
                    "wing": {"type": "string",
                             "description": "Optional wing to scope to."},
                },
                "required": ["query"],
            },
        },
    },
```

- [ ] **Step 3b: Add the dispatch branch — in `app.py`, before `return {"error": f"unknown tool: {name}"}` in the sync `_exec_tool`**

```python
        if name == "conversation_search":
            q = str(args.get("query") or "").strip()
            if not q:
                return {"error": "query is required"}
            wing = args.get("wing") or None
            n = max(1, min(int(args.get("n", 5)), 10))
            result = search_memories(
                q, palace_path=PALACE_PATH, wing=wing, n_results=n * 3
            )
            hits = result.get("results", []) or []
            convo = [
                h for h in hits
                if str(h.get("source_file") or "").startswith("chat://")
            ][:n]
            return {
                "count": len(convo),
                "hits": [
                    {
                        "wing": h.get("wing"),
                        "room": h.get("room"),
                        "similarity": h.get("similarity"),
                        "text": (h.get("text") or "")[:600],
                        "when": (str(h.get("source_file") or "")
                                 .split("/")[-1] or None),
                    }
                    for h in convo
                ],
            }
```

- [ ] **Step 4: Run — expect PASS**

Run: `.venv/bin/python -m pytest tests/test_skills_index.py -q`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_skills_index.py
git commit -m "feat(skills): conversation_search tool (chat:// transcripts only)"
```

---

### Task 5: `/api/wakeup` preview includes the skills index

**Files:**
- Modify: `app.py`
- Test: `tests/test_app_skills_endpoints.py`

- [ ] **Step 1: Write the failing test — APPEND to `tests/test_app_skills_endpoints.py`**

```python
def test_wakeup_includes_skills_block(client):
    client.post("/api/skills", json={
        "name": "wk", "description": "wakeup skill", "body": "## Contract\nx\n"})
    r = client.get("/api/wakeup")
    assert r.status_code == 200
    assert "<available_skills>" in r.json()["text"]
    assert "wk:" in r.json()["text"]
```

- [ ] **Step 2: Run — expect FAIL**

Run: `.venv/bin/python -m pytest tests/test_app_skills_endpoints.py::test_wakeup_includes_skills_block -q`
Expected: FAIL — `<available_skills>` not in wakeup text.

- [ ] **Step 3: Implement — in `app.py` `get_wakeup` (grep `@app.get("/api/wakeup")`)**

Replace the body of `get_wakeup` so the skills block is appended to the wake-up text:

```python
@app.get("/api/taxonomy")
@app.get("/api/wakeup")
async def get_wakeup(wing: Optional[str] = None):
    try:
        stack = MemoryStack(palace_path=PALACE_PATH)
        text = stack.wake_up(wing=wing)
        skills_block = _format_skills_index(15)
        if skills_block:
            text = f"{text}\n\n{skills_block}"
        return {"text": text, "tokens_estimate": len(text) // 4, "wing": wing}
    except Exception as e:
        return {"text": "", "tokens_estimate": 0, "wing": wing, "error": str(e)}
```

(`layers.py` is NOT modified — composition happens here at the endpoint.)

- [ ] **Step 4: Run — expect PASS**

Run: `.venv/bin/python -m pytest tests/test_app_skills_endpoints.py -q`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_app_skills_endpoints.py
git commit -m "feat(skills): surface skills index in /api/wakeup preview (endpoint-composed)"
```

---

### Task 6: `/api/stats` excludes the `kt-skills` wing

**Files:**
- Modify: `app.py`
- Test: `tests/test_skills_index.py`

- [ ] **Step 1: Write the failing test — APPEND to `tests/test_skills_index.py`**

```python
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
```

- [ ] **Step 2: Run — expect FAIL**

Run: `.venv/bin/python -m pytest tests/test_skills_index.py::test_aggregate_palace_excludes_kt_skills -q`
Expected: FAIL — `app` has no attribute `_aggregate_palace`.

- [ ] **Step 3a: Add the pure helper — in `app.py` just above the `palace_stats` handler (grep `@app.get("/api/stats")`)**

```python
SKILL_INDEX_WING_NAME = "kt-skills"  # mirror skill_store.SKILL_INDEX_WING; internal


def _aggregate_palace(all_meta: list) -> tuple[dict, dict]:
    """Count drawers per wing/room, excluding the internal kt-skills index
    so it is never offered to the model/UI as a reusable memory topic."""
    wings: dict[str, int] = {}
    rooms: dict[str, int] = {}
    for m in all_meta:
        w = (m or {}).get("wing", "unknown")
        if w == SKILL_INDEX_WING_NAME:
            continue
        r = (m or {}).get("room", "unknown")
        wings[w] = wings.get(w, 0) + 1
        rooms[r] = rooms.get(r, 0) + 1
    return wings, rooms
```

- [ ] **Step 3b: Use it in `palace_stats` — replace the inline wing/room loop**

In `palace_stats`, replace the block:

```python
    wings: dict[str, int] = {}
    rooms: dict[str, int] = {}
    for m in all_meta:
        w = (m or {}).get("wing", "unknown")
        r = (m or {}).get("room", "unknown")
        wings[w] = wings.get(w, 0) + 1
        rooms[r] = rooms.get(r, 0) + 1
```

with:

```python
    wings, rooms = _aggregate_palace(all_meta)
```

- [ ] **Step 4: Run — expect PASS (full suite both orderings)**

Run: `.venv/bin/python -m pytest tests/ -q`
Run: `.venv/bin/python -m pytest tests/test_app_skills_endpoints.py tests/test_skill_store.py tests/test_skills_index.py tests/test_skill_index.py -q`
Expected: all passed, both orderings.

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_skills_index.py
git commit -m "feat(skills): exclude kt-skills wing from /api/stats topic surface (FU-2)"
```

---

### Task 7: Regression close-out

- [ ] **Step 1: Full suite, both orderings**

Run: `cd "/Users/peterarango/cursor experiments/keepers-temple" && .venv/bin/python -m pytest tests/ -q`
Run: `cd "/Users/peterarango/cursor experiments/keepers-temple" && .venv/bin/python -m pytest tests/test_skill_index.py tests/test_app_skills_endpoints.py tests/test_skill_store.py tests/test_skills_index.py -q`
Expected: all pass in both orderings (report the count).

- [ ] **Step 2: Smoke — app imports + new tool/route registered**

Run: `cd "/Users/peterarango/cursor experiments/keepers-temple" && PYTHONPATH=mempalace-src .venv/bin/python -c "import app; print('conversation_search' in {t['function']['name'] for t in app.TOOLS}, hasattr(app,'_format_skills_index'), hasattr(app,'_compose_skill_message'), hasattr(app,'_aggregate_palace'))"`
Expected: `True True True True`

- [ ] **Step 3: Close-out commit + push**

```bash
git commit --allow-empty -m "docs: Plan 2 (skill injection + conversation_search) complete"
git push origin feat/skill-store
```

---

## Self-Review

**Spec coverage:** §3.1 `_format_skills_index` → Task 2. §3.2 chat-path injection + `use_skills`/`skill_limit` → Task 3. §3.3 wakeup preview (endpoint-composed, `layers.py` untouched) → Task 5. §3.4 `conversation_search` → Task 4. §3.5 FU-2 deindex/reindex → Task 1. §3.6 kt-skills topic exclusion → Task 6 (the concrete surface on this branch is `/api/stats`; `TOOL_PROTOCOL` is a static string that does not enumerate wings, so there is no other topic-hint surface to filter — confirmed by anchor grep). §5 error handling: best-effort `""`/`{"error":...}` returns covered in Tasks 1,2,4. §6 testing strategy → every task is TDD; non-Ollama seams (`_format_skills_index`, `_compose_skill_message`, `_aggregate_palace`, `conversation_search` via `_exec_tool`, `/api/wakeup`, `/api/stats`) are unit/TestClient-tested; the streaming Ollama call is deliberately not mocked (pure-helper boundaries instead). Non-goals (Plan 3/4 work, `layers.py` edits) respected.

**Placeholder scan:** No TBD/TODO. Every code step has complete code; every test step has real assertions and exact commands + expected output. The one conditional instruction (Task 1 Step 3 `dest` variable name) is an explicit anchor instruction (read the existing `restore_skill` post-move path), not a placeholder.

**Type consistency:** `skill_store.deindex_skill(name)` defined Task 1, called by `archive_skill`/`restore_skill` (Task 1) — consistent. `_format_skills_index(limit:int)->str` (Task 2) called by `_compose_skill_message` (Task 3) and `get_wakeup` (Task 5) with int args — consistent. `SKILLS_INDEX_CHAR_CAP` defined Task 2, referenced in Task 2 tests only. `_aggregate_palace(all_meta)->tuple[dict,dict]` (Task 6) matches `palace_stats` usage. `ChatRequest.use_skills/skill_limit` (Task 3) used by `_compose_skill_message` (Task 3) — consistent. `conversation_search` TOOLS name matches the `_exec_tool` branch and tests (Task 4). `search_memories` is the existing `app.py`-imported symbol (monkeypatched on `app_module` in Task 4 test) — consistent with the existing `memory_search` branch usage.

**Branch note:** continue on `feat/skill-store` (PR #1 unmerged); Plan 2 stacks on Plan 1.
