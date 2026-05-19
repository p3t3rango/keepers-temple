"""File-backed skill artifact store for Keepers Temple.

Skills live as markdown files with YAML frontmatter under ~/.mempalace/skills/,
modeled on the Nous Hermes / agentskills.io layout. This module is the single
owner of skill file I/O. Paths are resolved at call time so tests can redirect
HOME after import.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class SkillError(Exception):
    """Raised for any invalid skill input or store operation."""


class SkillNotFoundError(SkillError):
    """Raised when a referenced skill (active or archived) does not exist."""


class SkillConflictError(SkillError):
    """Raised when an operation conflicts with existing state (duplicate/active)."""


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(text).strip().lower())
    return s.strip("-")


def _unquote(s: str) -> str:
    if len(s) >= 2 and (
        (s[0] == '"' and s[-1] == '"') or (s[0] == "'" and s[-1] == "'")
    ):
        return s[1:-1]
    return s


def _yaml_scalar(v: str):
    v = v.strip()
    if v.startswith("[") and v.endswith("]"):
        try:
            parsed = json.loads(v)
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass
        inner = v[1:-1].strip()
        return (
            [_unquote(p.strip()) for p in inner.split(",") if p.strip()]
            if inner else []
        )
    if v.lower() in ("true", "false"):
        return v.lower() == "true"
    return _unquote(v)


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Return (metadata, body). Raises SkillError on malformed input.

    Supports flat keys plus a one-level `metadata:` block (sufficient for
    the SKILL.md shape defined in the spec).
    """
    if not text.startswith("---"):
        raise SkillError("missing opening '---' frontmatter fence")
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise SkillError("missing closing '---' frontmatter fence")
    raw_meta, body = parts[1], parts[2]
    meta: dict = {}
    for line in raw_meta.splitlines():
        if not line.strip() or line.strip().startswith("#"):
            continue
        if re.match(r"^\S.*:\s*$", line) and line.strip().rstrip(":") == "metadata":
            meta["metadata"] = {}
            continue
        m = re.match(r"^(\s*)([\w.-]+):\s*(.*)$", line)
        if not m:
            continue
        indent, key, val = m.group(1), m.group(2), m.group(3)
        target = meta["metadata"] if (indent and "metadata" in meta) else meta
        target[key] = _yaml_scalar(val) if val != "" else ""
    if not str(meta.get("name", "")).strip():
        raise SkillError("frontmatter missing required 'name'")
    if not str(meta.get("description", "")).strip():
        raise SkillError("frontmatter missing required 'description'")
    if not body.strip():
        raise SkillError("skill body is empty")
    return meta, body


_DANGER_PATTERNS = [
    r"ignore\s+(all\s+)?previous\s+instructions",
    r"disregard\s+(the\s+)?(system|above)\s+prompt",
    r"curl\s+https?://\S+\s*\|\s*(ba)?sh",
    r"wget\s+https?://\S+\s*\|\s*(ba)?sh",
    r"rm\s+-rf\s+/(?:\s|$|--)",
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    r"exfiltrat",
]


def security_scan(text: str) -> Optional[str]:
    """Return a human-readable reason if the content is unsafe, else None."""
    s = str(text)
    for pat in _DANGER_PATTERNS:
        if re.search(pat, s, re.IGNORECASE):
            return f"blocked: content matched unsafe pattern /{pat}/"
    return None


def skills_root() -> Path:
    p = Path(os.path.expanduser("~/.mempalace/skills"))
    p.mkdir(parents=True, exist_ok=True)
    return p


def archive_root() -> Path:
    p = skills_root() / ".archive"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _usage_path() -> Path:
    return skills_root() / ".usage.json"


