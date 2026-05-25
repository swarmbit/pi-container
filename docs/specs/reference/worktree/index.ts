/**
 * Pi Worktree Extension (v2 — session-switching model)
 *
 * Instead of intercepting tool calls to redirect paths, this extension creates
 * a new Pi session whose cwd IS the worktree. All built-in tools (read, write,
 * edit, bash, etc.) naturally target the worktree — zero interception.
 *
 * Architecture:
 * - Main session (cwd = repo root): /worktree:create, /worktree:attach, /worktree:prune, /worktree:list
 * - Worktree session (cwd = worktree path): auto-commit (primary), /worktree:accept, /worktree:reset,
 *   /worktree:unlink, /worktree:status
 * - Detection via custom entry "worktree_info" in the session
 *
 * Aliases: /wt: prefix works for all commands (e.g. /wt:create, /wt:accept)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  repoRoot: string;
  branch: string;
  baseCommit: string;
  mode: "primary" | "secondary";
  name: string;
}

export interface WorktreeConfig {
  storagePath: string;
  autoCommit: boolean;
  autoCommitTemplate: string;
  statusLine: boolean;
  staleLockHours: number;
}

export interface PrimaryLock {
  sessionId: string;
  linkedAt: number;
}

const WORKTREE_INFO_TYPE = "worktree_info";
const PRIMARY_LOCK_FILE = ".pi-worktree-primary";
const SESSION_REF_FILE = ".pi-worktree-session";

// ---------------------------------------------------------------------------
// State (per session instance — reset on session_start)
// ---------------------------------------------------------------------------

let worktreeInfo: WorktreeInfo | null = null;
let turnCounter = 0;
let isWorktreeSession = false;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function loadJsonSafe<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function getDefaultStoragePath(repoRoot: string): string {
  let parent = path.dirname(repoRoot);
  const repoName = path.basename(repoRoot);
  if (parent === "/") {
    parent = repoRoot;
  }
  return path.join(parent, ".pi-worktrees", repoName);
}

export function getConfig(repoRoot: string): WorktreeConfig {
  const defaults: WorktreeConfig = {
    storagePath: getDefaultStoragePath(repoRoot),
    autoCommit: true,
    autoCommitTemplate: "[pi-worktree] auto-commit turn {turn}",
    statusLine: true,
    staleLockHours: 24,
  };

  const global = loadJsonSafe<{ worktree?: Partial<WorktreeConfig> }>(
    path.join(process.env.HOME || "~", ".pi/agent/settings.json")
  );
  const project = loadJsonSafe<{ worktree?: Partial<WorktreeConfig> }>(
    path.join(repoRoot, ".pi/settings.json")
  );

  return { ...defaults, ...global?.worktree, ...project?.worktree };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

export function runGit(
  cwd: string,
  args: string[]
): { stdout: string; stderr: string; code: number } {
  try {
    const cmd = `git ${args.join(" ")}`;
    const stdout = execSync(cmd, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr: "", code: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout?.toString() || "",
      stderr: e.stderr?.toString() || e.message || "",
      code: e.status ?? 1,
    };
  }
}

export function getRepoHash(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
}

export function getWorktreeBranchName(name: string, repoRoot: string): string {
  const hash = createHash("sha256").update(name + repoRoot).digest("hex").slice(0, 7);
  return `${name}-${hash}`;
}

export function getWorktreeStoragePath(repoRoot: string, config: WorktreeConfig): string {
  return path.join(config.storagePath, getRepoHash(repoRoot));
}

export function getWorktreePath(repoRoot: string, name: string, config: WorktreeConfig): string {
  return path.join(getWorktreeStoragePath(repoRoot, config), name);
}

export async function getCurrentBranch(cwd: string): Promise<string | null> {
  const { stdout, code } = runGit(cwd, ["branch", "--show-current"]);
  return code === 0 ? stdout.trim() || null : null;
}

export async function getCurrentCommit(cwd: string): Promise<string | null> {
  const { stdout, code } = runGit(cwd, ["rev-parse", "HEAD"]);
  return code === 0 ? stdout.trim() || null : null;
}

export async function gitStatus(cwd: string): Promise<boolean> {
  const { stdout } = runGit(cwd, ["status", "--porcelain"]);
  return stdout.trim().length > 0;
}

export async function gitCommit(
  cwd: string,
  message: string
): Promise<{ ok: boolean; error?: string }> {
  const { code: addCode, stderr: addErr } = runGit(cwd, ["add", "-A"]);
  if (addCode !== 0) {
    return { ok: false, error: `git add failed: ${addErr}` };
  }
  const { code: diffCode } = runGit(cwd, ["diff", "--cached", "--quiet"]);
  if (diffCode !== 0) {
    const { code, stderr } = runGit(cwd, ["commit", "-m", message]);
    if (code !== 0) {
      return { ok: false, error: `git commit failed: ${stderr}` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Primary lock helpers
// ---------------------------------------------------------------------------

export function ensureStorageDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export function writePrimaryLock(worktreePath: string, sessionId: string): void {
  const lock: PrimaryLock = { sessionId, linkedAt: Date.now() };
  fs.writeFileSync(
    path.join(worktreePath, PRIMARY_LOCK_FILE),
    JSON.stringify(lock, null, 2),
    "utf-8"
  );
}

export function removePrimaryLock(worktreePath: string): void {
  try { fs.rmSync(path.join(worktreePath, PRIMARY_LOCK_FILE), { force: true }); } catch { /* ok */ }
}

