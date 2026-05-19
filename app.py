"""ollama-mempalace — local chat UI that wires Ollama models to MemPalace memory."""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from mempalace.config import MempalaceConfig, sanitize_name
from mempalace.general_extractor import extract_memories
from mempalace.layers import MemoryStack
from mempalace.mcp_server import (
    tool_add_drawer,
    tool_check_duplicate,
    tool_create_tunnel,
    tool_delete_drawer,
    tool_delete_tunnel,
    tool_diary_read,
    tool_diary_write,
    tool_follow_tunnels,
    tool_get_aaak_spec,
    tool_get_drawer,
    tool_kg_add,
    tool_kg_invalidate,
    tool_kg_query,
    tool_kg_stats,
    tool_kg_timeline,
    tool_list_drawers,
    tool_list_tunnels,
    tool_list_wings,
    tool_reconnect,
    tool_update_drawer,
)
from mempalace.palace import get_collection
from mempalace.searcher import search_memories

import mcp_client

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
DEFAULT_ROOM = "general"
DEFAULT_WING = "personal"
FACTS_ROOM = "hall_facts"
ATTACH_ROOM = "attachments"
MAX_ATTACH_BYTES = 5 * 1024 * 1024  # 5 MB
CHUNK_TARGET_CHARS = 1500

# Map general_extractor's memory_type → MemPalace hall room name.
# Anything missing falls back to "hall_facts".
HALL_FOR_MEMORY_TYPE = {
    "fact": "hall_facts",
    "preference": "hall_preferences",
    "decision": "hall_decisions",
    "discovery": "hall_discoveries",
    "event": "hall_events",
    "advice": "hall_advice",
    "warning": "hall_warnings",
    "instruction": "hall_instructions",
    "emotion": "hall_emotions",
    "identity": "hall_identity",
}

config = MempalaceConfig()
config.init()
PALACE_PATH = config.palace_path
Path(PALACE_PATH).mkdir(parents=True, exist_ok=True)

IDENTITY_PATH = Path(os.path.expanduser("~/.mempalace/identity.txt"))
PERSONAS_PATH = Path(os.path.expanduser("~/.mempalace/personas.json"))
AGENTS_PATH = Path(os.path.expanduser("~/.mempalace/agents.json"))

app = FastAPI(title="ollama-mempalace")
STATIC_DIR = Path(__file__).parent / "static"


class Message(BaseModel):
    role: str
    content: str
    # Optional list of base64-encoded images (no data: prefix). Forwarded to
    # vision-capable Ollama models via the `images` field on the message dict.
    images: Optional[list[str]] = None


class ChatRequest(BaseModel):
    model: str
    wing: str = DEFAULT_WING
    room: str = DEFAULT_ROOM
    messages: list[Message]
    use_memory: bool = True
    save_to_memory: bool = True
    auto_extract: bool = True
    use_identity: bool = True
    enable_tools: bool = False
    system_prompt: Optional[str] = None
    session_id: Optional[str] = None
    memory_limit: int = Field(default=5, ge=1, le=20)
    persona: Optional[str] = None
    # Context window handling. When True, the server auto-summarizes older
    # message pairs before sending if the prompt would exceed
    # context_budget_pct of the model's reported context window.
    auto_compact: bool = True
    context_budget_pct: float = Field(default=0.75, ge=0.3, le=0.95)
    keep_recent_turns: int = Field(default=6, ge=2, le=20)
    # When True, after each save runs a small LLM pass to extract S/P/O
    # triples from the exchange and writes them to the knowledge graph.
    # Costs an extra Ollama call per turn; off by default.
    auto_kg: bool = False
    auto_kg_model: Optional[str] = None  # falls back to req.model if unset


class WingRenameBody(BaseModel):
    new_name: str


class IdentityBody(BaseModel):
    text: str


class PersonaBody(BaseModel):
    name: str
    description: str = ""
    identity: str


class AgentBody(BaseModel):
    name: str
    description: str = ""
    system_prompt: str = ""
    model: str
    wing: Optional[str] = None
    use_memory: bool = True


class SpeakBody(BaseModel):
    text: str
    voice: Optional[str] = None
    rate: Optional[int] = None  # words per minute


class DrawerUpdate(BaseModel):
    content: Optional[str] = None
    wing: Optional[str] = None
    room: Optional[str] = None


class DupeCheckBody(BaseModel):
    content: str
    threshold: float = 0.9


class KgAddBody(BaseModel):
    subject: str
    predicate: str
    object: str
    valid_from: Optional[str] = None
    source_closet: Optional[str] = None


class KgInvalidateBody(BaseModel):
    subject: str
    predicate: str
    object: str
    ended: Optional[str] = None


class DiaryWriteBody(BaseModel):
    agent_name: str = "ollama-mempalace"
    entry: str
    topic: str = "general"


class TunnelCreateBody(BaseModel):
    source_wing: str
    source_room: str
    target_wing: str
    target_room: str
    label: str = ""


class ConvoImportBody(BaseModel):
    path: str
    limit: Optional[int] = None
    extract: Optional[str] = None  # "exchange" | "general"
    review: bool = True            # gate --extract general output via review queue


def _safe_collection():
    try:
        return get_collection(PALACE_PATH, create=False)
    except Exception:
        return None


@app.get("/")
async def root():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/sw.js")
async def service_worker():
    """Service worker must be served from the root scope (or with
    Service-Worker-Allowed header) for it to control / requests. Easier
    to just serve it from /sw.js."""
    return FileResponse(
        STATIC_DIR / "sw.js",
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/"},
    )


@app.get("/manifest.webmanifest")
async def manifest_root():
    return FileResponse(
        STATIC_DIR / "manifest.webmanifest",
        media_type="application/manifest+json",
    )


@app.get("/api/health")
async def health():
    return {"ok": True, "palace_path": PALACE_PATH, "ollama_host": OLLAMA_HOST}


@app.get("/api/models")
async def list_models():
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{OLLAMA_HOST}/api/tags")
            r.raise_for_status()
            data = r.json()
        names = [m.get("name") for m in data.get("models", []) if m.get("name")]
        return {"models": names}
    except Exception as e:
        raise HTTPException(502, f"Ollama unreachable at {OLLAMA_HOST}: {e}")


_MODEL_INFO_CACHE: dict[str, dict] = {}


@app.get("/api/model-info")
async def model_info(model: str):
    """Return basic model info from Ollama's /api/show. Cached per model."""
    if model in _MODEL_INFO_CACHE:
        return _MODEL_INFO_CACHE[model]
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                f"{OLLAMA_HOST}/api/show", json={"model": model}
            )
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        raise HTTPException(502, f"Ollama show failed: {e}")
    info = data.get("model_info", {}) or {}
    # Find context length — varies by architecture (e.g. qwen2.context_length)
    context_length = 4096  # safe default
    for k, v in info.items():
        if isinstance(v, int) and k.endswith(".context_length"):
            context_length = v
            break
    out = {
        "model": model,
        "context_length": context_length,
        "parameters": data.get("details", {}).get("parameter_size"),
        "quantization": data.get("details", {}).get("quantization_level"),
        "capabilities": data.get("capabilities", []),
    }
    _MODEL_INFO_CACHE[model] = out
    return out


@app.get("/api/models/installed")
async def installed_models():
    """Detailed list of installed Ollama models — name, size, digest, modified."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{OLLAMA_HOST}/api/tags")
            r.raise_for_status()
            data = r.json()
        return {"models": data.get("models", [])}
    except Exception as e:
        raise HTTPException(502, f"Ollama unreachable: {e}")


class ModelNameBody(BaseModel):
    name: str


@app.delete("/api/models/{name:path}")
async def delete_model(name: str):
    """Delete an installed Ollama model."""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.request(
                "DELETE",
                f"{OLLAMA_HOST}/api/delete",
                json={"name": name},
            )
        if r.status_code != 200:
            raise HTTPException(r.status_code, f"Ollama delete: {r.text[:300]}")
        # Bust caches
        _MODEL_INFO_CACHE.pop(name, None)
        return {"ok": True, "deleted": name}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Ollama unreachable: {e}")


@app.post("/api/models/pull")
async def pull_model(body: ModelNameBody):
    """Pull a model. Streams Ollama's progress events as SSE."""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "model name required")

    async def gen():
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "POST",
                    f"{OLLAMA_HOST}/api/pull",
                    json={"name": name, "stream": True},
                ) as r:
                    if r.status_code != 200:
                        body_text = (await r.aread()).decode("utf-8", "replace")
                        yield (
                            "data: "
                            + json.dumps(
                                {"type": "error", "message": f"Ollama {r.status_code}: {body_text[:300]}"}
                            )
                            + "\n\n"
                        )
                        return
                    async for line in r.aiter_lines():
                        if not line:
                            continue
                        try:
                            chunk = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        yield "data: " + json.dumps(chunk) + "\n\n"
                        if chunk.get("status") == "success":
                            return
        except Exception as e:
            yield (
                "data: "
                + json.dumps({"type": "error", "message": str(e)})
                + "\n\n"
            )

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/api/wings")
async def list_wings():
    col = _safe_collection()
    if col is None:
        return {"wings": []}
    try:
        all_meta = col.get(include=["metadatas"]).get("metadatas") or []
    except Exception as e:
        return {"wings": [], "error": str(e)}
    counts: dict[str, int] = {}
    for m in all_meta:
        w = (m or {}).get("wing", "unknown")
        counts[w] = counts.get(w, 0) + 1
    wings = [{"name": w, "drawer_count": c} for w, c in sorted(counts.items())]
    return {"wings": wings}


@app.patch("/api/wings/{old_name}")
async def rename_wing(old_name: str, body: WingRenameBody):
    try:
        new_name = sanitize_name(body.new_name, "new_name")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if new_name == old_name:
        return {"renamed": 0, "from": old_name, "to": new_name}
    col = _safe_collection()
    if col is None:
        raise HTTPException(404, "No palace yet")
    hits = col.get(where={"wing": old_name}, include=["metadatas", "documents"])
    ids = hits.get("ids") or []
    if not ids:
        raise HTTPException(404, f"Wing {old_name!r} has no drawers")
    new_metas = []
    for m in hits.get("metadatas") or []:
        nm = dict(m or {})
        nm["wing"] = new_name
        new_metas.append(nm)
    docs = hits.get("documents") or []
    col.upsert(ids=ids, documents=docs, metadatas=new_metas)
    return {"renamed": len(ids), "from": old_name, "to": new_name}


@app.delete("/api/wings/{name}")
async def delete_wing(name: str):
    col = _safe_collection()
    if col is None:
        raise HTTPException(404, "No palace yet")
    hits = col.get(where={"wing": name}, include=["metadatas"])
    ids = hits.get("ids") or []
    if not ids:
        raise HTTPException(404, f"Wing {name!r} has no drawers")
    col.delete(ids=ids)
    return {"deleted": len(ids), "wing": name}


def _safe_filename(name: str) -> str:
    return re.sub(r"[^\w.-]", "_", name)[:120] or "attachment"


def _chunk_text(text: str, target: int = CHUNK_TARGET_CHARS) -> list[str]:
    """Greedy paragraph-aware chunker. Falls back to hard splits for huge paragraphs."""
    paras = re.split(r"\n\s*\n", text)
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for p in paras:
        p = p.strip()
        if not p:
            continue
        if len(p) > target * 2:
            if current:
                chunks.append("\n\n".join(current))
                current, current_len = [], 0
            for i in range(0, len(p), target):
                chunks.append(p[i : i + target])
            continue
        if current_len + len(p) > target and current:
            chunks.append("\n\n".join(current))
            current, current_len = [p], len(p)
        else:
            current.append(p)
            current_len += len(p) + 2
    if current:
        chunks.append("\n\n".join(current))
    return chunks


@app.post("/api/wings/{wing}/attach")
async def attach_to_wing(wing: str, file: UploadFile = File(...)):
    try:
        wing = sanitize_name(wing, "wing")
    except ValueError as e:
        raise HTTPException(400, str(e))

    raw = await file.read()
    if len(raw) > MAX_ATTACH_BYTES:
        raise HTTPException(
            413,
            f"File is {len(raw)} bytes; max is {MAX_ATTACH_BYTES} bytes ({MAX_ATTACH_BYTES // 1024 // 1024} MB).",
        )
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(
            400,
            "File is not UTF-8 text. Only text files (txt, md, json, code, etc.) are supported in v1.",
        )
    text = text.strip()
    if not text:
        raise HTTPException(400, "File is empty.")

    chunks = _chunk_text(text)
    safe_name = _safe_filename(file.filename or "attachment")

    saved: list[str] = []
    errors: list[str] = []
    for i, chunk in enumerate(chunks):
        result = tool_add_drawer(
            wing=wing,
            room=ATTACH_ROOM,
            content=chunk,
            source_file=f"attachment://{safe_name}#{i}",
            added_by="ollama-mempalace-attach",
        )
        if result.get("success"):
            did = result.get("drawer_id")
            if did:
                saved.append(did)
        else:
            errors.append(result.get("error", "unknown"))

    return {
        "filename": file.filename,
        "stored_as": safe_name,
        "chunks": len(chunks),
        "saved": len(saved),
        "errors": errors,
    }


@app.get("/api/wings/{wing}/attachments")
async def list_attachments(wing: str):
    col = _safe_collection()
    if col is None:
        return {"attachments": []}
    try:
        hits = col.get(
            where={"$and": [{"wing": wing}, {"room": ATTACH_ROOM}]},
            include=["metadatas"],
        )
    except Exception as e:
        return {"attachments": [], "error": str(e)}
    counts: dict[str, int] = {}
    for m in hits.get("metadatas") or []:
        src = (m or {}).get("source_file", "") or ""
        if src.startswith("attachment://"):
            base = src.split("#", 1)[0].replace("attachment://", "")
            counts[base] = counts.get(base, 0) + 1
    return {
        "attachments": [
            {"filename": n, "chunks": c} for n, c in sorted(counts.items())
        ]
    }


