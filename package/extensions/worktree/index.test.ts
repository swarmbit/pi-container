// ============================================================
// Tests for worktree extension
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";

// ── Hoisted mocks ───────────────────────────────────────────

const {
  mockFsExistsSync,
  mockFsReadFileSync,
  mockFsWriteFileSync,
  mockFsMkdirSync,
  mockExecSync,
} = vi.hoisted(() => ({
  mockFsExistsSync: vi.fn(),
  mockFsReadFileSync: vi.fn(),
  mockFsWriteFileSync: vi.fn(),
  mockFsMkdirSync: vi.fn(),
  mockExecSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mockFsExistsSync,
  readFileSync: mockFsReadFileSync,
  writeFileSync: mockFsWriteFileSync,
  mkdirSync: mockFsMkdirSync,
  unlinkSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
}));

const {
  mockSessionForkFrom,
} = vi.hoisted(() => ({
  mockSessionForkFrom: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    forkFrom: mockSessionForkFrom,
  },
}));

// ── Now import extension functions ──────────────────────────

import {
  buildWorktreeName,
  getWorktreeHomeDir,
  getWorktreeProjectDir,
  getRegistryPath,
  getWorktreePath,
  readRegistry,
  writeRegistry,
  getCurrentBranch,
  getShortHash,
  listWorktrees,
  createWorktree,
  forkWorktree,
  deleteWorktree,
} from "./index";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// ── Helpers ──────────────────────────────────────────────────

const TEST_CWD = "/pi-container";

function mockSessionManager(sessionFile: string) {
  return {
    getSessionFile: () => sessionFile,
    getCwd: () => "/pi-container",
    appendSessionInfo: vi.fn(),
  };
}

function mockPi(gitResults: Array<{ code: number; stdout: string; stderr: string }> = [], opts?: { sessionName?: string }) {
  let callIndex = 0;
  return {
    exec: vi.fn().mockImplementation(async (_cmd: string, _args: string[]) => {
      const result = gitResults[callIndex] ?? { code: 0, stdout: "", stderr: "" };
      callIndex++;
      return result;
    }),
    getSessionName: vi.fn().mockReturnValue(opts?.sessionName ?? null),
    setSessionName: vi.fn(),
  } as any;
}

function mockCtx(sessionFile: string | undefined, cwd?: string) {
  const ctx: any = {
    cwd: cwd ?? TEST_CWD,
    sessionManager: {
      getSessionFile: () => sessionFile ?? null,
      getCwd: () => cwd ?? TEST_CWD,
    },
    switchSession: vi.fn().mockImplementation(async (_path: string, _opts: any) => {
      if (_opts?.withSession) await _opts.withSession(ctx);
    }),
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
    },
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
  };
  return ctx;
}

function resetAllMocks() {
  vi.clearAllMocks();
  mockFsExistsSync.mockReturnValue(false);
  mockFsReadFileSync.mockImplementation(() => {
    throw new Error("ENOENT");
  });
  mockFsWriteFileSync.mockImplementation(() => {});
  mockFsMkdirSync.mockImplementation(() => {});
  mockExecSync.mockReturnValue("main");
}

// ── Path helpers ────────────────────────────────────────────

describe("path helpers", () => {
  it("getWorktreeHomeDir returns ~/.pi/worktrees", () => {
    const dir = getWorktreeHomeDir();
    expect(dir).toBe(path.resolve(os.homedir(), ".pi", "worktrees"));
  });

  it("getWorktreeProjectDir encodes cwd", () => {
    const dir = getWorktreeProjectDir("/home/user/project");
    expect(dir).toContain("home-user-project");
    expect(dir).toContain(".pi/worktrees");
  });

  it("getRegistryPath returns registry.json in project dir", () => {
    const p = getRegistryPath("/home/user/project");
    expect(p).toContain("registry.json");
  });

  it("getWorktreePath includes worktree name", () => {
    const p = getWorktreePath("/home/user/project", "feat-abc123");
    expect(p).toContain("feat-abc123");
  });
});

// ── buildWorktreeName ────────────────────────────────────────

describe("buildWorktreeName", () => {
  it("combines hash and name", () => {
    expect(buildWorktreeName("abc123", "feature-x")).toBe("feature-x-abc123");
  });

  it("sanitizes special characters", () => {
    expect(buildWorktreeName("abc123", "fix!@#$%^&*()bug")).toBe("fix-bug-abc123");
  });
});

