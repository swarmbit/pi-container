// ============================================================
// Tests for worktree extension
// ============================================================
// Tests exported helpers, registry I/O, git helpers, and the
// create/delete flows with mocked external dependencies.
//
// @earendil-works/pi-coding-agent is mocked since it's only
// available at runtime inside the pi agent.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ───────────────────────────────────────────

const {
  mockFsExistsSync,
  mockFsReadFileSync,
  mockFsWriteFileSync,
  mockFsMkdirSync,
  mockFsUnlinkSync,
  mockExecSync,
} = vi.hoisted(() => ({
  mockFsExistsSync: vi.fn(),
  mockFsReadFileSync: vi.fn(),
  mockFsWriteFileSync: vi.fn(),
  mockFsMkdirSync: vi.fn(),
  mockFsUnlinkSync: vi.fn(),
  mockExecSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mockFsExistsSync,
  readFileSync: mockFsReadFileSync,
  writeFileSync: mockFsWriteFileSync,
  mkdirSync: mockFsMkdirSync,
  unlinkSync: mockFsUnlinkSync,
}));

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
}));

const {
  mockSessionCreate,
  mockSessionForkFrom,
  mockSessionList,
  mockAppendSessionInfo,
  mockAppendCustomEntry,
} = vi.hoisted(() => ({
  mockSessionCreate: vi.fn(),
  mockSessionForkFrom: vi.fn(),
  mockSessionList: vi.fn(),
  mockAppendSessionInfo: vi.fn(),
  mockAppendCustomEntry: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    create: mockSessionCreate,
    forkFrom: mockSessionForkFrom,
    list: mockSessionList,
    listAll: vi.fn(),
  },
}));

// ── Now import extension functions ──────────────────────────

import {
  buildWorktreeName,
  readRegistry,
  writeRegistry,
  getCurrentBranch,
  getShortHash,
  listWorktrees,
  createWorktree,
  deleteWorktree,
  WORKTREES_DIR,
} from "./index";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// ── Helpers ──────────────────────────────────────────────────

function mockSessionManager(sessionFile: string) {
  return {
    getSessionFile: () => sessionFile,
    appendSessionInfo: mockAppendSessionInfo,
    appendCustomEntry: mockAppendCustomEntry,
  };
}

function mockPi(gitResults: Array<{ code: number; stdout: string; stderr: string }> = []) {
  let callIndex = 0;
  return {
    exec: vi.fn().mockImplementation(async (_cmd: string, _args: string[]) => {
      const result = gitResults[callIndex] ?? { code: 0, stdout: "", stderr: "" };
      callIndex++;
      return result;
    }),
  } as any;
}

function mockCtx(sessionFile: string | undefined) {
  return {
    cwd: "/pi-container",
    sessionManager: {
      getSessionFile: () => sessionFile ?? null,
    },
    switchSession: vi.fn().mockImplementation(async (_path: string, _opts: any) => {
      if (_opts?.withSession) await _opts.withSession({});
    }),
    ui: {} as any,
  } as any;
}

function resetAllMocks() {
  vi.clearAllMocks();
  mockFsExistsSync.mockReturnValue(false);
  mockFsReadFileSync.mockImplementation(() => {
    throw new Error("ENOENT");
  });
  mockFsWriteFileSync.mockImplementation(() => {});
  mockFsMkdirSync.mockImplementation(() => {});
  mockFsUnlinkSync.mockImplementation(() => {});
  mockExecSync.mockReturnValue("main");
}

// ── buildWorktreeName ────────────────────────────────────────