@app.get("/api/stats")
async def palace_stats():
    col = _safe_collection()
    if col is None:
        return {"total": 0, "wings": {}, "rooms": {}, "palace_path": PALACE_PATH}
    try:
        all_meta = col.get(include=["metadatas"]).get("metadatas") or []
    except Exception as e:
        return {"total": 0, "wings": {}, "rooms": {}, "error": str(e)}
    wings: dict[str, int] = {}
    rooms: dict[str, int] = {}
    for m in all_meta:
        w = (m or {}).get("wing", "unknown")
        r = (m or {}).get("room", "unknown")
        wings[w] = wings.get(w, 0) + 1
        rooms[r] = rooms.get(r, 0) + 1
    try:
        total = col.count()
    except Exception:
        total = len(all_meta)
    return {
        "total": total,
        "wings": wings,
        "rooms": rooms,
        "palace_path": PALACE_PATH,
    }


@app.get("/api/taxonomy")
async def palace_taxonomy():
    col = _safe_collection()
    if col is None:
        return {"taxonomy": {}}
    try:
        all_meta = col.get(include=["metadatas"]).get("metadatas") or []
    except Exception as e:
        return {"taxonomy": {}, "error": str(e)}
    tax: dict[str, dict[str, int]] = {}
    for m in all_meta:
        w = (m or {}).get("wing", "unknown")
        r = (m or {}).get("room", "unknown")
        tax.setdefault(w, {})
        tax[w][r] = tax[w].get(r, 0) + 1
    return {"taxonomy": tax}


@app.get("/api/drawers")
async def list_drawers(
    wing: Optional[str] = None,
    room: Optional[str] = None,
    q: Optional[str] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
):
    col = _safe_collection()
    if col is None:
        return {"drawers": [], "total": 0, "offset": offset, "limit": limit}
    where = None
    conditions = []
    if wing:
        conditions.append({"wing": wing})
    if room:
        conditions.append({"room": room})
    if len(conditions) == 1:
        where = conditions[0]
    elif len(conditions) > 1:
        where = {"$and": conditions}

    try:
        kwargs = {"include": ["documents", "metadatas"]}
        if where:
            kwargs["where"] = where
        result = col.get(**kwargs)
    except Exception as e:
        return {"drawers": [], "total": 0, "error": str(e)}

    ids = result.get("ids") or []
    docs = result.get("documents") or []
    metas = result.get("metadatas") or []

    rows = []
    needle = (q or "").lower().strip()
    since_norm = (since or "").strip()
    until_norm = (until or "").strip()
    for i, did in enumerate(ids):
        doc = docs[i] if i < len(docs) else ""
        meta = metas[i] if i < len(metas) else {}
        if needle and needle not in doc.lower():
            continue
        filed_at = (meta or {}).get("filed_at", "") or ""
        # ISO timestamps sort correctly as strings
        if since_norm and filed_at and filed_at < since_norm:
            continue
        if until_norm and filed_at and filed_at > until_norm:
            continue
        rows.append(
            {
                "drawer_id": did,
                "wing": (meta or {}).get("wing", ""),
                "room": (meta or {}).get("room", ""),
                "source_file": (meta or {}).get("source_file", ""),
                "filed_at": (meta or {}).get("filed_at", ""),
                "added_by": (meta or {}).get("added_by", ""),
                "preview": doc[:300] + ("…" if len(doc) > 300 else ""),
                "length": len(doc),
            }
        )
    rows.sort(key=lambda r: r["filed_at"], reverse=True)
    total = len(rows)
    return {
        "drawers": rows[offset : offset + limit],
        "total": total,
        "offset": offset,
        "limit": limit,
    }


@app.get("/api/drawers/{drawer_id}")
async def get_drawer(drawer_id: str):
    return tool_get_drawer(drawer_id)


@app.patch("/api/drawers/{drawer_id}")
async def update_drawer(drawer_id: str, body: DrawerUpdate):
    return tool_update_drawer(
        drawer_id, content=body.content, wing=body.wing, room=body.room
    )


@app.delete("/api/drawers/{drawer_id}")
async def delete_drawer(drawer_id: str):
    return tool_delete_drawer(drawer_id)


class BulkIdsBody(BaseModel):
    ids: list[str]


class BulkMoveBody(BaseModel):
    ids: list[str]
    wing: str
    room: Optional[str] = None


@app.post("/api/drawers/bulk-delete")
async def bulk_delete_drawers(body: BulkIdsBody):
    if not body.ids:
        return {"deleted": 0, "errors": []}
    col = _safe_collection()
    if col is None:
        raise HTTPException(404, "No palace yet")
    try:
        # Fetch first so we know which IDs actually existed
        existing = col.get(ids=body.ids, include=["metadatas"])
    except Exception as e:
        raise HTTPException(500, str(e))
    found_ids = existing.get("ids") or []
    if not found_ids:
        return {"deleted": 0, "errors": ["no matching drawers"]}
    try:
        col.delete(ids=found_ids)
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"deleted": len(found_ids), "errors": []}


@app.post("/api/drawers/bulk-move")
async def bulk_move_drawers(body: BulkMoveBody):
    if not body.ids:
        return {"moved": 0, "errors": []}
    try:
        new_wing = sanitize_name(body.wing, "wing")
    except ValueError as e:
        raise HTTPException(400, str(e))
    new_room: Optional[str] = None
    if body.room:
        try:
            new_room = sanitize_name(body.room, "room")
        except ValueError as e:
            raise HTTPException(400, str(e))
    col = _safe_collection()
    if col is None:
        raise HTTPException(404, "No palace yet")
    try:
        existing = col.get(ids=body.ids, include=["metadatas", "documents"])
    except Exception as e:
        raise HTTPException(500, str(e))
    found_ids = existing.get("ids") or []
    metas = existing.get("metadatas") or []
    docs = existing.get("documents") or []
    if not found_ids:
        return {"moved": 0, "errors": ["no matching drawers"]}
    new_metas = []
    for m in metas:
        nm = dict(m or {})
        nm["wing"] = new_wing
        if new_room:
            nm["room"] = new_room
        new_metas.append(nm)
    try:
        col.upsert(ids=found_ids, documents=docs, metadatas=new_metas)
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"moved": len(found_ids), "errors": []}


@app.post("/api/check-duplicate")
async def check_dupe(body: DupeCheckBody):
    return tool_check_duplicate(body.content, body.threshold)


@app.get("/api/kg/stats")
async def kg_stats_endpoint():
    return tool_kg_stats()


@app.get("/api/kg/query")
async def kg_query_endpoint(
    entity: str,
    as_of: Optional[str] = None,
    direction: str = "both",
):
    return tool_kg_query(entity, as_of=as_of, direction=direction)


@app.get("/api/kg/timeline")
async def kg_timeline_endpoint(entity: Optional[str] = None):
    return tool_kg_timeline(entity=entity)


@app.post("/api/kg/add")
async def kg_add_endpoint(body: KgAddBody):
    return tool_kg_add(
        body.subject,
        body.predicate,
        body.object,
        valid_from=body.valid_from,
        source_closet=body.source_closet,
    )


@app.post("/api/kg/invalidate")
async def kg_invalidate_endpoint(body: KgInvalidateBody):
    return tool_kg_invalidate(
        body.subject, body.predicate, body.object, ended=body.ended
    )


@app.get("/api/diary")
async def diary_read_endpoint(agent_name: str = "ollama-mempalace", last_n: int = 20):
    return tool_diary_read(agent_name, last_n=last_n)


@app.post("/api/diary")
async def diary_write_endpoint(body: DiaryWriteBody):
    return tool_diary_write(body.agent_name, body.entry, topic=body.topic)


@app.get("/api/aaak-spec")
async def aaak_spec_endpoint():
    return tool_get_aaak_spec()


@app.post("/api/reconnect")
async def reconnect_endpoint():
    return tool_reconnect()


# ─── External MCP clients ─────────────────────────────────────────────────


class MCPClientBody(BaseModel):
    name: str
    command: str
    args: list[str] = []
    env: dict[str, str] = {}
    enabled: bool = True


@app.get("/api/mcp/clients")
async def mcp_list_clients():
    return {"clients": await mcp_client.status_snapshot()}


@app.post("/api/mcp/clients")
async def mcp_upsert_client(body: MCPClientBody):
    try:
        name = sanitize_name(body.name, "name")
    except ValueError as e:
        raise HTTPException(400, str(e))
    mcp_client.upsert(
        name=name,
        command=body.command,
        args=body.args,
        env=body.env,
        enabled=body.enabled,
    )
    return {"ok": True, "name": name}


@app.delete("/api/mcp/clients/{name}")
async def mcp_remove_client(name: str):
    if not mcp_client.remove(name):
        raise HTTPException(404, f"no MCP client {name!r}")
    return {"ok": True, "removed": name}


@app.post("/api/mcp/clients/{name}/probe")
async def mcp_probe_client(name: str):
    """Spawn (or reuse) the named MCP client and return its tools/resources."""
    client = mcp_client.get_registry().get(name)
    if not client:
        raise HTTPException(404, f"no MCP client {name!r}")
    try:
        if not client.is_running:
            await client.start()
    except Exception as e:
        return {
            "name": name,
            "ok": False,
            "error": str(e),
            "is_running": False,
            "tools": [],
            "resources": [],
        }
    return {
        "name": name,
        "ok": True,
        "is_running": client.is_running,
        "tools": [
            {"name": t.get("name"), "description": t.get("description", "")[:240]}
            for t in client.tools
        ],
        "resources": [
            {"uri": r.get("uri"), "name": r.get("name", "")}
            for r in client.resources
        ],
    }


@app.post("/api/mcp/clients/{name}/stop")
async def mcp_stop_client(name: str):
    client = mcp_client.get_registry().get(name)
    if not client:
        raise HTTPException(404, f"no MCP client {name!r}")
    await client.stop()
    return {"ok": True}


@app.on_event("shutdown")
async def _shutdown_mcp():
    await mcp_client.shutdown_all()


@app.post("/api/tunnels")
async def create_tunnel_endpoint(body: TunnelCreateBody):
    return tool_create_tunnel(
        body.source_wing,
        body.source_room,
        body.target_wing,
        body.target_room,
        label=body.label,
    )


@app.get("/api/tunnels")
async def list_tunnels_endpoint(wing: Optional[str] = None):
    return tool_list_tunnels(wing=wing)


@app.delete("/api/tunnels/{tunnel_id}")
async def delete_tunnel_endpoint(tunnel_id: str):
    return tool_delete_tunnel(tunnel_id)


@app.get("/api/tunnels/follow")
async def follow_tunnels_endpoint(wing: str, room: str):
    return tool_follow_tunnels(wing, room)


@app.get("/api/recall")
async def l2_recall_endpoint(
    wing: Optional[str] = None,
    room: Optional[str] = None,
    n: int = 10,
):
    """Layer 2 — on-demand retrieval scoped to wing/room."""
    try:
        stack = MemoryStack(palace_path=PALACE_PATH)
        text = stack.recall(wing=wing, room=room, n_results=n)
        return {
            "text": text,
            "tokens_estimate": len(text) // 4,
            "wing": wing,
            "room": room,
        }
    except Exception as e:
        return {"text": "", "tokens_estimate": 0, "error": str(e)}


# ── Memories tab endpoints (consumer-facing unified view) ────────────────


@app.get("/api/memories/topics")
async def memories_topics():
    """Topics (wings) with drawer counts. Used by the Memories filter."""
    try:
        result = tool_list_wings() or {}
        wings = result.get("wings") if isinstance(result, dict) else None
        if isinstance(wings, dict):
            items = [
                {"topic": str(k), "count": int(v)}
                for k, v in wings.items()
                if k and not str(k).startswith("_")
            ]
        else:
            items = []
        items.sort(key=lambda x: (-x["count"], x["topic"]))
        return {"topics": items, "total": sum(i["count"] for i in items)}
    except Exception as e:
        return {"topics": [], "total": 0, "error": str(e)}


@app.get("/api/memories/list")
async def memories_list(
    topic: Optional[str] = None,
    section: Optional[str] = None,
    limit: int = 30,
    offset: int = 0,
):
    """List drawers with full metadata (including filed_at timestamp)."""
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    col = _safe_collection()
    if col is None:
        return {"items": [], "total": 0}
    try:
        conditions = []
        if topic:
            conditions.append({"wing": topic})
        if section:
            conditions.append({"room": section})
        # Exclude the internal "_registry" sentinel room used by convo_miner.
        conditions.append({"room": {"$ne": "_registry"}})
        where = conditions[0] if len(conditions) == 1 else {"$and": conditions}

        # Fetch all matching (ChromaDB has no cheap count; we filter/paginate client side).
        full = col.get(include=["documents", "metadatas"], where=where)
        all_ids = full.get("ids") or []
        all_docs = full.get("documents") or []
        all_metas = full.get("metadatas") or []

        combined = []
        for i, did in enumerate(all_ids):
            meta = all_metas[i] or {}
            doc = all_docs[i] or ""
            combined.append((did, doc, meta))

        # Sort newest-first by filed_at.
        combined.sort(
            key=lambda t: str((t[2] or {}).get("filed_at") or ""),
            reverse=True,
        )
        page = combined[offset : offset + limit]
        items = []
        for did, doc, meta in page:
            items.append({
                "drawer_id": did,
                "wing": meta.get("wing", ""),
                "room": meta.get("room", ""),
                "content_preview": doc[:400] + ("…" if len(doc) > 400 else ""),
                "filed_at": meta.get("filed_at"),
                "added_by": meta.get("added_by"),
                "source_file": meta.get("source_file"),
                "origin": meta.get("origin"),
            })
        return {"items": items, "total": len(combined)}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/memories/search")
async def memories_search_endpoint(
    q: str,
    topic: Optional[str] = None,
    n: int = 15,
):
    q = q.strip()
    if not q:
        return {"items": [], "total": 0}
    try:
        result = search_memories(
            q,
            palace_path=PALACE_PATH,
            wing=topic or None,
            n_results=max(1, min(int(n), 50)),
        )
    except Exception as e:
        raise HTTPException(500, str(e))
    hits = result.get("results") or []
    return {
        "items": [
            {
                "drawer_id": h.get("drawer_id") or h.get("id"),
                "wing": h.get("wing"),
                "room": h.get("room"),
                "content_preview": (h.get("text") or "")[:800],
                "similarity": h.get("similarity"),
                "source_file": h.get("source_file"),
                "filed_at": h.get("filed_at") or h.get("added_at"),
            }
            for h in hits
        ],
        "total": len(hits),
    }


