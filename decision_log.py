"""Append-only decision log for the background review fork.

Port of `gbrain/agent/fail-improve.ts` adapted to Python:
  - JSONL records per decision (one line per turn that reached the fork)
  - {total, decided, noop, errored} counts sidecar (cheap to read)
  - cascade_failure flag distinguishes "review errored" from "review declined"
  - ring-buffer rotation: keep the last MAX_ENTRIES lines on disk

Read-mostly file; we never lock — concurrent writes from background tasks are
rare (one per chat turn) and the truncation rewrite happens at append-time.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import logging

logger = logging.getLogger(__name__)

LOG_DIR = Path(os.path.expanduser("~/.mempalace/skills"))
LOG_PATH = LOG_DIR / ".decisions.jsonl"
COUNTS_PATH = LOG_DIR / ".decisions.counts.json"
INPUT_TRUNCATE_CHARS = 2000  # mirrors fail-improve.ts cap
MAX_ENTRIES = 500            # ring buffer


def _truncate_inputs(rec: dict) -> dict:
    out = dict(rec)
    for k in ("input_truncated", "raw_review_output"):
        v = out.get(k)
        if isinstance(v, str) and len(v) > INPUT_TRUNCATE_CHARS:
            out[k] = v[:INPUT_TRUNCATE_CHARS]
    return out


def _load_counts() -> dict:
    try:
        c = json.loads(COUNTS_PATH.read_text())
        for k in ("total", "decided", "noop", "errored"):
            c.setdefault(k, 0)
        return c
    except FileNotFoundError:
        return {"total": 0, "decided": 0, "noop": 0, "errored": 0}
    except Exception:
        logger.warning(
            "decision_log: corrupt counts JSON at %s, resetting",
            COUNTS_PATH, exc_info=True,
        )
        return {"total": 0, "decided": 0, "noop": 0, "errored": 0}


def _atomic_write(path: Path, data: str) -> None:
    # Mirror of nudge_state._atomic_write — keep both in sync on bugfix.
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".log.", dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _bump_counts(decision: str) -> None:
    c = _load_counts()
    c["total"] += 1
    if decision == "errored":
        c["errored"] += 1
    elif decision == "noop":
        c["noop"] += 1
    else:
        c["decided"] += 1
    _atomic_write(COUNTS_PATH, json.dumps(c, indent=2, sort_keys=True))


def _append_line_with_rotation(line: str) -> None:
    # O(N) per append (reads then rewrites the whole file). Acceptable for
    # MAX_ENTRIES=500 short JSON lines; switch to truncate-only-on-overflow
    # if ever raised >> 5k.
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        existing = LOG_PATH.read_text().splitlines()
    except FileNotFoundError:
        existing = []
    existing.append(line)
    if len(existing) > MAX_ENTRIES:
        existing = existing[-MAX_ENTRIES:]
    _atomic_write(LOG_PATH, "\n".join(existing) + "\n")


def append(record: dict) -> None:
    """Write one decision record + bump counts. Never raises into the caller."""
    rec = _truncate_inputs(record)
    line = json.dumps(rec, sort_keys=True)
    try:
        _append_line_with_rotation(line)
    except Exception:
        # Last-resort: best-effort, swallow disk errors.
        logger.warning(
            "decision_log: line append failed", exc_info=True
        )
        return
    try:
        _bump_counts(str(rec.get("decision", "noop")))
    except Exception:
        logger.warning(
            "decision_log: counts bump failed", exc_info=True
        )
        return
