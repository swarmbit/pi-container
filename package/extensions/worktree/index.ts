// ============================================================
// worktree — Git worktree management extension
// ============================================================
// Supports creating, listing, and deleting git worktrees.
// Each worktree lives under .pi/worktrees/
// and has a dedicated pi session rooted at the worktree directory.
//
// Create behavior:
//   - If no session is active (ephemeral): creates a fresh session
//     via SessionManager.create(worktreePath).
//   - If a session is active: forks it via SessionManager.forkFrom()
//     into the worktree, carrying full conversation history.
//
// Delete behavior:
//   - Removes the git worktree (directory + files) via git.
//   - Deletes the associated session file from disk.
//   - If the deleted session is the current one, prompts to switch
//     to another session first.
//
// Commands:
//   /worktree-create <name>.        Create a new worktree + session
//   /worktree-delete                Interactively select and delete a worktree
//   /worktree-list                  List all managed worktrees
//
// Tools (LLM-callable):
//   worktree_create  - Create a new git worktree + session
//   worktree_delete  - Delete a git worktree and its session
//   worktree_list    - List all registered worktrees
//
// Registry:
//   /workdir/.pi/worktrees/.registry.json
//   Maps worktree name -> { path, sessionFile, createdAt, baseRef }
//
// What if we delete the worktree but not the session?
//   The session file still exists but its cwd (the worktree directory)
//   no longer exists. Pi will fail with a "missing session cwd" error
//   when trying to load it. The extension always deletes both together.
//   Listing worktrees marks orphaned entries with "[directory missing]".
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

// ── Constants ────────────────────────────────────────────────

export const WORKTREES_DIR = ".pi/worktrees";
export const REGISTRY_FILE = path.join(WORKTREES_DIR, ".registry.json");

export interface WorktreeEntry {
  path: string;
  sessionFile: string;
  createdAt: string;
  baseRef: string;
}

export interface Registry {
  worktrees: Record<string, WorktreeEntry>;
}

// ── Registry helpers ─────────────────────────────────────────

export function readRegistry(): Registry {
  try {
    const raw = fs.readFileSync(REGISTRY_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { worktrees: {} };
  }
}

export function writeRegistry(registry: Registry): void {
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2) + "\n");
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
  return `${shortHash}_${safe}`;
}

// ── Core logic ───────────────────────────────────────────────

export interface CreateResult {
  error?: string;
  worktreeName?: string;
  worktreePath?: string;
  sessionFile?: string;
  /** Whether we forked from an existing session (vs created new) */
  forked?: boolean;
}

export async function createWorktree(
  pi: ExtensionAPI,
  ctx: any,
  name: string
): Promise<CreateResult> {
  const shortHash = getShortHash("HEAD");
  const worktreeName = buildWorktreeName(shortHash, name);
  const worktreePath = path.join(WORKTREES_DIR, worktreeName);

  // Check if already exists on disk
  if (fs.existsSync(worktreePath)) {
    return { error: `Worktree path already exists: ${worktreePath}` };
  }

  // Check if already registered
  const registry = readRegistry();
  if (registry.worktrees[worktreeName]) {
    return { error: `Worktree "${worktreeName}" already registered.` };
  }

  // 1. Create the git worktree with a new branch named after the worktree.
  //    Using -b creates a fresh branch so there's no "already checked out"
  //    conflict with the base ref.
  const baseRef = getCurrentBranch();
  const addResult = await pi.exec("git", [
    "worktree", "add", "-b", worktreeName, worktreePath, baseRef,
  ]);

  if (addResult.code !== 0) {
    const stderr = (addResult.stderr || "").toLowerCase();
    if (stderr.includes("already exists")) {
      return {
        error: `A branch named "${worktreeName}" already exists. ` +
          `Use a different worktree name.`,
      };
    }
    return { error: `git worktree add failed: ${addResult.stderr || addResult.stdout}` };
  }

  // 2. Create or fork a session rooted at the worktree directory
  const currentSessionFile = ctx.sessionManager.getSessionFile();
  let newSm: SessionManager;
  let forked = false;

  try {
    if (currentSessionFile) {
      // Active session exists → try to fork it into the worktree.
      // If the session file is empty/invalid (e.g. freshly started pi
      // with no messages yet), fall back to creating a fresh session.
      try {
        newSm = SessionManager.forkFrom(currentSessionFile, worktreePath);
        forked = true;
      } catch (forkErr: any) {
        const msg = (forkErr.message ?? "").toLowerCase();
        if (msg.includes("empty") || msg.includes("invalid")) {
          newSm = SessionManager.create(worktreePath);
        } else {
          throw forkErr;
        }
      }
    } else {
      // No active session (ephemeral) → create a fresh session
      newSm = SessionManager.create(worktreePath);
    }

    // Set the session display name to the worktree name
    newSm.appendSessionInfo(worktreeName);

    // Store worktree metadata in the session for context
    newSm.appendCustomEntry("worktree", {
      worktreeName: worktreeName,
      worktreePath: worktreePath,
      baseRef,
      createdAt: new Date().toISOString(),
      forked,
    });

    const sessionFile = newSm.getSessionFile();
    if (!sessionFile) {
      // Clean up git worktree
      await pi.exec("git", ["worktree", "remove", "--force", worktreePath]);
      return { error: "Failed to create session file." };
    }

    // 3. Record in persistent registry
    registry.worktrees[worktreeName] = {
      path: worktreePath,
      sessionFile,
      createdAt: new Date().toISOString(),
      baseRef,
    };
    writeRegistry(registry);

    // 4. Switch to the new session
    await ctx.switchSession(sessionFile, {
      withSession: async (_newCtx: any) => {
        // Session is now active with the worktree as cwd
      },
    });

    return {
      worktreeName: worktreeName,
      worktreePath: worktreePath,
      sessionFile,
      forked,
    };
  } catch (err: any) {
    // Roll back the git worktree on failure
    await pi.exec("git", ["worktree", "remove", "--force", worktreePath]);
    return { error: `Session setup failed: ${err.message ?? String(err)}` };
  }
}