export function readPrimaryLock(worktreePath: string): PrimaryLock | null {
  return loadJsonSafe(path.join(worktreePath, PRIMARY_LOCK_FILE));
}

export function isPrimaryLockStale(lock: PrimaryLock, staleHours: number): boolean {
  return Date.now() - lock.linkedAt > staleHours * 3600 * 1000;
}

// ---------------------------------------------------------------------------
// Session reference file
// ---------------------------------------------------------------------------

export function getWorktreeSessionPath(worktreePath: string): string | null {
  try {
    return fs.readFileSync(path.join(worktreePath, SESSION_REF_FILE), "utf-8").trim() || null;
  } catch {
    return null;
  }
}

export function writeWorktreeSessionPath(worktreePath: string, sessionPath: string): void {
  fs.writeFileSync(path.join(worktreePath, SESSION_REF_FILE), sessionPath, "utf-8");
}

/**
 * Fix a session file whose header cwd is wrong.
 *
 * Pi's SessionManager.create() ignores its cwd argument and always writes
 * process.cwd() into the session header. This rewrites the first line to
 * set the correct cwd so the session loads with the right working directory.
 */
export function fixSessionCwd(sessionPath: string, correctCwd: string): void {
  const raw = fs.readFileSync(sessionPath, "utf-8");
  const newlineIdx = raw.indexOf("\n");
  if (newlineIdx < 0) return;
  const headerLine = raw.slice(0, newlineIdx);
  try {
    const header = JSON.parse(headerLine);
    if (header.cwd === correctCwd) return; // already correct
    header.cwd = correctCwd;
    const rest = raw.slice(newlineIdx);
    fs.writeFileSync(sessionPath, JSON.stringify(header) + rest, "utf-8");
  } catch {
    // Non-JSON header? Leave it alone.
  }
}

/**
 * Append an entry line to a session JSONL file.
 * Used as a workaround when SessionManager's appendCustomEntry doesn't
 * persist to disk immediately.
 */
export function appendEntryToFile(
  sessionPath: string,
  entry: Record<string, unknown>
): void {
  const fullEntry = {
    ...entry,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  };
  fs.appendFileSync(sessionPath, JSON.stringify(fullEntry) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Session detection
// ---------------------------------------------------------------------------

export function findWorktreeInfo(
  sm: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }> }
): WorktreeInfo | null {
  const entries = sm.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "custom" && e.customType === WORKTREE_INFO_TYPE) {
      return e.data as WorktreeInfo;
    }
  }
  return null;
}

