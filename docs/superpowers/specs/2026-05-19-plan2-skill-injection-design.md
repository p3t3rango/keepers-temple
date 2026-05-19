# Design: Plan 2 — Skill Injection + Cross-Session Conversation Search

**Date:** 2026-05-19
**Status:** Approved design — ready for implementation planning
**Parent spec:** `docs/superpowers/specs/2026-05-18-hermes-self-improvement-loop-design.md` (§5, §6, §12)
**Builds on:** Plan 1 (skill store & tools), merged/PR #1 on `feat/skill-store`

## 1. Goal

Make the skills created in Plan 1 actually influence the model, and let the model
recall prior conversations on demand. Plan 1 built the store + tools + API but
nothing surfaces skills to the model and nothing searches past chats. Plan 2
closes that: a compact skills index injected into the model's per-turn system
prompt, the same index shown in the wake-up UI preview, and a
`conversation_search` tool.

### Correction to the parent spec

Parent spec §5 said "inject L1.5 inside `MemoryStack.wake_up()`." Investigation of
the current code proved this wrong: `wake_up()` is **not** in the chat path — it
is only called by `GET /api/wakeup` (UI sidebar preview) and `/api/recall`. The
model's per-turn system prompt is composed ad hoc in the `/api/chat` handler
(identity → custom `system_prompt` → tool protocol → memory-recall block → user
messages). Plan 2 therefore injects the skills index as a new system-message
block in the chat handler, **not** in `layers.py`. This is simpler and correctly
layered (`skill_store` is app-level; `layers.py` is vendored mempalace code that
must not depend on it).

## 2. Non-Goals (explicit)

- No background/autonomous skill creation or self-patching — that is **Plan 3**.
- No curator, GUI Skills panel, inline "📘 Learned X" signal, or settings UI —
  that is **Plan 4**.
- No change to `layers.py` / the mempalace package.
- `conversation_search` is **agent-pulled only**; never auto-injected into the
  system prompt (parent spec §6).

## 3. Components

### 3.1 `_format_skills_index()` — single formatter, two consumers

A new function in `app.py` (it depends on `skill_store`, which is app-level).
Signature: `_format_skills_index(limit: int) -> str` (returns `""` when there are
no active skills).

- Source: `skill_store.list_skills(include_archived=False)` (filesystem-backed —
  archived skills are already excluded).
- Ordering: **pinned skills first**, then by category, then name (stable,
  deterministic).
- Content per skill: `- <name>: <description>` only. **Never** the body.
- Cap: at most `limit` skills; additionally a hard character ceiling of
  `SKILLS_INDEX_CHAR_CAP = 2000` (~600 tokens) — if exceeded, truncate the list
  and append a final line `… (N more skills; use skill_view to discover)`.
- Wrapper: an `<available_skills>` block ending with the instruction:
  *"Before replying, scan the skills above. If one is relevant or even partially
  applies, you MUST load it with skill_view(name) before acting. Do not guess a
  procedure a skill already documents."* (Hermes progressive-disclosure pattern;
  the `skill_view` tool already exists from Plan 1.)

### 3.2 Chat-path injection (the part that reaches the model)

- `ChatRequest` gains two fields, parallel to existing `use_memory`/`use_identity`:
  - `use_skills: bool = True`
  - `skill_limit: int = Field(default=15, ge=1, le=50)`
- In the `/api/chat` system-message composition, **after** the memory-recall
  block append and **before** the user/assistant messages are extended, append
  one system message with `_format_skills_index(req.skill_limit)` when
  `req.use_skills` is true and the formatted string is non-empty.
- Exact insertion site is located at plan time by code anchor (the
  `_format_memory_block(...)` append in the chat handler), not line number — the
  Plan 1 lesson: `app.py` line numbers are branch-variant-specific.

### 3.3 Wake-up UI preview (also surface it, correctly layered)

- `layers.py` / `MemoryStack.wake_up()` is **untouched**.
- The `GET /api/wakeup` endpoint composes its existing `wake_up()` output **plus**
  the same `_format_skills_index()` string (appended after the wake-up text,
  clearly delimited). One formatter → chat prompt and preview stay consistent.
- The preview uses a fixed reasonable limit (the `use_skills` default, 15); it
  does not take request params.

### 3.4 `conversation_search` tool

- New entry in the `TOOLS` list and a branch in the sync `_exec_tool`
  (consistent with how `skill_manage`/`skill_view` were wired in Plan 1).
- Parameters: `query: string` (required), `n: integer` (1–10, default 5),
  optional `wing: string`.
- Implementation: call
  `search_memories(query, palace_path=PALACE_PATH, wing=<arg or None>,
  n_results=n*3)`, then keep only hits whose `source_file` starts with
  `"chat://"` (the raw-transcript convention written by the chat handler when
  `save_to_memory` is true), truncate to `n`, return
  `{"count": k, "hits": [{wing, room, similarity, text(≤600 chars), when}]}`
  where `when` is parsed from the `chat://model/session/<iso>` source_file when
  available.
