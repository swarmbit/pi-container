// ============================================================
// Tests for config.ts — config discovery and loading
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { loadConfig, getUserConfigPath, parsePortMapping, parsePortsString, parseMountMapping, PI_VERSION, PI_IMAGE } from "./config";

let tmpDir: string;
let origCwd: string;

beforeEach(() => {
  origCwd = process.cwd();
  tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-container-test-")));
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PI_VERSION and PI_IMAGE constants", () => {
  it("PI_VERSION is a valid version string", () => {
    expect(PI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("PI_IMAGE is derived from PI_VERSION", () => {
    expect(PI_IMAGE).toBe(`pi-agent:${PI_VERSION}`);
  });

  it("loadConfig uses these constants", () => {
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir: tmpDir });
    // Config no longer has version/image — they're constants
    expect(config.ports).toEqual([]);
    expect(config.mounts).toEqual([]);
  });
});

describe("loadConfig", () => {
  it("returns empty ports when no config exists", () => {
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir: tmpDir });
    expect(config.ports).toEqual([]);
  });

  it("discovers .pi/ in CWD", () => {
    const containerDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(containerDir);
    process.chdir(tmpDir);

    const config = loadConfig({ homeDir: tmpDir });
    expect(config.containerDir).toBe(containerDir);
  });

  it("detects env from project config", () => {
    const containerDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(containerDir, { recursive: true });
    fs.writeFileSync(
      path.join(containerDir, "pi-container.yml"),
      "env:\n  ANTHROPIC_API_KEY: sk-test"
    );
    process.chdir(tmpDir);

    const config = loadConfig({ homeDir: tmpDir });
    expect(config.env).toEqual({ ANTHROPIC_API_KEY: "sk-test" });
  });

  it("returns empty env when no config exists", () => {
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir: tmpDir });
    expect(config.env).toEqual({});
  });

  it("detects dockerfileExtension from project config", () => {
    const containerDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(containerDir, { recursive: true });
    fs.writeFileSync(
      path.join(containerDir, "pi-container.yml"),
      "dockerfileExtension: |\n  RUN apt-get install -y python3"
    );
    process.chdir(tmpDir);

    const config = loadConfig({ homeDir: tmpDir });
    expect(config.dockerfileExtension).toBe("RUN apt-get install -y python3");
  });

  it("project dockerfileExtension overrides user config", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-container-home-"));
    fs.mkdirSync(path.join(homeDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".pi", "pi-container.yml"),
      "dockerfileExtension: |\n  RUN echo user"
    );

    const containerDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(containerDir, { recursive: true });
    fs.writeFileSync(
      path.join(containerDir, "pi-container.yml"),
      "dockerfileExtension: |\n  RUN echo project"
    );

    process.chdir(tmpDir);
    const config = loadConfig({ homeDir });
    expect(config.dockerfileExtension).toBe("RUN echo project");

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("projectDir equals CWD", () => {
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir: tmpDir });
    expect(config.projectDir).toBe(tmpDir);
  });

  it("workspaceDir is basename of projectDir with leading slash", () => {
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir: tmpDir });
    expect(config.workspaceDir).toBe(`/${path.basename(tmpDir)}`);
  });

  it("configDir is always ~/.pi", () => {
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir: tmpDir });
    expect(config.configDir).toBe(path.join(tmpDir, ".pi"));
  });

  // ── Config precedence for ports ────────────────────────────

  describe("port precedence", () => {
    it("user config overrides project config on conflict", () => {
      const containerDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(containerDir, { recursive: true });
      fs.writeFileSync(
        path.join(containerDir, "pi-container.yml"),
        "ports:\n  - 3000"
      );
      // User config at ~/.pi/pi-container.yml — same dir since homeDir=tmpDir
      fs.writeFileSync(
        path.join(tmpDir, ".pi", "pi-container.yml"),
        "ports:\n  - 3000:4000"
      );

      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir });
      expect(config.ports).toEqual([{ host: 3000, container: 4000 }]);
    });

    it("CLI ports override config on conflict", () => {
      const containerDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(containerDir, { recursive: true });
      fs.writeFileSync(
        path.join(containerDir, "pi-container.yml"),
        "ports:\n  - 3000"
      );
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir, cliPorts: ["3000:4000"] });
      expect(config.ports).toEqual([{ host: 3000, container: 4000 }]);
    });

    it("user env overrides project env on conflict", () => {
      // Use a separate home dir for user config
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-container-home-"));
      fs.mkdirSync(path.join(homeDir, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".pi", "pi-container.yml"),
        "env:\n  KEY: user-value"
      );

      // Project config
      const containerDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(containerDir, { recursive: true });
      fs.writeFileSync(
        path.join(containerDir, "pi-container.yml"),
        "env:\n  KEY: project-value\n  PROJECT_ONLY: yes"
      );

      process.chdir(tmpDir);
      const config = loadConfig({ homeDir });
      expect(config.env).toEqual({ KEY: "user-value", PROJECT_ONLY: "yes" });

      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    it("falls back gracefully when config files are missing", () => {
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir });
      expect(config.ports).toEqual([]);
    });

    // ── mounts ───────────────────────────────────────────

    it("mounts defaults to empty when not configured", () => {
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir });
      expect(config.mounts).toEqual([]);
    });

    it("reads mounts from project config", () => {
      const containerDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(containerDir, { recursive: true });
      fs.writeFileSync(
        path.join(containerDir, "pi-container.yml"),
        "mounts:\n  - /var/run/docker.sock:/var/run/docker.sock\n  - /host/ssh:/container/ssh:ro"
      );
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir });
      expect(config.mounts).toEqual([
        { host: "/var/run/docker.sock", container: "/var/run/docker.sock" },
        { host: "/host/ssh", container: "/container/ssh", mode: "ro" },
      ]);
    });

    it("user mounts override project mounts on matching container path", () => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-container-home-"));
      fs.mkdirSync(path.join(homeDir, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".pi", "pi-container.yml"),
        "mounts:\n  - /user/socket:/var/run/docker.sock"
      );

      const containerDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(containerDir, { recursive: true });
      fs.writeFileSync(
        path.join(containerDir, "pi-container.yml"),
        "mounts:\n  - /project/socket:/var/run/docker.sock"
      );

      process.chdir(tmpDir);
      const config = loadConfig({ homeDir });
      expect(config.mounts).toEqual([
        { host: "/user/socket", container: "/var/run/docker.sock" },
      ]);

      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    it("user mounts add to project mounts for different container paths", () => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-container-home-"));
      fs.mkdirSync(path.join(homeDir, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".pi", "pi-container.yml"),
        "mounts:\n  - /host/config:/container/config"
      );

      const containerDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(containerDir, { recursive: true });
      fs.writeFileSync(
        path.join(containerDir, "pi-container.yml"),
        "mounts:\n  - /var/run/docker.sock:/var/run/docker.sock"
      );

      process.chdir(tmpDir);
      const config = loadConfig({ homeDir });
      expect(config.mounts).toHaveLength(2);

      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    // ── gitUserName / gitUserEmail ──────────────────────

    it("gitUserName defaults to undefined when not configured", () => {
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir });
      // No git config set up in test env, so should be undefined
      // (inferGitConfig won't find anything and returns undefined)
      expect(config.gitUserName).toBeUndefined();
      expect(config.gitUserEmail).toBeUndefined();
    });

    it("reads gitUserName from project config", () => {
      const containerDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(containerDir, { recursive: true });
      fs.writeFileSync(
        path.join(containerDir, "pi-container.yml"),
        "gitUserName: Alice\ngitUserEmail: alice@example.com"
      );
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir });
      expect(config.gitUserName).toBe("Alice");
      expect(config.gitUserEmail).toBe("alice@example.com");
    });

    it("reads gitUserName from user config", () => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-container-home-"));
      fs.mkdirSync(path.join(homeDir, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".pi", "pi-container.yml"),
        "gitUserName: Bob"
      );
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir });
      expect(config.gitUserName).toBe("Bob");
      expect(config.gitUserEmail).toBeUndefined();
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    it("project gitUserName overrides user gitUserName", () => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-container-home-"));
      fs.mkdirSync(path.join(homeDir, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".pi", "pi-container.yml"),
        "gitUserName: UserBob\ngitUserEmail: user@bob.com"
      );

      const containerDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(containerDir, { recursive: true });
      fs.writeFileSync(
        path.join(containerDir, "pi-container.yml"),
        "gitUserName: ProjectAlice"
      );

      process.chdir(tmpDir);
      const config = loadConfig({ homeDir });
      expect(config.gitUserName).toBe("ProjectAlice");
      // User gitUserEmail not overridden by project (project doesn't set it)
      expect(config.gitUserEmail).toBe("user@bob.com");

      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    it("mounts are empty when config files are missing", () => {
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir });
      expect(config.mounts).toEqual([]);
    });
  });

  // ── Port parsing tests ──────────────────────────────────────────

  describe("ports from config", () => {
    it("parses ports from project config", () => {
      const containerDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(containerDir, { recursive: true });
      fs.writeFileSync(
        path.join(containerDir, "pi-container.yml"),
        "ports:\n  - 3000\n  - 8080:80"
      );
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir });
      expect(config.ports).toEqual([
        { host: 3000, container: 3000 },
        { host: 8080, container: 80 },
      ]);
    });

    it("parses ports from user config", () => {
      const userPiDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(userPiDir, { recursive: true });
      fs.writeFileSync(
        path.join(userPiDir, "pi-container.yml"),
        "ports:\n  - 4000"
      );
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir });
      expect(config.ports).toEqual([{ host: 4000, container: 4000 }]);
    });
  });
});

