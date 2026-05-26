// ============================================================
// worktree — Git worktree management extension
// ============================================================
// Supports creating, listing, and deleting git worktrees.
// Each worktree lives under ~/.pi/worktrees/<encoded-cwd>/
// and has a dedicated pi session rooted at the worktree directory.
//
// Worktrees and sessions are decoupled — the registry only tracks
// worktree metadata. Sessions are managed independently by pi's
// session manager.
//
// Commands:
//   /worktree:prepare-session <name>  Create worktree + tell LLM to use worktree
//   /worktree:open                    Select worktree and fork into it
//   /worktree:delete                  Interactively select and delete a worktree
//   /worktree:close                   Fork back to the original project directory
//   /worktree:list                    List all managed worktrees
//
// Registry:
//   ~/.pi/worktrees/<encoded-cwd>/registry.json
//   Maps worktree name -> { path, createdAt, baseRef }
// ============================================================

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as os from "node:os";

// ── Logging ──────────────────────────────────────────────────

const LOG_FILE = path.join(os.homedir(), ".pi", "worktree.log");

function log(msg: string): void {
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
  } catch {
    // best-effort
  }
}

// ── Path helpers ────────────────────────────────────────────

/** Top-level worktrees directory in the user's home. */
export function getWorktreeHomeDir(): string {
  return path.resolve(os.homedir(), ".pi", "worktrees");
}

/**
 * Encode a cwd into a safe directory name, matching the scheme
 * used by pi's session manager for session directories.
 */
function encodeCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Per-project directory for worktrees registered from a given cwd. */
export function getWorktreeProjectDir(cwd: string): string {
  return path.join(getWorktreeHomeDir(), encodeCwd(cwd));
}

/** Registry file for a project. Automatically normalizes cwd —
 * if the cwd is inside a worktree, resolves to the parent project dir. */
export function getRegistryPath(cwd: string): string {
  return path.join(getWorktreeProjectDir(cwd), "registry.json");
}

/** Check if a cwd is inside a worktree directory. */
function isInsideWorktree(cwd: string): boolean {
  return path.resolve(cwd).startsWith(getWorktreeHomeDir() + path.sep);
}

/** Derive the project directory that owns a given cwd.
 * If cwd is inside ~/.pi/worktrees/<project>/..., returns <project>.
 * Otherwise returns getWorktreeProjectDir(cwd). */
function resolveProjectDir(cwd: string): string {
  const resolved = path.resolve(cwd);
  const homeDir = getWorktreeHomeDir();
  if (resolved.startsWith(homeDir + path.sep)) {
    const relative = resolved.slice(homeDir.length + 1);
    const encoded = relative.split(path.sep)[0];
    const projectDir = path.join(homeDir, encoded);
    if (fs.existsSync(path.join(projectDir, "registry.json"))) {
      return projectDir;
    }
  }
  return getWorktreeProjectDir(cwd);
}

/** Derive the original project cwd from a potentially-worktree cwd,
 * using the first worktree entry's originalCwd as a hint. */
function resolveProjectCwd(ctxCwd: string): string {
  const projectDir = resolveProjectDir(ctxCwd);
  const registry = readRegistryFromDir(projectDir);
  for (const entry of Object.values(registry.worktrees)) {
    if (entry.originalCwd) return entry.originalCwd;
  }
  return ctxCwd;
}

function readRegistryFromDir(projectDir: string): Registry {
  const registryPath = path.join(projectDir, "registry.json");
  try {
    const raw = fs.readFileSync(registryPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { worktrees: {} };
  }
}

function writeRegistryToDir(projectDir: string, registry: Registry): void {
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "registry.json"), JSON.stringify(registry, null, 2) + "\n");
}

/** Full path to a specific worktree on disk. */
export function getWorktreePath(cwd: string, worktreeName: string): string {
  return path.join(getWorktreeProjectDir(cwd), worktreeName);
}

// ── Git helpers ──────────────────────────────────────────────

export function getCurrentBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "HEAD";
  }
}