@app.delete("/api/memories/{drawer_id}")
async def memories_delete(drawer_id: str):
    try:
        result = tool_delete_drawer(drawer_id)
    except Exception as e:
        raise HTTPException(500, str(e))
    if result.get("success"):
        return {"ok": True, "drawer_id": drawer_id}
    raise HTTPException(500, result.get("error", "delete failed"))


@app.post("/api/palace/backup")
async def palace_backup():
    """Snapshot palace + pending + KG to ~/.mempalace/backups/palace-<ts>."""
    import shutil
    home = Path(os.path.expanduser("~"))
    base = home / ".mempalace"
    backup_root = base / "backups"
    backup_root.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    made = {}
    errors = []

    palace = base / "palace"
    if palace.exists():
        try:
            dest = backup_root / f"palace-{ts}"
            shutil.copytree(palace, dest)
            made["palace"] = str(dest)
        except Exception as e:
            errors.append(f"palace: {e}")

    for name in ("pending.sqlite3", "knowledge_graph.sqlite3"):
        src = base / name
        if src.exists():
            try:
                dest = backup_root / f"{Path(name).stem}-{ts}.sqlite3"
                shutil.copy2(src, dest)
                made[Path(name).stem] = str(dest)
            except Exception as e:
                errors.append(f"{name}: {e}")

    return {
        "ok": len(errors) == 0,
        "timestamp": ts,
        "created": made,
        "errors": errors,
    }


@app.get("/api/palace/backups")
async def palace_backups_list():
    """List existing snapshots. Newest first."""
    home = Path(os.path.expanduser("~"))
    root = home / ".mempalace" / "backups"
    if not root.is_dir():
        return {"backups": []}
    entries = []
    for p in root.iterdir():
        try:
            stat = p.stat()
        except OSError:
            continue
        entries.append({
            "name": p.name,
            "path": str(p),
            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            "size_bytes": stat.st_size if p.is_file() else None,
            "is_dir": p.is_dir(),
        })
    entries.sort(key=lambda d: d["modified"], reverse=True)
    return {"backups": entries}


class PalaceNukeBody(BaseModel):
    confirm: str


_NUKE_PHRASE = "WIPE MY MEMORY"


@app.post("/api/palace/nuke")
async def palace_nuke(body: PalaceNukeBody):
    """Wipe all drawers, knowledge-graph entities/triples, and pending queues.

    Guarded by an exact-match typed phrase so accidental clicks can't trigger it.
    Does NOT touch: identity, personas, agents, MCP configs, backups, chat
    sessions (those are client-side localStorage), or the disk snapshots under
    ~/.mempalace/backups/.
    """
    if body.confirm != _NUKE_PHRASE:
        raise HTTPException(
            400,
            f'typed confirmation does not match. expected exactly: "{_NUKE_PHRASE}"',
        )
    counts = {
        "drawers": 0,
        "kg_entities": 0,
        "kg_triples": 0,
        "pending_drawers": 0,
        "pending_questions": 0,
        "errors": [],
    }

    # 1. Drawers (ChromaDB)
    try:
        col = _safe_collection()
        if col is not None:
            got = col.get()
            all_ids = got.get("ids") or []
            if all_ids:
                col.delete(ids=all_ids)
                counts["drawers"] = len(all_ids)
    except Exception as e:
        counts["errors"].append(f"drawers: {e}")

    # 2. Knowledge graph (SQLite)
    try:
        from mempalace.knowledge_graph import KnowledgeGraph
        kg = KnowledgeGraph()
        with kg._lock:
            conn = kg._conn()
            counts["kg_triples"] = int(
                conn.execute("SELECT COUNT(*) FROM triples").fetchone()[0]
            )
            counts["kg_entities"] = int(
                conn.execute("SELECT COUNT(*) FROM entities").fetchone()[0]
            )
            conn.execute("DELETE FROM triples")
            conn.execute("DELETE FROM entities")
            conn.commit()
    except Exception as e:
        counts["errors"].append(f"kg: {e}")

    # 3. Pending store (SQLite)
    try:
        from mempalace.pending_store import PendingStore
        store = PendingStore()
        with store._lock:
            conn = store._conn()
            counts["pending_drawers"] = int(
                conn.execute("SELECT COUNT(*) FROM drawers_pending").fetchone()[0]
            )
            counts["pending_questions"] = int(
                conn.execute("SELECT COUNT(*) FROM questions_pending").fetchone()[0]
            )
            conn.execute("DELETE FROM drawers_pending")
            conn.execute("DELETE FROM questions_pending")
            conn.commit()
    except Exception as e:
        counts["errors"].append(f"pending: {e}")

    return {"ok": True, "counts": counts, "confirm_phrase": _NUKE_PHRASE}


@app.get("/api/palace/nuke-phrase")
async def palace_nuke_phrase():
    """Expose the required confirmation phrase to the UI (avoids hardcoding)."""
    return {"phrase": _NUKE_PHRASE}


class RenameTopicBody(BaseModel):
    from_topic: str
    to_topic: str


@app.post("/api/memories/rename-topic")
async def memories_rename_topic(body: RenameTopicBody):
    """Move every drawer from `from_topic` → `to_topic`.

    Effectively renames/merges a topic. Uses tool_update_drawer per drawer so
    the drawer_id is regenerated under the new wing and metadata stays
    consistent.
    """
    try:
        old = sanitize_name(body.from_topic, "from_topic")
        new = sanitize_name(body.to_topic, "to_topic")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if old == new:
        return {"ok": True, "moved": 0, "note": "same topic, no change"}

    moved = 0
    errors: list[dict] = []
    offset = 0
    page = 500
    while True:
        try:
            result = tool_list_drawers(wing=old, limit=page, offset=offset)
        except Exception as e:
            raise HTTPException(500, str(e))
        items = result.get("drawers") or []
        if not items:
            break
        ids = [it.get("drawer_id") for it in items if it.get("drawer_id")]
        for did in ids:
            try:
                r = tool_update_drawer(drawer_id=did, wing=new)
                if r.get("success"):
                    moved += 1
                else:
                    errors.append({"id": did, "error": r.get("error")})
            except Exception as e:
                errors.append({"id": did, "error": str(e)})
        if len(items) < page:
            break
        offset += page
    return {
        "ok": True,
        "from": old,
        "to": new,
        "moved": moved,
        "errors": errors,
    }


class MemoriesBulkDeleteBody(BaseModel):
    ids: Optional[list[str]] = None       # delete exactly these drawers
    topic: Optional[str] = None           # OR: delete all matching filter
    section: Optional[str] = None
    all_matching: bool = False            # must be True to accept filter mode


@app.post("/api/memories/bulk-delete")
async def memories_bulk_delete(body: MemoriesBulkDeleteBody):
    if body.ids:
        ids = list(body.ids)
    elif body.all_matching:
        # Filter mode: gather every drawer matching the filter, then delete.
        collected: list[str] = []
        offset = 0
        page = 500
        while True:
            try:
                result = tool_list_drawers(
                    wing=body.topic or None,
                    room=body.section or None,
                    limit=page,
                    offset=offset,
                )
            except Exception as e:
                raise HTTPException(500, str(e))
            items = result.get("drawers", []) or []
            if not items:
                break
            for it in items:
                did = it.get("drawer_id") or it.get("id")
                if did:
                    collected.append(did)
            if len(items) < page:
                break
            offset += page
        ids = collected
    else:
        raise HTTPException(
            400,
            "pass `ids` (list) or `all_matching: true` (with optional topic/section)",
        )

    deleted = 0
    errors: list[dict] = []
    for did in ids:
        try:
            result = tool_delete_drawer(did)
            if result.get("success"):
                deleted += 1
            else:
                errors.append({"id": did, "error": result.get("error", "unknown")})
        except Exception as e:
            errors.append({"id": did, "error": str(e)})
    return {"ok": True, "deleted": deleted, "requested": len(ids), "errors": errors}


# ── Drawer edit/move (used by the save chip 'change' button) ────────────


class DrawerMoveBody(BaseModel):
    topic: Optional[str] = None  # new wing
    section: Optional[str] = None  # new room
    content: Optional[str] = None


@app.post("/api/drawers/{drawer_id}/move")
async def drawers_move(drawer_id: str, body: DrawerMoveBody):
    wing = section = None
    if body.topic:
        try:
            wing = sanitize_name(body.topic, "topic")
        except ValueError as e:
            raise HTTPException(400, str(e))
    if body.section:
        try:
            section = sanitize_name(body.section, "section")
        except ValueError as e:
            raise HTTPException(400, str(e))
    if not (wing or section or body.content):
        raise HTTPException(400, "pass at least one of topic, section, content")
    try:
        result = tool_update_drawer(
            drawer_id=drawer_id,
            content=body.content,
            wing=wing,
            room=section,
        )
    except Exception as e:
        raise HTTPException(500, str(e))
    if result.get("success"):
        return {"ok": True, "drawer_id": drawer_id, "topic": wing, "section": section}
    raise HTTPException(500, result.get("error", "move failed"))


# ── Smart import: LLM-based wing classification ─────────────────────────


class ImportsPlanBody(BaseModel):
    path: str
    model: Optional[str] = None  # Ollama model — defaults to current chat model
    sample_size: int = 300       # cap convos sent to classifier (token safety)


class PlannedWing(BaseModel):
    name: str
    description: str = ""
    convo_ids: list[str] = Field(default_factory=list)


class ImportsCommitBody(BaseModel):
    path: str
    plan: list[PlannedWing]
    extract: Optional[str] = None  # "general" or None
    review: bool = True


def _classifier_prompt(convos: list, existing_wings: list) -> str:
    lines = []
    for c in convos:
        name = (c.get("name") or "").replace("\n", " ")[:120]
        summary = (c.get("summary") or "").replace("\n", " ")[:180]
        lines.append(f"{c['uuid']}: \"{name}\" — {summary}")
    existing_str = ", ".join(existing_wings) if existing_wings else "(none)"
    return (
        "You are organizing someone's chat history into WINGS — top-level "
        "buckets for their personal memory palace. Each wing is a broad "
        "domain (e.g. 'coding', 'personal-finance', 'creative-writing', "
        "'keepers-temple-work').\n\n"
        f"Existing wings in the user's palace (reuse these when a fit is "
        f"clear, only propose new ones when no existing wing matches): "
        f"{existing_str}\n\n"
        "Rules:\n"
        "- Group into 4–12 wings total. Fewer is better if possible.\n"
        "- Wing names MUST be short, lowercase, hyphen-separated "
        "  (e.g. 'coding-help'). No spaces, no apostrophes.\n"
        "- Every conversation must be assigned to exactly one wing.\n"
        "- Cluster by topic / domain, not by time.\n"
        "- A short wing description helps the user.\n\n"
        "Return JSON ONLY (no prose, no markdown) in this shape:\n"
        '{"wings": [{"name": "...", "description": "...", '
        '"convo_ids": ["..."]}]}\n\n'
        "Conversations:\n" + "\n".join(lines)
    )


async def _list_existing_wings() -> list[str]:
    col = _safe_collection()
    if col is None:
        return []
    try:
        got = col.get(include=["metadatas"])
    except Exception:
        return []
    seen = set()
    for m in got.get("metadatas") or []:
        w = (m or {}).get("wing")
        if w and not str(w).startswith("_"):
            seen.add(str(w))
    return sorted(seen)


def _parse_plan_json(raw: str) -> list[dict]:
    """Salvage JSON from an LLM response, with fallbacks for stray prose."""
    import re as _re
    txt = raw.strip()
    # Strip markdown fences if present
    if txt.startswith("```"):
        txt = _re.sub(r"^```(?:json)?\s*|\s*```$", "", txt, flags=_re.DOTALL)
    # Find first { ... } block
    start = txt.find("{")
    end = txt.rfind("}")
    if start == -1 or end == -1:
        raise ValueError(f"no JSON object in response (first 200 chars: {raw[:200]!r})")
    obj = json.loads(txt[start : end + 1])
    wings = obj.get("wings")
    if not isinstance(wings, list):
        raise ValueError("response has no 'wings' list")
    return wings


