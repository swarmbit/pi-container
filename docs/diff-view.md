# diff-view — Post-prompt Diff in Editor

Show all file changes made during a prompt as a diff in VS Code or IntelliJ IDEA.

## Problem

After a prompt finishes, users have no easy way to review *all* the changes that happened. They can scroll through tool output in the terminal, but this is noisy — `edit` and `write` output is interleaved with `bash` output, thinking, and other noise. A focused diff view in the user's editor (already open and familiar) is far more useful.

## Key Design Questions

### Should we use git worktrees?

**No.** Git worktrees are the wrong tool here:

| Concern | Worktree | Stash + diff |
|---------|----------|--------------|
| Speed | Slow — `git worktree add` copies the object tree to a new directory | Fast — stash is in-memory, diff is instant |
| Cleanup | Must `git worktree remove` or litter directories | `git stash drop` is cheap |
| Uncommitted files | Worktrees only see committed content; `git add` + commit is noisy | Stash captures the index and worktree |
| Nested git repos | Worktrees break on submodules | Stash/diff handle submodules fine |
| Concurrency | One worktree per ref; collisions are possible | Stash refs are unique per stash |
| Disk usage | Full tree checkout | Zero extra space |

The right approach is:

1. **Before the prompt starts** — `git stash` (or `git add -A && git stash`) to capture current state
2. **After the prompt finishes** — `git diff HEAD` (or `git diff stash@{0}`) to get the full diff
3. **Post-review** — `git stash pop` to restore, or keep the changes

Actually, even that is over-complicated. Since pi runs inside the container with a mounted workspace, we don't need git at all. We can:

1. **Snapshot file hashes** at `agent_start`
2. **Compare at `agent_end`** — list files that changed (by hash or mtime)
3. **Generate a unified diff** of only the changed files
4. **Open it in the editor** via `code --diff` or `idea diff`

Even simpler: just use `git diff` if it's a git repo, or fall back to hash-based diffing.

### Which diff strategy?

| Strategy | Pros | Cons |
|----------|------|------|
| `git diff HEAD` | Simple, fast, handles all changes | Requires git, only works on committed files |
| `git stash` + `git diff` | Captures uncommitted changes | Stash can fail on dirty trees |
| Hash snapshot | Works without git | More code, need to handle binary files |
| `git diff --name-only` + per-file diff | Selective, no temp state | Still needs git |

**Decision: Use `git diff` as primary, hash-snapshot as fallback.**

- If the project is a git repo: `git diff HEAD` before prompt → `git diff HEAD` after prompt → diff of diffs
- If not a git repo: snapshot file hashes before → compare after → use `diff` command or inline diff generation

### How to open in the editor?

| Editor | Command | Notes |
|--------|---------|-------|
| VS Code | `code --diff file_a file_b` | Opens a tabbed diff view. Can also open a saved `.patch` file with syntax highlighting |
| IntelliJ | `idea diff file_a file_b` | Opens IntelliJ's built-in 3-way merge viewer. Also supports `idea diff <dir_a> <dir_a>` for directory diffs |

Both editors are on the *host* machine, not in the container. The extension running inside the container can't call `code` or `idea` directly because those commands don't exist in the container.

**Solution: Write the diff to a file in `/workspace`** (which is mounted to the host), then emit a `bash` command or `ctx.ui.notify` telling the user to open it. Or, better yet, **have the container write the diff file and use a helper script on the host to open it in the editor.**

Actually, the simplest approach that works today:

1. Extension tracks file changes during a prompt
2. At `agent_end`, writes a unified diff/patch file to `/workspace/.pi-container/diffs/<timestamp>.patch`
3. The user's editor can auto-open `.patch` files with diff highlighting, or the user opens it manually
4. For VS Code, we could also write a `.code-workspace` task, but that's over-engineering

**Revised approach — use the host's editor commands from outside the container:**

Since `pi-container` orchestrates the Docker run, we can add a post-exit hook. After the container exits, the host script checks for a diff file and opens it:

```bash
# After container exits
if [ -f ".pi-container/diffs/latest.patch" ]; then
  code --diff "$(git diff HEAD --name-only | head -1)" ".pi-container/diffs/latest.patch"
  # OR: idea diff ...
fi
```

But this only works for interactive sessions that exit. For long-running sessions, we need something inside the container.

**Final decision: hybrid approach.**

Inside the container:
- Track changes via `agent_start` / `agent_end` events
- Generate a `.patch` file in `/workspace/.pi-container/diffs/`
- `ctx.ui.notify()` with a summary of changes

Outside the container (pi-container CLI):
- After `docker run` exits, check for diff files and open in the user's preferred editor
- Configure editor choice in `.pi-container/config.yml`

## Extension Design

### Events Used

| Event | Purpose |
|-------|---------|
| `agent_start` | Capture `git diff HEAD` or snapshot file hashes |
| `agent_end` | Generate diff, write `.patch` file, notify user |
| `tool_call` (edit/write/bash) | Track which files were touched for faster diffing |

### File Structure

```
.pi-container/extensions/diff-view/
├── index.ts          # Main extension
├── git-diff.ts       # Git-based diff generation
├── hash-snapshot.ts  # Fallback for non-git repos
└── package.json
```

### Config

In `.pi-container/config.yml`:

```yaml
diffView:
  editor: "code"        # "code" | "idea" | "auto" | "none"
  autoOpen: true        # Auto-open diff after prompt (if editor available)
```

### Host-side Integration

The `pi-container` CLI gains a `--diff` post-exit hook:

1. After `docker run` exits, check `/workspace/.pi-container/diffs/latest.patch`
2. If found, open in the configured editor
3. Clean up old diffs (keep last N)

The extension writes the diff inside the container, and the host-side `pi-container` wrapper opens it.

### Implementation Plan

#### Phase 1: Inside the container

1. Build the extension using `agent_start` / `agent_end` events
2. Use `bash` tool to run `git diff` or snapshot/compare files
3. Write `.patch` file to `/workspace/.pi-container/diffs/`
4. Show summary via `ctx.ui.notify()`

#### Phase 2: Host-side editor launch

1. Add `diffView.editor` config to `.pi-container/config.yml`
2. After `docker run` exits, `pi-container` checks for the diff file
3. Launches `code --diff` or `idea diff` on the host
4. This only works for sessions that exit — ongoing sessions rely on the in-terminal summary

#### Phase 3: Real-time diff (future)

- Use `ctx.ui.setWidget()` to show a persistent diff summary above the editor
- Click-to-open requires a protocol between container and host (see inter-agent extension)

## Open Questions

- **Should the diff clear between prompts, or accumulate?** → Accumulate per-prompt, with a "latest" symlink
- **Binary files?** → Skip in the diff, list them in the notification
- **What about `edit` tool calls that are partial (offset/limit)?** → The git diff shows the actual result, not the edit instructions
- **Should we track the diff at the turn level or prompt level?** → Prompt level (`agent_start` → `agent_end`), since that's the natural unit of work