describe("parsePortMapping", () => {
  it("parses simple port", () => {
    expect(parsePortMapping("3000")).toEqual({ host: 3000, container: 3000 });
  });

  it("parses host:container", () => {
    expect(parsePortMapping("8080:3000")).toEqual({ host: 8080, container: 3000 });
  });

  it("rejects invalid ports", () => {
    expect(() => parsePortMapping("0")).toThrow();
    expect(() => parsePortMapping("65536")).toThrow();
    expect(() => parsePortMapping("abc")).toThrow();
    expect(() => parsePortMapping("-1")).toThrow();
  });

  it("rejects partially numeric ports", () => {
    expect(() => parsePortMapping("3000abc")).toThrow();
    expect(() => parsePortMapping("8080:3000abc")).toThrow();
  });

  it("rejects port ranges in CLI format", () => {
    expect(() => parsePortMapping("9000-9010")).toThrow(/only supported in config/);
  });

  it("rejects invalid host:container", () => {
    expect(() => parsePortMapping("abc:3000")).toThrow();
    expect(() => parsePortMapping("3000:abc")).toThrow();
  });

  it("rejects malformed host:container:extra", () => {
    expect(() => parsePortMapping("8080:3000:extra")).toThrow();
  });
});

describe("parsePortsString", () => {
  it("parses comma-separated ports", () => {
    expect(parsePortsString("3000,8080")).toEqual([
      { host: 3000, container: 3000 },
      { host: 8080, container: 8080 },
    ]);
  });

  it("parses host:container in comma-separated", () => {
    expect(parsePortsString("8080:3000,6006")).toEqual([
      { host: 8080, container: 3000 },
      { host: 6006, container: 6006 },
    ]);
  });

  it("parses port ranges", () => {
    expect(parsePortsString("9000-9002")).toEqual([
      { host: 9000, container: 9000 },
      { host: 9001, container: 9001 },
      { host: 9002, container: 9002 },
    ]);
  });

  it("ignores whitespace", () => {
    expect(parsePortsString(" 3000 , 8080 ")).toEqual([
      { host: 3000, container: 3000 },
      { host: 8080, container: 8080 },
    ]);
  });

  it("handles empty string", () => {
    expect(parsePortsString("")).toEqual([]);
  });

  it("rejects malformed host:container:extra", () => {
    expect(() => parsePortsString("8080:3000:extra")).toThrow();
  });

  it("rejects partially numeric ports", () => {
    expect(() => parsePortsString("3000abc")).toThrow();
  });
});

