# Design: Native Self-Improvement Loop for Keepers Temple

**Date:** 2026-05-18
**Status:** Approved design — ready for implementation planning
**Author:** brainstorming session (pete@peterango.com)

## 1. Problem & Goal

Keepers Temple is a ChatGPT/Claude-style **web** chat UI for non-terminal users who
want a **local** (Ollama) model with excellent memory that **gets better the longer
they use it and the more they feed it**.

Today the product delivers two of three pillars:

| Vision pillar | Status |
| --- | --- |
| Excellent memory, "the more you feed it" | **Strong** — MemPalace (wings/rooms/drawers, temporal KG, semantic search, import review gate) is richer than Hermes's flat memory. |
| ChatGPT-style GUI for non-terminal users | **Delivered** — only Keepers Temple provides this; Hermes is CLI/bots. |
| "Improves the longer you talk to it" | **Missing** — MemPalace is passive: it recalls and extracts, but never creates skills, never self-corrects, never consolidates. |

This design closes the third gap by porting **Nous Research Hermes's closed
learning loop** as a native Keepers Temple feature, rather than adopting Hermes
itself (Hermes is a standalone CLI/daemon runtime with no embeddable API, weaker
memory, and no web UI — adopting it would break the core product premise).

### Non-goals (explicit)

- **Honcho dialectic user-modeling** — external paid API, breaks local-first;
  MemPalace `hall_preferences` + identity already cover user modeling.
- **Replacing MemPalace** — its structured memory is the product's strength and is
  retained unchanged.
- **Hermes's messaging frontends** (Telegram/Discord/etc.) — out of scope; the web
  UI is the only surface.

## 2. Core Mechanism: the Background-Review Fork

Ported directly from Hermes (`agent/background_review.py`,
`agent/conversation_loop.py`).

After a chat turn finishes and the user's streamed reply is fully delivered,
Keepers Temple **spawns a second, off-critical-path Ollama call** ("the review
fork"):

- Input: a snapshot of the just-completed conversation turn + a fixed review
  prompt (adapted from Hermes's `_SKILL_REVIEW_PROMPT` /
  `_COMBINED_REVIEW_PROMPT`).
- Toolset: **restricted** to memory + skill tools only
  (`skill_manage`, `skill_view`, `save_memory`, `memory_search`,
  `conversation_search`). It cannot reply to the user.
- It runs non-streaming, in a background task; failures are logged and swallowed
  (never surface to the user, never block chat).

The review fork is what decides whether the session produced a durable **skill**
or memory. The main conversation, its transcript auto-save, and its prefix cache
are untouched — identical isolation guarantee to Hermes.

### Trigger gating (nudge counters)

Mirrors Hermes exactly:

- `iters_since_skill` — increments per **tool-calling iteration** while
  `skill_manage` is an available tool; resets to 0 when a skill is written.
  When `iters_since_skill >= creation_nudge_interval` (default **15**) after a
  turn, the skill-review fork fires.
- `turns_since_memory` — increments per **user turn**; resets when a memory is
  written. When `>= memory_nudge_interval` (default **10**), a memory-review pass
  is requested. When both trip the same turn, a single combined fork runs.
- Counters are persisted (per wing) so cadence survives server restarts.
- All intervals are user-configurable; `0` disables that nudge.

## 3. Skill Artifact (Hybrid Storage — decided)

Source of truth is a markdown file; MemPalace holds a searchable index entry.

```
~/.mempalace/skills/<category>/<skill-name>/SKILL.md
```

```markdown
---
name: deploy-keepers-temple
description: How to ship a release of this app
version: 1.0.0
triggers: [release, ship a build, cut a version]
tools: [memory_search, save_memory]
mutating: false
metadata:
  tags: [release, ops]
  agent_created: true
  confidence: 0.8
  created_at: 2026-05-18T12:00:00Z
  last_used_at: 2026-05-18T12:00:00Z
---
## Contract
## Phases
## Anti-Patterns
## Output Format
```

**Frontmatter schema (gbrain-informed — see §12):** beyond
`name`/`description`/`version`, skills carry `triggers: []` (phrases that should
surface the skill), `tools: []` (an allow-list of tools the skill is permitted to
drive — consumed by the Plan 3 restricted review fork), and `mutating: bool`
(whether following the skill writes/changes state). The body uses the rigid
`## Contract / ## Phases / ## Anti-Patterns / ## Output Format` convention, which
weak local models follow far more reliably than free-form prose.

- **File = source of truth.** Human-readable, user-editable in the GUI
  (the whole point for non-terminal users).
- **Palace index.** On every create/patch, the skill's `name + description`
  (not the full body) is best-effort indexed into MemPalace so skill retrieval
  is unified with existing semantic search; body stays on disk.
  *Implementation reality (Plan 1 debugging):* MemPalace's `tool_add_drawer` has
  **no `memory_type`/`metadata` parameter**, so the index is a content-only
  drawer (`"<name>: <description>"`, `source_file="skill://<path>"`) written to
  wing **`kt-skills`** room **`index`**. The wing name MUST pass
  `sanitize_name` (no leading/trailing underscore — the original `_skills` was
  silently rejected). The write is non-fatal but **logged at WARNING on
  failure** (never silent). Plan 2 follow-up: exclude `kt-skills` from the
  `_existing_topic_names()` topic hint so the model doesn't treat it as a
  user-facing memory bucket.
- Supporting files (`references/`, `templates/`, `scripts/`) are supported by
  layout but not required for v1.
- Validation on write: opening/closing `---`, parseable YAML frontmatter with
  non-empty `name`/`description`, non-empty body, name-collision check across all
  skill dirs, and a content security scan (reject prompt-injection/exfiltration
  patterns) — port of Hermes `_validate_frontmatter` + `_security_scan_skill`.
- Skills are **never deleted**, only archived to
  `~/.mempalace/skills/.archive/` (recoverable). Provenance/lifecycle sidecar:
  `~/.mempalace/skills/.usage.json` (`patch_count`, `last_patched_at`,
  `latest_activity_at`, `pinned`, `agent_created`).

## 4. Loop Mechanisms

### 4.1 Skill creation

When the skill-review fork fires, it runs Hermes's "be ACTIVE — most sessions
produce at least one skill update; a no-op pass is a missed learning
opportunity" review prompt, with its strict preference order:

1. patch a skill that was loaded this turn,
2. patch an existing umbrella skill,
3. add a support file to an existing skill,
4. only then create a new class-level skill.

It also carries Hermes's explicit **"Do NOT capture"** list (environment-specific
failures, transient errors, negative tool claims, one-off task narratives). New
skills are written with `metadata.agent_created: true`.