export interface DeleteResult {
  error?: string;
  switchedTo?: string;
}

export async function deleteWorktree(
  pi: ExtensionAPI,
  ctx: any,
  worktreeName: string
): Promise<DeleteResult> {
  const registry = readRegistry();
  const entry = registry.worktrees[worktreeName];

  if (!entry) {
    return { error: `Worktree "${worktreeName}" not found in registry.` };
  }

  const currentSessionFile = ctx.sessionManager.getSessionFile();

  // If the session we're about to delete is the current one,
  // we must switch to another session first.
  let switchedTo: string | undefined;
  if (currentSessionFile && currentSessionFile === entry.sessionFile) {
    const allSessions = await SessionManager.list(ctx.cwd);
    const otherSessions = allSessions.filter((s) => s.path !== entry.sessionFile);

    if (otherSessions.length === 0) {
      return {
        error:
          "Cannot delete the only remaining session while in it. " +
          "Create another session first, or switch to a different project.",
      };
    }

    const choices = otherSessions.map(
      (s) => `${s.path}${s.name ? `  (${s.name})` : ""}`
    );
    const choice = await ctx.ui.select(
      "Current session is tied to this worktree. Switch to:",
      choices
    );
    if (!choice) {
      return { error: "Delete cancelled — no session to switch to." };
    }

    // Extract the session path from the choice string
    const chosenPath = choice.split("  ")[0];
    await ctx.switchSession(chosenPath, {
      withSession: async (_newCtx: any) => {
        // Silently switched
      },
    });
    switchedTo = chosenPath;
  }

  // Remove the git worktree (deletes directory and files)
  const removeResult = await pi.exec("git", ["worktree", "remove", "--force", entry.path]);
  if (removeResult.code !== 0) {
    // If the directory is already gone (manual deletion), prune from git and continue
    if (!fs.existsSync(entry.path)) {
      await pi.exec("git", ["worktree", "prune"]);
    } else {
      return {
        error: `git worktree remove failed: ${removeResult.stderr || removeResult.stdout}`,
      };
    }
  }

  // Delete the associated session file
  try {
    if (fs.existsSync(entry.sessionFile)) {
      fs.unlinkSync(entry.sessionFile);
    }
  } catch (err: any) {
    // Non-fatal: session file may already be gone
  }

  // Update registry
  delete registry.worktrees[worktreeName];
  writeRegistry(registry);

  return { switchedTo };
}