export function getShortHash(ref: string = "HEAD"): string {
  try {
    return execSync(`git rev-parse --short ${ref}`, { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

export function buildWorktreeName(shortHash: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${safe}-${shortHash}`;
}

// ── Registry ────────────────────────────────────────────────

export interface WorktreeEntry {
  /** Full absolute path to the git worktree on disk. */
  path: string;
  createdAt: string;
  baseRef: string;
  /** The cwd where the worktree was created from. */
  originalCwd: string;
}

export interface Registry {
  worktrees: Record<string, WorktreeEntry>;
}

export function readRegistry(cwd: string): Registry {
  return readRegistryFromDir(resolveProjectDir(cwd));
}

export function writeRegistry(cwd: string, registry: Registry): void {
  writeRegistryToDir(resolveProjectDir(cwd), registry);
}

// ── Core logic ───────────────────────────────────────────────

export interface CreateResult {
  error?: string;
  worktreeName?: string;
  worktreePath?: string;
}

export async function createWorktree(
  pi: ExtensionAPI,
  ctx:  ExtensionCommandContext,
  name: string,
  base?: string
): Promise<CreateResult> {
  // Use the original project cwd for path and registry lookups,
  // even if the current session is inside a worktree.
  const projectCwd = resolveProjectCwd(ctx.cwd);
  try {
    execSync("git rev-parse --git-dir", { encoding: "utf-8", stdio: "pipe" });
  } catch {
    return { error: "Not a git repository. Initialize git first." };
  }

  const baseRef = base ?? getCurrentBranch();
  const shortHash = getShortHash(baseRef);
  const worktreeName = buildWorktreeName(shortHash, name);
  const worktreePath = getWorktreePath(ctx.cwd, worktreeName);

  log(`createWorktree: name=${name} base=${baseRef} worktreeName=${worktreeName} cwd=${ctx.cwd} path=${worktreePath}`);

  // Check if already exists on disk
  if (fs.existsSync(worktreePath)) {
    return { error: `Worktree path already exists: ${worktreePath}` };
  }

  // Check if already registered
  const registry = readRegistry(ctx.cwd);
  if (registry.worktrees[worktreeName]) {
    return { error: `Worktree "${worktreeName}" already registered.` };
  }

  // Create the git worktree
  log(`createWorktree: git worktree add -b ${worktreeName} ${worktreePath} ${baseRef}`);
  const addResult = await pi.exec("git", [
    "worktree", "add", "-b", worktreeName, worktreePath, baseRef,
  ]);

  if (addResult.code !== 0) {
    log(`createWorktree: git worktree add FAILED: ${addResult.stderr || addResult.stdout}`);
    const stderr = (addResult.stderr || "").toLowerCase();
    if (stderr.includes("already exists")) {
      return {
        error: `A branch named "${worktreeName}" already exists. ` +
          `Use a different worktree name.`,
      };
    }
    return { error: `git worktree add failed: ${addResult.stderr || addResult.stdout}` };
  }

  // Register
  registry.worktrees[worktreeName] = {
    path: worktreePath,
    createdAt: new Date().toISOString(),
    baseRef,
    originalCwd: projectCwd,
  };
  writeRegistry(projectCwd, registry);
  log(`createWorktree: registry updated for ${worktreeName}`);

  return { worktreeName, worktreePath };
}

// ── Fork into worktree ─────────────────────────────────────

export interface ForkResult {
  error?: string;
  worktreeName?: string;
  worktreePath?: string;
}

export async function forkWorktree(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  worktreeName: string
): Promise<ForkResult> {
  log(`forkWorktree: name=${worktreeName}`);

  const registry = readRegistry(ctx.cwd);
  const entry = registry.worktrees[worktreeName];

  if (!entry) {
    return { error: `Worktree "${worktreeName}" not found in registry.` };
  }

  // Get current session to fork from
  const sourceSessionPath = ctx.sessionManager.getSessionFile();
  if (!sourceSessionPath) {
    return {
      error:
        "No current session file to fork from. " +
        "Start a conversation first so there is a session to copy into the worktree.",
    };
  }

  const absoluteWorktreePath = entry.path;
  log(`forkWorktree: forkFrom ${sourceSessionPath} -> ${absoluteWorktreePath}`);

  let forkedSm: ReturnType<typeof SessionManager.forkFrom>;
  try {
    forkedSm = SessionManager.forkFrom(sourceSessionPath, absoluteWorktreePath);
  } catch (err: any) {
    log(`forkWorktree: forkFrom failed: ${err.message ?? String(err)}`);
    return { error: `Failed to fork session: ${err.message ?? String(err)}` };
  }

  const sessionFile = forkedSm.getSessionFile();
  if (!sessionFile) {
    return { error: "Failed to create session file for forked session." };
  }

  log(`forkWorktree: forked session file: ${sessionFile}`);

  // Switch to the forked session
  log(`forkWorktree: switching to session ${sessionFile}`);
  await ctx.switchSession(sessionFile, {
    withSession: async (newCtx: any) => {
      newCtx.ui.notify(
        `Joined worktree "${worktreeName}" at ${entry.path}.`,
        "info"
      );
      await newCtx.sendUserMessage(
        "You were moved to a new directory. You should now apply changes and excute changes on this directory. List directory files."
      );
    },
  });
  log(`forkWorktree: switch complete`);

  return {
    worktreeName,
    worktreePath: entry.path,
  };
}

// ── Delete worktree ────────────────────────────────────────

export interface DeleteResult {
  error?: string;
}

export async function deleteWorktree(
  pi: ExtensionAPI,
  ctx: any,
  worktreeName: string
): Promise<DeleteResult> {
  log(`deleteWorktree: name=${worktreeName}`);

  // Use the original cwd from the registry for path resolution,
  // since the current cwd may be different (e.g. inside a worktree).
  // Look up the worktree first to get its originalCwd.
  const registry = readRegistry(ctx.cwd);
  const entry = registry.worktrees[worktreeName];

  if (!entry) {
    log(`deleteWorktree: not found in registry`);
    return { error: `Worktree "${worktreeName}" not found in registry.` };
  }

  // Refuse to delete the worktree the current session is in
  const currentCwd = ctx.sessionManager.getCwd();
  if (currentCwd && currentCwd === entry.path) {
    return {
      error:
        `Cannot delete worktree "${worktreeName}" while your session is inside it. ` +
        `Switch to a different session first.`,
    };
  }

  // Remove the git worktree (deletes directory and files)
  log(`deleteWorktree: removing git worktree ${entry.path}`);
  const removeResult = await pi.exec("git", ["worktree", "remove", "--force", entry.path]);
  if (removeResult.code !== 0) {
    log(`deleteWorktree: git remove FAILED: ${removeResult.stderr || removeResult.stdout}`);
    if (!fs.existsSync(entry.path)) {
      log(`deleteWorktree: directory missing, pruning`);
      await pi.exec("git", ["worktree", "prune"]);
    } else {
      return {
        error: `git worktree remove failed: ${removeResult.stderr || removeResult.stdout}`,
      };
    }
  }

  // Update registry
  delete registry.worktrees[worktreeName];
  writeRegistry(ctx.cwd, registry);
  log(`deleteWorktree: registry updated, worktree ${worktreeName} removed`);

  // Clean up empty project directory
  const projectDir = resolveProjectDir(ctx.cwd);
  const remaining = Object.keys(registry.worktrees).length;
  if (remaining === 0) {
    try {
      const registryPath = path.join(projectDir, "registry.json");
      if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
      fs.rmdirSync(projectDir);
      log(`deleteWorktree: removed empty project dir ${projectDir}`);

      // Also remove the top-level worktrees dir if empty
      const homeDir = getWorktreeHomeDir();
      const homeEntries = fs.readdirSync(homeDir).filter((n) => !n.startsWith("."));
      if (homeEntries.length === 0) {
        fs.rmdirSync(homeDir);
        log(`deleteWorktree: removed empty worktrees dir ${homeDir}`);
      }
    } catch (err: any) {
      log(`deleteWorktree: cleanup warning: ${err.message ?? String(err)}`);
    }
  }

  return {};
}

// ── List worktrees ─────────────────────────────────────────

export function listWorktrees(ctx: any): string[] {
  const registry = readRegistry(ctx.cwd);
  const currentCwd = ctx.sessionManager.getCwd();
  const lines: string[] = [];

  for (const [name, entry] of Object.entries(registry.worktrees)) {
    const marker = currentCwd && currentCwd === entry.path ? " ← current" : "";
    const missing = !fs.existsSync(entry.path) ? " [directory missing]" : "";
    lines.push(`${name}  base=${entry.baseRef}${marker}${missing}`);
  }

  return lines;
}

// ── Extension entry point ────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ==========================================================
  // Commands
  // ==========================================================

  pi.registerCommand("worktree:prepare-session", {
    description: "Prepare a worktree so the LLM knows it will be moved: /worktree:prepare-session <name>",
    handler: async (args, ctx) => {
      if (isInsideWorktree(ctx.cwd)) {
        ctx.ui.notify("Cannot prepare a worktree from inside a worktree. Use /worktree:close first.", "error");
        return;
      }

      const name = (args ?? "").trim().split(/\s+/)[0];

      if (!name) {
        ctx.ui.notify("Usage: /worktree:prepare-session <name>", "error");
        return;
      }

      // Check if worktree already exists
      const shortHash = getShortHash(getCurrentBranch());
      const worktreeName = buildWorktreeName(shortHash, name);
      const registry = readRegistry(ctx.cwd);

      if (!registry.worktrees[worktreeName]) {
        const result = await createWorktree(pi, ctx, name);
        if (result.error) {
          ctx.ui.notify(result.error, "error");
          return;
        }
        ctx.ui.notify(`Worktree "${result.worktreeName}" created.`, "info");
      }

      pi.sendUserMessage(
        `You are about to be moved to worktree "${getWorktreeProjectDir(ctx.cwd)}/${worktreeName}". ` +
        `Make no action — do not call any tools. Wait for the user to run /worktree:open.`
      );
    },
  });

  pi.registerCommand("worktree:open", {
    description: "Select a worktree and fork the current session into it",
    handler: async (_args, ctx) => {
      if (isInsideWorktree(ctx.cwd)) {
        ctx.ui.notify("Already in a worktree. Use /worktree:close first.", "error");
        return;
      }

      const registry = readRegistry(ctx.cwd);
      const names = Object.keys(registry.worktrees);

      if (names.length === 0) {
        ctx.ui.notify("No worktrees available. Use /worktree:prepare-session <name> first.", "info");
        return;
      }

      const choice = await ctx.ui.select(
        "Select worktree to join:",
        names.map((n) => {
          const e = registry.worktrees[n];
          return `${n}  (${e.baseRef})`;
        })
      );

      if (!choice) {
        ctx.ui.notify("Join cancelled.", "info");
        return;
      }

      const worktreeName = choice.split("  ")[0];
      const result = await forkWorktree(pi, ctx, worktreeName);
      if (result.error) {
        ctx.ui.notify(result.error, "error");
      }
    },
  });

  pi.registerCommand("worktree:delete", {
    description: "Interactively select and delete a worktree",
    handler: async (_args, ctx) => {
      if (isInsideWorktree(ctx.cwd)) {
        ctx.ui.notify("Cannot delete worktrees from inside a worktree. Use /worktree:close first.", "error");
        return;
      }

      const registry = readRegistry(ctx.cwd);
      const currentCwd = ctx.sessionManager.getCwd();

      // Filter out worktrees matching the current session cwd
      const names = Object.keys(registry.worktrees).filter((n) => {
        const entry = registry.worktrees[n];
        return currentCwd !== entry.path;
      });

      if (names.length === 0) {
        ctx.ui.notify("No worktrees available to delete.", "info");
        return;
      }

      const choice = await ctx.ui.select(
        "Select worktree to delete:",
        names.map((n) => {
          const e = registry.worktrees[n];
          return `${n}  (${e.baseRef})`;
        })
      );

      if (!choice) {
        ctx.ui.notify("Delete cancelled.", "info");
        return;
      }

      const worktreeName = choice.split("  ")[0];
      const result = await deleteWorktree(pi, ctx, worktreeName);
      if (result.error) {
        ctx.ui.notify(result.error, "error");
        return;
      }
      ctx.ui.notify(`Worktree "${worktreeName}" deleted.`, "info");
    },
  });

  pi.registerCommand("worktree:list", {
    description: "List all managed worktrees",
    handler: async (_args, ctx) => {
      if (isInsideWorktree(ctx.cwd)) {
        ctx.ui.notify("Cannot list worktrees from inside a worktree. Use /worktree:close first.", "error");
        return;
      }

      const lines = listWorktrees(ctx);
      if (lines.length === 0) {
        ctx.ui.notify("No worktrees registered.", "info");
        return;
      }
      await ctx.ui.select("Worktrees:", lines);
    },
  });

  pi.registerCommand("worktree:close", {
    description: "Fork the current session back to the original project directory",
    handler: async (_args, ctx) => {
      const currentCwd = ctx.sessionManager.getCwd();
      const registry = readRegistry(ctx.cwd);

      // Find the worktree matching the current cwd
      let worktreeEntry: WorktreeEntry | undefined;
      for (const entry of Object.values(registry.worktrees)) {
        if (entry.path === currentCwd) {
          worktreeEntry = entry;
          break;
        }
      }

      if (!worktreeEntry) {
        ctx.ui.notify("Current session is not inside a worktree.", "error");
        return;
      }

      const sourceSessionPath = ctx.sessionManager.getSessionFile();
      if (!sourceSessionPath) {
        ctx.ui.notify("No current session file to fork from.", "error");
        return;
      }

      const originalCwd = worktreeEntry.originalCwd;
      log(`worktree:close: forkFrom ${sourceSessionPath} -> ${originalCwd}`);

      let forkedSm: ReturnType<typeof SessionManager.forkFrom>;
      try {
        forkedSm = SessionManager.forkFrom(sourceSessionPath, originalCwd);
      } catch (err: any) {
        ctx.ui.notify(`Failed to fork session: ${err.message ?? String(err)}`, "error");
        return;
      }

      const sessionFile = forkedSm.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("Failed to create session file.", "error");
        return;
      }

      await ctx.switchSession(sessionFile, {
        withSession: async (newCtx: any) => {
          newCtx.ui.notify(
            `Closed worktree. Returned to ${originalCwd}.`,
            "info"
          );
          await newCtx.sendUserMessage(
            "You have been moved back to the original project directory. All work should now be done relative to this directory."
          );
        },
      });
    },
  });
}
