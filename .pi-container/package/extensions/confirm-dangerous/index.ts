// ============================================================
// confirm-dangerous — Prompt before destructive operations
// ============================================================
// Blocks or confirms potentially dangerous bash commands,
// writes outside the workspace, and modifications to the pi
// config directory.
//
// Read operations (read tool) are always allowed — they are
// never dangerous regardless of the target path.
//
// The workspace directory is determined by the WORKSPACE_DIR
// environment variable, set by pi-container based on the
// project directory name.
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// Workspace directory — set by pi-container from the CWD basename
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";

// Patterns that indicate a dangerous bash command
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)/, description: "Force removal" },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s/, description: "Recursive removal" },
  { pattern: /\brm\s+--no-preserve-root/, description: "Root filesystem removal" },
  { pattern: /\bsudo\s+/, description: "Sudo command" },
  { pattern: /\bgit\s+push\s+.*(--force|-f)\b/, description: "Force push" },
  { pattern: /\bgit\s+push\s+.*--delete\b/, description: "Delete remote branch" },
  { pattern: /\bdd\s+/, description: "Low-level disk operation" },
  { pattern: /\bmkfs\b/, description: "Format filesystem" },
  { pattern: /\bmount\b/, description: "Mount filesystem" },
  { pattern: /\bchown\s+/, description: "Change ownership" },
  { pattern: /\bchmod\s+.*[0-7]{3,4}\s+/, description: "Permission change" },
  { pattern: />\s*\/dev\//, description: "Write to device file" },
  { pattern: /\bcurl\s+.*\|\s*(sudo\s+)?sh\b/, description: "Pipe curl to shell" },
  { pattern: /\bwget\s+.*\|\s*(sudo\s+)?sh\b/, description: "Pipe wget to shell" },
];

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // ── Read operations are always safe ──────────────────────
    // Reads cannot modify state and are never dangerous.
    if (isToolCallEventType("read", event)) {
      return; // always allow
    }

    // ── Bash commands ──────────────────────────────────────
    if (isToolCallEventType("bash", event)) {
      const command: string = event.input.command ?? "";

      for (const { pattern, description } of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
          const ok = await ctx.ui.confirm(
            "Dangerous Command",
            `${description}:\n\n${command}\n\nAllow this command?`
          );
          if (!ok) {
            return { block: true, reason: `Blocked: ${description}` };
          }
          return; // Allowed — don't check further patterns
        }
      }
    }

    // ── Write/edit outside workspace ──────────────────────
    if (isToolCallEventType("write", event)) {
      const filePath: string = event.input.path ?? "";
      if (isOutsideWorkspace(filePath) && !isPiConfigDir(filePath)) {
        const ok = await ctx.ui.confirm(
          "Write Outside Workspace",
          `Attempting to write to:\n\n${filePath}\n\nThis is outside ${WORKSPACE_DIR}. Allow?`
        );
        if (!ok) {
          return { block: true, reason: `Blocked: write outside ${WORKSPACE_DIR}` };
        }
      }
    }

    if (isToolCallEventType("edit", event)) {
      const filePath: string = event.input.path ?? "";
      if (isOutsideWorkspace(filePath) && !isPiConfigDir(filePath)) {
        const ok = await ctx.ui.confirm(
          "Edit Outside Workspace",
          `Attempting to edit:\n\n${filePath}\n\nThis is outside ${WORKSPACE_DIR}. Allow?`
        );
        if (!ok) {
          return { block: true, reason: `Blocked: edit outside ${WORKSPACE_DIR}` };
        }
      }
    }
  });
}

// ── Helper functions (exported for testing) ──────────────────

export function isOutsideWorkspace(filePath: string, workspaceDir: string = WORKSPACE_DIR): boolean {
  // Resolve relative paths against the workspace directory
  const normalized = filePath.startsWith("/") ? filePath : `${workspaceDir}/${filePath}`;
  return !normalized.startsWith(`${workspaceDir}/`) && normalized !== workspaceDir;
}

export function isPiConfigDir(filePath: string): boolean {
  // Allow writes to the pi config directory (mounted from host)
  return filePath.startsWith("/home/pi-user/.pi/");
}

export { DANGEROUS_PATTERNS, WORKSPACE_DIR };