@app.post("/api/imports/plan/stream")
async def imports_plan_stream(body: ImportsPlanBody):
    """Same as /api/imports/plan but streams phase/progress events so the UI
    can show a real progress bar. Emits JSON lines prefixed with 'data: '
    (SSE style) for:
      - {"type":"phase", "label":..., "approx_total":N}
      - {"type":"progress", "bytes":N}
      - {"type":"done", "payload":{...}}        (terminal event, same shape as /plan)
      - {"type":"error", "message":...}          (terminal event)
    """
    from mempalace.export_scanner import scan_export

    async def generator():
        def event(obj):
            return f"data: {json.dumps(obj, default=str)}\n\n".encode()

        try:
            yield event({"type": "phase", "label": "Scanning export folder"})
            try:
                scan = scan_export(body.path)
            except ValueError as e:
                yield event({"type": "error", "message": str(e)})
                return

            if scan["format"] == "unknown" and not scan["convos"]:
                yield event({
                    "type": "error",
                    "message": "No conversations found. Pick a Claude data export folder or conversations.json.",
                })
                return

            convos = scan["convos"]
            sample = convos[: body.sample_size]
            existing = await _list_existing_wings()

            yield event({
                "type": "phase",
                "label": f"Found {len(convos)} conversations; preparing classifier prompt…",
            })

            model = body.model or os.environ.get("OLLAMA_DEFAULT_MODEL") or "gpt-oss:20b"
            try:
                async with httpx.AsyncClient(timeout=10.0) as c:
                    tags = (await c.get(f"{OLLAMA_HOST}/api/tags")).json()
                    available = [m["name"] for m in tags.get("models", [])]
                    if model not in available and available:
                        model = available[0]
            except Exception:
                pass

            prompt = _classifier_prompt(sample, existing)
            # Rough expected output size: ~25 chars per convo assignment + wing
            # metadata (~1-2KB). Used purely for the progress bar's scale.
            approx_total = max(1024, len(sample) * 30 + 2048)

            yield event({
                "type": "phase",
                "label": f"Classifying via {model}…",
                "approx_total": approx_total,
            })

            raw_chunks: list[str] = []
            bytes_so_far = 0
            try:
                async with httpx.AsyncClient(timeout=1200.0) as client:
                    async with client.stream(
                        "POST",
                        f"{OLLAMA_HOST}/api/chat",
                        json={
                            "model": model,
                            "messages": [{"role": "user", "content": prompt}],
                            "stream": True,
                            "format": "json",
                            "options": {"temperature": 0.2},
                        },
                    ) as r:
                        r.raise_for_status()
                        async for line in r.aiter_lines():
                            if not line.strip():
                                continue
                            try:
                                piece = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            msg = piece.get("message") or {}
                            chunk = msg.get("content") or ""
                            if chunk:
                                raw_chunks.append(chunk)
                                bytes_so_far += len(chunk.encode())
                                yield event({"type": "progress", "bytes": bytes_so_far})
                            if piece.get("done"):
                                break
            except httpx.HTTPError as e:
                yield event({"type": "error", "message": f"Ollama call failed: {e}"})
                return

            raw = "".join(raw_chunks)
            try:
                wings = _parse_plan_json(raw)
            except (ValueError, json.JSONDecodeError) as e:
                yield event({
                    "type": "error",
                    "message": f"classifier returned unparseable JSON: {e}. First 400 chars: {raw[:400]}",
                })
                return

            # Same normalization as the non-streaming endpoint
            sample_ids = {c["uuid"] for c in sample}
            assigned: dict[str, str] = {}
            normalized_wings: list[dict] = []
            for w in wings:
                name = str(w.get("name") or "").strip().lower().replace(" ", "-")
                if not name:
                    continue
                desc = str(w.get("description") or "").strip()
                ids = [str(i) for i in w.get("convo_ids") or [] if i]
                normalized_wings.append({"name": name, "description": desc, "convo_ids": []})
                for cid in ids:
                    if cid in sample_ids and cid not in assigned:
                        assigned[cid] = name
                        normalized_wings[-1]["convo_ids"].append(cid)

            missed = [c for c in sample if c["uuid"] not in assigned]
            if missed:
                fallback = next(
                    (w for w in normalized_wings if w["name"] in ("misc", "other", "uncategorized")),
                    None,
                )
                if not fallback:
                    fallback = {"name": "misc", "description": "Uncategorized", "convo_ids": []}
                    normalized_wings.append(fallback)
                for c in missed:
                    assigned[c["uuid"]] = fallback["name"]
                    fallback["convo_ids"].append(c["uuid"])

            overflow = [c for c in convos if c["uuid"] not in assigned]
            if overflow:
                def score(c, wing):
                    blob = (c.get("name", "") + " " + c.get("summary", "")).lower()
                    kw_src = (wing["name"].replace("-", " ") + " " + wing["description"]).lower()
                    kws = [t for t in kw_src.split() if len(t) > 3]
                    return sum(1 for t in kws if t in blob)
                fallback_wing = next(
                    (w for w in normalized_wings if w["name"] == "misc"),
                    normalized_wings[0] if normalized_wings else None,
                )
                for c in overflow:
                    best = None
                    best_s = 0
                    for w in normalized_wings:
                        s = score(c, w)
                        if s > best_s:
                            best = w
                            best_s = s
                    target = best or fallback_wing
                    if target:
                        target["convo_ids"].append(c["uuid"])
                        assigned[c["uuid"]] = target["name"]

            titles = {c["uuid"]: c["name"] for c in convos}
            summaries = {c["uuid"]: c["summary"] for c in convos}

            yield event({
                "type": "done",
                "payload": {
                    "path": scan["path"],
                    "format": scan["format"],
                    "convos_total": len(convos),
                    "metadata_files": scan["metadata_files"],
                    "skipped": scan["skipped"],
                    "existing_wings": existing,
                    "model_used": model,
                    "plan": normalized_wings,
                    "titles": titles,
                    "summaries": summaries,
                },
            })
        except Exception as e:
            yield event({"type": "error", "message": f"unexpected: {e}"})

    return StreamingResponse(generator(), media_type="text/event-stream")


@app.post("/api/imports/plan")
async def imports_plan(body: ImportsPlanBody):
    from mempalace.export_scanner import scan_export
    try:
        scan = scan_export(body.path)
    except ValueError as e:
        raise HTTPException(400, str(e))

    if scan["format"] == "unknown" and not scan["convos"]:
        raise HTTPException(
            400,
            "no conversations found. Make sure the folder is a Claude data export "
            "(should contain conversations.json).",
        )

    convos = scan["convos"]
    # Cap what we send to the LLM to avoid runaway context. If there are more
    # than sample_size, classify a sample to get wings, then bucket the rest
    # via string-match on the sample (simple + cheap).
    sample = convos[: body.sample_size]

    existing = await _list_existing_wings()

    model = body.model or os.environ.get("OLLAMA_DEFAULT_MODEL") or "gpt-oss:20b"
    # Try user's current preferred model first; fall back to first installed
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            tags = (await client.get(f"{OLLAMA_HOST}/api/tags")).json()
            available = [m["name"] for m in tags.get("models", [])]
            if model not in available and available:
                model = available[0]
    except Exception:
        pass

    prompt = _classifier_prompt(sample, existing)
    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            r = await client.post(
                f"{OLLAMA_HOST}/api/chat",
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": False,
                    "format": "json",
                    "options": {"temperature": 0.2},
                },
            )
            r.raise_for_status()
            raw = (r.json().get("message", {}) or {}).get("content", "")
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Ollama call failed: {e}")

    try:
        wings = _parse_plan_json(raw)
    except (ValueError, json.JSONDecodeError) as e:
        raise HTTPException(
            500,
            f"classifier returned unparseable JSON: {e}. Raw: {raw[:400]}",
        )

    # Normalize and repair: every sample convo must be assigned to exactly
    # one wing. Convos outside the sample get bucketed by matching their name
    # against known wing names + descriptions.
    sample_ids = {c["uuid"] for c in sample}
    assigned: dict[str, str] = {}  # convo_id -> wing_name
    normalized_wings: list[dict] = []
    for w in wings:
        name = str(w.get("name") or "").strip().lower().replace(" ", "-")
        if not name:
            continue
        desc = str(w.get("description") or "").strip()
        ids = [str(i) for i in w.get("convo_ids") or [] if i]
        normalized_wings.append({"name": name, "description": desc, "convo_ids": []})
        for cid in ids:
            if cid in sample_ids and cid not in assigned:
                assigned[cid] = name
                normalized_wings[-1]["convo_ids"].append(cid)

    # Force-assign any sample convo the LLM forgot into a fallback wing.
    missed = [c for c in sample if c["uuid"] not in assigned]
    if missed:
        fallback = next(
            (w for w in normalized_wings if w["name"] in ("misc", "other", "uncategorized")),
            None,
        )
        if not fallback:
            fallback = {"name": "misc", "description": "Uncategorized", "convo_ids": []}
            normalized_wings.append(fallback)
        for c in missed:
            assigned[c["uuid"]] = fallback["name"]
            fallback["convo_ids"].append(c["uuid"])

    # Bucket any overflow convos (if we capped via sample_size) by keyword-match
    # on their name/summary against the wing descriptions the LLM produced.
    overflow = [c for c in convos if c["uuid"] not in assigned]
    if overflow:
        def score(c, wing):
            blob = (c.get("name", "") + " " + c.get("summary", "")).lower()
            kw_src = (wing["name"].replace("-", " ") + " " + wing["description"]).lower()
            kws = [t for t in kw_src.split() if len(t) > 3]
            return sum(1 for t in kws if t in blob)

        fallback_wing = next(
            (w for w in normalized_wings if w["name"] == "misc"),
            normalized_wings[0] if normalized_wings else None,
        )
        for c in overflow:
            best = None
            best_s = 0
            for w in normalized_wings:
                s = score(c, w)
                if s > best_s:
                    best = w
                    best_s = s
            target = best or fallback_wing
            if target:
                target["convo_ids"].append(c["uuid"])
                assigned[c["uuid"]] = target["name"]

    # Build a title map for the UI.
    titles = {c["uuid"]: c["name"] for c in convos}
    summaries = {c["uuid"]: c["summary"] for c in convos}

    return {
        "path": scan["path"],
        "format": scan["format"],
        "convos_total": len(convos),
        "metadata_files": scan["metadata_files"],
        "skipped": scan["skipped"],
        "existing_wings": existing,
        "model_used": model,
        "plan": normalized_wings,
        "titles": titles,
        "summaries": summaries,
    }


@app.post("/api/imports/commit")
async def imports_commit(body: ImportsCommitBody):
    from mempalace.export_scanner import scan_export
    from mempalace.pending_store import PendingStore
    from mempalace.general_extractor import extract_memories
    from mempalace.miner import add_drawer as miner_add_drawer

    try:
        scan = scan_export(body.path)
    except ValueError as e:
        raise HTTPException(400, str(e))

    convos_by_id = {c["uuid"]: c for c in scan["convos"]}
    col = _safe_collection()
    if col is None and not (body.review and body.extract == "general"):
        raise HTTPException(500, "palace collection unavailable")

    store = None
    if body.review and body.extract == "general":
        store = PendingStore()

    total_committed = 0
    total_pending = 0
    per_wing = []
    for wing in body.plan:
        try:
            wing_name = sanitize_name(wing.name, "wing")
        except ValueError as e:
            raise HTTPException(400, f"wing '{wing.name}': {e}")
        committed = 0
        pending = 0
        for cid in wing.convo_ids:
            convo = convos_by_id.get(cid)
            if convo is None:
                continue
            text = convo["text"]
            source_conversation = f"{convo['name'][:60]} ({cid[:8]})"

            if body.extract == "general":
                chunks = extract_memories(text)
                if body.review and store is not None:
                    for ch in chunks:
                        store.add_pending_drawer(
                            content=ch["content"],
                            proposed_wing=wing_name,
                            proposed_room=ch.get("memory_type", "general"),
                            memory_type=ch.get("memory_type"),
                            keyword_score=ch.get("keyword_score"),
                            source_conversation=source_conversation,
                        )
                    pending += len(chunks)
                    continue
                else:
                    for idx, ch in enumerate(chunks):
                        miner_add_drawer(
                            collection=col,
                            wing=wing_name,
                            room=ch.get("memory_type", "general"),
                            content=ch["content"],
                            source_file=f"smart-import:{cid}",
                            chunk_index=idx,
                            agent="smart-import",
                        )
                        committed += 1
                    continue

            # Default mode: file the full transcript as one drawer per convo
            # (verbatim, no inference). Room = "chats" for clarity.
            miner_add_drawer(
                collection=col,
                wing=wing_name,
                room="chats",
                content=text,
                source_file=f"smart-import:{cid}",
                chunk_index=0,
                agent="smart-import",
            )
            committed += 1
        total_committed += committed
        total_pending += pending
        per_wing.append({
            "wing": wing_name,
            "committed": committed,
            "pending": pending,
            "convos": len(wing.convo_ids),
        })

    return {
        "ok": True,
        "total_committed": total_committed,
        "total_pending": total_pending,
        "per_wing": per_wing,
    }


class NativePickBody(BaseModel):
    kind: str = "any"  # "any" | "folder" | "file" — "any" lets the user pick either


# JavaScript for Automation script that opens a unified NSOpenPanel allowing
# either a folder OR a .json file. AppleScript's `choose folder` / `choose file`
# don't support this combo natively, but NSOpenPanel does.
_JXA_UNIFIED_PICKER = """
ObjC.import('AppKit');
const panel = $.NSOpenPanel.openPanel;
panel.setTitle('Pick a folder or JSON file to import');
panel.setPrompt('Choose');
panel.setCanChooseFiles(true);
panel.setCanChooseDirectories(true);
panel.setAllowsMultipleSelection(false);
panel.setCanCreateDirectories(false);
panel.setAllowedFileTypes($(['json']));
// Raise the dialog to the front (osascript often runs headless).
$.NSApp.activateIgnoringOtherApps(true);
const response = panel.runModal;
if (response == 1 && panel.URLs.count > 0) {
  panel.URLs.objectAtIndex(0).path.js;
} else {
  '__CANCELLED__';
}
""".strip()


@app.post("/api/fs/native-pick")
async def fs_native_pick(body: Optional[NativePickBody] = None):
    """Pop the native macOS picker. 'any' opens a unified NSOpenPanel where
    the user can choose either a folder or a JSON file from the same dialog.
    """
    if sys.platform != "darwin":
        raise HTTPException(
            501, "native picker is macOS-only; use the in-app Browse instead"
        )
    kind = (body.kind if body else "any").lower()

    if kind in ("any", "either", ""):
        args = ["osascript", "-l", "JavaScript", "-e", _JXA_UNIFIED_PICKER]
    elif kind == "file":
        script = (
            'try\n'
            '  set f to choose file with prompt "Pick a JSON export file" '
            'of type {"json", "public.json"}\n'
            '  POSIX path of f\n'
            'on error number -128\n'
            '  return "__CANCELLED__"\n'
            'end try'
        )
        args = ["osascript", "-e", script]
    else:  # folder
        script = (
            'try\n'
            '  set f to choose folder with prompt "Pick a folder to import"\n'
            '  POSIX path of f\n'
            'on error number -128\n'
            '  return "__CANCELLED__"\n'
            'end try'
        )
        args = ["osascript", "-e", script]

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
    except asyncio.TimeoutError:
        raise HTTPException(504, "native picker timed out (5 min)")
    if proc.returncode != 0:
        raise HTTPException(
            500, f"osascript failed: {(stderr or b'').decode().strip()}"
        )
    out = stdout.decode().strip()
    if out == "__CANCELLED__" or not out:
        return {"cancelled": True}
    if out.endswith("/") and out != "/":
        out = out[:-1]
    return {"path": out}