// ── Registry I/O ─────────────────────────────────────────────

describe("Registry", () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it("readRegistry returns empty when file doesn't exist", () => {
    const registry = readRegistry(TEST_CWD);
    expect(registry).toEqual({ worktrees: {} });
  });

  it("roundtrip: write then read", () => {
    const registry = {
      worktrees: {
        "feat-abc123": {
          path: "/home/user/.pi/worktrees/--proj--/feat-abc123",
          createdAt: "2025-01-01T00:00:00.000Z",
          baseRef: "main",
          originalCwd: TEST_CWD,
        },
      },
    };

    writeRegistry(TEST_CWD, registry);
    const registryPath = getRegistryPath(TEST_CWD);
    const writtenJson = mockFsWriteFileSync.mock.calls.find(
      (c: any) => c[0] === registryPath
    )?.[1];
    expect(writtenJson).toBeDefined();
    mockFsReadFileSync.mockReturnValue(writtenJson);

    const read = readRegistry(TEST_CWD);
    expect(read).toEqual(registry);
  });
});

// ── listWorktrees ────────────────────────────────────────────

describe("listWorktrees", () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it("marks current cwd worktree", () => {
    const data = {
      worktrees: {
        "feat-abc123": {
          path: "/pi-container/.pi/worktrees/proj/feat-abc123",
          createdAt: "",
          baseRef: "main",
          originalCwd: TEST_CWD,
        },
      },
    };
    mockFsReadFileSync.mockReturnValue(JSON.stringify(data));
    mockFsExistsSync.mockReturnValue(true);

    const ctx = mockCtx("/sessions/a.jsonl", "/pi-container/.pi/worktrees/proj/feat-abc123");
    const lines = listWorktrees(ctx);
    expect(lines[0]).toContain("← current");
  });

  it("marks missing directories", () => {
    const data = {
      worktrees: {
        "feat-abc123": {
          path: "/pi-container/.pi/worktrees/proj/feat-abc123",
          createdAt: "",
          baseRef: "main",
          originalCwd: TEST_CWD,
        },
      },
    };
    mockFsReadFileSync.mockReturnValue(JSON.stringify(data));
    mockFsExistsSync.mockReturnValue(false);

    const ctx = mockCtx("/sessions/a.jsonl");
    const lines = listWorktrees(ctx);
    expect(lines[0]).toContain("[directory missing]");
  });
});

// ── createWorktree ──────────────────────────────────────────

describe("createWorktree", () => {
  let pi: any;
  let ctx: any;

  beforeEach(() => {
    resetAllMocks();
    mockExecSync.mockReturnValue("abc123");
  });

  it("returns error if not a git repo", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    pi = mockPi();
    ctx = mockCtx("/sessions/current.jsonl");

    const result = await createWorktree(pi, ctx, "feature-x");
    expect(result.error).toContain("Not a git repository");
  });

  it("returns error if path already exists", async () => {
    mockFsExistsSync.mockReturnValue(true);
    pi = mockPi();
    ctx = mockCtx("/sessions/current.jsonl");

    const result = await createWorktree(pi, ctx, "feature-x");
    expect(result.error).toContain("already exists");
  });

  it("returns error if already registered", async () => {
    mockFsExistsSync.mockImplementation((p: string) => p.includes("registry.json"));
    mockFsReadFileSync.mockReturnValue(
      JSON.stringify({
        worktrees: {
          "feature-abc123": {
            path: "/some/path",
            createdAt: "",
            baseRef: "",
            originalCwd: TEST_CWD,
          },
        },
      })
    );
    pi = mockPi();
    ctx = mockCtx("/sessions/current.jsonl");

    const result = await createWorktree(pi, ctx, "feature");
    expect(result.error).toContain("already registered");
  });

  it("creates git worktree and registers it", async () => {
    mockFsExistsSync.mockReturnValue(false);
    mockFsReadFileSync.mockReturnValue(JSON.stringify({ worktrees: {} }));
    pi = mockPi();
    ctx = mockCtx("/sessions/current.jsonl");

    const result = await createWorktree(pi, ctx, "feature");

    expect(result.error).toBeUndefined();
    expect(result.worktreeName).toBe("feature-abc123");

    // Registry written
    const registryPath = getRegistryPath(TEST_CWD);
    const registryCall = mockFsWriteFileSync.mock.calls.find(
      (c: any) => c[0] === registryPath
    );
    expect(registryCall).toBeDefined();
    const registry = JSON.parse(registryCall[1]);
    expect(registry.worktrees["feature-abc123"]).toBeDefined();
    expect(registry.worktrees["feature-abc123"].baseRef).toBe("abc123");

    // Does NOT fork or switch
    expect(SessionManager.forkFrom).not.toHaveBeenCalled();
    expect(ctx.switchSession).not.toHaveBeenCalled();
  });

  it("uses base parameter", async () => {
    mockFsExistsSync.mockReturnValue(false);
    mockFsReadFileSync.mockReturnValue(JSON.stringify({ worktrees: {} }));
    pi = mockPi();
    ctx = mockCtx("/sessions/current.jsonl");

    const result = await createWorktree(pi, ctx, "feature", "develop");
    expect(result.worktreeName).toBe("feature-abc123");
    expect(mockExecSync).toHaveBeenCalledWith(
      "git rev-parse --short develop",
      expect.any(Object)
    );
  });

  it("returns error if git worktree add fails", async () => {
    mockFsExistsSync.mockReturnValue(false);
    mockFsReadFileSync.mockReturnValue(JSON.stringify({ worktrees: {} }));
    pi = mockPi([{ code: 1, stdout: "", stderr: "fatal: not a git repository" }]);
    ctx = mockCtx("/sessions/current.jsonl");

    const result = await createWorktree(pi, ctx, "feature");
    expect(result.error).toContain("git worktree add failed");
  });
});