export function listWorktrees(ctx: any): string[] {
  const registry = readRegistry();
  const currentFile = ctx.sessionManager.getSessionFile();
  const lines: string[] = [];

  for (const [name, entry] of Object.entries(registry.worktrees)) {
    const marker = entry.sessionFile === currentFile ? " ← current" : "";
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

  pi.registerCommand("worktree-create", {
    description: "Create a new git worktree: /worktree-create <name> [base]",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const name = parts[0];

      if (!name) {
        ctx.ui.notify("Usage: /worktree-create <name>", "error");
        return;
      }

      const result = await createWorktree(pi, ctx, name);
      if (result.error) {
        ctx.ui.notify(result.error, "error");
      } else {
        const mode = result.forked ? "Forked session →" : "New session at";
        ctx.ui.notify(
          `${mode} ${result.worktreePath}\nWorktree "${result.worktreeName}" ready.`,
          "info"
        );
      }
    },
  });

  pi.registerCommand("worktree-delete", {
    description: "Interactively select and delete a worktree",
    handler: async (_args, ctx) => {
      const registry = readRegistry();
      const names = Object.keys(registry.worktrees);

      if (names.length === 0) {
        ctx.ui.notify("No worktrees to delete.", "info");
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
      } else {
        ctx.ui.notify(
          `Worktree "${worktreeName}" deleted.${result.switchedTo ? ` Switched to: ${result.switchedTo}` : ""}`,
          "info"
        );
      }
    },
  });

  pi.registerCommand("worktree-list", {
    description: "List all managed worktrees",
    handler: async (_args, ctx) => {
      const lines = listWorktrees(ctx);
      if (lines.length === 0) {
        ctx.ui.notify("No worktrees registered.", "info");
        return;
      }
      await ctx.ui.select("Worktrees:", lines);
    },
  });

  // ==========================================================
  // Tools (LLM-callable)
  // ==========================================================

  pi.registerTool({
    name: "worktree_create",
    label: "Create Worktree",
    description:
      "Create a new git worktree at .pi/worktrees/<hash>_<name> " +
      "and set up a dedicated pi session rooted at the worktree. " +
      "If a session is active, it is forked (full history copied); " +
      "otherwise a fresh session is created.",
    promptSnippet: "Create a new git worktree with a pi session at its root",
    promptGuidelines: [
      "Use worktree_create when the user asks to create a new git worktree, " +
        "start work in an isolated directory, or experiment without affecting the main tree.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description:
          "Short name for the worktree (e.g. feature-x, bugfix-123). Combined with a git hash prefix.",
      }),
      base: Type.Optional(
        Type.String({
          description:
            "Git ref (branch, tag, or commit) to base the worktree on. Defaults to the current HEAD.",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await createWorktree(pi, ctx, params.name);
      if (result.error) {
        throw new Error(result.error);
      }
      const mode = result.forked ? "Forked session →" : "New session at";
      return {
        content: [
          {
            type: "text",
            text: [
              `Worktree "${result.worktreeName}" created successfully.`,
              `${mode} ${result.worktreePath}`,
              `Session: ${result.sessionFile}`,
            ].join("\n"),
          },
        ],
        details: {
          worktreeName: result.worktreeName,
          worktreePath: result.worktreePath,
          sessionFile: result.sessionFile,
          forked: result.forked ?? false,
        },
      };
    },
  });

  pi.registerTool({
    name: "worktree_delete",
    label: "Delete Worktree",
    description:
      "Delete a git worktree (removes directory and files) and its associated pi session. " +
      "If the current session belongs to this worktree, you will be prompted to switch first.",
    promptSnippet: "Delete a git worktree and its associated pi session",
    promptGuidelines: [
      "Use worktree_delete when the user asks to remove or clean up a git worktree. " +
        "The worktree name must match a registered worktree from worktree_list.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description: "Name of the worktree to delete (as shown in worktree_list).",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await deleteWorktree(pi, ctx, params.name);
      if (result.error) {
        throw new Error(result.error);
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Worktree "${params.name}" deleted successfully.` +
              (result.switchedTo ? ` Switched to session: ${result.switchedTo}` : ""),
          },
        ],
        details: {
          deleted: params.name,
          switchedTo: result.switchedTo ?? null,
        },
      };
    },
  });

  pi.registerTool({
    name: "worktree_list",
    label: "List Worktrees",
    description:
      "List all registered git worktrees and their associated pi sessions. " +
      'Marks the current session\'s worktree with "← current" ' +
      "and flags any worktrees whose directories have been manually removed.",
    promptSnippet: "List all git worktrees and their pi sessions",
    promptGuidelines: [
      "Use worktree_list when the user asks what worktrees exist or wants an overview.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const lines = listWorktrees(ctx);
      const currentFile = ctx.sessionManager.getSessionFile();
      let summary = "";
      for (const line of lines) {
        const marker = currentFile && line.includes(currentFile) ? " ← current" : "";
        summary += `- ${line}${marker}\n`;
      }
      return {
        content: [
          {
            type: "text",
            text: summary || "No worktrees registered.",
          },
        ],
        details: {
          worktrees: lines,
          currentSession: currentFile,
        },
      };
    },
  });
}