describe("getUserConfigPath", () => {
  it("returns path under ~/.pi/", () => {
    const configPath = getUserConfigPath("/home/testuser");
    expect(configPath).toBe("/home/testuser/.pi/pi-container.yml");
  });

  it("uses default home dir when no argument", () => {
    const configPath = getUserConfigPath();
    expect(configPath).toMatch(/\.pi.pi-container\.yml$/);
  });
});

describe("parseMountMapping", () => {
  it("parses host:container", () => {
    expect(parseMountMapping("/host/path:/container/path")).toEqual({
      host: "/host/path",
      container: "/container/path",
    });
  });

  it("parses host:container:mode", () => {
    expect(parseMountMapping("/host/path:/container/path:ro")).toEqual({
      host: "/host/path",
      container: "/container/path",
      mode: "ro",
    });
  });

  it("trims whitespace", () => {
    expect(parseMountMapping("  /host:/container  ")).toEqual({
      host: "/host",
      container: "/container",
    });
  });

  it("rejects empty host", () => {
    expect(() => parseMountMapping(":/container")).toThrow();
  });

  it("rejects empty container", () => {
    expect(() => parseMountMapping("/host:")).toThrow();
  });

  it("rejects single path (missing colon)", () => {
    expect(() => parseMountMapping("/only-one-path")).toThrow();
  });

  it("rejects too many colons", () => {
    expect(() => parseMountMapping("/a:/b:ro:extra")).toThrow();
  });

  it("supports paths with colons in mode-like positions", () => {
    // Only the first two colons are separators; rest is mode
    expect(parseMountMapping("/host:/container:ro,z")).toEqual({
      host: "/host",
      container: "/container",
      mode: "ro,z",
    });
  });
});