describe("buildWorktreeName", () => {
  it("combines hash and name with underscore", () => {
    expect(buildWorktreeName("abc123", "feature-x")).toBe("abc123_feature-x");
  });

  it("sanitizes spaces to dashes", () => {
    expect(buildWorktreeName("abc123", "my feature")).toBe("abc123_my-feature");
  });

  it("replaces multiple spaces with single dash", () => {
    expect(buildWorktreeName("abc123", "my   feature")).toBe("abc123_my-feature");
  });

  it("replaces special characters with dashes", () => {
    // !@#$%^&*() each become "-", then collapsed to a single "-"
    expect(buildWorktreeName("abc123", "fix!@#$%^&*()bug")).toBe("abc123_fix-bug");
  });

  it("collapses consecutive dashes from sanitization", () => {
    expect(buildWorktreeName("abc123", "a!@#b")).toBe("abc123_a-b");
  });

  it("trims leading and trailing dashes", () => {
    expect(buildWorktreeName("abc123", "-leading-")).toBe("abc123_leading");
    expect(buildWorktreeName("abc123", "trailing-")).toBe("abc123_trailing");
    expect(buildWorktreeName("abc123", "---")).toBe("abc123_");
  });

  it("handles dots and underscores", () => {
    expect(buildWorktreeName("abc123", "v1.2.3_rc1")).toBe("abc123_v1.2.3_rc1");
  });

  it("handles empty name gracefully", () => {
    expect(buildWorktreeName("abc123", "")).toBe("abc123_");
  });

  it("preserves numbers", () => {
    expect(buildWorktreeName("abc123", "bugfix-123")).toBe("abc123_bugfix-123");
  });

  it("handles long hash", () => {
    expect(buildWorktreeName("a1b2c3d4e5f6", "feat")).toBe("a1b2c3d4e5f6_feat");
  });
});

// ── Registry I/O ─────────────────────────────────────────────

describe("Registry", () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it("readRegistry returns empty when file doesn't exist", () => {
    // mockFsReadFileSync throws ENOENT by default from resetAllMocks
    const registry = readRegistry();
    expect(registry).toEqual({ worktrees: {} });
  });

  it("readRegistry returns parsed content when file exists", () => {
    const data = {
      worktrees: {
        "abc123_feat": {
          path: "/workdir/pi-container/worktrees/abc123_feat",
          sessionFile: "/sessions/x.jsonl",
          createdAt: "2025-01-01T00:00:00.000Z",
          baseRef: "main",
        },
      },
    };
    mockFsReadFileSync.mockReturnValue(JSON.stringify(data));
    const registry = readRegistry();
    expect(registry.worktrees["abc123_feat"]).toBeDefined();
    expect(registry.worktrees["abc123_feat"].baseRef).toBe("main");
  });

  it("writeRegistry creates directory and writes JSON", () => {
    writeRegistry({ worktrees: {} });
    expect(mockFsMkdirSync).toHaveBeenCalledWith(WORKTREES_DIR, { recursive: true });
    expect(mockFsWriteFileSync).toHaveBeenCalled();
    const written = JSON.parse(mockFsWriteFileSync.mock.calls[0][1]);
    expect(written).toEqual({ worktrees: {} });
  });

  it("writeRegistry writes valid JSON with worktree entries", () => {
    const registry = {
      worktrees: {
        "abc123_feat": {
          path: "/workdir/worktrees/abc123_feat",
          sessionFile: "/sessions/x.jsonl",
          createdAt: "2025-01-01T00:00:00.000Z",
          baseRef: "main",
        },
      },
    };
    writeRegistry(registry);
    const written = JSON.parse(mockFsWriteFileSync.mock.calls[0][1]);
    expect(written.worktrees["abc123_feat"].path).toBe("/workdir/worktrees/abc123_feat");
    expect(written.worktrees["abc123_feat"].sessionFile).toBe("/sessions/x.jsonl");
    expect(written.worktrees["abc123_feat"].baseRef).toBe("main");
  });

  it("roundtrip: write then read", () => {
    const registry = {
      worktrees: {
        "abc123_feat": {
          path: "/workdir/worktrees/abc123_feat",
          sessionFile: "/sessions/x.jsonl",
          createdAt: "2025-01-01T00:00:00.000Z",
          baseRef: "main",
        },
      },
    };

    // Capture what writeRegistry writes
    writeRegistry(registry);
    const writtenJson = mockFsWriteFileSync.mock.calls[0][1];
    mockFsReadFileSync.mockReturnValue(writtenJson);

    const read = readRegistry();
    expect(read).toEqual(registry);
  });

  it("registry can hold multiple worktrees", () => {
    const registry = {
      worktrees: {
        "abc123_feat-a": {
          path: "/workdir/worktrees/abc123_feat-a",
          sessionFile: "/sessions/a.jsonl",
          createdAt: "2025-01-01T00:00:00.000Z",
          baseRef: "main",
        },
        "def456_feat-b": {
          path: "/workdir/worktrees/def456_feat-b",
          sessionFile: "/sessions/b.jsonl",
          createdAt: "2025-01-02T00:00:00.000Z",
          baseRef: "develop",
        },
      },
    };

    writeRegistry(registry);
    const writtenJson = mockFsWriteFileSync.mock.calls[0][1];
    mockFsReadFileSync.mockReturnValue(writtenJson);

    const read = readRegistry();
    expect(Object.keys(read.worktrees)).toHaveLength(2);
  });

  it("delete from registry removes entry", () => {
    const registry = {
      worktrees: {
        "abc123_feat": {
          path: "/workdir/worktrees/abc123_feat",
          sessionFile: "/sessions/x.jsonl",
          createdAt: "2025-01-01T00:00:00.000Z",
          baseRef: "main",
        },
      },
    };

    // Write initial
    writeRegistry(registry);
    const writtenJson = mockFsWriteFileSync.mock.calls[0][1];
    mockFsReadFileSync.mockReturnValue(writtenJson);

    // Read, modify, write
    const read = readRegistry();
    delete read.worktrees["abc123_feat"];
    writeRegistry(read);

    const updatedJson = mockFsWriteFileSync.mock.calls[1][1];
    mockFsReadFileSync.mockReturnValue(updatedJson);

    const reRead = readRegistry();
    expect(Object.keys(reRead.worktrees)).toHaveLength(0);
  });
});

