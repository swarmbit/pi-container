# Pi Worktree Extension — Functional Spec (v2)

## 1. Overview

A Pi extension that lets the agent operate inside isolated **git worktrees**. Instead of intercepting and rewriting every tool call, the extension uses Pi's **session switching** to create a new session whose working directory IS the worktree. All built-in tools (`read`, `write`, `edit`, `bash`, etc.) naturally target the worktree with zero interception.

Key goals:
- **Zero tool interception**: No path rewriting, no bash wrapping, no system prompt injection. The agent's cwd IS the worktree.
- **Zero host pollution**: Worktree files never appear in the main working directory.
- **Persistent sessions**: Each worktree gets its own Pi session file, so work survives restarts and can be resumed independently.
- **Clean hand-off**: `/worktree:accept` squashes worktree commits and cherry-picks into the main WD's branch.

---

## 2. Terminology

| Term | Meaning |
|------|---------|
| **Main WD** | The git repository checkout that Pi was started in (e.g. `/workspace/my-repo`). |
| **Worktree** | A git worktree created via `git worktree add`, stored outside the repo. |
| **Worktree Session** | A Pi session whose `cwd` is the worktree directory. All tool calls target the worktree naturally. |
| **Main Session** | The original Pi session whose `cwd` is the main WD. Used for `/worktree:create`, `/worktree:attach`, `/worktree:prune`. |
| **Base Commit** | The commit the worktree was created from. Used during accept. |
| **Primary Agent** | The worktree session that owns git lifecycle (auto-commit, accept, reset). |
| **Secondary Agent** | A worktree session that only edits files — it never auto-commits or touches git. |

---

## 3. Storage & Isolation Model

### 3.1 Worktree Storage

Worktrees are created **outside the main repo directory**:

```
<repo-parent>/.pi-worktrees/<repo-name>/<worktree-name>/
```

For a repo at `/workspace/my-project`, default storage: `/workspace/.pi-worktrees/my-project/`.

**Why this path?**
- Outside the repo — no `.git` pollution or accidental host-side commits.
- On the host filesystem — shared across containers that mount the same workspace.
- Override with `worktree.storagePath` in settings for true container-local storage.

**IDE exclusion:** Add `.pi-worktrees/` to your IDE's exclusion list to prevent duplicate-symbol errors.

### 3.2 Session Storage

Each worktree has its own Pi session file whose `cwd` is the worktree path. Sessions are stored at `~/.pi/agent/sessions/<encoded-worktree-path>/`. The session file path is written into `<worktreePath>/.pi-worktree-session` so the extension can find it.

Metadata is stored in the session as a custom entry:
```json
{"type":"custom","customType":"worktree_info","data":{
  "repoRoot": "/workspace/my-repo",
  "branch": "feature-x-a1b2c3d",
  "baseCommit": "abc123def",
  "mode": "primary",
  "name": "feature-x"
}}
```

The primary lock is `<worktreePath>/.pi-worktree-primary` (contains the session ID of the primary agent).

### 3.3 Git Mechanics

Standard `git worktree add -b <branch> <path> [<base>]`. All worktrees share the repo's single `.git` directory. No remote operations (push/pull) — everything is local.

---

## 4. IDE Integration Strategy

Worktrees are **container-only** and **purely local**. The host IDE cannot see or edit worktree files. No host-mount option exists because it causes IDE indexing conflicts (duplicate symbols, false refactor targets).

The agent operates entirely within the container. The user syncs worktree changes to the host manually via standard tools (e.g. `git diff | patch -p1`).

---

## 5. Core Commands

All commands are prefixed with `/worktree:` (alias `/wt:`).

| Command | Args | Context | Description |
|---------|------|---------|-------------|
| `/worktree:create` | `<name> [base]` | Main session | Create a worktree, fork a new session with cwd=worktree, switch to it. |
| `/worktree:attach` | `[name] [--primary]` | Main session | Switch to an existing worktree's session. Shows interactive list if no name. |
| `/worktree:unlink` | — | Worktree session | Switch back to the main session. |
| `/worktree:list` | — | Any | List all worktrees for this repo. |
| `/worktree:accept` | — | Worktree session | Squash worktree commits, prompt for message, cherry-pick into main WD's branch. |
| `/worktree:reset` | — | Worktree session | Interactive hard reset to a commit within the worktree. |
| `/worktree:prune` | `[name]` | Main session | Remove a worktree and delete its session file. Shows interactive list if no name. |
| `/worktree:status` | — | Worktree session | `git status` + `git diff --stat` in the worktree. |

### 5.1 How `/worktree:create` Works

