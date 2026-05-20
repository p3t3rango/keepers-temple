"""Unit tests for nudge_state (per-wing counters)."""

import json
import os
import sys
import tempfile

import pytest

_TMP_HOME = tempfile.mkdtemp(prefix="kt_nudge_")
os.environ["HOME"] = _TMP_HOME
os.environ["USERPROFILE"] = _TMP_HOME

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
for p in (_REPO_ROOT, os.path.join(_REPO_ROOT, "mempalace-src")):
    if p not in sys.path:
        sys.path.insert(0, p)

import nudge_state as ns  # noqa: E402


@pytest.fixture(autouse=True)
def _clean(tmp_path, monkeypatch):
    monkeypatch.setattr(ns, "STATE_PATH", tmp_path / "nudge.json")
    yield


def test_load_empty_returns_zero_counters():
    s = ns.load("personal")
    assert s == {"iters_since_skill": 0, "turns_since_memory": 0}


def test_increment_persists_across_loads():
    ns.bump(wing="personal", key="iters_since_skill")
    ns.bump(wing="personal", key="iters_since_skill")
    ns.bump(wing="work", key="turns_since_memory")
    again = ns.load("personal")
    assert again["iters_since_skill"] == 2
    assert again["turns_since_memory"] == 0
    assert ns.load("work")["turns_since_memory"] == 1


def test_reset_zeros_only_named_key():
    ns.bump(wing="personal", key="iters_since_skill")
    ns.bump(wing="personal", key="turns_since_memory")
    ns.reset(wing="personal", key="iters_since_skill")
    s = ns.load("personal")
    assert s["iters_since_skill"] == 0
    assert s["turns_since_memory"] == 1


def test_atomic_write_does_not_corrupt_on_partial_failure(monkeypatch, tmp_path):
    # Simulate an os.replace failure halfway through; the original file must survive.
    ns.bump(wing="personal", key="iters_since_skill")
    good = json.loads(ns.STATE_PATH.read_text())

    def _boom(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(ns.os, "replace", _boom)
    with pytest.raises(OSError):
        ns.bump(wing="personal", key="iters_since_skill")
    # Original file unchanged
    assert json.loads(ns.STATE_PATH.read_text()) == good