@app.get("/api/fs/browse")
async def fs_browse(path: Optional[str] = None):
    """Local directory browser for the import picker.

    Security: paths must resolve under the user's HOME. Symlinks that escape
    HOME are skipped. No hidden dirs unless explicitly navigated to (we just
    return them marked `hidden`).
    """
    home = os.path.expanduser("~")
    home_real = os.path.realpath(home)
    raw = path or home
    target = os.path.realpath(os.path.expanduser(raw))
    if not (target == home_real or target.startswith(home_real + os.sep)):
        raise HTTPException(400, "path must be under HOME")
    if not os.path.isdir(target):
        raise HTTPException(404, f"not a directory: {target}")

    entries = []
    try:
        with os.scandir(target) as it:
            for e in it:
                try:
                    if not e.is_dir(follow_symlinks=False):
                        continue
                    # Skip symlinks that escape HOME.
                    resolved = os.path.realpath(e.path)
                    if not (resolved == home_real or resolved.startswith(home_real + os.sep)):
                        continue
                except OSError:
                    continue
                entries.append({
                    "name": e.name,
                    "path": e.path,
                    "hidden": e.name.startswith("."),
                })
    except PermissionError:
        raise HTTPException(403, "permission denied")
    entries.sort(key=lambda d: (d["hidden"], d["name"].lower()))

    parent = os.path.dirname(target)
    can_go_up = target != home_real and (
        parent == home_real or parent.startswith(home_real + os.sep)
    )

    crumbs = []
    cursor = target
    while True:
        crumbs.append({"name": os.path.basename(cursor) or cursor, "path": cursor})
        if cursor == home_real:
            break
        parent_c = os.path.dirname(cursor)
        if parent_c == cursor:
            break
        if not (parent_c == home_real or parent_c.startswith(home_real + os.sep)):
            break
        cursor = parent_c
    crumbs.reverse()

    return {
        "path": target,
        "home": home_real,
        "parent": parent if can_go_up else None,
        "crumbs": crumbs,
        "entries": entries,
    }


@app.post("/api/wings/{wing}/import-convos")
async def import_convos(wing: str, body: ConvoImportBody):
    """Import a folder of conversation exports into the wing.

    Shells out to the mempalace CLI which handles all the format-specific
    parsing (Claude Code JSONL, ChatGPT JSON, Slack exports, plain text).
    """
    try:
        wing = sanitize_name(wing, "wing")
    except ValueError as e:
        raise HTTPException(400, str(e))
    convo_dir = os.path.expanduser(body.path)
    if not os.path.isdir(convo_dir):
        raise HTTPException(400, f"Not a directory: {convo_dir}")

    cmd = [
        sys.executable,
        "-m",
        "mempalace",
        "mine",
        convo_dir,
        "--mode",
        "convos",
        "--wing",
        wing,
    ]
    if body.limit:
        cmd.extend(["--limit", str(body.limit)])
    if body.extract:
        cmd.extend(["--extract", body.extract])
    if body.review and (body.extract == "general"):
        cmd.append("--review")

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=600
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "Mining timed out (10 min)")

    if result.returncode != 0:
        raise HTTPException(
            500,
            f"mempalace mine failed (rc={result.returncode}): "
            + (result.stderr or result.stdout)[-1500:],
        )

    pending_count = 0
    questions_count = 0
    try:
        from mempalace.pending_store import PendingStore
        store = PendingStore()
        pending_count = store.count_pending()
        questions_count = store.count_questions()
    except Exception:
        pass

    return {
        "ok": True,
        "wing": wing,
        "stdout_tail": result.stdout[-2000:],
        "pending_count": pending_count,
        "questions_count": questions_count,
    }


# ── Review gate: import-time staging for classified inferences ──────────
#
# Only populated when /api/wings/{wing}/import-convos runs with
# extract="general" + review=True. Runtime chat and verbatim mining are
# not affected.


class ReviewEditBody(BaseModel):
    content: Optional[str] = None
    wing: Optional[str] = None
    room: Optional[str] = None


class ReviewBulkBody(BaseModel):
    source: str
    action: str  # "accept" | "reject"


class QuestionAnswerBody(BaseModel):
    answer: str


def _pending_store():
    from mempalace.pending_store import PendingStore
    return PendingStore()


def _commit_pending_to_palace(item: dict, added_by: str = "mempalace-review") -> bool:
    """Write an approved pending drawer into ChromaDB via miner.add_drawer."""
    from mempalace.miner import add_drawer as miner_add_drawer
    col = _safe_collection()
    if col is None:
        raise HTTPException(500, "palace collection unavailable")
    source_file = item.get("source_conversation") or f"review:{item['id']}"
    miner_add_drawer(
        collection=col,
        wing=item["proposed_wing"],
        room=item["proposed_room"],
        content=item["content"],
        source_file=source_file,
        chunk_index=0,
        agent=added_by,
    )
    return True


@app.get("/api/review/sources")
async def review_sources():
    store = _pending_store()
    return {"sources": store.list_pending_sources()}


@app.get("/api/review")
async def review_list(
    source: Optional[str] = None, limit: int = 100, offset: int = 0
):
    store = _pending_store()
    return {
        "items": store.list_pending(limit=limit, offset=offset, source=source),
        "total": store.count_pending(source=source),
    }


@app.post("/api/review/{drawer_id}/accept")
async def review_accept(drawer_id: str):
    store = _pending_store()
    item = store.get_pending(drawer_id)
    if not item:
        raise HTTPException(404, "pending drawer not found")
    if item["status"] != "pending":
        raise HTTPException(409, f"drawer already {item['status']}")
    _commit_pending_to_palace(item)
    store.mark_approved(drawer_id)
    return {"ok": True, "id": drawer_id}


@app.post("/api/review/{drawer_id}/edit")
async def review_edit(drawer_id: str, body: ReviewEditBody):
    store = _pending_store()
    item = store.get_pending(drawer_id)
    if not item:
        raise HTTPException(404, "pending drawer not found")
    if item["status"] != "pending":
        raise HTTPException(409, f"drawer already {item['status']}")
    wing = body.wing
    room = body.room
    if wing:
        try:
            wing = sanitize_name(wing, "wing")
        except ValueError as e:
            raise HTTPException(400, str(e))
    if room:
        try:
            room = sanitize_name(room, "room")
        except ValueError as e:
            raise HTTPException(400, str(e))
    store.apply_edits(drawer_id, content=body.content, wing=wing, room=room)
    return {"ok": True, "id": drawer_id}


@app.post("/api/review/{drawer_id}/reject")
async def review_reject(drawer_id: str):
    store = _pending_store()
    item = store.get_pending(drawer_id)
    if not item:
        raise HTTPException(404, "pending drawer not found")
    if item["status"] != "pending":
        raise HTTPException(409, f"drawer already {item['status']}")
    store.mark_rejected(drawer_id)
    return {"ok": True, "id": drawer_id}


@app.post("/api/review/bulk")
async def review_bulk(body: ReviewBulkBody):
    if body.action not in ("accept", "reject"):
        raise HTTPException(400, "action must be 'accept' or 'reject'")
    store = _pending_store()
    ids = store.ids_for_source(body.source, status="pending")
    accepted = 0
    rejected = 0
    errors = []
    for drawer_id in ids:
        item = store.get_pending(drawer_id)
        if not item or item["status"] != "pending":
            continue
        try:
            if body.action == "accept":
                _commit_pending_to_palace(item)
                store.mark_approved(drawer_id)
                accepted += 1
            else:
                store.mark_rejected(drawer_id)
                rejected += 1
        except Exception as e:
            errors.append({"id": drawer_id, "error": str(e)})
    return {
        "ok": True,
        "source": body.source,
        "accepted": accepted,
        "rejected": rejected,
        "errors": errors,
    }


@app.get("/api/questions")
async def questions_list():
    store = _pending_store()
    items = store.list_questions()
    return {"items": items, "total": store.count_questions()}


@app.post("/api/questions/{question_id}/answer")
async def questions_answer(question_id: str, body: QuestionAnswerBody):
    store = _pending_store()
    q = store.get_question(question_id)
    if not q:
        raise HTTPException(404, "question not found")
    if q["status"] != "open":
        raise HTTPException(409, f"question already {q['status']}")
    store.mark_question_answered(question_id, body.answer)
    return {"ok": True, "id": question_id, "answer": body.answer}


@app.post("/api/questions/{question_id}/skip")
async def questions_skip(question_id: str):
    store = _pending_store()
    q = store.get_question(question_id)
    if not q:
        raise HTTPException(404, "question not found")
    if q["status"] != "open":
        raise HTTPException(409, f"question already {q['status']}")
    store.mark_question_skipped(question_id)
    return {"ok": True, "id": question_id}


@app.get("/api/recent")
async def recent_activity(limit: int = 20):
    col = _safe_collection()
    if col is None:
        return {"recent": []}
    try:
        result = col.get(include=["metadatas", "documents"])
    except Exception as e:
        return {"recent": [], "error": str(e)}
    ids = result.get("ids") or []
    metas = result.get("metadatas") or []
    docs = result.get("documents") or []
    rows = []
    for i, did in enumerate(ids):
        meta = metas[i] if i < len(metas) else {}
        doc = docs[i] if i < len(docs) else ""
        rows.append(
            {
                "drawer_id": did,
                "wing": (meta or {}).get("wing", ""),
                "room": (meta or {}).get("room", ""),
                "filed_at": (meta or {}).get("filed_at", ""),
                "added_by": (meta or {}).get("added_by", ""),
                "preview": doc[:200] + ("…" if len(doc) > 200 else ""),
            }
        )
    rows.sort(key=lambda r: r["filed_at"], reverse=True)
    return {"recent": rows[:limit]}


@app.delete("/api/chat-session/{session_id}")
async def delete_chat_session(session_id: str, drop_memories: bool = False):
    """Delete drawers tagged with this chat session's id.

    Default (drop_memories=False): no-op — chat sessions are client-side only,
    memories survive across session deletes. Pass `?drop_memories=true` for the
    old destructive behavior (still available as an explicit power-user move).
    """
    if not drop_memories:
        return {"deleted": 0, "session_id": session_id, "skipped": True}
    col = _safe_collection()
    if col is None:
        raise HTTPException(404, "No palace yet")
    try:
        result = col.get(include=["metadatas"])
    except Exception as e:
        raise HTTPException(500, str(e))
    ids = result.get("ids") or []
    metas = result.get("metadatas") or []
    matched = [
        ids[i]
        for i, m in enumerate(metas)
        if session_id
        and session_id in (((m or {}).get("source_file") or ""))
    ]
    if not matched:
        return {"deleted": 0, "session_id": session_id}
    try:
        col.delete(ids=matched)
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"deleted": len(matched), "session_id": session_id}


@app.delete("/api/wings/{wing}/attachments")
async def delete_attachment(wing: str, filename: str):
    col = _safe_collection()
    if col is None:
        raise HTTPException(404, "No palace yet")
    safe = _safe_filename(filename)
    try:
        hits = col.get(
            where={"$and": [{"wing": wing}, {"room": ATTACH_ROOM}]},
            include=["metadatas"],
        )
    except Exception as e:
        raise HTTPException(500, str(e))
    ids_all = hits.get("ids") or []
    metas = hits.get("metadatas") or []
    target_prefix = f"attachment://{safe}"
    matched = [
        ids_all[i]
        for i, m in enumerate(metas)
        if (m or {}).get("source_file", "").startswith(target_prefix)
    ]
    if not matched:
        raise HTTPException(404, f"No attachment {filename!r} in wing {wing!r}")
    col.delete(ids=matched)
    return {"deleted": len(matched), "filename": filename}


@app.get("/api/search")
async def debug_search(
    q: str,
    wing: Optional[str] = None,
    room: Optional[str] = None,
    n: int = 5,
):
    return search_memories(
        q, palace_path=PALACE_PATH, wing=wing, room=room, n_results=n
    )


@app.get("/api/identity")
async def get_identity():
    text = ""
    if IDENTITY_PATH.exists():
        text = IDENTITY_PATH.read_text(encoding="utf-8")
    return {"text": text, "path": str(IDENTITY_PATH)}


@app.put("/api/identity")
async def put_identity(body: IdentityBody):
    IDENTITY_PATH.parent.mkdir(parents=True, exist_ok=True)
    IDENTITY_PATH.write_text(body.text, encoding="utf-8")
    try:
        IDENTITY_PATH.chmod(0o600)
    except OSError:
        pass
    return {"ok": True, "bytes": len(body.text.encode("utf-8"))}


@app.delete("/api/identity")
async def delete_identity():
    if IDENTITY_PATH.exists():
        IDENTITY_PATH.unlink()
    return {"ok": True}


# ─── Sub-agents (delegation) ──────────────────────────────────────────────
# An "agent" is a callable specialist: a system prompt + model + optional
# wing scope. The primary chat agent (whatever model you're talking to)
# can call `delegate(agent_name, task)` to hand off a subtask. Sub-agents
# do NOT get the delegate tool themselves (no recursion).


