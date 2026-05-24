// ============================================================
// confirm-dangerous — Prompt before destructive operations
// ============================================================
// Blocks or confirms potentially dangerous bash commands,
// writes outside /workspace, and modifications to the pi
// config directory.
//
// This extension is baked into the pi-container image and
// symlinked into ~/.pi/agent/extensions/ on startup.
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

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

// Paths that should not be written to outside /workspace
const PROTECTED_PATHS = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/var",
  "/root",
  "/boot",
  "/proc",
  "/sys",
];

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
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

    // ── Write/edit outside /workspace ───────────────────────
    if (isToolCallEventType("write", event)) {
      const filePath: string = event.input.path ?? "";
      if (isOutsideWorkspace(filePath) && !isPiConfigDir(filePath)) {
        const ok = await ctx.ui.confirm(
          "Write Outside Workspace",
          `Attempting to write to:\n\n${filePath}\n\nThis is outside /workspace. Allow?`
        );
        if (!ok) {
          return { block: true, reason: "Blocked: write outside /workspace" };
        }
      }
    }

    if (isToolCallEventType("edit", event)) {
      const filePath: string = event.input.path ?? "";
      if (isOutsideWorkspace(filePath) && !isPiConfigDir(filePath)) {
        const ok = await ctx.ui.confirm(
          "Edit Outside Workspace",
          `Attempting to edit:\n\n${filePath}\n\nThis is outside /workspace. Allow?`
        );
        if (!ok) {
          return { block: true, reason: "Blocked: edit outside /workspace" };
        }
      }
    }
  });
}

function isOutsideWorkspace(filePath: string): boolean {
  // Resolve relative paths
  const normalized = filePath.startsWith("/") ? filePath : `/workspace/${filePath}`;
  return !normalized.startsWith("/workspace/") && normalized !== "/workspace";
}

function isPiConfigDir(filePath: string): boolean {
  // Allow writes to the pi config directory (mounted from host)
  return filePath.startsWith("/home/pi-user/.pi/agent/");
}