1. Create the git worktree: `git worktree add -b <branch> <path> [<base>]`
2. Fork the main session using `SessionManager.forkFrom(mainSessionFile, worktreePath)` — this creates a new session file whose `cwd` is the worktree, with the full conversation history.
3. Write `worktree_info` as a custom entry in the new session.
4. Write the primary lock `<worktreePath>/.pi-worktree-primary`.
5. Store the session file path in `<worktreePath>/.pi-worktree-session`.
6. Switch to the new session via `ctx.switchSession()`.

### 5.2 How `/worktree:attach` Works

1. If no name given, show interactive list of worktrees.
2. Read `<worktreePath>/.pi-worktree-session` to find the session file path.
3. Check if primary lock exists — if so, the user must attach as secondary.
4. Switch to the worktree session via `ctx.switchSession()`.
5. If the user is attaching as primary (and no existing primary), update the session's `worktree_info.mode` to `"primary"` and write the lock.

### 5.3 How `/worktree:unlink` Works

1. Read `worktree_info.repoRoot` from the worktree session.
2. Find the main session (the session whose cwd is `repoRoot`).
3. Switch to it. The worktree session persists for later re-attach.

---

## 6. Session Model

### 6.1 No Tool Interception

The extension does **not** intercept any tool calls. Because the worktree session's `cwd` IS the worktree path:

- `read` resolves paths relative to the worktree
- `write` / `edit` operate on worktree files
- `bash` runs in the worktree directory
- `ls`, `find`, `grep` search the worktree

### 6.2 Extension Behavior by Session Type

The extension auto-detects which type of session it's in by scanning for `worktree_info` custom entries on `session_start`.

**In the main session** (no `worktree_info` entry):
- Commands: `create`, `attach`, `list`, `prune`
- Status footer: `WT: none`

**In a worktree session** (`worktree_info` entry found):
- Commands: `unlink`, `accept`, `reset`, `status`, `list`
- Auto-commit (primary only) on `agent_end`
- Status footer: `WT: <name> (primary)` or `WT: <name> (secondary)`

### 6.3 Primary / Secondary Distinction

| Capability | Primary | Secondary |
|-----------|---------|-----------|
| Auto-commit on each turn | ✅ | ❌ |
| `/worktree:accept` | ✅ | ❌ |
| `/worktree:reset` | ✅ | ❌ |
| File editing (read, write, edit) | ✅ | ✅ |
| Bash commands | ✅ | ✅ |
| Run git commands manually | ✅ | ✅ |

---

## 7. Accept Flow

`/worktree:accept` (run from the worktree session, primary only):

1. Confirm: "Squash worktree history and merge into main WD?"
2. Auto-commit any uncommitted changes.
3. Compute the squash message from `git log baseCommit..HEAD`.
4. Let the user edit the message via `ctx.ui.editor()`.
5. Save the squash result to the main repo (cherry-pick or merge).
6. Notify: "Worktree 'name' accepted. Run /worktree:unlink to switch back."

---

## 8. Auto-Commit

When the agent is in a **primary** worktree session, the extension auto-commits at the end of every turn (`agent_end`):

```bash
git add -A
git diff --cached --quiet || git commit -m "[pi-worktree] auto-commit turn <n>"
```

Also commits on `session_shutdown` to capture final work.

Configured via `worktree.autoCommit` (default: `true`) and `worktree.autoCommitTemplate`.

---

## 9. Configuration

```json
{
  "worktree": {
    "storagePath": "<repo-parent>/.pi-worktrees/<repo-name>/",
    "autoCommit": true,
    "autoCommitTemplate": "[pi-worktree] auto-commit turn {turn}",
    "statusLine": true,
    "staleLockHours": 24
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `storagePath` | Derived from repo location | Root directory for worktrees. |
| `autoCommit` | `true` | Auto-commit at end of each turn when primary. |
| `autoCommitTemplate` | `[pi-worktree] auto-commit turn {turn}` | Template for auto-commit messages. |
| `statusLine` | `true` | Show active worktree in footer. |
| `staleLockHours` | `24` | How long before a primary lock is stale and can be reclaimed. |

---

## 10. Edge Cases & Safety

| Scenario | Behavior |
|----------|----------|
| No remote configured | Works fine — all git ops are local. |
| Pruning a worktree | Removes worktree directory + deletes session file. Warns if commits ahead of upstream. |
| Stale primary lock | After `staleLockHours`, a new agent can claim primary. Existing primary is notified. |
| Multiple secondary agents | Allowed — they can edit files simultaneously. Primary auto-commits to capture their changes. |
| Worktree at filesystem root | Storage falls back to `<repoRoot>/.pi-worktrees/`. |

## 11. Branch Naming

Worktree branches are named `<name>-<hash>` where `<hash>` is a 7-char SHA-256 digest of `name + repoRoot`. This prevents collisions when the same name is reused across repos.

## 12. Scoped Commit History

`/worktree:log` and `/worktree:reset` only show commits from `baseCommit..HEAD` — the worktree's own history, not the full repo history.