// ── listWorktrees ────────────────────────────────────────────

describe("listWorktrees", () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it("returns empty array for empty registry", () => {
    const ctx = mockCtx(undefined);
    const lines = listWorktrees(ctx);
    expect(lines).toEqual([]);
  });

  it("lists registered worktrees with branch info", () => {
    const data = {
      worktrees: {
        "abc123_feat-a": {
          path: "/workdir/worktrees/abc123_feat-a",
          sessionFile: "/sessions/a.jsonl",
          createdAt: "",
          baseRef: "main",
        },
      },
    };
    mockFsReadFileSync.mockReturnValue(JSON.stringify(data));

    const ctx = mockCtx(undefined);
    const lines = listWorktrees(ctx);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("abc123_feat-a");
    expect(lines[0]).toContain("base=main");
  });

  it("marks the current session's worktree", () => {
    const data = {
      worktrees: {
        "abc123_feat-a": {
          path: "/workdir/worktrees/abc123_feat-a",
          sessionFile: "/sessions/a.jsonl",
          createdAt: "",
          baseRef: "main",
        },
        "def456_feat-b": {
          path: "/workdir/worktrees/def456_feat-b",
          sessionFile: "/sessions/b.jsonl",
          createdAt: "",
          baseRef: "develop",
        },
      },
    };
    mockFsReadFileSync.mockReturnValue(JSON.stringify(data));

    const ctx = mockCtx("/sessions/a.jsonl");
    const lines = listWorktrees(ctx);

    const currentLine = lines.find((l) => l.includes("abc123_feat-a"));
    expect(currentLine).toContain("← current");

    const otherLine = lines.find((l) => l.includes("def456_feat-b"));
    expect(otherLine).not.toContain("← current");
  });

  it("marks missing directories", () => {
    const data = {
      worktrees: {
        "abc123_feat-a": {
          path: "/workdir/worktrees/abc123_feat-a",
          sessionFile: "/sessions/a.jsonl",
          createdAt: "",
          baseRef: "main",
        },
      },
    };
    mockFsReadFileSync.mockReturnValue(JSON.stringify(data));
    // existsSync returns false for the worktree path (directory missing)
    mockFsExistsSync.mockReturnValue(false);

    const ctx = mockCtx(undefined);
    const lines = listWorktrees(ctx);
    expect(lines[0]).toContain("[directory missing]");
  });

  it("does not mark existing directories", () => {
    const data = {
      worktrees: {
        "abc123_feat-a": {
          path: "/workdir/worktrees/abc123_feat-a",
          sessionFile: "/sessions/a.jsonl",
          createdAt: "",
          baseRef: "main",
        },
      },
    };
    mockFsReadFileSync.mockReturnValue(JSON.stringify(data));
    // existsSync returns true for the worktree path
    mockFsExistsSync.mockReturnValue(true);

    const ctx = mockCtx(undefined);
    const lines = listWorktrees(ctx);
    expect(lines[0]).not.toContain("[directory missing]");
  });
});