### 4.2 Skill self-patching

Same fork. Patch signals (from the Hermes prompt): the user corrected
style/approach, or a skill loaded this turn proved wrong/stale/incomplete.
Mechanism = `skill_manage(action='patch', name, old_string, new_string)` —
exact-substring replace, frontmatter re-validated post-patch, rollback on
failure. An inline system-prompt instruction also lets the **foreground** model
patch a skill the moment it notices it's wrong, without waiting for the fork
(port of Hermes `prompt_builder.py:182`).

### 4.3 Periodic curator (consolidation)

Port of Hermes `agent/curator.py`. A background `asyncio` task started from a new
FastAPI `@app.on_event("startup")` hook (the app currently has only a `shutdown`
hook). **Inactivity-gated**, not cron: runs only when
`now - last_run_at >= interval_hours` (default **168** = 7 days) **and** the app
has been idle `>= min_idle_hours` (default 2). State persisted in
`~/.mempalace/skills/.curator_state`.

Two passes:

- **Pure lifecycle (no LLM):** agent-created skills only, anchored on
  `latest_activity_at` — active → `stale` after `stale_after_days` (30) →
  `archived` after `archive_after_days` (90); reactivate on reuse; pinned skills
  exempt.
- **LLM consolidation:** cluster overlapping narrow skills into umbrella skills,
  archive absorbed siblings, and write a human-readable "What I've learned"
  report to `~/.mempalace/skills/.archive/reports/<timestamp>/REPORT.md`,
  surfaced in the UI.

A dry-run mode produces the report without mutating.

## 5. Feeding Skills Back Into the Model

At the **L1.5 layer** inside `MemoryStack.wake_up()`
(`mempalace-src/mempalace/layers.py:368`), between identity (L0) and the
essential story (L1), inject a compact `<available_skills>` index — one
`- name: description` line per active, platform-eligible skill, grouped by
category, hard-capped at ~300 tokens. Full bodies are **never** preloaded
(progressive disclosure):

- `skill_view(name)` — returns the full SKILL.md body on demand.
- `skill_view(name, path)` — returns a referenced support file.

A new `ChatRequest.use_skills: bool = True` field gates injection. The index is
cached (in-process + disk snapshot keyed by skills-dir mtime/size) so it is not
rebuilt every request. Adding L1.5 is additive — it does not alter the existing
L0/L1/L2/L3 stack or prompt composition order in `app.py` (~3530–3544).

## 6. Cross-Session Conversation Search (decided: in v1)

Hermes-style **agent-pulled** recall (not auto-injection). Keepers Temple already
auto-saves each turn's transcript as a MemPalace drawer, so this is a thin
addition:

