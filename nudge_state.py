"""Per-wing nudge counters with atomic JSON persistence.

Counters mirror Hermes `agent/conversation_loop.py` semantics:
  iters_since_skill  — tool-call iterations since last skill write
  turns_since_memory — user turns since last memory write

Reset by the chat handler when it detects the corresponding write in a turn.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

STATE_PATH = Path(os.path.expanduser("~/.mempalace/skills/.nudge_state.json"))
_VALID_KEYS = ("iters_since_skill", "turns_since_memory")


def _load_all() -> dict:
    try:
        return json.loads(STATE_PATH.read_text())
    except FileNotFoundError:
        return {}
    except Exception:
        # Corrupt file is treated as empty; never propagate to the chat path.
        return {}


def _atomic_write(data: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        prefix=".nudge.", dir=str(STATE_PATH.parent), suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
        os.replace(tmp, STATE_PATH)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load(wing: str) -> dict:
    """Return the wing's counter dict (missing wing -> all zeros)."""
    state = _load_all()
    wing_state = state.get(wing) or {}
    return {k: int(wing_state.get(k, 0)) for k in _VALID_KEYS}


def bump(wing: str, key: str) -> int:
    """Increment one counter for one wing; returns the new value."""
    if key not in _VALID_KEYS:
        raise ValueError(f"unknown nudge counter: {key!r}")
    state = _load_all()
    wing_state = state.setdefault(wing, {})
    new_val = int(wing_state.get(key, 0)) + 1
    wing_state[key] = new_val
    _atomic_write(state)
    return new_val


def reset(wing: str, key: str) -> None:
    """Zero one counter for one wing."""
    if key not in _VALID_KEYS:
        raise ValueError(f"unknown nudge counter: {key!r}")
    state = _load_all()
    wing_state = state.setdefault(wing, {})
    wing_state[key] = 0
    _atomic_write(state)