def _load_usage() -> dict:
    try:
        return json.loads(_usage_path().read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_usage(d: dict) -> None:
    tmp = _usage_path().with_suffix(".json.tmp")
    tmp.write_text(json.dumps(d, indent=2))
    tmp.replace(_usage_path())


def _now() -> str:
    return datetime.now().isoformat()


def _touch_usage(name: str, **fields) -> dict:
    usage = _load_usage()
    rec = usage.get(name, {})
    rec.setdefault("created_at", _now())
    rec.setdefault("agent_created", False)
    rec.setdefault("pinned", False)
    rec.setdefault("archived", False)
    rec.setdefault("patch_count", 0)
    rec["latest_activity_at"] = _now()
    rec.update(fields)
    usage[name] = rec
    _save_usage(usage)
    return rec


def render_skill(meta: dict, body: str) -> str:
    lines = ["---"]
    for k, v in meta.items():
        if k == "metadata" and isinstance(v, dict):
            lines.append("metadata:")
            for mk, mv in v.items():
                lines.append(f"  {mk}: {json.dumps(mv) if isinstance(mv, (list, bool)) else mv}")
        else:
            rv = json.dumps(v) if isinstance(v, (list, bool)) else v
            lines.append(f"{k}: {rv}")
    lines.append("---")
    return "\n".join(lines) + "\n" + body.lstrip("\n")


# MemPalace wing/room for the best-effort skill index. The wing name MUST pass
# mempalace.config.sanitize_name (no leading/trailing underscore). See Plan 1
# debugging note: '_skills' was rejected by _SAFE_NAME_RE.
SKILL_INDEX_WING = "kt-skills"
SKILL_INDEX_ROOM = "index"


def index_skill(name: str, description: str, path: str) -> None:
    """Best-effort: upsert name+description into MemPalace for unified search.

    Never raises (file remains the source of truth) but is no longer SILENT:
    a failed/erroring index write is logged at WARNING. tool_add_drawer has no
    metadata param, so the index drawer is content-only ("name: description").
    """
    try:
        from mempalace.mcp_server import tool_add_drawer

        result = tool_add_drawer(
            wing=SKILL_INDEX_WING,
            room=SKILL_INDEX_ROOM,
            content=f"{name}: {description}",
            source_file=f"skill://{path}",
            added_by="skill_store-index",
        )
        if not (isinstance(result, dict) and result.get("success")):
            detail = result.get("error") if isinstance(result, dict) else result
            logger.warning("skill index write failed for %r: %s", name, detail)
    except Exception:
        logger.warning("skill index write errored for %r", name, exc_info=True)


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


def _skill_dir(name: str) -> Optional[Path]:
    for md in skills_root().glob("*/*/SKILL.md"):
        if md.parent.name == name:
            return md.parent
    return None


def _archived_skill_dir(slug: str) -> Optional[Path]:
    for md in archive_root().glob("*/*/SKILL.md"):
        if md.parent.name == slug:
            return md.parent
    return None


def _all_skill_md(root: Path):
    return list(root.glob("*/*/SKILL.md"))


def create_skill(
    name: str,
    description: str,
    body: str,
    category: str = "general",
    metadata: Optional[dict] = None,
    agent_created: bool = False,
    triggers: Optional[list] = None,
    tools: Optional[list] = None,
    mutating: bool = False,
) -> dict:
    slug = slugify(name)
    cat = slugify(category) or "general"
    if not slug:
        raise SkillError("skill name is empty after normalization")
    if _skill_dir(slug) is not None or _archived_skill_dir(slug) is not None:
        raise SkillConflictError(f"skill '{slug}' already exists")
    reason = security_scan(body) or security_scan(description)
    if reason:
        raise SkillError(reason)
    meta = {
        "name": slug,
        "description": description.strip(),
        "version": "1.0.0",
        "triggers": list(triggers or []),
        "tools": list(tools or []),
        "mutating": bool(mutating),
        "metadata": {"agent_created": agent_created, **(metadata or {})},
    }
    parse_frontmatter(render_skill(meta, body))  # validate before write
    target = skills_root() / cat / slug
    target.mkdir(parents=True, exist_ok=True)
    md = target / "SKILL.md"
    tmp = md.with_suffix(".md.tmp")
    tmp.write_text(render_skill(meta, body))
    tmp.replace(md)
    _touch_usage(slug, created_at=_now(), agent_created=agent_created, category=cat)
    index_skill(slug, description.strip(), str(md))
    return {"name": slug, "category": cat, "path": str(md)}


def get_skill(name: str) -> dict:
    slug = slugify(name)
    d = _skill_dir(slug)
    archived = False
    if d is None:
        for md in archive_root().glob("*/*/SKILL.md"):
            if md.parent.name == slug:
                d = md.parent
                archived = True
                break
    if d is None:
        raise SkillNotFoundError(f"skill '{slug}' not found")
    meta, body = parse_frontmatter((d / "SKILL.md").read_text())
    rec = _load_usage().get(slug, {})
    return {
        "name": slug,
        "description": meta.get("description", ""),
        "category": d.parent.name,
        "version": meta.get("version", ""),
        "triggers": meta.get("triggers") or [],
        "tools": meta.get("tools") or [],
        "mutating": bool(meta.get("mutating", False)),
        "body": body,
        "pinned": bool(rec.get("pinned")),
        "agent_created": bool(rec.get("agent_created")),
        "state": "archived" if archived else "active",
    }


def read_skill_file(name: str, file_path: str) -> str:
    """Read a file inside a skill's directory (active or archived).

    Containment-guarded: rejects path traversal outside the skill dir.
    Raises SkillError on missing skill, missing/empty file_path, or escape.
    """
    slug = slugify(name)
    d = _skill_dir(slug) or _archived_skill_dir(slug)
    if d is None:
        raise SkillNotFoundError(f"skill '{slug}' not found")
    if not file_path:
        raise SkillError("file_path is required")
    target = d / file_path
    resolved = target.resolve()
    skill_root = d.resolve()
    if not target.exists() or (
        skill_root not in resolved.parents and resolved != skill_root / "SKILL.md"
    ):
        raise SkillError(f"file not found: {file_path}")
    return target.read_text()


def list_skills(include_archived: bool = False) -> list[dict]:
    out = []
    usage = _load_usage()
    for md in sorted(_all_skill_md(skills_root())):
        try:
            meta, _ = parse_frontmatter(md.read_text())
        except SkillError:
            continue
        rec = usage.get(md.parent.name, {})
        out.append({
            "name": meta["name"],
            "description": meta.get("description", ""),
            "category": md.parent.parent.name,
            "pinned": bool(rec.get("pinned")),
            "agent_created": bool(rec.get("agent_created")),
            "state": "active",
        })
    if include_archived:
        for md in sorted(archive_root().glob("*/*/SKILL.md")):
            try:
                meta, _ = parse_frontmatter(md.read_text())
            except SkillError:
                continue
            out.append({
                "name": meta["name"],
                "description": meta.get("description", ""),
                "category": md.parent.parent.name,
                "pinned": False,
                "agent_created": bool(usage.get(md.parent.name, {}).get("agent_created")),
                "state": "archived",
            })
    return out


def patch_skill(
    name: str,
    old_string: str,
    new_string: str,
    file_path: Optional[str] = None,
    replace_all: bool = False,
) -> dict:
    slug = slugify(name)
    d = _skill_dir(slug)
    if d is None:
        raise SkillNotFoundError(f"skill '{slug}' not found")
    target = d / (file_path or "SKILL.md")
    resolved = target.resolve()
    skill_root = d.resolve()
    if not target.exists() or (
        skill_root not in resolved.parents and resolved != skill_root / "SKILL.md"
    ):
        raise SkillError(f"target file not found: {file_path or 'SKILL.md'}")
    original = target.read_text()
    if old_string not in original:
        raise SkillError("old_string not found in skill file")
    updated = (
        original.replace(old_string, new_string)
        if replace_all
        else original.replace(old_string, new_string, 1)
    )
    if target.name == "SKILL.md":
        try:
            parse_frontmatter(updated)  # rollback-safe validation
        except SkillError as e:
            raise SkillError(f"patch would corrupt skill: {e}")
        reason = security_scan(updated)
        if reason:
            raise SkillError(reason)
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(updated)
    tmp.replace(target)
    rec = _load_usage().get(slug, {})
    _touch_usage(
        slug,
        patch_count=int(rec.get("patch_count", 0)) + 1,
        last_patched_at=_now(),
    )
    if target.name == "SKILL.md":
        meta, _ = parse_frontmatter(updated)
        index_skill(slug, meta.get("description", ""), str(target))
    return {"name": slug, "patched": file_path or "SKILL.md"}


def archive_skill(name: str) -> dict:
    slug = slugify(name)
    d = _skill_dir(slug)
    if d is None:
        raise SkillNotFoundError(f"skill '{slug}' not found")
    cat = d.parent.name
    dest = archive_root() / cat / slug
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        shutil.rmtree(dest)
    shutil.move(str(d), str(dest))
    _touch_usage(slug, archived=True)
    deindex_skill(slug)
    return {"name": slug, "state": "archived"}


def restore_skill(name: str) -> dict:
    slug = slugify(name)
    src = None
    for md in archive_root().glob("*/*/SKILL.md"):
        if md.parent.name == slug:
            src = md.parent
            break
    if src is None:
        raise SkillNotFoundError(f"archived skill '{slug}' not found")
    if _skill_dir(slug) is not None:
        raise SkillConflictError(f"an active skill '{slug}' already exists")
    cat = src.parent.name
    dest = skills_root() / cat / slug
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dest))
    _touch_usage(slug, archived=False)
    try:
        meta, _ = parse_frontmatter((dest / "SKILL.md").read_text())
        index_skill(slug, meta.get("description", ""), str(dest / "SKILL.md"))
    except Exception:
        logger.warning("restore_skill: re-index failed for %r", slug, exc_info=True)
    return {"name": slug, "state": "active"}


def set_pinned(name: str, pinned: bool) -> dict:
    slug = slugify(name)
    if _skill_dir(slug) is None:
        raise SkillNotFoundError(f"skill '{slug}' not found")
    _touch_usage(slug, pinned=bool(pinned))
    return {"name": slug, "pinned": bool(pinned)}