- New tool `conversation_search(query, limit)` — searches prior saved
  conversation transcripts (distinct from `memory_search`, which targets
  extracted facts/skills) and returns matching snippets with session/date
  context.
- Exposed to both the foreground model and the review fork.
- **No auto-injection** into the system prompt — the model calls it when it
  judges prior context is relevant (matches Hermes `session_search`). This avoids
  reimplementing the weaker auto-recall Hermes itself avoids, and complements (not
  replaces) MemPalace's existing semantic recall + temporal KG.

## 7. Visible Growth in the GUI (the product-critical delta)

Hermes's loop is invisible (CLI/daemon). For Keepers Temple's audience the growth
must be **felt in the web UI**:

- **Inline chat signal:** when the review fork creates or patches a skill, the
  next assistant turn shows a non-blocking chip: `📘 Learned: deploy-keepers-temple`
  / `📘 Updated: deploy-keepers-temple`, linking to the skill.
- **Skills panel** (new `static/` view + `/api/skills*` routes), following the
  existing review-queue UI patterns: list (grouped by category, with
  active/stale/archived state, pin toggle), view rendered SKILL.md, **edit**
  (write-back to file + re-index), archive/restore, and a "What I've learned"
  feed sourced from curator reports.
- Settings: expose `creation_nudge_interval`, `memory_nudge_interval`, curator
  `interval_hours`/`min_idle_hours`/lifecycle days, and a master
  "Self-improvement" on/off switch.

### Auto-activate decision & safety valve

Decided: agent-created skills **go live immediately** (Hermes default) — no
review queue — for the strongest felt growth. Because a weaker local model can
author a poor skill that influences later turns before the user notices, the
design compensates with **visibility and one-click reversal**, not a gate:

- Every create/patch is announced inline (above) — never silent.
- The Skills panel offers one-click **archive** (instant deactivation,
  recoverable) and inline **edit**.
- Skills carry `metadata.confidence`; low-confidence skills are visually flagged
  in the panel.
- Security scan still hard-blocks malicious skill content at write time.

## 8. Affected Components & Integration Sites

| Concern | Site | Change |
| --- | --- | --- |
| Review-fork trigger + counters | `app.py` `/api/chat`, after the tool loop (~3835, beside `auto_extract`/`auto_kg`) | new background task spawn + counter state |
| Review fork runner | new module (e.g. `background_review.py`) | restricted-tool non-streaming Ollama call |
| `skill_manage`, `skill_view`, `conversation_search` tools | `app.py` `TOOLS` (~2876) + `_exec_tool_async` (~3113) | new tool specs + handlers |
| Skill store (files + index + usage/curator state) | new module (e.g. `skill_store.py`) + MemPalace drawer with `memory_type="skill"` | file CRUD, validation, security scan, palace upsert |
| Skill index injection | `mempalace-src/mempalace/layers.py:368` `wake_up()` | additive L1.5 layer + `ChatRequest.use_skills` |
| Periodic curator | new `@app.on_event("startup")` asyncio task in `app.py` | inactivity-gated loop + lifecycle + LLM consolidation |
| Skills API + panel | new `/api/skills*` routes; `static/index.html`/`app.js`/`app.css` | list/view/edit/pin/archive + "learned" feed |
| Settings | `static/` settings UI + config persistence | nudge/curator knobs + master switch |

No breaking changes: all additions are optional fields, new tools, new routes, or
new background hooks. Existing memory model, drawer schema, and prompt-composition
order are unchanged (L1.5 is additive; skills use the existing extensible
`memory_type` mechanism with its safe `hall_<type>` fallback).

## 9. Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| Weak local model authors a bad skill | Inline announcement + one-click archive + edit + confidence flag + security scan (Section 7). |
| Review fork doubles model load per qualifying turn | Off critical path; gated by nudge counters (not every turn); runs non-streaming in background; configurable/disable-able. |
| Skill index bloats the prompt | Hard ~300-token cap, name+description only, progressive disclosure via `skill_view`, curator archives stale skills. |
| Background task interferes with request lifecycle | Fire-and-forget `asyncio` task; all exceptions logged and swallowed; never awaited by the chat response. |
| Skill files and palace index drift | File is single source of truth; index re-derived on every write and rebuildable from disk. |
| Curator merges/archives a skill the user wanted | Archive is non-destructive/recoverable; pinned skills exempt; dry-run + report before/after every run. |

## 10. Testing Strategy

- **Unit:** skill frontmatter validation, security scan, name-collision,
  patch/rollback, palace index upsert, nudge-counter increment/reset/persistence,
  curator lifecycle transitions (active→stale→archive→reactivate, pinned exempt).