// ── forkWorktree ────────────────────────────────────────────

describe("forkWorktree", () => {
  let pi: any;
  let ctx: any;

  beforeEach(() => {
    resetAllMocks();
  });

  it("returns error if worktree not found", async () => {
    mockFsReadFileSync.mockReturnValue(JSON.stringify({ worktrees: {} }));
    pi = mockPi();
    ctx = mockCtx("/sessions/current.jsonl");

    const result = await forkWorktree(pi, ctx, "nonexistent");
    expect(result.error).toContain("not found in registry");
  });

  it("returns error if no current session file", async () => {
    mockFsReadFileSync.mockReturnValue(
      JSON.stringify({
        worktrees: {
          "feat-abc123": {
            path: "/pi-container/.pi/worktrees/proj/feat-abc123",
            createdAt: "",
            baseRef: "main",
            originalCwd: TEST_CWD,
          },
        },
      })
    );
    pi = mockPi();
    ctx = mockCtx(undefined);

    const result = await forkWorktree(pi, ctx, "feat-abc123");
    expect(result.error).toContain("No current session file");
  });

  it("forks session and switches to it", async () => {
    mockFsReadFileSync.mockReturnValue(
      JSON.stringify({
        worktrees: {
          "feat-abc123": {
            path: "/pi-container/.pi/worktrees/proj/feat-abc123",
            createdAt: "",
            baseRef: "main",
            originalCwd: TEST_CWD,
          },
        },
      })
    );
    const mockSm = mockSessionManager("/sessions/forked.jsonl");
    mockSessionForkFrom.mockReturnValue(mockSm);
    pi = mockPi();
    ctx = mockCtx("/sessions/current.jsonl");

    const result = await forkWorktree(pi, ctx, "feat-abc123");

    expect(result.error).toBeUndefined();
    expect(result.worktreeName).toBe("feat-abc123");

    // forkFrom called with correct args
    expect(SessionManager.forkFrom).toHaveBeenCalledWith(
      "/sessions/current.jsonl",
      "/pi-container/.pi/worktrees/proj/feat-abc123"
    );

    // Original session name set to worktree name without hash
    expect(pi.getSessionName).toHaveBeenCalled();
    expect(pi.setSessionName).toHaveBeenCalledWith("feat");

    // Forked session name set to full worktree name
    expect(mockSm.appendSessionInfo).toHaveBeenCalledWith("feat-abc123");

    // Switch called
    expect(ctx.switchSession).toHaveBeenCalledWith(
      "/sessions/forked.jsonl",
      expect.objectContaining({ withSession: expect.any(Function) })
    );
  });

  it("does not override original session name if already set", async () => {
    mockFsReadFileSync.mockReturnValue(
      JSON.stringify({
        worktrees: {
          "feat-abc123": {
            path: "/pi-container/.pi/worktrees/proj/feat-abc123",
            createdAt: "",
            baseRef: "main",
            originalCwd: TEST_CWD,
          },
        },
      })
    );
    const mockSm = mockSessionManager("/sessions/forked.jsonl");
    mockSessionForkFrom.mockReturnValue(mockSm);
    pi = mockPi([], { sessionName: "existing-name" });
    ctx = mockCtx("/sessions/current.jsonl");

    const result = await forkWorktree(pi, ctx, "feat-abc123");

    expect(result.error).toBeUndefined();
    expect(pi.getSessionName).toHaveBeenCalled();
    expect(pi.setSessionName).not.toHaveBeenCalled();
  });

  it("returns error if forkFrom throws", async () => {
    mockFsReadFileSync.mockReturnValue(
      JSON.stringify({
        worktrees: {
          "feat-abc123": {
            path: "/pi-container/.pi/worktrees/proj/feat-abc123",
            createdAt: "",
            baseRef: "main",
            originalCwd: TEST_CWD,
          },
        },
      })
    );
    mockSessionForkFrom.mockImplementation(() => {
      throw new Error("Fork failed");
    });
    pi = mockPi();
    ctx = mockCtx("/sessions/current.jsonl");

    const result = await forkWorktree(pi, ctx, "feat-abc123");
    expect(result.error).toContain("Failed to fork session");
  });
});

