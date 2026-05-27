// ============================================================
// git-files — Show changed git files above the editor
// ============================================================
// Widget shows changed files. Press Enter or use /git-diff to
// pick a file and open its diff in neovim.
// ============================================================

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Focusable, matchesKey, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────

type FileStatus = "M" | "A" | "D" | "R" | "?";

interface ChangedFile {
  status: FileStatus;
  path: string;
  staged: boolean;
}

// ── Git helpers ─────────────────────────────────────────────

function getChangedFiles(cwd: string): ChangedFile[] {
  const opts = { encoding: "utf-8" as const, stdio: "pipe" as const, cwd };
  const files: ChangedFile[] = [];
  try {
    const staged = execSync("git diff --cached --name-status", opts).trim();
    for (const line of staged.split("\n")) {
      const m = line.match(/^(\S+)\s+(.+)$/);
      if (m) files.push({ status: m[1] as FileStatus, path: m[2].trim(), staged: true });
    }
    const unstaged = execSync("git diff --name-status", opts).trim();
    for (const line of unstaged.split("\n")) {
      const m = line.match(/^(\S+)\s+(.+)$/);
      if (m) {
        const p = m[2].trim();
        if (!files.some((f) => f.path === p))
          files.push({ status: m[1] as FileStatus, path: p, staged: false });
      }
    }
    const untracked = execSync("git ls-files --others --exclude-standard", opts).trim();
    for (const line of untracked.split("\n")) {
      const p = line.trim();
      if (p) files.push({ status: "?", path: p, staged: false });
    }
  } catch { /* not a git repo */ }
  return files;
}

function getFileDiff(cwd: string, filepath: string, staged: boolean): string[] {
  try {
    const flag = staged ? "--cached" : "";
    const raw = execSync(`git diff ${flag} -- ${filepath}`, {
      encoding: "utf-8", stdio: "pipe", cwd,
    });
    return raw ? raw.split("\n") : ["(no diff)"];
  } catch {
    return ["(failed to read diff)"];
  }
}

// ── File picker overlay ─────────────────────────────────────

class FilePickerOverlay implements Focusable {
  focused = false;
  private selected = 0;
  private files: ChangedFile[];
  private cwd: string;
  private th: any;

  constructor(
    theme: any,
    files: ChangedFile[],
    cwd: string,
    private done: (result: { action: string; file?: ChangedFile } | undefined) => void,
  ) {
    this.th = theme;
    this.files = files;
    this.cwd = cwd;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) { this.done(undefined); return; }
    if (matchesKey(data, "down") || data === "j") {
      this.selected = Math.min(this.selected + 1, this.files.length - 1);
    }
    if (matchesKey(data, "up") || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
    }
    if (matchesKey(data, "return")) {
      const file = this.files[this.selected]!;
      this.done({ action: "view", file });
    }
  }

  render(width: number): string[] {
    // Fixed overlay dimensions — won't resize with terminal
    const w = 70;
    const innerW = w - 2;
    const th = this.th;
    const out: string[] = [];
    const pad = (s: string, len: number) => truncateToWidth(s + " ".repeat(Math.max(0, len - visibleWidth(s))), len);
    const row = (content: string) => th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");

    out.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
    out.push(row(` ${th.fg("toolTitle", "Changed files")}`));
    out.push(row(""));

    const maxShow = Math.min(this.files.length, 15);
    for (let i = 0; i < maxShow; i++) {
      const f = this.files[i]!;
      const isSel = i === this.selected;
      const cursor = isSel ? "▶" : " ";
      const staged = f.staged ? "●" : "○";

      let statusCol: string;
      if (f.status === "M" || f.status === "R") statusCol = th.fg("warning", f.status);
      else if (f.status === "A") statusCol = th.fg("success", f.status);
      else if (f.status === "D") statusCol = th.fg("error", f.status);
      else statusCol = th.fg("dim", "?");

      const dirname = path.dirname(f.path);
      const display = dirname !== "." ? `${path.basename(f.path)} (${dirname})` : f.path;

      let line = ` ${cursor}  ${statusCol} ${staged} ${display}`;
      if (isSel) line = th.bg("selectedBg", line);
      out.push(row(line));
    }

    out.push(row(""));
    out.push(row(` ${th.fg("dim", "↑↓ select  Enter view diff  Esc cancel")}`));
    out.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
    return out;
  }

  invalidate(): void {}
  dispose(): void {}
}