function encodeWorktreeInfoFromEntry(
  e: { type: string; customType?: string; data?: unknown }
): WorktreeInfo | null {
  if (e.type === "custom" && e.customType === WORKTREE_INFO_TYPE) {
    return e.data as WorktreeInfo;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Worktree directory scanning
// ---------------------------------------------------------------------------

export function listWorktrees(repoRoot: string, config: WorktreeConfig): string[] {
  const storage = getWorktreeStoragePath(repoRoot, config);
  if (!fs.existsSync(storage)) return [];
  return fs
    .readdirSync(storage, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

// ── Verifications ──────────────────────────────────────────

/** Check that we're in a worktree session and optionally that we're primary. */
function requireWorktree(ctx: ExtensionCommandContext, primaryOnly = false): boolean {
  if (!isWorktreeSession || !worktreeInfo) {
    ctx.ui.notify("Not in a worktree session. Use /worktree:create or /worktree:attach first.", "error");
    return false;
  }
  if (primaryOnly && worktreeInfo.mode !== "primary") {
    ctx.ui.notify("Only the primary agent can do this.", "error");
    return false;
  }
  return true;
}

/** Check that we're in the main session. */
function requireMain(ctx: ExtensionCommandContext): boolean {
  if (isWorktreeSession) {
    ctx.ui.notify("Already in a worktree session. Run /worktree:unlink first.", "error");
    return false;
  }
  return true;
}

// ── Helpers ────────────────────────────────────────────────

function escapeCommitMsg(msg: string): string {
  // Replace single quotes in the commit message for shell safety
  return msg.replace(/'/g, "'\\''");
}

// ---------------------------------------------------------------------------
// Command registrations
// ---------------------------------------------------------------------------

type CmdFn = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function register(pi: ExtensionAPI, name: string, desc: string, fn: CmdFn): void {
  pi.registerCommand(`worktree:${name}`, { description: desc, handler: fn });
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ========================================================================
  // SESSION START — detect session type
  // ========================================================================

  pi.on("session_start", async (_event, ctx) => {
    // Reset per-session-instance state
    worktreeInfo = null;
    isWorktreeSession = false;
    turnCounter = 0;

    const entries = ctx.sessionManager.getEntries();
    const wtEntry = entries.find(
      (e: any) => e.type === "custom" && e.customType === WORKTREE_INFO_TYPE
    );

    process.stderr.write(
      `[worktree] session_start: cwd=${ctx.cwd} entries=${entries.length} has_wt=${!!wtEntry}\n`
    );

    const info = wtEntry ? encodeWorktreeInfoFromEntry(wtEntry) : null;
    if (info) {
      worktreeInfo = info;
      isWorktreeSession = true;
      try {
        process.chdir(ctx.cwd);
      } catch { /* non-fatal */ }
    }

    const config = info ? getConfig(info.repoRoot) : getConfig(ctx.cwd);
    if (config.statusLine) {
      ctx.ui.setStatus(
        "worktree",
        info
          ? `WT: ${info.name} (${info.mode}) @ ${ctx.cwd}`
          : `WT: none @ ${ctx.cwd}`
      );
    }
  });

  // ========================================================================
  // BEFORE AGENT START — inject worktree context into system prompt
  // ========================================================================

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!isWorktreeSession || !worktreeInfo) return;

    const prompt = (ctx.getSystemPrompt?.() ?? "");
    const autoCommitNote =
      worktreeInfo.mode === "primary"
        ? "Auto-commit is ON — changes are committed after each turn."
        : "Auto-commit is OFF. Use /worktree:commit to manually commit.";

    const contextBlock = [
      "",
      "[WORKTREE CONTEXT — CRITICAL]",
      `Your working directory is: ${ctx.cwd}`,
      `Git branch: ${worktreeInfo.branch}`,
      `Main repository: ${worktreeInfo.repoRoot}`,
      "",
      "FILE OPERATIONS: Always use paths relative to your working directory.",
      `Example: read(\"src/index.ts\") NOT read(\"${worktreeInfo.repoRoot}/src/index.ts\").`,
      "The working directory IS the worktree — all file changes go here.",
      "",
      autoCommitNote,
      "Commands: /worktree:accept (merge back), /worktree:unlink (leave), /worktree:status, /worktree:commit.",
    ].join("\n");

    return { systemPrompt: prompt + "\n" + contextBlock };
  });

  // ========================================================================
  // AGENT END — auto-commit for primary
  // ========================================================================

  pi.on("agent_end", async (_event, ctx) => {
    if (!isWorktreeSession || !worktreeInfo || worktreeInfo.mode !== "primary") return;
    const config = getConfig(worktreeInfo.repoRoot);
    if (!config.autoCommit) return;

    turnCounter++;
    const message = config.autoCommitTemplate.replace("{turn}", String(turnCounter));
    if (await gitStatus(ctx.cwd)) {
      const result = await gitCommit(ctx.cwd, message);
      if (!result.ok) {
        ctx.ui.setStatus("worktree", `WT: ${worktreeInfo!.name} (commit failed — ${result.error})`);
      }
    }
  });

  // ========================================================================
  // SESSION SHUTDOWN — final commit for primary
  // ========================================================================

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!isWorktreeSession || !worktreeInfo || worktreeInfo.mode !== "primary") return;
    if (!getConfig(worktreeInfo.repoRoot).autoCommit) return;
    if (await gitStatus(ctx.cwd)) {
      await gitCommit(ctx.cwd, "[pi-worktree] final commit before shutdown");
    }
  });

  // ========================================================================
  // COMMANDS
  // ========================================================================

  // ── /worktree:list ── always available
  register(pi, "list", "List all worktrees for this repo", async (_args, ctx) => {
    const repoRoot = worktreeInfo?.repoRoot ?? ctx.cwd;
    const config = getConfig(repoRoot);
    const names = listWorktrees(repoRoot, config);

    if (names.length === 0) {
      ctx.ui.notify("No worktrees found.", "info");
      return;
    }

    const currentPath = ctx.cwd;
    const lines = names.map((n) => {
      const wtPath = getWorktreePath(repoRoot, n, config);
      const active = worktreeInfo && wtPath === currentPath ? " [ACTIVE]" : "";
      return `${n} (${getWorktreeBranchName(n, repoRoot)})${active}`;
    });

    ctx.ui.notify(lines.join("\n"), "info");
  });

  // ── /worktree:status ── worktree session only
  register(pi, "status", "Show git status for the active worktree", async (_args, ctx) => {
    if (!requireWorktree(ctx)) return;

    const cwd = ctx.cwd;
    const { stdout: st } = runGit(cwd, ["status", "--short"]);
    const { stdout: diffStat } = runGit(cwd, [
      "diff", "--stat", worktreeInfo!.baseCommit,
    ]);
    const { stdout: log } = runGit(cwd, [
      "log", "-5", "--oneline", "--no-merges",
      `${worktreeInfo!.baseCommit}..HEAD`,
    ]);

    ctx.ui.notify(
      [
        `Worktree: ${worktreeInfo!.name}`,
        `Branch:   ${worktreeInfo!.branch}`,
        `Mode:     ${worktreeInfo!.mode}`,
        "",
        "─ Status ─",
        st || "(clean)",
        "",
        "─ Diff from base ─",
        diffStat || "(no changes)",
        "",
        "─ Recent commits ─",
        log || "(none)",
      ].join("\n"),
      "info"
    );
  });

  // ── /worktree:commit [message] ── manual commit
  register(pi, "commit", "Manually commit staged changes in the worktree", async (args, ctx) => {
    if (!requireWorktree(ctx)) return;

    const cwd = ctx.cwd;
    const dirty = await gitStatus(cwd);
    if (!dirty) {
      ctx.ui.notify("Nothing to commit (working tree clean).", "info");
      return;
    }

    // Show what will be committed
    const { stdout: staged } = runGit(cwd, ["status", "--short"]);
    ctx.ui.notify(`Changes to commit:\n${staged}`, "info");

    const message = args?.trim() || undefined;
    if (!message) {
      // Ask for a message
      const msg = await ctx.ui.input(
        "Commit message",
        `[pi-worktree] manual commit turn ${turnCounter + 1}`
      );
      if (!msg?.trim()) {
        ctx.ui.notify("Commit cancelled (empty message).", "info");
        return;
      }
      const result = await gitCommit(cwd, msg);
      if (!result.ok) {
        ctx.ui.notify(`Commit failed: ${result.error}`, "error");
        return;
      }
    } else {
      const result = await gitCommit(cwd, message);
      if (!result.ok) {
        ctx.ui.notify(`Commit failed: ${result.error}`, "error");
        return;
      }
    }

    ctx.ui.notify("Changes committed.", "info");
  });

  // ── /worktree:create <name> [base] ── main session only
  register(pi, "create", "Create a worktree and switch to a new session targeting it", async (args, ctx) => {
    if (!requireMain(ctx)) return;
    if (!args?.trim()) { ctx.ui.notify("Usage: /worktree:create <name> [base]", "error"); return; }

    const parts = args.trim().split(/\s+/);
    const name = parts[0];
    const base = parts[1] || undefined;

    const repoRoot = ctx.cwd;
    const config = getConfig(repoRoot);
    const branch = getWorktreeBranchName(name, repoRoot);
    const worktreePath = getWorktreePath(repoRoot, name, config);

    if (fs.existsSync(worktreePath)) {
      ctx.ui.notify(`Worktree '${name}' already exists. Use /worktree:attach.`, "error");
      return;
    }

    // Create the git worktree
    ensureStorageDir(getWorktreeStoragePath(repoRoot, config));
    const { code, stderr } = runGit(repoRoot, [
      "worktree", "add", "-b", branch, worktreePath, base || "HEAD",
    ]);
    if (code !== 0) {
      ctx.ui.notify(`Failed to create worktree: ${stderr}`, "error");
      return;
    }

    const baseCommit = await getCurrentCommit(worktreePath);
    if (!baseCommit) {
      ctx.ui.notify("Failed to determine base commit.", "error");
      runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
      return;
    }

    // Exclude lock files from git in the worktree
    try {
      fs.appendFileSync(
        path.join(worktreePath, ".git", "info", "exclude"),
        `\n${PRIMARY_LOCK_FILE}\n${SESSION_REF_FILE}\n`,
        "utf-8"
      );
    } catch { /* non-fatal */ }

    // Fork session into worktree (or create fresh as fallback)
    const mainSessionFile = ctx.sessionManager.getSessionFile();
    let sessionFile: string | undefined;

    if (mainSessionFile) {
      // Try forking: copies conversation history to the new session
      try {
        const worktreeSession = SessionManager.forkFrom(mainSessionFile, worktreePath);
        worktreeSession.appendCustomEntry(WORKTREE_INFO_TYPE, {
          repoRoot, branch, baseCommit, mode: "primary", name,
        } satisfies WorktreeInfo);
        writePrimaryLock(worktreePath, worktreeSession.getSessionId());
        sessionFile = worktreeSession.getSessionFile();
      } catch (e: any) {
        ctx.ui.notify(
          `Session fork failed: ${e.message}. Creating fresh session instead.`,
          "warning"
        );
        // Fall through to fresh-session path
      }
    }

    // Fallback: create a fresh session (no history, but functional)
    if (!sessionFile) {
      try {
        const freshSession = SessionManager.create(worktreePath);
        freshSession.appendCustomEntry(WORKTREE_INFO_TYPE, {
          repoRoot, branch, baseCommit, mode: "primary", name,
        } satisfies WorktreeInfo);
        freshSession.appendCustomMessageEntry(
          WORKTREE_INFO_TYPE,
          `You are now working in worktree '${name}' (branch: ${branch}). ` +
          `This is a git worktree created from the main repository at ${repoRoot}. ` +
          `All file operations target this worktree automatically. ` +
          `Run /worktree:accept to merge changes back into the main working directory.`,
          true
        );
        writePrimaryLock(worktreePath, freshSession.getSessionId());
        sessionFile = freshSession.getSessionFile();

        // Pi bugs:
        // 1. create() ignores cwd arg → fix the header
        // 2. appendCustomEntry doesn't persist to disk until Pi starts → write manually
        if (sessionFile) {
          fixSessionCwd(sessionFile, worktreePath);
          appendEntryToFile(sessionFile, {
            type: "custom",
            customType: WORKTREE_INFO_TYPE,
            data: { repoRoot, branch, baseCommit, mode: "primary", name },
          });
          appendEntryToFile(sessionFile, {
            type: "customMessage",
            customType: WORKTREE_INFO_TYPE,
            message: {
              role: "user",
              content: [{ type: "text", text:
                `You are now working in worktree '${name}' (branch: ${branch}). ` +
                `All file operations target this worktree automatically. ` +
                `Run /worktree:accept to merge changes back into ${repoRoot}.`
              }],
            },
            quiet: true,
          });
        }
      } catch (e: any) {
        ctx.ui.notify(`Failed to create session: ${e.message}`, "error");
        runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
        return;
      }
    }

    if (!sessionFile) {
      ctx.ui.notify("Failed to persist session file.", "error");
      runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
      return;
    }

    writeWorktreeSessionPath(worktreePath, sessionFile);

    // Defensive: ensure session cwd is the worktree (Pi create() may use process.cwd())
    try { fixSessionCwd(sessionFile, worktreePath); } catch { /* ok */ }

    try {
      await ctx.switchSession(sessionFile, {
        withSession: async (newCtx) => {
          newCtx.ui.notify(
            `Worktree '${name}' created as primary.\n` +
            `Branch: ${branch}\n` +
            `CWD: ${newCtx.cwd}\n` +
            `Base: ${baseCommit.slice(0, 7)}\n\n` +
            `Commands: /worktree:accept, /worktree:reset, /worktree:unlink, /worktree:status`,
            "info"
          );
        },
      });
    } catch (e: any) {
      ctx.ui.notify(`Session switch failed: ${e.message}. You are still at ${ctx.cwd}.
` +
        `Try attaching: /worktree:attach ${name}`, "error");
    }
  });

  // ── /worktree:attach [name] [--primary] ── main session only
  register(pi, "attach", "Switch to a worktree session", async (args, ctx) => {
    if (!requireMain(ctx)) return;

    const repoRoot = ctx.cwd;
    const config = getConfig(repoRoot);
    let name: string | undefined;
    let asPrimary = false;

    if (args?.trim()) {
      const parts = args.trim().split(/\s+/);
      name = parts[0];
      asPrimary = parts.includes("--primary");
    } else {
      const names = listWorktrees(repoRoot, config);
      if (names.length === 0) { ctx.ui.notify("No worktrees found.", "info"); return; }
      const choice = await ctx.ui.select("Select worktree:", names);
      if (!choice) return;
      name = choice;
    }

    if (!name) return;
    const worktreePath = getWorktreePath(repoRoot, name, config);
    if (!fs.existsSync(worktreePath)) {
      ctx.ui.notify(`Worktree '${name}' does not exist.`, "error");
      return;
    }

    let sessionPath = getWorktreeSessionPath(worktreePath);
    if (!sessionPath) {
      // Recovery: search for sessions whose cwd matches the worktree path
      const sessions = await SessionManager.list(worktreePath);
      if (sessions.length > 0) {
        // Use the most recently modified session
        sessionPath = sessions.sort(
          (a, b) => b.modified.getTime() - a.modified.getTime()
        )[0].path;
        // Write the ref file so next time it's fast
        writeWorktreeSessionPath(worktreePath, sessionPath);
      }
    }
    if (!sessionPath) {
      ctx.ui.notify(
        `No Pi session found for worktree '${name}'.\n\n` +
        `The worktree exists but has no associated Pi session. ` +
        `This can happen if the worktree was created outside Pi or if ` +
        `a previous /worktree:create failed partway through. ` +
        `Try /worktree:prune to remove it, then recreate.`,
        "error"
      );
      return;
    }

    // Handle primary lock
    const existingLock = readPrimaryLock(worktreePath);
    if (existingLock && !isPrimaryLockStale(existingLock, config.staleLockHours)) {
      if (asPrimary) {
        ctx.ui.notify(`Worktree '${name}' already has a primary agent. Attaching as secondary.`, "warning");
        asPrimary = false;
      }
    } else if (existingLock && isPrimaryLockStale(existingLock, config.staleLockHours)) {
      removePrimaryLock(worktreePath);
    }

    // If claiming primary, update session metadata
    if (asPrimary) {
      try {
        const wtSession = SessionManager.open(sessionPath, undefined, worktreePath);
        const wti: WorktreeInfo = {
          repoRoot, name,
          branch: await getCurrentBranch(worktreePath) || "unknown",
          baseCommit: await getCurrentCommit(worktreePath) || "unknown",
          mode: "primary",
        };
        wtSession.appendCustomEntry(WORKTREE_INFO_TYPE, wti);
        writePrimaryLock(worktreePath, wtSession.getSessionId());
      } catch (e: any) {
        ctx.ui.notify(`Failed to set primary: ${e.message}`, "error");
        return;
      }
    }

    try {
      await ctx.switchSession(sessionPath, {
        withSession: async (newCtx) => {
          newCtx.ui.notify(
            `Attached to worktree '${name}' as ${asPrimary ? "primary" : "secondary"}.\n` +
            `CWD: ${newCtx.cwd}`,
            "info"
          );
        },
      });
    } catch (e: any) {
      ctx.ui.notify(`Session switch failed: ${e.message}`, "error");
    }
  });

  // ── /worktree:prune [name] ── main session only
  register(pi, "prune", "Remove a worktree", async (args, ctx) => {
    if (!requireMain(ctx)) return;

    const repoRoot = ctx.cwd;
    const config = getConfig(repoRoot);
    let name: string | undefined;

    if (args?.trim()) {
      name = args.trim().split(/\s+/)[0];
    } else {
      const names = listWorktrees(repoRoot, config);
      if (names.length === 0) { ctx.ui.notify("No worktrees to prune.", "info"); return; }
      const choice = await ctx.ui.select("Select worktree to prune:", names);
      if (!choice) return;
      name = choice;
    }

    if (!name) return;
    const worktreePath = getWorktreePath(repoRoot, name, config);
    if (!fs.existsSync(worktreePath)) {
      ctx.ui.notify(`Worktree '${name}' does not exist.`, "error");
      return;
    }

    const ok = await ctx.ui.confirm(
      "Prune worktree?",
      `Remove worktree '${name}'? This cannot be undone.`
    );
    if (!ok) return;

    // Warn about unmerged commits
    const { stdout: ahead, code: aheadCode } = runGit(worktreePath, [
      "rev-list", "@{u}..HEAD", "--count",
    ]);
    if (aheadCode === 0 && parseInt(ahead.trim(), 10) > 0) {
      const ok2 = await ctx.ui.confirm(
        "Unmerged commits",
        `Branch has ${ahead.trim()} commit(s) ahead of upstream. Remove anyway?`
      );
      if (!ok2) return;
    }

    // 1. Remove the git worktree (directory + metadata)
    let { code: rmCode } = runGit(repoRoot, ["worktree", "remove", worktreePath]);
    if (rmCode !== 0) {
      rmCode = runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]).code;
    }
    if (rmCode !== 0 && fs.existsSync(worktreePath)) {
      // Last resort: force-delete the directory
      try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {
        ctx.ui.notify(`Failed to remove: ${worktreePath}`, "error");
        return;
      }
    }

    // 2. Prune stale worktree metadata (important if fs.rmSync was used)
    runGit(repoRoot, ["worktree", "prune"]);

    // 3. Delete the git branch
    const branch = getWorktreeBranchName(name, repoRoot);
    const { code: branchCode } = runGit(repoRoot, ["branch", "-D", branch]);

    // 4. Clean empty storage dir
    try {
      const sp = getWorktreeStoragePath(repoRoot, config);
      if (fs.existsSync(sp) && fs.readdirSync(sp).length === 0) fs.rmdirSync(sp);
    } catch { /* ok */ }

    removePrimaryLock(worktreePath);
    ctx.ui.notify(
      `Worktree '${name}' removed${branchCode === 0 ? " and branch deleted." : " (branch cleanup skipped)."}`,
      "info"
    );
  });

  // ── /worktree:unlink ── worktree session only
  register(pi, "unlink", "Switch back to the main session", async (_args, ctx) => {
    if (!requireWorktree(ctx)) return;

    const repoRoot = worktreeInfo!.repoRoot;
    const sessions = await SessionManager.list(repoRoot);
    const mainSession = sessions.find((s) => s.cwd === repoRoot);

    if (!mainSession) {
      ctx.ui.notify(`No main Pi session found for ${repoRoot}.`, "error");
      return;
    }

    await ctx.switchSession(mainSession.path, {
      withSession: async (newCtx) => {
        // Restore process.cwd() to the main working directory
        try { process.chdir(repoRoot); } catch { /* ok */ }
        newCtx.ui.notify(`Unlinked from '${worktreeInfo!.name}'. Back in main working directory.`, "info");
      },
    });
  });

  // ── /worktree:accept ── worktree session only, primary only
  register(pi, "accept", "Squash worktree commits and merge into main WD", async (_args, ctx) => {
    if (!requireWorktree(ctx, true)) return;

    const { repoRoot, branch, baseCommit, name } = worktreeInfo!;
    const cwd = ctx.cwd;

    // 0. Determine the target branch (currently checked out in the main WD)
    const targetBranch = await getCurrentBranch(repoRoot);
    if (!targetBranch) {
      ctx.ui.notify("Could not determine the target branch in the main working directory.", "error");
      return;
    }

    // 1. Check main WD is clean (git merge --squash requires it)
    if (await gitStatus(repoRoot)) {
      const continueAnyway = await ctx.ui.confirm(
        "Main WD has uncommitted changes",
        "The main working directory has uncommitted changes. Continue? Changes may cause conflicts."
      );
      if (!continueAnyway) return;
    }

    // 2. Confirm — show both source and target
    const ok = await ctx.ui.confirm(
      "Accept worktree?",
      `Squash all commits from worktree '${name}' (branch: ${branch})` +
        `\ninto main WD branch '${targetBranch}'?`
    );
    if (!ok) return;

    // 3. Auto-commit any dirty changes in the worktree
    if (await gitStatus(cwd)) {
      await gitCommit(cwd, "[pi-worktree] auto-commit before accept");
    }

    // 4. Show commit log so the user can craft a message
    const { stdout: logOut } = runGit(cwd, [
      "log", "--oneline", "--no-merges", `${baseCommit}..HEAD`,
    ]);

    if (!logOut.trim()) {
      ctx.ui.notify("No commits to accept.", "info");
      return;
    }

    ctx.ui.notify(`Commits to be merged into ${targetBranch}:\n${logOut}`, "info");

    // 5. Get commit message from user
    const message = await ctx.ui.input(
      "Commit message for the squash",
      `[pi-worktree] accept '${name}'`
    );
    if (!message?.trim()) {
      ctx.ui.notify("Accept cancelled (empty message).", "info");
      return;
    }

    // 6. Squash-merge into main WD
    const { code: mergeCode, stderr: mergeErr } = runGit(repoRoot, [
      "merge", "--squash", branch,
    ]);

    if (mergeCode !== 0) {
      runGit(repoRoot, ["merge", "--abort"]);
      runGit(repoRoot, ["reset", "--hard", "HEAD"]);
      ctx.ui.notify(
        `Merge into '${targetBranch}' failed (may have conflicting changes):\n${mergeErr}`,
        "error"
      );
      return;
    }

    // 7. Commit the squashed changes
    const { code: commitCode, stderr: commitErr } = runGit(repoRoot, [
      "commit", "-m", escapeCommitMsg(message),
    ]);

    if (commitCode !== 0) {
      runGit(repoRoot, ["reset", "HEAD"]);
      ctx.ui.notify(`Commit failed: ${commitErr}`, "error");
      return;
    }

    ctx.ui.notify(
      `Worktree '${name}' accepted into ${targetBranch}.` +
        `\nUse /worktree:unlink to switch back, /worktree:prune to clean up.`,
      "info"
    );
  });

  // ── /worktree:reset ── worktree session only, primary only
  register(pi, "reset", "Interactive hard reset to a worktree commit", async (_args, ctx) => {
    if (!requireWorktree(ctx, true)) return;

    const cwd = ctx.cwd;
    const { baseCommit } = worktreeInfo!;
    const { stdout: logOut } = runGit(cwd, [
      "log", "-30", "--oneline", "--no-merges", `${baseCommit}..HEAD`,
    ]);

    if (!logOut.trim()) {
      ctx.ui.notify("No worktree commits to reset to.", "info");
      return;
    }

    const lines = logOut.trim().split("\n");
    const choice = await ctx.ui.select("Select commit to reset to:", lines);
    if (!choice) return;

    const hash = choice.split(" ")[0];
    const ok = await ctx.ui.confirm(
      "Hard reset?",
      `Reset to ${hash}? Uncommitted changes will be committed first.`
    );
    if (!ok) return;

    // Auto-commit before reset
    if (await gitStatus(cwd)) {
      await gitCommit(cwd, "[pi-worktree] checkpoint before reset");
    }

    const { code, stderr } = runGit(cwd, ["reset", "--hard", hash]);
    if (code !== 0) {
      ctx.ui.notify(`Reset failed: ${stderr}`, "error");
    } else {
      ctx.ui.notify(`Reset to ${hash}.`, "info");
    }
  });
}