- Distinct from `memory_search` (extracted facts + the `kt-skills` index) and
  from the injected skills index. Tool description states this explicitly so the
  model knows when to use which.
- Returns `{"count": 0, "hits": []}` (not an error) when nothing matches.

### 3.5 FU-2 — honest palace index on archive/restore

- Add `skill_store.deindex_skill(name: str) -> None`: best-effort removal of the
  skill's `kt-skills/index` drawer (locate via the mempalace drawer-list/delete
  tools by matching `source_file == f"skill://{path}"` or content prefix
  `f"{slug}: "`). Same best-effort contract as `index_skill`: never raises,
  logs at WARNING on failure.
- `archive_skill()` calls `deindex_skill(slug)` after the directory move.
- `restore_skill()` calls `index_skill(slug, description, path)` after the move
  back (re-derive description/path from the restored `SKILL.md`).
- Net effect: `kt-skills/index` reflects only active skills, so archived skills
  cannot resurface via `memory_search`.

### 3.6 `kt-skills` exclusion from user-facing topic hints

Wherever wings/rooms are presented to the model or UI as reusable memory
"topics" (the topic-hint surface — exact site, e.g. the `/api/stats`
aggregation and/or the tool-protocol topic list, pinned at plan time), filter
out the `kt-skills` wing so the model never proposes filing user memory there.
This is a presentation-layer filter only; it does not touch stored data.

## 4. Data Flow

```
chat turn → /api/chat
  compose system msgs: identity → system_prompt → tool protocol
    → memory-recall block
    → [NEW] _format_skills_index(skill_limit)   (if use_skills & non-empty)
  → user/assistant messages → Ollama
        model may call skill_view(name)  → full SKILL.md body (Plan 1 tool)
        model may call conversation_search(query) → prior chat:// transcript hits
        model may call memory_search / kg_* (unchanged)

skill_store.archive_skill → dir move + deindex_skill  → kt-skills/index shrinks
skill_store.restore_skill → dir move + index_skill    → kt-skills/index grows

GET /api/wakeup → wake_up() text + _format_skills_index()  (UI preview)
```

## 5. Error Handling

- `_format_skills_index()`: if `skill_store.list_skills()` raises, log WARNING and
  return `""` (skills injection is best-effort; never breaks a chat turn).
- `conversation_search`: mempalace/search errors caught in the existing
  `_exec_tool` try/except → `{"error": str(e)}` (consistent with sibling tools).
- `deindex_skill`: best-effort, never raises, WARNING on failure (mirrors
  `index_skill`).
- Archive/restore must still succeed even if (de)index fails — the filesystem
  move is the source of truth (same contract as Plan 1).

## 6. Testing Strategy

Mirrors Plan 1 conventions (`HOME` redirected to tmp; autouse `_clean_skills`
runtime-resolved; `index_skill` stubbed in unit tests; a separate real-seam
test file like `test_skill_index.py`).

- **Unit (`tests/test_skills_index.py`):** `_format_skills_index` — empty store →
  `""`; pinned-first + category ordering; `limit` and char-cap truncation with
  the "N more" line; archived skills excluded; body never present.
- **Lifecycle (extend `tests/test_skill_store.py`):** `archive_skill` →
  `deindex_skill` invoked; `restore_skill` → `index_skill` re-invoked
  (assert via the same stub/calls-list seam used in Plan 1).
- **Real seam (extend `tests/test_skill_index.py`):** `deindex_skill` actually
  removes the `kt-skills/index` drawer for a created→archived skill (uses real
  mempalace, same pattern that caught the Plan 1 bug).
- **Integration (`tests/test_app_skills_endpoints.py` / a new chat test with
  TestClient + mocked Ollama):** the `<available_skills>` block is present in the
  composed system messages when `use_skills=true` and a skill exists; absent when
  `use_skills=false` or no skills; `GET /api/wakeup` body contains the block;
  `conversation_search` returns only `source_file` `chat://` hits and `{"count":
  0}` when none; the `kt-skills` wing is absent from the topic-hint surface.
- Mock the Ollama endpoint for any chat-path test (no live model dependency); the
  real-model tool-calling path was already smoke-verified in Plan 1.

## 7. Open Implementation Details (for the plan, not blockers)

- Exact `_exec_tool`/`TOOLS` insertion anchors and the chat-handler memory-block
  anchor — located at plan time via grep, not line numbers (Plan 1 lesson;
  `app.py` differs by branch variant).
- The precise topic-hint surface to filter `kt-skills` from (confirm whether it
  is `/api/stats`, a `_existing_topic_names`-style helper, or the tool-protocol
  builder on the current branch) — pinned during writing-plans.
- `deindex_skill` lookup key: prefer exact `source_file == "skill://<path>"`
  match; fall back to content-prefix `"<slug>: "` if the drawer-list tool does
  not expose `source_file`.
- Branch: continue on `feat/skill-store` (Plan 1) if PR #1 is not yet merged, or
  branch `feat/skill-injection` off updated `main` if it is — decided at plan
  execution time based on PR #1 status.