def _read_agents() -> list[dict]:
    if not AGENTS_PATH.exists():
        return []
    try:
        data = json.loads(AGENTS_PATH.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return [a for a in data if isinstance(a, dict) and a.get("name")]
    except Exception:
        pass
    return []


def _write_agents(agents: list[dict]) -> None:
    AGENTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    AGENTS_PATH.write_text(
        json.dumps(agents, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    try:
        AGENTS_PATH.chmod(0o600)
    except OSError:
        pass


def _build_delegate_tool() -> Optional[dict]:
    """Build the delegate tool schema with the current agent registry baked
    into its description + enum. Returns None if no agents exist yet."""
    agents = _read_agents()
    if not agents:
        return None
    agent_names = [a["name"] for a in agents]
    descriptions = "\n".join(
        f"  - {a['name']}: {a.get('description') or 'no description'}"
        for a in agents
    )
    return {
        "type": "function",
        "function": {
            "name": "delegate",
            "description": (
                "Delegate a focused subtask to a specialized sub-agent. Each "
                "sub-agent has its own system prompt, model, and memory scope.\n\n"
                "Available agents:\n"
                + descriptions
                + "\n\nUse when:\n"
                "- The task is outside your specialty\n"
                "- A different model would be better suited\n"
                "- You want a focused single-turn answer without polluting this chat\n\n"
                "The sub-agent's full text reply will be returned to you. "
                "You can call this multiple times in a single turn."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "agent": {
                        "type": "string",
                        "enum": agent_names,
                        "description": "Name of the sub-agent to call.",
                    },
                    "task": {
                        "type": "string",
                        "description": "Plain-language task description for the sub-agent.",
                    },
                },
                "required": ["agent", "task"],
            },
        },
    }


async def _exec_delegate(agent_name: str, task: str) -> dict:
    """Run one round-trip with a sub-agent. Non-streaming, single-turn."""
    agents = {a["name"]: a for a in _read_agents()}
    agent = agents.get(agent_name)
    if not agent:
        return {"error": f"unknown agent: {agent_name!r}"}
    if not task or not task.strip():
        return {"error": "task required"}
    model = agent.get("model")
    if not model:
        return {"error": f"agent {agent_name!r} has no model configured"}

    messages: list[dict] = []
    sys_prompt = (agent.get("system_prompt") or "").strip()
    if sys_prompt:
        messages.append({"role": "system", "content": sys_prompt})

    # Optionally inject memory from the agent's wing (or our default wing)
    if agent.get("use_memory", True):
        wing = agent.get("wing") or DEFAULT_WING
        try:
            result = search_memories(
                task, palace_path=PALACE_PATH, wing=wing, n_results=5
            )
            hits = result.get("results", []) or []
            block = _format_memory_block(hits)
            if block:
                messages.append({"role": "system", "content": block})
        except Exception:
            pass

    messages.append({"role": "user", "content": task})

    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            r = await client.post(
                f"{OLLAMA_HOST}/api/chat",
                json={"model": model, "messages": messages, "stream": False},
            )
            if r.status_code != 200:
                return {"error": f"Ollama {r.status_code}: {r.text[:300]}"}
            data = r.json()
    except Exception as e:
        return {"error": str(e)}

    msg = data.get("message", {}) or {}
    return {
        "agent": agent_name,
        "task": task,
        "model": model,
        "response": (msg.get("content") or "").strip(),
        "thinking": (msg.get("thinking") or "").strip() or None,
    }


@app.get("/api/agents")
async def list_agents():
    return {"agents": _read_agents()}


@app.post("/api/agents")
async def create_agent(body: AgentBody):
    try:
        name = sanitize_name(body.name, "agent name")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if name == "delegate":
        raise HTTPException(400, "'delegate' is a reserved name")
    agents = _read_agents()
    if any(a["name"] == name for a in agents):
        raise HTTPException(409, f"agent {name!r} already exists")
    new = {
        "name": name,
        "description": body.description or "",
        "system_prompt": body.system_prompt or "",
        "model": body.model,
        "wing": body.wing,
        "use_memory": body.use_memory,
    }
    agents.append(new)
    _write_agents(agents)
    return new


@app.put("/api/agents/{old_name}")
async def update_agent(old_name: str, body: AgentBody):
    try:
        new_name = sanitize_name(body.name, "agent name")
    except ValueError as e:
        raise HTTPException(400, str(e))
    agents = _read_agents()
    for i, a in enumerate(agents):
        if a["name"] == old_name:
            if new_name != old_name and any(
                x["name"] == new_name for x in agents
            ):
                raise HTTPException(409, f"agent {new_name!r} already exists")
            agents[i] = {
                "name": new_name,
                "description": body.description or "",
                "system_prompt": body.system_prompt or "",
                "model": body.model,
                "wing": body.wing,
                "use_memory": body.use_memory,
            }
            _write_agents(agents)
            return agents[i]
    raise HTTPException(404, f"agent {old_name!r} not found")


@app.delete("/api/agents/{name}")
async def delete_agent(name: str):
    agents = _read_agents()
    new = [a for a in agents if a["name"] != name]
    if len(new) == len(agents):
        raise HTTPException(404, f"agent {name!r} not found")
    _write_agents(new)
    return {"ok": True, "deleted": name}


# ─── Voice input (Whisper) ────────────────────────────────────────────────

WHISPER_MODELS = {
    "tiny.en": "mlx-community/whisper-tiny.en-mlx",
    "base.en": "mlx-community/whisper-base.en-mlx-q4",
    "small.en": "mlx-community/whisper-small.en-mlx-q4",
    "medium.en": "mlx-community/whisper-medium.en-mlx-q4",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
}


@app.post("/api/transcribe")
async def transcribe_endpoint(
    audio: UploadFile = File(...),
    model: str = "base.en",
):
    """Transcribe an uploaded audio blob (WAV recommended) via mlx-whisper."""
    repo = WHISPER_MODELS.get(model)
    if not repo:
        raise HTTPException(
            400, f"unknown whisper model {model!r}. one of: {list(WHISPER_MODELS)}"
        )

    raw = await audio.read()
    if not raw:
        raise HTTPException(400, "empty audio")
    if len(raw) > 50 * 1024 * 1024:
        raise HTTPException(413, "audio over 50MB cap")

    # Pick a sensible suffix so librosa/soundfile can sniff the format.
    ct = (audio.content_type or "").lower()
    if "wav" in ct or audio.filename and audio.filename.endswith(".wav"):
        suffix = ".wav"
    elif "webm" in ct:
        suffix = ".webm"
    elif "ogg" in ct:
        suffix = ".ogg"
    elif "mp3" in ct or "mpeg" in ct:
        suffix = ".mp3"
    else:
        suffix = ".wav"

    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        tmp.write(raw)
        tmp.flush()
        tmp.close()
        try:
            import mlx_whisper  # lazy import — heavy
        except ImportError as e:
            raise HTTPException(500, f"mlx-whisper not installed: {e}")
        try:
            result = mlx_whisper.transcribe(tmp.name, path_or_hf_repo=repo)
        except Exception as e:
            raise HTTPException(500, f"transcription failed: {e}")
        text = (result.get("text") or "").strip()
        return {
            "text": text,
            "language": result.get("language"),
            "model": model,
        }
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


# ─── Voice output (macOS `say`) ───────────────────────────────────────────


@app.get("/api/voices")
async def list_voices(lang_prefix: Optional[str] = "en"):
    """List available macOS TTS voices. Filter to a language prefix (default: en).

    No caching — `say -v ?` is cheap (~50ms) and caching meant newly installed
    Premium voices wouldn't show up until the server restarted.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "say", "-v", "?", stdout=asyncio.subprocess.PIPE
        )
        out, _ = await proc.communicate()
    except FileNotFoundError:
        raise HTTPException(500, "macOS `say` command not found")
    voices: list[dict] = []
    for raw in out.decode("utf-8", errors="replace").splitlines():
        # Format: "Name              lang_LL    # comment"
        line = raw.rstrip()
        if not line:
            continue
        # Find the language code (xx_YY) — split on it for robustness with
        # voices that have spaces in their names ("Bad News", "Eddy (German …)")
        m = re.search(r"\s+([a-z]{2}_[A-Z]{2})\s+", line)
        if not m:
            continue
        name = line[: m.start()].strip()
        lang = m.group(1)
        comment = line[m.end():].lstrip("# ").strip()
        voices.append({"name": name, "lang": lang, "sample": comment})
    if lang_prefix:
        voices = [v for v in voices if v["lang"].startswith(lang_prefix)]
    voices.sort(key=lambda v: v["name"])
    return {"voices": voices}


@app.post("/api/speak")
async def speak(body: SpeakBody):
    """Synthesize text via macOS `say` and return a WAV blob."""
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "empty text")
    if len(text) > 8000:
        # Cap so a runaway response can't tie up TTS forever
        text = text[:8000]

    voice = (body.voice or "Samantha").strip()
    # Sanitize: macOS voice names use letters, spaces, parens, accents.
    if any(c in voice for c in ("\n", "\r", "\x00")):
        raise HTTPException(400, "invalid voice name")

    aiff_fd, aiff_path = tempfile.mkstemp(suffix=".aiff")
    os.close(aiff_fd)
    wav_fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(wav_fd)

    try:
        say_args = ["say", "-v", voice, "-o", aiff_path]
        if body.rate and 80 <= body.rate <= 500:
            say_args += ["-r", str(body.rate)]
        say_args.append(text)
        proc = await asyncio.create_subprocess_exec(
            *say_args,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise HTTPException(500, f"say failed: {err.decode('utf-8', 'replace')[:200]}")

        # Convert AIFF → 16-bit mono PCM WAV @ 22050 Hz (broadly compatible)
        proc = await asyncio.create_subprocess_exec(
            "afconvert", "-f", "WAVE", "-d", "LEI16@22050", "-c", "1",
            aiff_path, wav_path,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise HTTPException(
                500, f"afconvert failed: {err.decode('utf-8', 'replace')[:200]}"
            )

        with open(wav_path, "rb") as f:
            data = f.read()
        return Response(content=data, media_type="audio/wav")
    finally:
        for p in (aiff_path, wav_path):
            try:
                os.unlink(p)
            except OSError:
                pass


# ─── Personas ─────────────────────────────────────────────────────────────
# personas.json holds *named* personas. The "default" persona is always
# present and reads its identity text from identity.txt — that's the file
# the welcome modal and Identity (Layer 0) editor in Settings already
# write to. Named personas live in personas.json with their own identity
# text and override the default identity when active for a session.


def _read_other_personas() -> list[dict]:
    if not PERSONAS_PATH.exists():
        return []
    try:
        data = json.loads(PERSONAS_PATH.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return [p for p in data if isinstance(p, dict) and p.get("name")]
    except Exception:
        pass
    return []


def _write_other_personas(personas: list[dict]) -> None:
    PERSONAS_PATH.parent.mkdir(parents=True, exist_ok=True)
    PERSONAS_PATH.write_text(
        json.dumps(personas, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    try:
        PERSONAS_PATH.chmod(0o600)
    except OSError:
        pass


def _all_personas() -> list[dict]:
    """List of every persona, with 'default' synthesized from identity.txt."""
    default_text = ""
    if IDENTITY_PATH.exists():
        default_text = IDENTITY_PATH.read_text(encoding="utf-8")
    default = {
        "name": "default",
        "description": "your main identity (Layer 0 — edited via Settings)",
        "identity": default_text,
        "is_default": True,
    }
    return [default, *_read_other_personas()]


def _identity_for_persona(persona_name: Optional[str]) -> str:
    name = persona_name or "default"
    for p in _all_personas():
        if p["name"] == name:
            return (p.get("identity") or "").strip()
    # Persona name was set but no matching persona — fall back to default
    return (_all_personas()[0].get("identity") or "").strip()


@app.get("/api/personas")
async def list_personas():
    return {"personas": _all_personas()}


@app.post("/api/personas")
async def create_persona(body: PersonaBody):
    try:
        name = sanitize_name(body.name, "persona name")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if name == "default":
        raise HTTPException(400, "use Settings → Identity to edit the default persona")
    personas = _read_other_personas()
    if any(p["name"] == name for p in personas):
        raise HTTPException(409, f"persona {name!r} already exists")
    new = {
        "name": name,
        "description": body.description or "",
        "identity": body.identity or "",
    }
    personas.append(new)
    _write_other_personas(personas)
    return new


@app.put("/api/personas/{old_name}")
async def update_persona(old_name: str, body: PersonaBody):
    if old_name == "default":
        raise HTTPException(400, "default persona is edited via Settings → Identity")
    try:
        new_name = sanitize_name(body.name, "persona name")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if new_name == "default":
        raise HTTPException(400, "cannot rename a persona to 'default'")
    personas = _read_other_personas()
    for i, p in enumerate(personas):
        if p["name"] == old_name:
            # Disallow rename collision
            if new_name != old_name and any(
                q["name"] == new_name for q in personas
            ):
                raise HTTPException(409, f"persona {new_name!r} already exists")
            personas[i] = {
                "name": new_name,
                "description": body.description or "",
                "identity": body.identity or "",
            }
            _write_other_personas(personas)
            return personas[i]
    raise HTTPException(404, f"persona {old_name!r} not found")


@app.delete("/api/personas/{name}")
async def delete_persona(name: str):
    if name == "default":
        raise HTTPException(400, "cannot delete the default persona")
    personas = _read_other_personas()
    new = [p for p in personas if p["name"] != name]
    if len(new) == len(personas):
        raise HTTPException(404, f"persona {name!r} not found")
    _write_other_personas(new)
    return {"ok": True, "deleted": name}


@app.get("/api/wakeup")
async def get_wakeup(wing: Optional[str] = None):
    try:
        stack = MemoryStack(palace_path=PALACE_PATH)
        text = stack.wake_up(wing=wing)
        return {"text": text, "tokens_estimate": len(text) // 4, "wing": wing}
    except Exception as e:
        return {"text": "", "tokens_estimate": 0, "wing": wing, "error": str(e)}


# ─── Tool calling (OpenAI-style schemas; Ollama forwards these verbatim) ────

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "memory_search",
            "description": (
                "Search the user's palace for prior memories relevant to a query. "
                "Call this BEFORE answering anything about the user's past "
                "conversations, preferences, projects, or people. "
                "Do not guess — verify by searching first."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language query to search for.",
                    },
                    "wing": {
                        "type": "string",
                        "description": "Optional wing to scope the search. Defaults to the current wing.",
                    },
                    "n": {
                        "type": "integer",
                        "description": "Max results to return (1-10). Default 5.",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kg_query",
            "description": (
                "Query the knowledge graph for what you know about an entity "
                "(a person, project, or thing). Returns typed, time-aware facts. "
                "Use this before claiming facts about someone or something."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "entity": {
                        "type": "string",
                        "description": "The entity name to query (e.g. 'Alex', 'dos-clone').",
                    },
                    "as_of": {
                        "type": "string",
                        "description": "Optional YYYY-MM-DD; only facts valid at this date.",
                    },
                },
                "required": ["entity"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kg_add",
            "description": (
                "Record a new fact in the knowledge graph as subject → predicate → object. "
                "Use when the user states a durable fact, preference, or decision "
                "(e.g. 'I prefer dark mode', 'Alex works at X')."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "subject": {"type": "string"},
                    "predicate": {
                        "type": "string",
                        "description": "snake_case relationship, e.g. 'works_on', 'prefers', 'lives_in'.",
                    },
                    "object": {"type": "string"},
                    "valid_from": {
                        "type": "string",
                        "description": "Optional YYYY-MM-DD when the fact became true.",
                    },
                },
                "required": ["subject", "predicate", "object"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kg_invalidate",
            "description": (
                "Mark a prior fact as no longer true (e.g. user used to prefer X, now prefers Y). "
                "Call with the OLD fact's subject/predicate/object to expire it, then kg_add the new fact."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "subject": {"type": "string"},
                    "predicate": {"type": "string"},
                    "object": {"type": "string"},
                    "ended": {
                        "type": "string",
                        "description": "Optional YYYY-MM-DD when the fact stopped being true.",
                    },
                },
                "required": ["subject", "predicate", "object"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "diary_write",
            "description": (
                "Write a short reflection to the agent's own journal. "
                "Use at natural breakpoints (after a meaningful exchange, when you learn "
                "something worth remembering, or when the user says 'remember this'). "
                "Keep entries brief and first-person."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "entry": {"type": "string"},
                    "topic": {
                        "type": "string",
                        "description": "Optional short tag (reflection, observation, todo, decision).",
                    },
                },
                "required": ["entry"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "save_memory",
            "description": (
                "File a note or quote into the user's palace under a topic and section. "
                "Call this when the user shares something worth remembering later — a "
                "decision, plan, preference, event, creative idea, personal detail, or "
                "any specific fact. Pick the best-fitting existing topic (see 'Existing "
                "topics' in the system prompt); only propose a NEW topic if no existing "
                "one fits. Use short, lowercase, hyphen-separated names."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "topic": {
                        "type": "string",
                        "description": "Top-level bucket (mempalace 'wing'). Lowercase, hyphenated. Examples: 'work', 'personal', 'keepers-temple', 'creative-writing'.",
                    },
                    "section": {
                        "type": "string",
                        "description": "Sub-bucket within the topic (mempalace 'room'). Lowercase, hyphenated. Examples: 'decisions', 'auth-migration', 'daily-journal'.",
                    },
                    "content": {
                        "type": "string",
                        "description": "The memory content. Prefer the user's own words verbatim when possible; distill only when they're lengthy.",
                    },
                },
                "required": ["topic", "section", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_topics",
            "description": (
                "List existing topics (wings) in the palace. Call this before proposing "
                "a new topic if you're not sure whether one already exists. Cheap to call."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
]

TOOL_PROTOCOL_BASE = (
    "You have tools available. Use them proactively and silently:\n"
    "- BEFORE answering about the user's past (preferences, people, projects, "
    "past decisions, events), call memory_search and/or kg_query FIRST. Never guess.\n"
    "- When the user shares something worth remembering later — a decision, plan, "
    "preference, event, creative idea, update, personal detail, or specific fact — "
    "call save_memory with a fitting topic + section. Prefer verbatim user words as "
    "the content. REUSE an existing topic when one fits (see list below); propose a "
    "new topic only when none match. Keep one save_memory call per distinct memory.\n"
    "- When the user states a durable structured fact (e.g. 'Alex works at X', "
    "'I prefer dark mode'), also call kg_add so the knowledge graph stays fresh.\n"
    "- When something the user said before has changed, call kg_invalidate on the "
    "old fact, then kg_add the new one.\n"
    "- After a meaningful exchange, optionally call diary_write with a brief "
    "first-person reflection.\n"
    "Never narrate 'I'm calling a tool' — your text reply should read naturally. "
    "If the user's message isn't worth saving (small talk, clarifying questions, "
    "confirmations), don't call save_memory.\n"
    "IMPORTANT: After any tool calls complete, ALWAYS produce a final text reply "
    "answering the user. Don't stop after just thinking or tool calls — the user "
    "needs to see a response.\n"
    "STYLE: Write like you're talking to a friend, not filing a report. Use "
    "second person ('you') and natural sentences. Weave facts into prose instead "
    "of dumping them as bold-label bullet points like 'Name: …'  'Profession: …'. "
    "A sentence like 'You're Pete — creative director and music producer running "
    "L.I.V. Corp.' beats a three-bullet fact sheet. Only structure with headings/"
    "bullets if the user explicitly asks for a summary or list."
)


def _existing_topic_names() -> list[str]:
    """List the wings that already have content. Shape from tool_list_wings:
    {'wings': {wing_name: drawer_count, ...}}.
    """
    try:
        result = tool_list_wings() or {}
        wings = result.get("wings") if isinstance(result, dict) else None
        if isinstance(wings, dict):
            names = list(wings.keys())
        elif isinstance(wings, list):
            names = [
                str(w.get("wing") or w.get("name") or "").strip()
                for w in wings if isinstance(w, dict)
            ]
        else:
            names = []
    except Exception:
        names = []
    return sorted({n for n in names if n and not n.startswith("_")})


def _build_tool_protocol() -> str:
    """Append a runtime list of existing topics so the LLM reuses them."""
    names = _existing_topic_names()
    if names:
        display = ", ".join(names[:40])
        return TOOL_PROTOCOL_BASE + f"\n\nExisting topics (reuse when possible): {display}"
    return TOOL_PROTOCOL_BASE + "\n\nExisting topics: (none yet — propose fitting new ones)"


TOOL_PROTOCOL = TOOL_PROTOCOL_BASE  # legacy; real protocol is built per-request below


async def _exec_tool_async(
    name: str, raw_args, current_wing: str, session_id: Optional[str]
) -> dict:
    """Async dispatcher — used by the chat handler. Routes:
    - mcp__* → external MCP registry
    - delegate → sub-agent
    - everything else → sync _exec_tool
    """
    if isinstance(raw_args, str):
        try:
            args = json.loads(raw_args) if raw_args.strip() else {}
        except json.JSONDecodeError:
            return {"error": f"invalid JSON arguments: {raw_args[:200]}"}
    elif isinstance(raw_args, dict):
        args = raw_args
    else:
        args = {}

    if name.startswith("mcp__"):
        return await mcp_client.dispatch_external(name, args)
    if name == "delegate":
        return await _exec_delegate(
            str(args.get("agent") or "").strip(),
            str(args.get("task") or "").strip(),
        )
    return _exec_tool(name, args, current_wing, session_id)


def _exec_tool(
    name: str, raw_args, current_wing: str, session_id: Optional[str]
) -> dict:
    """Dispatch a tool call. Returns a JSON-serializable dict."""
    if isinstance(raw_args, str):
        try:
            args = json.loads(raw_args) if raw_args.strip() else {}
        except json.JSONDecodeError:
            return {"error": f"invalid JSON arguments: {raw_args[:200]}"}
    elif isinstance(raw_args, dict):
        args = raw_args
    else:
        args = {}

    try:
        if name == "memory_search":
            q = str(args.get("query") or "").strip()
            if not q:
                return {"error": "query is required"}
            # If the LLM doesn't pass an explicit wing, search ALL wings —
            # it may be hunting for something save_memory filed under a
            # different wing than the chat's default.
            wing = args.get("wing") or None
            n = max(1, min(int(args.get("n", 5)), 10))
            result = search_memories(
                q, palace_path=PALACE_PATH, wing=wing, n_results=n
            )
            hits = result.get("results", []) or []
            return {
                "count": len(hits),
                "hits": [
                    {
                        "wing": h.get("wing"),
                        "room": h.get("room"),
                        "similarity": h.get("similarity"),
                        "text": (h.get("text") or "")[:600],
                    }
                    for h in hits
                ],
            }
        if name == "kg_query":
            entity = str(args.get("entity") or "").strip()
            if not entity:
                return {"error": "entity is required"}
            return tool_kg_query(entity, as_of=args.get("as_of"))
        if name == "kg_add":
            subj = str(args.get("subject") or "").strip()
            pred = str(args.get("predicate") or "").strip()
            obj = str(args.get("object") or "").strip()
            if not (subj and pred and obj):
                return {"error": "subject, predicate, object are all required"}
            return tool_kg_add(
                subj, pred, obj, valid_from=args.get("valid_from")
            )
        if name == "kg_invalidate":
            subj = str(args.get("subject") or "").strip()
            pred = str(args.get("predicate") or "").strip()
            obj = str(args.get("object") or "").strip()
            if not (subj and pred and obj):
                return {"error": "subject, predicate, object are all required"}
            return tool_kg_invalidate(subj, pred, obj, ended=args.get("ended"))
        if name == "diary_write":
            entry = str(args.get("entry") or "").strip()
            if not entry:
                return {"error": "entry is required"}
            return tool_diary_write(
                "ollama-mempalace",
                entry,
                topic=str(args.get("topic") or "general"),
            )
        if name == "save_memory":
            topic = str(args.get("topic") or "").strip().lower().replace(" ", "-")
            section = str(args.get("section") or "").strip().lower().replace(" ", "-")
            content = str(args.get("content") or "").strip()
            if not (topic and section and content):
                return {
                    "error": "topic, section, and content are all required",
                    "hint": "pick a short kebab-case topic (e.g. 'work') and section (e.g. 'decisions')",
                }
            try:
                topic = sanitize_name(topic, "topic")
                section = sanitize_name(section, "section")
            except ValueError as e:
                return {"error": f"invalid topic/section: {e}"}
            result = tool_add_drawer(
                wing=topic,
                room=section,
                content=content,
                source_file=(
                    f"chat-save://{session_id or 'no-session'}"
                    f"/{datetime.now().isoformat()}"
                ),
                added_by="ollama-mempalace-save_memory",
            )
            if result.get("success"):
                return {
                    "ok": True,
                    "topic": topic,
                    "section": section,
                    "drawer_id": result.get("drawer_id"),
                    "preview": content[:140],
                }
            return {"error": result.get("error", "unknown save error")}
        if name == "list_topics":
            names = _existing_topic_names()
            return {"topics": names, "count": len(names)}
        return {"error": f"unknown tool: {name}"}
    except Exception as e:
        return {"error": str(e)}


MAX_TOOL_ITERATIONS = 6


def _estimate_tokens(text: str) -> int:
    """Rough char-based token estimate. ~4 chars per token for English."""
    return max(1, len(text) // 4)


def _estimate_messages_tokens(messages: list[dict]) -> int:
    """Sum estimated tokens across a message list, accounting for content + images."""
    total = 0
    for m in messages:
        c = m.get("content") or ""
        total += _estimate_tokens(c) + 4  # 4-token overhead per message
        if m.get("images"):
            # Vision encoding cost varies wildly; rough overhead per image
            total += 600 * len(m["images"])
    return total


async def _summarize_messages(model: str, messages: list[dict]) -> str:
    """Ask the same model to summarize older messages. Returns plain text summary."""
    if not messages:
        return ""
    convo = "\n\n".join(
        f"{m.get('role', '?').upper()}: {m.get('content', '')}" for m in messages
    )
    prompt = (
        "Summarize the following conversation in under 300 words. "
        "Preserve all key facts, decisions, named people/projects, and any "
        "unresolved questions. Use bullet points. Don't add preamble.\n\n"
        f"{convo}"
    )
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(
                f"{OLLAMA_HOST}/api/chat",
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": False,
                },
            )
            r.raise_for_status()
            return (r.json().get("message", {}) or {}).get("content", "").strip()
    except Exception:
        return ""


async def _maybe_compact(
    req: ChatRequest, system_messages: list[dict], chat_messages: list[dict]
) -> tuple[list[dict], Optional[dict]]:
    """If the prompt would exceed budget, summarize older chat messages.

    Returns (possibly-compacted chat_messages, optional summary-event dict).
    System messages are NEVER compacted — only user/assistant turns.
    """
    if not req.auto_compact:
        return chat_messages, None
    try:
        info = await model_info(req.model)
        ctx = int(info.get("context_length") or 4096)
    except Exception:
        ctx = 4096
    budget = int(ctx * req.context_budget_pct)
    overhead = _estimate_messages_tokens(system_messages)
    body_tokens = _estimate_messages_tokens(chat_messages)
    if overhead + body_tokens <= budget:
        return chat_messages, None

    keep_recent = req.keep_recent_turns * 2  # user+assistant pairs
    if len(chat_messages) <= keep_recent + 1:
        return chat_messages, None  # nothing safe to compact

    older = chat_messages[:-keep_recent]
    recent = chat_messages[-keep_recent:]
    summary = await _summarize_messages(req.model, older)
    if not summary:
        return chat_messages, None  # summarization failed; send as-is

    summary_msg = {
        "role": "system",
        "content": (
            "Summary of earlier conversation (older turns were compacted to save "
            "context window):\n\n" + summary
        ),
    }
    new_chat = [summary_msg, *recent]
    saved = body_tokens - _estimate_messages_tokens(new_chat)
    event = {
        "type": "compacted",
        "summarized_turns": len(older),
        "kept_turns": len(recent),
        "tokens_saved_estimate": saved,
        "context_length": ctx,
    }
    return new_chat, event


def _format_memory_block(hits: list[dict]) -> str:
    if not hits:
        return ""
    parts = [
        "Here are things you've learned about this user from past conversations. "
        "Weave them into your reply naturally when relevant — don't echo the "
        "structure below. Never mention that this background exists. "
        "If these memories contradict the user's current question, prefer a "
        "fresh memory_search or ask the user — don't assume past assistant "
        "replies ('I don't have memories of you') are facts about them."
    ]
    usable = 0
    for h in hits:
        text = (h.get("text") or "").strip()
        if not text:
            continue
        sim = h.get("similarity")
        if isinstance(sim, (int, float)) and sim < 0.25:
            # Low-confidence hit — skip. These are more likely to mislead the
            # model than help it. Semantic-search floor chosen empirically.
            continue
        cleaned = text
        # Strip saved-transcript framing so the model doesn't re-quote its
        # own past replies as if they were user facts.
        if cleaned.startswith("User: "):
            cleaned = cleaned[6:]
        # Drop everything from "\n\nAssistant:" onward — the assistant's
        # prior reply isn't a fact about the user.
        asst_idx = cleaned.find("\n\nAssistant:")
        if asst_idx == -1:
            asst_idx = cleaned.find("\nAssistant:")
        if asst_idx != -1:
            cleaned = cleaned[:asst_idx].strip()
        if not cleaned:
            continue
        parts.append(f"- {cleaned}")
        usable += 1
    if usable == 0:
        return ""
    return "\n".join(parts)


async def _extract_kg_triples(model: str, transcript: str) -> list[dict]:
    """Use a small fast LLM to pull subject/predicate/object triples from a transcript."""
    prompt = (
        "Extract every durable fact from the following conversation. Output a "
        "JSON object with a single key 'triples' whose value is an array of "
        "{subject, predicate, object} triples.\n\n"
        "Include facts that are:\n"
        "- About specific named people, projects, products, places, or things\n"
        "- Stated as true (not asked, hypothesized, or denied)\n"
        "- Not obvious or trivial\n\n"
        "Be EXHAUSTIVE — if one sentence has 3 facts, emit 3 triples.\n\n"
        "Use snake_case predicates (works_on, prefers, lives_in, owns, decided, "
        "switched_to, started, finished, met, produces, founded, created).\n\n"
        "Output shape: {\"triples\": [{\"subject\":\"...\",\"predicate\":\"...\",\"object\":\"...\"}]}\n"
        "Empty list if nothing qualifies. No preamble, no markdown.\n\n"
        f"Conversation:\n{transcript}"
    )
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                f"{OLLAMA_HOST}/api/chat",
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": False,
                    "format": "json",
                },
            )
            r.raise_for_status()
            text = (r.json().get("message", {}) or {}).get("content", "").strip()
    except Exception:
        return []
    if not text:
        return []
    # Tolerate either {"triples": [...]} or [...] shape since some models wrap.
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # Try to find a JSON array inside the text
        m = re.search(r"\[.*\]", text, re.DOTALL)
        if not m:
            return []
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError:
            return []
    if isinstance(data, dict):
        # Common wrapping keys
        for k in ("triples", "facts", "results", "items"):
            if k in data and isinstance(data[k], list):
                data = data[k]
                break
        else:
            # Model returned a single triple as a flat dict — wrap it
            if all(k in data for k in ("subject", "predicate", "object")):
                data = [data]
            else:
                return []
    if not isinstance(data, list):
        return []
    out = []
    for t in data:
        if not isinstance(t, dict):
            continue
        s = str(t.get("subject", "")).strip()
        p = str(t.get("predicate", "")).strip()
        o = str(t.get("object", "")).strip()
        if not (s and p and o):
            continue
        out.append({"subject": s, "predicate": p, "object": o})
    return out


def _run_auto_extract(transcript: str, wing: str) -> list[dict]:
    """Extract facts from a transcript and file each as its own drawer.

    Default 0.3 confidence misses single-paragraph user turns; 0.15 catches
    typical "I prefer..." / "I decided..." statements without becoming noisy.
    """
    try:
        memories = extract_memories(transcript, min_confidence=0.15)
    except Exception:
        return []
    saved: list[dict] = []
    for m in memories:
        content = (m.get("content") or "").strip()
        if not content:
            continue
        mem_type = (m.get("memory_type") or "fact").strip().lower()
        room = HALL_FOR_MEMORY_TYPE.get(mem_type)
        if not room:
            candidate = f"hall_{mem_type}"
            room = candidate if re.match(r"^hall_[a-z_]+$", candidate) else FACTS_ROOM
        try:
            r = tool_add_drawer(
                wing=wing,
                room=room,
                content=content,
                source_file=f"extract://{datetime.now().isoformat()}",
                added_by="auto-extract",
            )
            if r.get("success"):
                saved.append({"room": room, "type": mem_type, "preview": content[:120]})
        except Exception:
            continue
    return saved


@app.post("/api/chat")
async def chat(req: ChatRequest):
    try:
        wing = sanitize_name(req.wing or DEFAULT_WING, "wing")
        room = sanitize_name(req.room or DEFAULT_ROOM, "room")
    except ValueError as e:
        raise HTTPException(400, str(e))

    last_user = next((m for m in reversed(req.messages) if m.role == "user"), None)

    memory_hits: list[dict] = []
    if req.use_memory and last_user:
        # When auto-filing is on, the LLM spreads memories across many wings,
        # so pre-turn recall must search cross-wing too. Only scope when tools
        # are off (classic dropdown flow).
        recall_wing = None if req.enable_tools else wing
        try:
            result = search_memories(
                last_user.content,
                palace_path=PALACE_PATH,
                wing=recall_wing,
                n_results=req.memory_limit,
            )
            memory_hits = result.get("results", []) or []
        except Exception:
            memory_hits = []

    out_messages: list[dict] = []

    # System prompts compose top-down: identity first, per-wing prompt next, memory last.
    if req.use_identity:
        identity = _identity_for_persona(req.persona)
        if identity:
            out_messages.append({"role": "system", "content": identity})

    if req.system_prompt and req.system_prompt.strip():
        out_messages.append({"role": "system", "content": req.system_prompt.strip()})

    if req.enable_tools:
        out_messages.append({"role": "system", "content": _build_tool_protocol()})

    memory_block = _format_memory_block(memory_hits)
    if memory_block:
        out_messages.append({"role": "system", "content": memory_block})

    chat_msgs: list[dict] = []
    for m in req.messages:
        msg_dict: dict = {"role": m.role, "content": m.content}
        if m.images:
            msg_dict["images"] = m.images
        chat_msgs.append(msg_dict)

    # Compaction pass — only on chat messages, never on system prompts above.
    chat_msgs, compaction_event = await _maybe_compact(req, out_messages, chat_msgs)
    out_messages.extend(chat_msgs)

    async def generate():
        meta = {
            "type": "memory_hits",
            "wing": wing,
            "room": room,
            "hits": [
                {
                    "wing": h.get("wing"),
                    "room": h.get("room"),
                    "source": h.get("source_file"),
                    "similarity": h.get("similarity"),
                    "preview": (h.get("text") or "")[:400],
                }
                for h in memory_hits
            ],
        }
        yield f"data: {json.dumps(meta)}\n\n"
        if compaction_event:
            yield f"data: {json.dumps(compaction_event)}\n\n"

        full_response = ""
        # Track whether the LLM filed the turn itself via save_memory so we
        # can skip the transcript auto-save below (avoid double-filing).
        llm_saves: list[dict] = []
        try:
            if req.enable_tools:
                # Tool-enabled turn: non-streaming loop so tool_calls arrive intact.
                async with httpx.AsyncClient(timeout=None) as client:
                    current = list(out_messages)
                    # Merge external MCP tools (best-effort — ignore broken servers)
                    try:
                        ext_tools = await mcp_client.all_external_tools()
                    except Exception:
                        ext_tools = []
                    delegate_tool = _build_delegate_tool()
                    combined_tools = TOOLS + ext_tools + (
                        [delegate_tool] if delegate_tool else []
                    )
                    for _ in range(MAX_TOOL_ITERATIONS):
                        r = await client.post(
                            f"{OLLAMA_HOST}/api/chat",
                            json={
                                "model": req.model,
                                "messages": current,
                                "tools": combined_tools,
                                "stream": False,
                            },
                        )
                        if r.status_code != 200:
                            try:
                                err = r.json().get("error") or r.text[:500]
                            except Exception:
                                err = r.text[:500]
                            yield (
                                "data: "
                                + json.dumps(
                                    {
                                        "type": "error",
                                        "message": f"Ollama {r.status_code}: {err}",
                                    }
                                )
                                + "\n\n"
                            )
                            return
                        data = r.json()
                        msg_out = (data or {}).get("message", {}) or {}
                        tool_calls = msg_out.get("tool_calls") or []
                        assistant_text = msg_out.get("content", "") or ""
                        thinking_text = msg_out.get("thinking", "") or ""
                        if thinking_text:
                            yield (
                                "data: "
                                + json.dumps(
                                    {"type": "thinking", "content": thinking_text}
                                )
                                + "\n\n"
                            )

                        if not tool_calls:
                            # Fallback: some models (Gemma) emit their entire
                            # final answer into the `thinking` channel and
                            # leave `content` empty. Treat thinking as the
                            # reply in that case so the user isn't stuck on
                            # an empty bubble.
                            if not assistant_text and thinking_text:
                                assistant_text = thinking_text
                            if not assistant_text:
                                assistant_text = (
                                    "_(model returned no reply — try a different model "
                                    "like qwen3.6 or gpt-oss, or turn off Auto-file memories "
                                    "in Settings → Conversation if you don't need tools)_"
                                )
                            full_response = assistant_text
                            yield (
                                "data: "
                                + json.dumps(
                                    {"type": "token", "content": assistant_text}
                                )
                                + "\n\n"
                            )
                            break

                        # Record the assistant's tool-call message in the history
                        current.append(
                            {
                                "role": "assistant",
                                "content": assistant_text,
                                "tool_calls": tool_calls,
                            }
                        )

                        for tc in tool_calls:
                            fn = (tc or {}).get("function") or {}
                            name = fn.get("name") or "unknown"
                            raw_args = fn.get("arguments")
                            yield (
                                "data: "
                                + json.dumps(
                                    {
                                        "type": "tool_call",
                                        "name": name,
                                        "arguments": raw_args,
                                    }
                                )
                                + "\n\n"
                            )
                            result = await _exec_tool_async(
                                name, raw_args, wing, req.session_id
                            )
                            if name == "save_memory" and isinstance(result, dict) and result.get("ok"):
                                llm_saves.append({
                                    "topic": result.get("topic"),
                                    "section": result.get("section"),
                                    "drawer_id": result.get("drawer_id"),
                                    "preview": result.get("preview"),
                                })
                            yield (
                                "data: "
                                + json.dumps(
                                    {
                                        "type": "tool_result",
                                        "name": name,
                                        "result": result,
                                    }
                                )
                                + "\n\n"
                            )
                            current.append(
                                {
                                    "role": "tool",
                                    "name": name,
                                    "content": json.dumps(result),
                                }
                            )
                    else:
                        # Hit iteration cap
                        yield (
                            "data: "
                            + json.dumps(
                                {
                                    "type": "error",
                                    "message": f"tool loop exceeded {MAX_TOOL_ITERATIONS} iterations",
                                }
                            )
                            + "\n\n"
                        )
            else:
                async with httpx.AsyncClient(timeout=None) as client:
                    async with client.stream(
                        "POST",
                        f"{OLLAMA_HOST}/api/chat",
                        json={
                            "model": req.model,
                            "messages": out_messages,
                            "stream": True,
                        },
                    ) as r:
                        if r.status_code != 200:
                            body = await r.aread()
                            try:
                                err = json.loads(body.decode("utf-8")).get(
                                    "error"
                                ) or body.decode("utf-8")[:500]
                            except Exception:
                                err = body.decode("utf-8", errors="replace")[:500]
                            yield (
                                "data: "
                                + json.dumps(
                                    {
                                        "type": "error",
                                        "message": f"Ollama {r.status_code}: {err}",
                                    }
                                )
                                + "\n\n"
                            )
                            return
                        async for line in r.aiter_lines():
                            if not line:
                                continue
                            try:
                                chunk = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            if chunk.get("error"):
                                yield (
                                    "data: "
                                    + json.dumps(
                                        {
                                            "type": "error",
                                            "message": f"Ollama: {chunk['error']}",
                                        }
                                    )
                                    + "\n\n"
                                )
                                return
                            msg = chunk.get("message", {}) or {}
                            thinking = msg.get("thinking", "")
                            if thinking:
                                yield (
                                    "data: "
                                    + json.dumps(
                                        {
                                            "type": "thinking",
                                            "content": thinking,
                                        }
                                    )
                                    + "\n\n"
                                )
                            token = msg.get("content", "")
                            if token:
                                full_response += token
                                yield f"data: {json.dumps({'type': 'token', 'content': token})}\n\n"
                            if chunk.get("done"):
                                break
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
            return

        saved_id: Optional[str] = None
        save_error: Optional[str] = None
        extracted_facts: list[dict] = []
        kg_added: list[dict] = []

        # Auto-save the transcript ONLY when tools are off. When tools are on,
        # we trust the LLM's save_memory calls exclusively — otherwise the raw
        # transcript (including the assistant's own "I don't have memories"
        # replies) poisons future semantic recall and the model ends up
        # parroting its past denials back to the user.
        should_auto_save_transcript = (
            req.save_to_memory
            and last_user
            and full_response.strip()
            and not req.enable_tools
            and not llm_saves
        )
        if should_auto_save_transcript:
            transcript = (
                f"User: {last_user.content}\n\nAssistant: {full_response.strip()}"
            )
            try:
                result = tool_add_drawer(
                    wing=wing,
                    room=room,
                    content=transcript,
                    source_file=(
                        f"chat://{req.model}/{req.session_id or 'no-session'}"
                        f"/{datetime.now().isoformat()}"
                    ),
                    added_by="ollama-mempalace",
                )
                if result.get("success"):
                    saved_id = result.get("drawer_id")
                else:
                    save_error = result.get("error", "unknown error")
            except Exception as e:
                save_error = str(e)

            if req.auto_extract:
                extracted_facts = _run_auto_extract(transcript, wing)

            if req.auto_kg:
                kg_model = req.auto_kg_model or req.model
                triples = await _extract_kg_triples(kg_model, transcript)
                for t in triples:
                    try:
                        result = tool_kg_add(
                            t["subject"],
                            t["predicate"],
                            t["object"],
                        )
                        if result.get("success"):
                            kg_added.append(t)
                    except Exception:
                        continue

        yield (
            "data: "
            + json.dumps(
                {
                    "type": "done",
                    "saved_drawer_id": saved_id,
                    "save_error": save_error,
                    "extracted_facts": extracted_facts,
                    "kg_added": kg_added if req.auto_kg else [],
                    "llm_saves": llm_saves,
                }
            )
            + "\n\n"
        )

    return StreamingResponse(generate(), media_type="text/event-stream")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")
