// ============================================================
// git-files — Show changed git files below the editor
// ============================================================
// Displays modified, staged, and unstaged files in a compact
// widget below the editor area. Click a file to see its diff.
// ============================================================

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  type Theme,
  getKeybindings,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────

type FileStatus = "M" | "A" | "D" | "R" | "?";

interface ChangedFile {
  status: FileStatus;
  path: string;
  staged: boolean;
}

// ── Git helpers ─────────────────────────────────────────────

function getChangedFiles(): ChangedFile[] {
  const files: ChangedFile[] = [];
  try {
    // Staged changes
    const staged = execSync("git diff --cached --name-status", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    for (const line of staged.split("\n")) {
      const m = line.match(/^(\S+)\s+(.+)$/);
      if (m) files.push({ status: m[1] as FileStatus, path: m[2].trim(), staged: true });
    }

    // Unstaged changes
    const unstaged = execSync("git diff --name-status", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    for (const line of unstaged.split("\n")) {
      const m = line.match(/^(\S+)\s+(.+)$/);
      if (m) {
        // Don't duplicate if already shown as staged
        const p = m[2].trim();
        if (!files.some((f) => f.path === p)) {
          files.push({ status: m[1] as FileStatus, path: p, staged: false });
        }
      }
    }

    // Untracked
    const untracked = execSync("git ls-files --others --exclude-standard", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    for (const line of untracked.split("\n")) {
      const p = line.trim();
      if (p) files.push({ status: "?", path: p, staged: false });
    }
  } catch {
    // Not a git repo or git not available
  }
  return files;
}

function getFileDiff(filepath: string, staged: boolean): string {
  try {
    const args = staged
      ? ["diff", "--cached", "--", filepath]
      : ["diff", "--", filepath];
    const output = execSync("git", args.concat([filepath]), {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    return output || "(no diff — binary or empty file)";
  } catch {
    return "(failed to get diff)";
  }
}

// ── Widget ──────────────────────────────────────────────────

class GitFilesWidget extends Container {
  private files: ChangedFile[] = [];
  private selectedIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private ctx: ExtensionContext, private theme: Theme) {
    super();
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 3000);
  }

  private refresh() {
    this.files = getChangedFiles();
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.files.length - 1)
    );
    this.ctx.ui.requestRender?.();
  }

  dispose() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSessionList() {
    return this;
  }

  handleInput(_keyData: string): void {}

  invalidate(): void {
    this.refresh();
  }

  render(width: number): string[] {
    return this.renderContent(width);
  }

  private renderContent(width: number): string[] {
    if (this.files.length === 0) return [];

    const lines: string[] = [];
    const available = Math.min(this.files.length, 8);
    const maxLen = Math.max(...this.files.map((f) => f.path.length + 5), 1);

    // Header
    const header = `━━ ${this.files.length} changed file${this.files.length !== 1 ? "s" : ""} ━━`;
    lines.push(this.theme.fg("muted", truncateToWidth(header, width, "…")));

    for (let i = 0; i < available; i++) {
      const file = this.files[i];
      const statusColor =
        file.status === "M" || file.status === "R"
          ? "warning"
          : file.status === "A"
            ? "accent"
            : file.status === "D"
              ? "error"
              : "dim";
      const staged = file.staged ? "S" : "U";
      const basename = path.basename(file.path);
      const left = `${this.theme.fg(statusColor, file.status)} ${this.theme.fg("dim", staged)} ${basename}`;
      const dirname = path.dirname(file.path);
      const right = dirname === "." ? "" : this.theme.fg("dim", dirname);

      const leftWidth = (left.match(/[\u0000-\u05FF]/g) || left.split("")).length;
      // Approximate visible width
      let rawWidth = 0;
      for (const ch of left) rawWidth += ch.charCodeAt(0) > 127 ? 2 : 1;

      const rightVisible = right
        ? width - rawWidth - 2
        : 0;
      const truncatedRight = rightVisible > 0 ? truncateToWidth(right, rightVisible, "…") : "";
      const spacer = rightVisible > 0 ? " ".repeat(Math.max(1, width - rawWidth - (truncatedRight.length || 0))) : "";

      lines.push(left + spacer + truncatedRight);
    }

    return lines;
  }
}

// ── Extension entry point ────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let widget: GitFilesWidget | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setWidget("git-files", (tui, theme) => {
      widget = new GitFilesWidget(ctx, theme);
      return widget;
    }, { placement: "belowEditor" });
  });

  // Register a command to toggle diff view
  pi.registerCommand("git-diff", {
    description: "Show diff for a changed file by name",
    handler: async (args, ctx) => {
      const filepath = (args ?? "").trim();
      if (!filepath) {
        ctx.ui.notify("Usage: /git-diff <filepath>", "error");
        return;
      }

      const files = getChangedFiles();
      const match = files.find((f) => f.path === filepath || f.path.endsWith(filepath));
      if (!match) {
        ctx.ui.notify(`File "${filepath}" has no changes.`, "warning");
        return;
      }

      const diff = getFileDiff(match.path, match.staged);
      const title = `${match.staged ? "Staged" : "Unstaged"} diff: ${match.path}`;
      await ctx.ui.select(title, diff.split("\n").slice(0, 50));
    },
  });
}