// ── deleteWorktree ──────────────────────────────────────────

describe("deleteWorktree", () => {
  let pi: any;
  let ctx: any;

  beforeEach(() => {
    resetAllMocks();
  });

  it("returns error if worktree not in registry", async () => {
    mockFsReadFileSync.mockReturnValue(JSON.stringify({ worktrees: {} }));
    pi = mockPi();
    ctx = mockCtx(undefined);

    const result = await deleteWorktree(pi, ctx, "nonexistent");
    expect(result.error).toContain("not found in registry");
  });

  it("returns error if current session is in the worktree", async () => {
    const path = "/pi-container/.pi/worktrees/proj/feat-abc123";
    mockFsReadFileSync.mockReturnValue(
      JSON.stringify({
        worktrees: {
          "feat-abc123": {
            path,
            createdAt: "",
            baseRef: "main",
            originalCwd: TEST_CWD,
          },
        },
      })
    );
    pi = mockPi();
    ctx = mockCtx("/sessions/only.jsonl", path);

    const result = await deleteWorktree(pi, ctx, "feat-abc123");
    expect(result.error).toContain("Cannot delete worktree");
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("deletes worktree and removes from registry", async () => {
    const worktreePath = "/pi-container/.pi/worktrees/proj/feat-abc123";
    mockFsReadFileSync.mockReturnValue(
      JSON.stringify({
        worktrees: {
          "feat-abc123": {
            path: worktreePath,
            createdAt: "",
            baseRef: "main",
            originalCwd: TEST_CWD,
          },
        },
      })
    );
    mockFsExistsSync.mockReturnValue(true);

    pi = mockPi([{ code: 0, stdout: "", stderr: "" }]);
    ctx = mockCtx("/sessions/other.jsonl", TEST_CWD);

    const result = await deleteWorktree(pi, ctx, "feat-abc123");
    expect(result.error).toBeUndefined();
    expect(pi.exec).toHaveBeenCalledWith("git", [
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ]);
  });

  it("handles already-missing worktree directory", async () => {
    const worktreePath = "/pi-container/.pi/worktrees/proj/feat-abc123";
    mockFsReadFileSync.mockReturnValue(
      JSON.stringify({
        worktrees: {
          "feat-abc123": {
            path: worktreePath,
            createdAt: "",
            baseRef: "main",
            originalCwd: TEST_CWD,
          },
        },
      })
    );

    mockFsExistsSync.mockImplementation((p: string) => {
      if (p === worktreePath) return false;
      return true;
    });

    pi = mockPi([
      { code: 1, stdout: "", stderr: "fatal: not a git repository" },
      { code: 0, stdout: "", stderr: "" },
    ]);
    ctx = mockCtx("/sessions/current.jsonl", TEST_CWD);

    const result = await deleteWorktree(pi, ctx, "feat-abc123");
    expect(result.error).toBeUndefined();
    expect(pi.exec).toHaveBeenCalledWith("git", ["worktree", "prune"]);
  });
});
