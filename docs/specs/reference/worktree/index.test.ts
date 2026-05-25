/**
 * Tests for the worktree extension (v2 — session-switching model).
 *
 * Covers:
 * - Config loading (getConfig, getDefaultStoragePath)
 * - Path helpers (getWorktreePath, getWorktreeStoragePath, getRepoHash)
 * - Branch naming (getWorktreeBranchName)
 * - Primary lock I/O (writePrimaryLock, readPrimaryLock, removePrimaryLock, isPrimaryLockStale)
 * - Session detection (findWorktreeInfo)
 * - Session reference file (getWorktreeSessionPath, writeWorktreeSessionPath)
 * - Git helpers (runGit, gitStatus, gitCommit, getCurrentBranch, getCurrentCommit)
 * - Directory helpers (ensureStorageDir, listWorktrees)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getConfig,
  getDefaultStoragePath,
  getWorktreePath,
  getWorktreeStoragePath,
  getRepoHash,
  getWorktreeBranchName,
  writePrimaryLock,
  readPrimaryLock,
  removePrimaryLock,
  isPrimaryLockStale,
  findWorktreeInfo,
  ensureStorageDir,
  listWorktrees,
  getWorktreeSessionPath,
  writeWorktreeSessionPath,
  runGit,
  gitStatus,
  loadJsonSafe,
  getCurrentBranch,
  getCurrentCommit,
} from "./index";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-test-"));
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// loadJsonSafe
// ---------------------------------------------------------------------------

describe("loadJsonSafe", () => {
  it("returns parsed data for valid JSON", () => {
    const dir = tmpDir();
    const file = path.join(dir, "test.json");
    writeJson(file, { a: 1, b: "hello" });
    expect(loadJsonSafe(file)).toEqual({ a: 1, b: "hello" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for missing file", () => {
    expect(loadJsonSafe("/nonexistent/path.json")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    const dir = tmpDir();
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, "not json", "utf-8");
    expect(loadJsonSafe(file)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// getConfig
// ---------------------------------------------------------------------------

describe("getConfig", () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns defaults when no settings exist", () => {
    const config = getConfig(dir);
    expect(config.storagePath).toBe(getDefaultStoragePath(dir));
    expect(config.autoCommit).toBe(true);
    expect(config.autoCommitTemplate).toBe("[pi-worktree] auto-commit turn {turn}");
    expect(config.statusLine).toBe(true);
    expect(config.staleLockHours).toBe(24);
  });

  it("reads project settings from .pi/settings.json", () => {
    writeJson(path.join(dir, ".pi", "settings.json"), {
      worktree: { autoCommit: false, staleLockHours: 12 },
    });
    const config = getConfig(dir);
    expect(config.autoCommit).toBe(false);
    expect(config.staleLockHours).toBe(12);
    expect(config.statusLine).toBe(true); // other defaults apply
  });
});

// ---------------------------------------------------------------------------
// getDefaultStoragePath
// ---------------------------------------------------------------------------

describe("getDefaultStoragePath", () => {
  it("uses parent directory", () => {
    expect(getDefaultStoragePath("/workspace/my-project")).toBe(
      "/workspace/.pi-worktrees/my-project"
    );
  });

  it("falls back to repo root when at filesystem root", () => {
    const result = getDefaultStoragePath("/repo");
    expect(result.startsWith("/repo")).toBe(true);
    expect(result).toContain(".pi-worktrees");
  });
});

// ---------------------------------------------------------------------------
// getRepoHash / getWorktreeBranchName
// ---------------------------------------------------------------------------

describe("getRepoHash / getWorktreeBranchName", () => {
  it("getRepoHash returns 12-char hex", () => {
    const h = getRepoHash("/workspace/my-project");
    expect(h).toHaveLength(12);
    expect(/^[0-9a-f]+$/.test(h)).toBe(true);
  });

  it("getWorktreeBranchName appends 7-char hash", () => {
    const b = getWorktreeBranchName("my-feature", "/workspace/repo");
    expect(b).toMatch(/^my-feature-[0-9a-f]{7}$/);
  });

  it("different names → different hashes", () => {
    expect(getWorktreeBranchName("a", "/r")).not.toBe(getWorktreeBranchName("b", "/r"));
  });

  it("different repos → different hashes same name", () => {
    expect(getWorktreeBranchName("f", "/a")).not.toBe(getWorktreeBranchName("f", "/b"));
  });

  it("deterministic", () => {
    expect(getWorktreeBranchName("f", "/r")).toBe(getWorktreeBranchName("f", "/r"));
  });
});

// ---------------------------------------------------------------------------
// getWorktreeStoragePath / getWorktreePath
// ---------------------------------------------------------------------------

describe("getWorktreeStoragePath / getWorktreePath", () => {
  const cfg: Parameters<typeof getWorktreeStoragePath>[1] = {
    storagePath: "/ws/.pi-worktrees/p",
    autoCommit: true, autoCommitTemplate: "", statusLine: true, staleLockHours: 24,
  };

  it("appends repo hash", () => {
    const s = getWorktreeStoragePath("/ws/repo", cfg);
    expect(s.startsWith(cfg.storagePath)).toBe(true);
    expect(s).toHaveLength(cfg.storagePath.length + 1 + 12);
  });

  it("getWorktreePath appends name", () => {
    expect(getWorktreePath("/ws/repo", "ft", cfg)).toBe(
      path.join(getWorktreeStoragePath("/ws/repo", cfg), "ft")
    );
  });
});

// ---------------------------------------------------------------------------
// Primary lock I/O
// ---------------------------------------------------------------------------

describe("primary lock I/O", () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("write / read roundtrip", () => {
    writePrimaryLock(dir, "sess-1");
    const lock = readPrimaryLock(dir);
    expect(lock).not.toBeNull();
    expect(lock!.sessionId).toBe("sess-1");
    expect(lock!.linkedAt).toBeGreaterThan(0);
  });

  it("read returns null when absent", () => {
    expect(readPrimaryLock(dir)).toBeNull();
  });

  it("remove deletes lock", () => {
    writePrimaryLock(dir, "sess-1");
    removePrimaryLock(dir);
    expect(readPrimaryLock(dir)).toBeNull();
  });

  it("remove is idempotent", () => {
    expect(() => removePrimaryLock(dir)).not.toThrow();
  });

  it("isPrimaryLockStale returns false for fresh", () => {
    expect(isPrimaryLockStale({ sessionId: "a", linkedAt: Date.now() }, 24)).toBe(false);
  });

  it("isPrimaryLockStale returns true for old", () => {
    expect(isPrimaryLockStale({ sessionId: "a", linkedAt: Date.now() - 25 * 3600 * 1000 }, 24)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Session reference file
// ---------------------------------------------------------------------------

describe("session reference file", () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("write / read roundtrip", () => {
    writeWorktreeSessionPath(dir, "/home/user/.pi/agent/sessions/t.jsonl");
    expect(getWorktreeSessionPath(dir)).toBe("/home/user/.pi/agent/sessions/t.jsonl");
  });

  it("returns null when absent", () => {
    expect(getWorktreeSessionPath(dir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findWorktreeInfo
// ---------------------------------------------------------------------------

describe("findWorktreeInfo", () => {
  it("returns null when no entry", () => {
    expect(findWorktreeInfo({
      getEntries: () => [{ type: "message" }, { type: "custom", customType: "other", data: {} }],
    })).toBeNull();
  });

  it("finds worktree_info", () => {
    const info = { repoRoot: "/r", branch: "b-a1b2c3d", baseCommit: "dead", mode: "primary" as const, name: "f" };
    expect(findWorktreeInfo({
      getEntries: () => [
        { type: "message" },
        { type: "custom", customType: "worktree_info", data: info },
      ],
    })).toEqual(info);
  });

  it("returns newest entry", () => {
    const old = { repoRoot: "/r", branch: "old", baseCommit: "a", mode: "primary" as const, name: "old" };
    const newer = { repoRoot: "/r", branch: "new", baseCommit: "b", mode: "secondary" as const, name: "new" };
    expect(findWorktreeInfo({
      getEntries: () => [
        { type: "custom", customType: "worktree_info", data: old },
        { type: "custom", customType: "worktree_info", data: newer },
      ],
    })).toEqual(newer);
  });
});

// ---------------------------------------------------------------------------
// ensureStorageDir
// ---------------------------------------------------------------------------

describe("ensureStorageDir", () => {
  it("creates parents", () => {
    const d = tmpDir();
    const t = path.join(d, "a", "b", "c");
    ensureStorageDir(t);
    expect(fs.existsSync(t)).toBe(true);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// listWorktrees
// ---------------------------------------------------------------------------

describe("listWorktrees", () => {
  let d: string;
  beforeEach(() => { d = tmpDir(); });
  afterEach(() => { fs.rmSync(d, { recursive: true, force: true }); });

  it("empty when no storage dir", () => {
    const cfg = { ...getConfig("/r"), storagePath: "/nonexistent" };
    expect(listWorktrees("/r", cfg)).toEqual([]);
  });

  it("returns sorted directories", () => {
    const repoRoot = path.join(d, "repo");
    const sp = path.join(d, "storage");
    const cfg = { storagePath: sp, autoCommit: true, autoCommitTemplate: "", statusLine: true, staleLockHours: 24 };
    const realStorage = getWorktreeStoragePath(repoRoot, cfg);
    fs.mkdirSync(path.join(realStorage, "z"), { recursive: true });
    fs.mkdirSync(path.join(realStorage, "a"), { recursive: true });
    expect(listWorktrees(repoRoot, cfg)).toEqual(["a", "z"]);
  });

  it("filters out files", () => {
    const repoRoot = path.join(d, "repo");
    const sp = path.join(d, "storage");
    const realStorage = getWorktreeStoragePath(repoRoot, { storagePath: sp, autoCommit: true, autoCommitTemplate: "", statusLine: true, staleLockHours: 24 });
    fs.mkdirSync(realStorage, { recursive: true });
    fs.mkdirSync(path.join(realStorage, "dir"));
    fs.writeFileSync(path.join(realStorage, "file"), "x");
    const cfg = { storagePath: sp, autoCommit: true, autoCommitTemplate: "", statusLine: true, staleLockHours: 24 };
    expect(listWorktrees(repoRoot, cfg)).toEqual(["dir"]);
  });
});

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

describe("git helpers", () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    dir = tmpDir();
    cwd = path.join(dir, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    runGit(cwd, ["init"]);
    runGit(cwd, ["config", "user.email", "test@test.com"]);
    runGit(cwd, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(cwd, "README.md"), "# Test\n");
    runGit(cwd, ["add", "-A"]);
    runGit(cwd, ["commit", "-m", "initial"]);
  });

  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("runGit returns stdout and code 0", () => {
    const { stdout, code } = runGit(cwd, ["rev-parse", "HEAD"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^[0-9a-f]{40}$/m);
  });

  it("runGit returns non-zero on failure", () => {
    const { code, stderr } = runGit(cwd, ["nonexistent"]);
    expect(code).not.toBe(0);
    expect(stderr).toBeTruthy();
  });

  it("gitStatus false for clean", async () => {
    expect(await gitStatus(cwd)).toBe(false);
  });

  it("gitStatus true for dirty", async () => {
    fs.writeFileSync(path.join(cwd, "new.txt"), "hi");
    expect(await gitStatus(cwd)).toBe(true);
  });

  it("getCurrentBranch returns a branch name", async () => {
    const b = await getCurrentBranch(cwd);
    expect(b).toBeTruthy();
  });

  it("getCurrentCommit returns SHA", async () => {
    const c = await getCurrentCommit(cwd);
    expect(c).toMatch(/^[0-9a-f]{40}$/);
  });
});