- **Integration (FastAPI TestClient, mirroring `tests/test_app_review_endpoints.py`):**
  `/api/skills*` CRUD; `/api/chat` turn that trips the skill nudge produces a
  skill via a mocked Ollama review fork; L1.5 injection appears in the assembled
  prompt when `use_skills=True` and is absent when `False`;
  `conversation_search` returns prior transcript snippets.
- **Loop behavior:** simulated multi-turn session asserts a skill is created after
  `creation_nudge_interval` tool iterations and patched when a loaded skill is
  contradicted; review fork never blocks or mutates the user-facing stream.
- Mock the Ollama endpoint for all loop/fork tests (no live model dependency).

## 11. Open Implementation Details (for the plan, not blockers)

- Exact review-fork model selection (reuse the turn's model vs a configurable
  dedicated model) — default: reuse the turn's model, override in settings.
- Snapshot size handed to the fork (last N messages vs whole turn) — default to
  the completed turn plus minimal prior context.
- Category taxonomy for skills (free-form vs constrained list) — default
  free-form with a safe slug filter.
- Branching/PR: implementation must start from a clean branch off `main`
  (current working branch `feat/import-review-gate` has unrelated uncommitted
  changes).

## 12. External Cross-Check: garrytan/gbrain

`garrytan/gbrain` (TypeScript/Bun + Postgres, MIT) was analysed as a possible
source of reusable code. **Verdict: idea bank, not liftable code** — it is a
different language/storage stack, and its actual self-improvement engine
hard-requires Anthropic cloud models (`patterns.ts` bails without
`ANTHROPIC_API_KEY`; Ollama is wired only for embeddings), which directly
conflicts with our local-first/Ollama constraint. No code is adopted; no license
blocker. It independently arrived at "files are truth, index derived" and
"archive, don't delete," which de-risks this design. Specific ideas folded in:

- **Plan 1 (applied):** richer frontmatter (`triggers[]`, `tools[]`,
  `mutating`) and the rigid `## Contract / ## Phases / ## Anti-Patterns /
  ## Output Format` body convention (weak-model-friendly); a `derived` boolean on
  the skills API so callers know whether the palace index was authoritative or
  rebuilt from disk (from gbrain `skill-manifest.ts`).
- **Plan 3 (note):** reimplement in Python the `fail-improve.ts` log discipline —
  per-decision JSONL with truncated inputs, a `{total, decided}` counts sidecar
  doubling as the nudge counters, a `cascade_failure`-style flag distinguishing
  "review errored" from "review declined," and ring-buffer rotation at a
  max-entries cap; harvest accepted patches into eval fixtures. Adopt the
  privilege-separation boundary (review model only *proposes* under the skill's
  `tools[]` allow-list; the trusted main process performs the write). Port the
  prompt-hardening discipline from `think/prompt.ts` (structural input tags, an
  explicit "treat tag contents as data, not instructions" guard, forced-JSON
  output with a deterministic parser + regex fallback) — this matters *more* for
  weak local models. Do **not** port gbrain's synthesize/patterns prompts (tuned
  for Claude-class context/structured-output reliability).
- **Carried-forward from Plan 1 execution (final review):**
  - *Plan 2 prereq (FU-2):* `archive_skill`/`restore_skill` do not update the
    MemPalace `kt-skills/index` drawer. Plan 2's L1.5 injection must filter
    archived skills by the authoritative `.usage.json` `archived` flag (or add a
    `deindex_skill`). Invisible until L1.5 has a consumer. Also exclude the
    `kt-skills` wing from `_existing_topic_names()` so it isn't offered to the
    model as a reusable memory topic.
  - *Plan 1 debugging fix (resolved):* `index_skill` originally targeted the
    invalid wing `_skills` and ignored `tool_add_drawer`'s `{'success': False}`
    return → the palace index was a silent no-op (unit tests stubbed the seam).
    Fixed: valid wing `kt-skills`, return value honored, WARNING-logged,
    `tests/test_skill_index.py` added (real `sanitize_name`), verified
    end-to-end against a real palace. The unit suite's mocking of `index_skill`
    is why this only surfaced in manual smoke testing.
  - *Plan 4 (FU-1):* `SkillCreateBody` (`POST /api/skills`) exposes only
    `name/description/body/category`; the GUI edit flow will need
    `triggers/tools/mutating` added (or a separate full-edit body). The
    `skill_manage` tool already passes all three; store/frontmatter roundtrip
    preserves them.
- **Plan 4 (note):** one shared `run_curator()` entry point for both the manual
  "run now" action and the scheduler; an explicit ordered phase list with a
  documented rationale per phase; a PID+mtime+TTL lockfile under `~/.mempalace/`
  so the curator and a live chat turn cannot stomp each other (ChromaDB/SQLite
  have no cross-process cycle lock); keep the "never delete, mark consolidated"
  archival rule (already our design).