// ── Show diff in neovim ─────────────────────────────────────

async function showDiffInNeovim(ctx: ExtensionCommandContext) {
  const files = getChangedFiles(ctx.cwd);
  if (files.length === 0) {
    ctx.ui.notify("No changed files.", "info");
    return;
  }

  // Step 1: file picker overlay
  const pickResult = await ctx.ui.custom<{ action: string; file?: ChangedFile } | undefined>(
    (_tui, theme, _kb, done) => new FilePickerOverlay(theme, files, ctx.cwd, done),
    { overlay: true, overlayOptions: { width: 70, maxHeight: 22 } },
  );

  if (!pickResult || pickResult.action !== "view" || !pickResult.file) return;

  // Step 2: open diff in neovim
  const file = pickResult.file;
  const diffLines = getFileDiff(ctx.cwd, file.path, file.staged);

  const tmpFile = path.join(os.tmpdir(), `git-files-${Date.now()}.diff`);
  fs.writeFileSync(tmpFile, diffLines.join("\n"), "utf-8");
  const editor = process.env.VISUAL || process.env.EDITOR || "nvim";
  try {
    spawnSync(editor, [tmpFile], { stdio: "inherit", cwd: ctx.cwd });
  } catch (e) {
    ctx.ui.notify(`Failed to open editor: ${String(e)}`, "error");
  }
  try { fs.unlinkSync(tmpFile); } catch {}
}

// ── Simple text widget ──────────────────────────────────────

class GitFilesWidget extends Container {
  private files: ChangedFile[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private textComponent = new Text("", 0, 0);
  private cwd: string;
  private onEnter: () => void;

  constructor(cwd: string, onEnter: () => void) {
    super();
    this.cwd = cwd;
    this.onEnter = onEnter;
    this.addChild(this.textComponent);
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 3000);
  }

  private refresh() {
    this.files = getChangedFiles(this.cwd);
    this.updateText();
  }

  private updateText() {
    if (this.files.length === 0) {
      this.textComponent.setText("");
      return;
    }
    const changed = this.files.filter((f) => f.status !== "?");
    const untracked = this.files.filter((f) => f.status === "?");
    const lines: string[] = [];
    if (changed.length > 0 && untracked.length > 0) {
      lines.push(`  ${changed.length} changed, ${untracked.length} untracked`);
    } else if (changed.length > 0) {
      lines.push(`  ${changed.length} changed`);
    } else {
      lines.push(`  ${untracked.length} untracked`);
    }
    const maxShow = Math.min(this.files.length, 6);
    for (let i = 0; i < maxShow; i++) {
      const f = this.files[i];
      const staged = f.staged ? "\u25CF" : "\u25CB";
      const dirname = path.dirname(f.path);
      const display = dirname !== "." ? `${path.basename(f.path)} (${dirname})` : f.path;
      lines.push(`  ${f.status} ${staged} ${display}`);
    }
    this.textComponent.setText(lines.join("\n"));
  }

  dispose() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getSessionList() { return this; }

  handleInput(keyData: string): void {
    if (keyData === "\r" && this.files.length > 0) {
      this.onEnter();
    }
  }

  invalidate(): void { this.refresh(); }
}

// ── Extension entry point ────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setWidget("git-files", () => {
      return new GitFilesWidget(ctx.cwd, () => {
        void showDiffInNeovim(ctx as ExtensionCommandContext);
      });
    }, { placement: "aboveEditor" });
  });

  pi.registerCommand("git-diff", {
    description: "Pick a changed file and view its diff in neovim",
    handler: async (_args, ctx) => {
      await showDiffInNeovim(ctx);
    },
  });


}