// ── Git helpers ──────────────────────────────────────────────

describe("getCurrentBranch", () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it("returns execSync output on success", () => {
    mockExecSync.mockReturnValue("feature/my-branch\n");
    const branch = getCurrentBranch();
    expect(branch).toBe("feature/my-branch");
  });

  it("falls back to 'HEAD' on error", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("git not found");
    });
    const branch = getCurrentBranch();
    expect(branch).toBe("HEAD");
  });
});

describe("getShortHash", () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it("returns short hash from execSync", () => {
    mockExecSync.mockReturnValue("a1b2c3d\n");
    const hash = getShortHash();
    expect(hash).toBe("a1b2c3d");
  });

  it("uses provided ref", () => {
    mockExecSync.mockReturnValue("d4e5f6\n");
    const hash = getShortHash("develop");
    expect(hash).toBe("d4e5f6");
    expect(mockExecSync).toHaveBeenCalledWith(
      "git rev-parse --short develop",
      expect.any(Object)
    );
  });

  it("falls back to 'unknown' on error", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    const hash = getShortHash();
    expect(hash).toBe("unknown");
  });
});

// ── createWorktree ──────────────────────────────────────────

describe("createWorktree", () => {
  let pi: any;
  let ctx: any;

  beforeEach(() => {
    resetAllMocks();
    mockExecSync.mockReturnValue("abc123"); // for getShortHash
  });

  describe("validation errors", () => {
    it("returns error if worktree path already exists on disk", async () => {
      mockFsExistsSync.mockReturnValue(true); // path exists
      pi = mockPi();
      ctx = mockCtx("/sessions/current.jsonl");

      const result = await createWorktree(pi, ctx, "feature-x");

      expect(result.error).toContain("already exists");
      expect(result.worktreeName).toBeUndefined();
    });

    it("returns error if already registered", async () => {
      mockFsExistsSync.mockImplementation((p: string) => {
        return p.includes(".registry.json"); // only registry file "exists"
      });
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify({
          worktrees: {
            abc123_feature: {
              path: "/some/path",
              sessionFile: "/s.jsonl",
              createdAt: "",
              baseRef: "",
            },
          },
        })
      );

      pi = mockPi();
      ctx = mockCtx("/sessions/current.jsonl");

      const result = await createWorktree(pi, ctx, "feature");

      expect(result.error).toContain("already registered");
    });

    it("returns error if git worktree add fails", async () => {
      mockFsExistsSync.mockReturnValue(false); // path doesn't exist
      mockFsReadFileSync.mockReturnValue(JSON.stringify({ worktrees: {} }));

      pi = mockPi([{ code: 1, stdout: "", stderr: "fatal: not a git repository" }]);
      ctx = mockCtx("/sessions/current.jsonl");

      const result = await createWorktree(pi, ctx, "feature");

      expect(result.error).toContain("git worktree add failed");
    });
  });

  describe("session creation", () => {
    it("forks existing session via SessionManager.forkFrom", async () => {
      const mockSm = mockSessionManager("/sessions/new.jsonl");
      mockSessionForkFrom.mockReturnValue(mockSm);
      mockFsExistsSync.mockReturnValue(false); // path doesn't exist
      mockFsReadFileSync.mockReturnValue(JSON.stringify({ worktrees: {} }));

      pi = mockPi();
      ctx = mockCtx("/sessions/current.jsonl");

      const result = await createWorktree(pi, ctx, "feature");

      expect(result.error).toBeUndefined();
      expect(result.forked).toBe(true);
      expect(result.worktreeName).toBe("abc123_feature");
      expect(SessionManager.forkFrom).toHaveBeenCalledWith(
        "/sessions/current.jsonl",
        expect.stringContaining("/workdir/pi-container/worktrees/abc123_feature")
      );
      expect(mockAppendSessionInfo).toHaveBeenCalledWith("abc123_feature");
      expect(mockAppendCustomEntry).toHaveBeenCalled();
    });

    it("creates new session via SessionManager.create when ephemeral", async () => {
      const mockSm = mockSessionManager("/sessions/new.jsonl");
      mockSessionCreate.mockReturnValue(mockSm);
      mockFsExistsSync.mockReturnValue(false); // path doesn't exist
      mockFsReadFileSync.mockReturnValue(JSON.stringify({ worktrees: {} }));

      pi = mockPi();
      ctx = mockCtx(undefined); // no session file = ephemeral

      const result = await createWorktree(pi, ctx, "feature");

      expect(result.error).toBeUndefined();
      expect(result.forked).toBe(false);
      expect(SessionManager.create).toHaveBeenCalledWith(
        expect.stringContaining("/workdir/pi-container/worktrees/abc123_feature")
      );
    });

    it("rolls back git worktree if session creation throws", async () => {
      mockSessionForkFrom.mockImplementation(() => {
        throw new Error("Session creation failed");
      });
      mockFsExistsSync.mockReturnValue(false);
      mockFsReadFileSync.mockReturnValue(JSON.stringify({ worktrees: {} }));

      pi = mockPi([
        { code: 0, stdout: "", stderr: "" }, // git worktree add (succeeds)
        { code: 0, stdout: "", stderr: "" }, // git worktree remove (rollback)
      ]);
      ctx = mockCtx("/sessions/current.jsonl");

      const result = await createWorktree(pi, ctx, "feature");

      expect(result.error).toContain("Session setup failed");
      // First call: git worktree add, second: rollback remove
      expect(pi.exec).toHaveBeenCalledTimes(2);
    });

    it("stores worktree metadata in session via appendCustomEntry", async () => {
      const mockSm = mockSessionManager("/sessions/new.jsonl");
      mockSessionForkFrom.mockReturnValue(mockSm);
      mockFsExistsSync.mockReturnValue(false);
      mockFsReadFileSync.mockReturnValue(JSON.stringify({ worktrees: {} }));

      pi = mockPi();
      ctx = mockCtx("/sessions/current.jsonl");

      await createWorktree(pi, ctx, "feature");

      expect(mockAppendCustomEntry).toHaveBeenCalledWith(
        "worktree",
        expect.objectContaining({
          worktreeName: "abc123_feature",
          worktreePath: expect.stringContaining("/workdir/pi-container/worktrees/abc123_feature"),
          baseRef: expect.any(String),
          createdAt: expect.any(String),
          forked: true,
        })
      );
    });

    it("switches to the new session after creation", async () => {
      const mockSm = mockSessionManager("/sessions/new.jsonl");
      mockSessionForkFrom.mockReturnValue(mockSm);
      mockFsExistsSync.mockReturnValue(false);
      mockFsReadFileSync.mockReturnValue(JSON.stringify({ worktrees: {} }));

      pi = mockPi();
      ctx = mockCtx("/sessions/current.jsonl");

      await createWorktree(pi, ctx, "feature");

      expect(ctx.switchSession).toHaveBeenCalledWith(
        "/sessions/new.jsonl",
        expect.any(Object)
      );
    });
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

  it("returns error if deleting the only remaining session from within it", async () => {
    const sessionFile = "/sessions/only.jsonl";
    mockFsReadFileSync.mockReturnValue(
      JSON.stringify({
        worktrees: {
          abc123_feat: {
            path: "/workdir/worktrees/abc123_feat",
            sessionFile,
            createdAt: "",
            baseRef: "main",
          },
        },
      })
    );

    mockSessionList.mockResolvedValue([
      { path: sessionFile, cwd: "/pi-container", name: "abc123_feat" },
    ]);

    pi = mockPi();
    ctx = mockCtx(sessionFile);

    const result = await deleteWorktree(pi, ctx, "abc123_feat");
    expect(result.error).toContain("only remaining session");
  });

  it("successfully deletes a non-current session's worktree", async () => {
    const deletedSession = "/sessions/deleted.jsonl";
    const currentSession = "/sessions/current.jsonl";

    mockFsReadFileSync.mockReturnValue(
      JSON.stringify({
        worktrees: {
          abc123_feat: {
            path: "/workdir/worktrees/abc123_feat",
            sessionFile: deletedSession,
            createdAt: "",
            baseRef: "main",
          },
        },
      })
    );
    mockFsExistsSync.mockReturnValue(true); // everything exists

    pi = mockPi([{ code: 0, stdout: "", stderr: "" }]);
    ctx = mockCtx(currentSession); // different session

    const result = await deleteWorktree(pi, ctx, "abc123_feat");

    expect(result.error).toBeUndefined();
    expect(pi.exec).toHaveBeenCalledWith("git", [
      "worktree",
      "remove",
      "--force",
      "/workdir/worktrees/abc123_feat",
    ]);
    expect(mockFsUnlinkSync).toHaveBeenCalledWith(deletedSession);
  });

  it("switches session before deleting if current session matches", async () => {
    const sessionFile = "/sessions/current.jsonl";
    const otherSession = "/sessions/other.jsonl";

    mockFsReadFileSync.mockReturnValue(
      JSON.stringify({
        worktrees: {
          abc123_feat: {
            path: "/workdir/worktrees/abc123_feat",
            sessionFile,
            createdAt: "",
            baseRef: "main",
          },
        },
      })
    );

    mockSessionList.mockResolvedValue([
      { path: sessionFile, cwd: "/pi-container", name: "abc123_feat" },
      { path: otherSession, cwd: "/pi-container", name: "other" },
    ]);
    mockFsExistsSync.mockReturnValue(true);

    pi = mockPi([{ code: 0, stdout: "", stderr: "" }]);
    ctx = mockCtx(sessionFile);
    ctx.ui = {
      select: vi.fn().mockResolvedValue(`${otherSession}  (other)`),
    };

    const result = await deleteWorktree(pi, ctx, "abc123_feat");

    expect(result.error).toBeUndefined();
    expect(result.switchedTo).toBe(otherSession);
    expect(ctx.switchSession).toHaveBeenCalledWith(otherSession, expect.any(Object));
  });

  it("handles already-missing worktree directory gracefully", async () => {
    const deletedSession = "/sessions/deleted.jsonl";
    const currentSession = "/sessions/current.jsonl";

    mockFsReadFileSync.mockReturnValue(
      JSON.stringify({
        worktrees: {
          abc123_feat: {
            path: "/workdir/worktrees/abc123_feat",
            sessionFile: deletedSession,
            createdAt: "",
            baseRef: "main",
          },
        },
      })
    );

    // existsSync: return false only for the worktree path itself
    mockFsExistsSync.mockImplementation((p: string) => {
      if (p === "/workdir/worktrees/abc123_feat") return false; // missing
      return true; // everything else (including session file) exists
    });

    // git worktree remove fails, then git worktree prune succeeds
    pi = mockPi([
      { code: 1, stdout: "", stderr: "fatal: not a git repository" },
      { code: 0, stdout: "", stderr: "" },
    ]);
    ctx = mockCtx(currentSession);

    const result = await deleteWorktree(pi, ctx, "abc123_feat");

    expect(result.error).toBeUndefined();
    expect(pi.exec).toHaveBeenCalledWith("git", ["worktree", "prune"]);
  });

  it("cancels delete if user doesn't pick a session to switch to", async () => {
    const sessionFile = "/sessions/current.jsonl";
    const otherSession = "/sessions/other.jsonl";

    mockFsReadFileSync.mockReturnValue(
      JSON.stringify({
        worktrees: {
          abc123_feat: {
            path: "/workdir/worktrees/abc123_feat",
            sessionFile,
            createdAt: "",
            baseRef: "main",
          },
        },
      })
    );

    mockSessionList.mockResolvedValue([
      { path: sessionFile, cwd: "/pi-container", name: "abc123_feat" },
      { path: otherSession, cwd: "/pi-container", name: "other" },
    ]);

    pi = mockPi();
    ctx = mockCtx(sessionFile);
    ctx.ui = {
      select: vi.fn().mockResolvedValue(undefined), // user cancels
    };

    const result = await deleteWorktree(pi, ctx, "abc123_feat");

    expect(result.error).toContain("cancelled");
    // Should not attempt to delete anything
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("removes entry from registry after successful delete", async () => {
    const deletedSession = "/sessions/deleted.jsonl";
    const currentSession = "/sessions/current.jsonl";
    const initialRegistry = {
      worktrees: {
        abc123_feat: {
          path: "/workdir/worktrees/abc123_feat",
          sessionFile: deletedSession,
          createdAt: "",
          baseRef: "main",
        },
      },
    };

    mockFsReadFileSync.mockReturnValue(JSON.stringify(initialRegistry));
    mockFsExistsSync.mockReturnValue(true);

    pi = mockPi([{ code: 0, stdout: "", stderr: "" }]);
    ctx = mockCtx(currentSession);

    await deleteWorktree(pi, ctx, "abc123_feat");

    // The writeFileSync call should contain the updated registry (entry removed)
    expect(mockFsWriteFileSync).toHaveBeenCalledTimes(1);
    const updatedRegistry = JSON.parse(mockFsWriteFileSync.mock.calls[0][1]);
    expect(updatedRegistry.worktrees).toEqual({});
  });
});

// ── Edge cases ───────────────────────────────────────────────

describe("edge cases", () => {
  let pi: any;
  let ctx: any;

  beforeEach(() => {
    resetAllMocks();
    mockExecSync.mockReturnValue("abc123");
  });

  it("createWorktree handles null sessionFile as ephemeral", async () => {
    const mockSm = mockSessionManager("/sessions/new.jsonl");
    mockSessionCreate.mockReturnValue(mockSm);
    mockFsExistsSync.mockReturnValue(false);
    mockFsReadFileSync.mockReturnValue(JSON.stringify({ worktrees: {} }));

    const pi = mockPi();
    const ctx = mockCtx(null as any); // null session file

    const result = await createWorktree(pi, ctx, "feature");
    expect(result.forked).toBe(false);
    expect(SessionManager.create).toHaveBeenCalled();
  });

  it("deleteWorktree handles session file that's already gone", async () => {
    const deletedSession = "/sessions/deleted.jsonl";
    const currentSession = "/sessions/current.jsonl";

    mockFsReadFileSync.mockReturnValue(
      JSON.stringify({
        worktrees: {
          abc123_feat: {
            path: "/workdir/worktrees/abc123_feat",
            sessionFile: deletedSession,
            createdAt: "",
            baseRef: "main",
          },
        },
      })
    );

    // Session file doesn't exist on disk
    mockFsExistsSync.mockImplementation((p: string) => {
      if (p === deletedSession) return false; // session file gone
      return true;
    });

    pi = mockPi([{ code: 0, stdout: "", stderr: "" }]);
    ctx = mockCtx(currentSession);

    const result = await deleteWorktree(pi, ctx, "abc123_feat");

    expect(result.error).toBeUndefined();
    // unlinkSync should not be called because file doesn't exist
    expect(mockFsUnlinkSync).not.toHaveBeenCalled();
  });

  it("createWorktree uses custom base ref when provided", async () => {
    const mockSm = mockSessionManager("/sessions/new.jsonl");
    mockSessionForkFrom.mockReturnValue(mockSm);
    mockFsExistsSync.mockReturnValue(false);
    mockFsReadFileSync.mockReturnValue(JSON.stringify({ worktrees: {} }));

    const pi = mockPi();
    const ctx = mockCtx("/sessions/current.jsonl");

    // getShortHash is called with the base ref
    mockExecSync.mockReturnValueOnce("def456"); // getShortHash("develop")

    const result = await createWorktree(pi, ctx, "feature", "develop");

    expect(mockExecSync).toHaveBeenCalledWith(
      "git rev-parse --short develop",
      expect.any(Object)
    );
    expect(result.worktreeName).toBe("def456_feature");
  });
});
