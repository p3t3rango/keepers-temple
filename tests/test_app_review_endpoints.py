"""Tests for the /api/review and /api/questions FastAPI endpoints."""

import os
import sys
import tempfile

import pytest

# Redirect HOME before any app imports so PendingStore() defaults land in tmp.
_TMP_HOME = tempfile.mkdtemp(prefix="kt_review_endpoints_")
os.environ["HOME"] = _TMP_HOME
os.environ["USERPROFILE"] = _TMP_HOME

# Make the repo root importable so `import app` resolves.
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)
_MEMPALACE_SRC = os.path.join(_REPO_ROOT, "mempalace-src")
if _MEMPALACE_SRC not in sys.path:
    sys.path.insert(0, _MEMPALACE_SRC)

from fastapi.testclient import TestClient  # noqa: E402

import app as app_module  # noqa: E402
from mempalace.pending_store import PendingStore  # noqa: E402


@pytest.fixture
def client():
    return TestClient(app_module.app)


@pytest.fixture(autouse=True)
def _clean_pending():
    """Reset the default pending store between tests."""
    store = PendingStore()
    # Wipe both tables by deleting the DB file — simplest reset.
    store.close()
    try:
        os.remove(store.db_path)
    except FileNotFoundError:
        pass
    # Also drop WAL sidecars.
    for suffix in ("-wal", "-shm"):
        try:
            os.remove(store.db_path + suffix)
        except FileNotFoundError:
            pass
    yield


def _seed_pending(**kw) -> str:
    store = PendingStore()
    return store.add_pending_drawer(
        content=kw.get("content", "seeded content"),
        proposed_wing=kw.get("wing", "personal"),
        proposed_room=kw.get("room", "general"),
        memory_type=kw.get("memory_type"),
        keyword_score=kw.get("keyword_score", 2.0),
        source_conversation=kw.get("source", "seed.json"),
    )


def _seed_question(**kw) -> str:
    store = PendingStore()
    return store.add_pending_question(
        question=kw.get("question", "Which one?"),
        context=kw.get("context"),
        proposed_answers=kw.get("answers", ["yes", "no"]),
        blocks_pending_ids=kw.get("blocks", []),
        source_conversation=kw.get("source", "seed.json"),
    )


def test_review_list_returns_pending_items(client):
    pid = _seed_pending(content="pending-A", source="conv1.json")
    r = client.get("/api/review")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["id"] == pid


def test_review_sources_groups_by_conversation(client):
    _seed_pending(source="a.json")
    _seed_pending(source="a.json")
    _seed_pending(source="b.json")
    r = client.get("/api/review/sources")
    assert r.status_code == 200
    sources = {s["source"]: s["n"] for s in r.json()["sources"]}
    assert sources == {"a.json": 2, "b.json": 1}


def test_review_reject_marks_drawer_rejected(client):
    pid = _seed_pending()
    r = client.post(f"/api/review/{pid}/reject")
    assert r.status_code == 200
    assert r.json()["ok"] is True

    r2 = client.get("/api/review")
    assert r2.json()["total"] == 0

    # Rejecting again should 409.
    r3 = client.post(f"/api/review/{pid}/reject")
    assert r3.status_code == 409


def test_review_reject_unknown_id_returns_404(client):
    r = client.post("/api/review/does-not-exist/reject")
    assert r.status_code == 404


def test_review_edit_updates_fields(client):
    pid = _seed_pending(content="original", wing="personal", room="general")
    r = client.post(
        f"/api/review/{pid}/edit",
        json={"content": "edited", "wing": "work", "room": "planning"},
    )
    assert r.status_code == 200

    store = PendingStore()
    item = store.get_pending(pid)
    assert item["content"] == "edited"
    assert item["proposed_wing"] == "work"
    assert item["proposed_room"] == "planning"


def test_review_edit_rejects_invalid_wing_name(client):
    pid = _seed_pending()
    r = client.post(f"/api/review/{pid}/edit", json={"wing": "bad//name"})
    assert r.status_code == 400


def test_questions_list_and_answer_flow(client):
    qid = _seed_question(question="Which Kai?", answers=["Same", "Different"])
    r = client.get("/api/questions")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["id"] == qid
    assert body["items"][0]["proposed_answers"] == ["Same", "Different"]

    r2 = client.post(f"/api/questions/{qid}/answer", json={"answer": "Same"})
    assert r2.status_code == 200

    # Listing again is empty; answering again 409s.
    assert client.get("/api/questions").json()["total"] == 0
    r3 = client.post(f"/api/questions/{qid}/answer", json={"answer": "Different"})
    assert r3.status_code == 409


def test_question_skip_flow(client):
    qid = _seed_question()
    r = client.post(f"/api/questions/{qid}/skip")
    assert r.status_code == 200
    assert client.get("/api/questions").json()["total"] == 0


def test_review_bulk_reject_clears_a_conversation(client):
    _seed_pending(source="one.json")
    _seed_pending(source="one.json")
    _seed_pending(source="two.json")

    r = client.post(
        "/api/review/bulk",
        json={"source": "one.json", "action": "reject"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["rejected"] == 2
    assert body["accepted"] == 0
    assert body["errors"] == []

    # Only the "two.json" item remains.
    remaining = client.get("/api/review").json()
    assert remaining["total"] == 1
    assert remaining["items"][0]["source_conversation"] == "two.json"


def test_review_bulk_rejects_invalid_action(client):
    r = client.post("/api/review/bulk", json={"source": "x", "action": "bogus"})
    assert r.status_code == 400
