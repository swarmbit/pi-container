---
name: commit
description: Commit staged changes with a short descriptive message
---

# Commit

When asked to commit changes:

1. **Check what's staged** — run `git diff --cached --stat` to see staged files.
   If nothing is staged, run `git add` to stage the relevant changed files.

2. **Write a short one-line message** — the commit message should be a single line,
   under 72 characters, describing the change in imperative mood (e.g., "Add feature",
   "Fix bug", "Update docs"). Do not use multi-line messages.

3. **Commit** — run `git commit -m "<message>"`.

4. After committing, confirm the commit with `git log -1 --oneline`.
