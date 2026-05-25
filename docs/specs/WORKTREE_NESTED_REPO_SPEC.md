# Brainstorm: Worktree Extension + Nested Git Repos

## The Scenario

```
/workspace/my-project/          ← git repo A (main WD, where pi was started)
├── src/
├── packages/
│   ├── shared-lib/             ← git repo B (its own .git, no submodule)
│   └── frontend/               ← git repo C (its own .git, no submodule)
├── submodule-foo/              ← git submodule of repo A
└── .git/                       ← repo A's git dir
```

The user starts pi in `/workspace/my-project` (repo A), creates a worktree, and the agent starts editing. But the agent might read/write files in `packages/shared-lib/` which is **repo B**, not repo A.

## The Problems

| Problem | What Happens Today |
|---------|-------------------|
| Wrong repo root | `getRepoRoot(ctx.cwd)` returns repo A. Worktree is created for A. |
| Cross-repo writes | Agent edits `packages/shared-lib/src/index.ts`. `rewritePath` remaps it to repo A's worktree, not repo B's main WD or any worktree. |
| Silent data corruption | Changes meant for repo B land in repo A's worktree. repo B's actual files are untouched. |
| Git confusion | Auto-commit in repo A's worktree sees changes to `packages/shared-lib/...` and commits them as part of repo A. But repo B is a separate git repo — its `.git` in the subdirectory means those files are actually untracked in repo A (or worse, if `.git` is a file pointing to a gitdir). |

## Design Options

### Option A: Strict Single-Repo, Detect & Block Cross-Repo Edits

**Rule:** A session is linked to exactly one repo. Any file operation that targets a different git repo is **left untouched** (not rewritten to the worktree).

**Implementation:**
- `rewritePath` walks up from the target file looking for `.git`
- If the file's git root ≠ `link.repoRoot`, return the path unchanged
- The agent edits the file in the nested repo's actual working directory
- Add a system prompt note: "Some files are in separate git repos and are not part of the active worktree"

**Pros:**
- Simple, safe, no surprises
- Nested repos are edited directly (which may be what the user wants for submodules)

**Cons:**
- User can't isolate nested repos without opening a new pi session from that directory
- Agent might get confused about why some files are "not committing"

### Option B: Multi-Repo Worktree Map (Complex)

**Rule:** A session can manage multiple worktrees — one per git repo.

**Implementation:**
- `currentLink` becomes `Map<repoRoot, WorktreeLink>`
- `/worktree:create` takes an optional `--repo <path>` to target a specific nested repo
- `/worktree:attach` can attach to any discovered repo
- `rewritePath` detects the file's repo root and routes to the corresponding worktree
- Auto-commit iterates over all linked worktrees and commits changes

**Pros:**
- Full isolation for all repos in the project
- One session can work across the monorepo

**Cons:**
- Complex state management
- `/worktree:status`, `/worktree:log` need repo disambiguation
- Primary/secondary model gets messy (which repo is primary?)
- Overkill for most users

### Option C: Nested Repo Worktree Auto-Discovery (Middle Ground)

**Rule:** When creating a worktree, detect all nested git repos and offer to create worktrees for them too. But the session only actively manages ONE at a time.

**Implementation:**
- `/worktree:create` scans for `.git` directories within the repo
- If nested repos found, offer: "Also create worktrees for: shared-lib, frontend?"
- User picks which repos to isolate
- The "active" repo can be switched via `/worktree:scope <repo-name>`
- Only the active repo's worktree gets tool interception; others are left untouched

**Pros:**
- Guided setup for monorepos
- User explicitly chooses which repos to isolate
- Still simple per-session mental model

**Cons:**
- Adds setup friction
- Switching scopes is another command to remember

### Option D: Per-File Repo Detection with Error-on-Cross

**Rule:** Like Option A, but instead of silently leaving cross-repo files alone, the extension warns the user.

**Implementation:**
- `rewritePath` detects when a file is in a different git repo
- Returns the path unchanged BUT adds a `notify` warning: "File X is in repo B, not the active worktree (repo A). Changes will go to the main WD."
- Optionally inject a system prompt warning

**Pros:**
- Safe and transparent
- User is never surprised

**Cons:**
- Warning fatigue if the monorepo has many nested repos
- Still doesn't solve the isolation desire for nested repos

## Recommendation: Option A + D hybrid ("Safe Routing")

**Default behavior:**
1. Detect the file's actual git root by walking up from the file path
2. If it matches the linked worktree's repo → rewrite to worktree (current behavior)
3. If it's a different git repo → **leave path unchanged**, notify user once per turn
4. If it's not in any git repo → leave path unchanged (current behavior)

**Additional command:**
- `/worktree:repos` — list all git repos discovered in the working directory
- This helps users understand the project structure and decide if they need separate sessions

**For nested repo isolation:**
- User opens a new pi session from the nested repo directory
- Creates/attaches a worktree there normally
- This is the cleanest mental model: one session = one repo = one worktree

## Implementation Sketch

```typescript
function getRepoRootFromPath(filePath: string): string | null {
  let dir = path.dirname(filePath);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

function rewritePath(filePath: string, link: WorktreeLink): string {
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(link.repoRoot, filePath);
  const fileRepoRoot = getRepoRootFromPath(absPath);
  
  // If file is in a different repo than our linked worktree, don't rewrite
  if (fileRepoRoot && fileRepoRoot !== link.repoRoot) {
    return filePath; // edit the actual file in its own repo
  }
  
  // Otherwise, existing rewrite logic
  // ...
}
```

## Open Questions

1. **Git submodules** — `packages/shared-lib/.git` might be a file (gitlink) pointing to `.git/modules/shared-lib` in the parent repo. In this case, it's NOT a separate repo — it's part of repo A. Walking up and finding `.git` as a file means we need to treat it as part of the parent repo. We can check: `fs.statSync(path.join(dir, ".git")).isDirectory()`.

2. **Multiple warnings per turn** — if the agent edits 10 files in a nested repo, do we warn 10 times? Better to track "warnedThisTurn" and only notify once.

3. **Bash commands** — a bash command like `cd packages/shared-lib && npm test` would run in the main worktree's `packages/shared-lib/`, which might not exist or might be the wrong copy. Should we also detect cross-repo bash commands?

4. **Should `/worktree:list` show nested repos?** Probably not — it's for listing worktrees, not repos. But `/worktree:repos` could show discovered git roots.
