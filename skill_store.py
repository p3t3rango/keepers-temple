"""File-backed skill artifact store for Keepers Temple.

Skills live as markdown files with YAML frontmatter under ~/.mempalace/skills/,
modeled on the Nous Hermes / agentskills.io layout. This module is the single
owner of skill file I/O. Paths are resolved at call time so tests can redirect
HOME after import.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional


class SkillError(Exception):
    """Raised for any invalid skill input or store operation."""


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(text).strip().lower())
    return s.strip("-")


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
            [p.strip().strip("\"'") for p in inner.split(",") if p.strip()]
            if inner else []
        )
    if v.lower() in ("true", "false"):
        return v.lower() == "true"
    return v.strip("\"'")


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
    current = meta
    for line in raw_meta.splitlines():
        if not line.strip() or line.strip().startswith("#"):
            continue
        if re.match(r"^\S.*:\s*$", line) and line.strip().rstrip(":") == "metadata":
            meta["metadata"] = {}
            current = meta["metadata"]
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
