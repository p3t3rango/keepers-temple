# Upstream mempalace changes for the import-time review gate

`mempalace-src/` is gitignored in keepers-temple (see `.gitignore:11`), so these
edits are not captured by this repo's git history. Port them to your mempalace
fork (branch suggestion: `feat/import-review-gate`).

## 1. `mempalace/general_extractor.py` — surface keyword_score

In `extract_memories()` (around the docstring at line ~363 and the `memories.append()`
block at line ~413), update the returned dict to include `keyword_score`:

```python
# docstring change:
    Returns:
        List of dicts: {"content": str, "memory_type": str, "chunk_index": int,
                        "keyword_score": float}

# appended dict:
        memories.append(
            {
                "content": para.strip(),
                "memory_type": max_type,
                "chunk_index": len(memories),
                "keyword_score": float(max_score),
            }
        )
```

## 2. `mempalace/convo_miner.py` — review-mode gate + origin metadata

See the full file in this checkout — three regions changed:

- Top of file: added `import re`, a proper-noun regex constant `_PROPER_NOUN_RE`,
  a stopword set `_NOUN_STOPWORDS`, helpers `_extract_candidate_names()` and
  `_entity_exists_in_kg()`.
- `_file_chunks_locked()` metadata dict: added `source_conversation` (basename of
  source_file) and `origin: "import_auto"` so users can filter auto-committed
  items post-import.
- `mine_convos()`: new `review: bool = False` parameter, review-active setup
  block (instantiates `PendingStore` + `KnowledgeGraph`), the branch inside the
  main loop that routes `--extract general` chunks to pending + emits entity
  conflict questions instead of calling `_file_chunks_locked`, and a dict
  return value `{committed, pending, questions, files_processed, files_skipped}`.

## 3. `mempalace/cli.py` — --review flag forwarding

Two changes:

- `cmd_mine()`: pass `review=getattr(args, "review", False)` through to
  `mine_convos()`.
- Argparse for `p_mine`: add `p_mine.add_argument("--review", action="store_true", ...)`.

## 4. New file: `mempalace/pending_store.py`

See `patches/mempalace-review-gate-NEW-FILES.txt`.

## 5. New tests

- `tests/test_pending_store.py` (9 tests)
- `tests/test_convo_miner_review.py` (3 tests)

Contents in `patches/mempalace-review-gate-NEW-FILES.txt`.
