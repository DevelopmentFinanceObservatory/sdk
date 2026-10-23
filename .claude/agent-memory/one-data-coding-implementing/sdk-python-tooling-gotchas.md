---
name: sdk-python-tooling-gotchas
description: SDK repo python/ tooling traps - ruff isort path order and the import-linter cache giving stale results
metadata:
  type: project
---

Two tooling traps in the SDK repo's `python/` package.

- `uv run ruff check --fix src ../scripts tests` (from `python/`) re-sorts imports in dozens of test files, moving `tests.*` into its own block. CI's form, `ruff check . ../scripts`, accepts the committed order. Use CI's form, or `ruff check --fix src tests` without `../scripts`.
- `lint-imports` caches in `python/.import_linter_cache/`. After planting and reverting an import, it reported the reverted violation until the cache was deleted. Use `lint-imports --no-cache` when checking a just-edited tree; the pre-commit hook passes `--no-cache` for this reason.

**Why:** both gave wrong results that look like real problems.
**How to apply:** any lint or layer check in /Users/jorge/repos/sdk-worktrees or the sdk checkout.
