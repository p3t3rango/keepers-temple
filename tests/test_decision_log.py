"""Unit tests for decision_log (fail-improve port)."""

import json
import os
import sys
import tempfile
from datetime import datetime, timezone

import pytest

_TMP_HOME = tempfile.mkdtemp(prefix="kt_declog_")
os.environ["HOME"] = _TMP_HOME
os.environ["USERPROFILE"] = _TMP_HOME

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import decision_log as dl  # noqa: E402


@pytest.fixture(autouse=True)
def _clean(tmp_path, monkeypatch):
    monkeypatch.setattr(dl, "LOG_DIR", tmp_path)
    monkeypatch.setattr(dl, "LOG_PATH", tmp_path / "decisions.jsonl")
    monkeypatch.setattr(dl, "COUNTS_PATH", tmp_path / "decisions.counts.json")
    yield


def test_append_writes_jsonl_line_and_bumps_counts():
    dl.append({
        "ts": datetime.now(timezone.utc).isoformat(),
        "wing": "personal",
        "trigger": "creation_nudge",
        "decision": "patch",
        "skill": "deploy-app",
        "input_truncated": "a" * 5000,
    })
    lines = dl.LOG_PATH.read_text().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    # Input must be truncated to <=2000 chars (mirror fail-improve cap)
    assert len(rec["input_truncated"]) <= dl.INPUT_TRUNCATE_CHARS
    counts = json.loads(dl.COUNTS_PATH.read_text())
    assert counts == {"total": 1, "decided": 1, "noop": 0, "errored": 0}


def test_counts_separate_noop_from_decided_from_errored():
    dl.append({"decision": "create", "wing": "p"})
    dl.append({"decision": "noop", "wing": "p"})
    dl.append({"decision": "errored", "wing": "p", "cascade_failure": True})
    counts = json.loads(dl.COUNTS_PATH.read_text())
    assert counts == {"total": 3, "decided": 1, "noop": 1, "errored": 1}


def test_ring_buffer_rotates_at_cap(monkeypatch):
    monkeypatch.setattr(dl, "MAX_ENTRIES", 5)
    for i in range(12):
        dl.append({"decision": "noop", "wing": "p", "i": i})
    lines = dl.LOG_PATH.read_text().splitlines()
    assert len(lines) == 5  # tail of 5
    # First-kept line should be i=7 (last 5 of 0..11 == 7..11)
    assert json.loads(lines[0])["i"] == 7
    assert json.loads(lines[-1])["i"] == 11
    # Counts are NOT truncated — total accumulates monotonically.
    counts = json.loads(dl.COUNTS_PATH.read_text())
    assert counts["total"] == 12


def test_cascade_failure_flag_survives_roundtrip():
    dl.append({"decision": "errored", "cascade_failure": True, "wing": "p",
               "error": "timeout"})
    rec = json.loads(dl.LOG_PATH.read_text().splitlines()[0])
    assert rec["cascade_failure"] is True
    assert rec["decision"] == "errored"
