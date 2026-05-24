// ============================================================
// Tests for config.ts — config discovery and loading
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { loadConfig, getUserConfigPath, parsePortMapping, parsePortsString } from "./config";

let tmpDir: string;
let origCwd: string;

beforeEach(() => {
  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-container-test-"));
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.PI_VERSION;
  delete process.env.PI_IMAGE_TAG;
  delete process.env.PI_CONFIG_DIR;
  delete process.env.PI_PORTS;
});

describe("loadConfig", () => {
  it("uses defaults when no .pi/ directory exists", () => {
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir: tmpDir });

    expect(config.piVersion).toBe("0.75.5");
    expect(config.imageTag).toBe("pi-agent:0.75.5");
    expect(config.projectDir).toBe(tmpDir);
    expect(config.containerDir).toBe("");
    expect(config.hasPackage).toBe(false);
    expect(config.hasSettings).toBe(false);
    expect(config.packages).toEqual([]);
    expect(config.ports).toEqual([]);
  });

  it("discovers .pi/ in CWD", () => {
    const containerDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(containerDir);
    process.chdir(tmpDir);

    const config = loadConfig({ homeDir: tmpDir });
    expect(config.containerDir).toBe(containerDir);
  });

  it("detects package directory", () => {
    const pkgDir = path.join(tmpDir, ".pi", "package");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "test-pkg", pi: { extensions: ["./extensions"] } })
    );
    process.chdir(tmpDir);

    const config = loadConfig({ homeDir: tmpDir });
    expect(config.hasPackage).toBe(true);
  });

  it("detects package directory with extensions and themes", () => {
    const pkgDir = path.join(tmpDir, ".pi", "package");
    const extDir = path.join(pkgDir, "extensions", "my-ext");
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, "index.ts"), "export default function() {}");
    const themeDir = path.join(pkgDir, "themes");
    fs.mkdirSync(themeDir, { recursive: true });
    fs.writeFileSync(path.join(themeDir, "dark.json"), '{"name":"dark"}');
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "test-pkg", pi: { extensions: ["./extensions"], themes: ["./themes"] } })
    );
    process.chdir(tmpDir);

    const config = loadConfig({ homeDir: tmpDir });
    expect(config.hasPackage).toBe(true);
  });

  it("detects settings", () => {
    const settingsDir = path.join(tmpDir, ".pi", "settings");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, "default-settings.json"),
      JSON.stringify({ defaultThinkingLevel: "high" })
    );
    process.chdir(tmpDir);

    const config = loadConfig({ homeDir: tmpDir });
    expect(config.hasSettings).toBe(true);
  });

  it("detects package directory at project root", () => {
    // package/ at project root (not inside .pi/)
    const pkgDir = path.join(tmpDir, "package");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "root-pkg", pi: { extensions: ["./extensions"] } })
    );
    process.chdir(tmpDir);

    const config = loadConfig({ homeDir: tmpDir });
    expect(config.hasPackage).toBe(true);
  });

  it("detects settings at project root", () => {
    // settings/ at project root (not inside .pi/)
    const settingsDir = path.join(tmpDir, "settings");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, "default-settings.json"),
      JSON.stringify({ defaultThinkingLevel: "high" })
    );
    process.chdir(tmpDir);

    const config = loadConfig({ homeDir: tmpDir });
    expect(config.hasSettings).toBe(true);
  });

  it("detects .env file", () => {
    fs.writeFileSync(path.join(tmpDir, ".env"), "ANTHROPIC_API_KEY=sk-test");
    process.chdir(tmpDir);

    const config = loadConfig({ homeDir: tmpDir });
    expect(config.envFile).toBe(path.join(tmpDir, ".env"));
  });

  it("returns empty envFile when .env doesn't exist", () => {
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir: tmpDir });
    expect(config.envFile).toBe("");
  });

  // ── Config precedence tests ─────────────────────────────────

  describe("precedence", () => {
    it("env vars override everything", () => {
      // Set up project config
      const containerDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(containerDir, { recursive: true });
      fs.writeFileSync(
        path.join(containerDir, "config.yml"),
        "piVersion: '0.50.0'\nimageTag: 'project:tag'"
      );

      // Set up user config
      const userPiDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(userPiDir, { recursive: true });
      fs.writeFileSync(
        path.join(userPiDir, "pi-container.yml"),
        "piVersion: '0.60.0'\nimageTag: 'user:tag'"
      );

      process.chdir(tmpDir);
      process.env.PI_VERSION = "0.99.0";
      process.env.PI_IMAGE_TAG = "env:tag";

      const config = loadConfig({ homeDir: tmpDir });

      expect(config.piVersion).toBe("0.99.0");
      expect(config.imageTag).toBe("env:tag");
    });

    it("user config overrides project config", () => {
      // Set up project config
      const containerDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(containerDir, { recursive: true });
      fs.writeFileSync(
        path.join(containerDir, "config.yml"),
        "piVersion: '0.50.0'"  // project says 0.50.0
      );

      // Set up user config
      const userPiDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(userPiDir, { recursive: true });
      fs.writeFileSync(
        path.join(userPiDir, "pi-container.yml"),
        "piVersion: '0.60.0'"  // user overrides to 0.60.0
      );

      process.chdir(tmpDir);

      const config = loadConfig({ homeDir: tmpDir });

      expect(config.piVersion).toBe("0.60.0");
      expect(config.imageTag).toBe("pi-agent:0.60.0");
    });

    it("project config overrides defaults", () => {
      const containerDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(containerDir, { recursive: true });
      fs.writeFileSync(
        path.join(containerDir, "config.yml"),
        "piVersion: '0.50.0'\nimageTag: 'custom:tag'"
      );
      process.chdir(tmpDir);

      const config = loadConfig({ homeDir: tmpDir });
      expect(config.piVersion).toBe("0.50.0");
      expect(config.imageTag).toBe("custom:tag");
    });

    it("env var overrides user config", () => {
      const userPiDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(userPiDir, { recursive: true });
      fs.writeFileSync(
        path.join(userPiDir, "pi-container.yml"),
        "piVersion: '0.60.0'"
      );

      process.chdir(tmpDir);
      process.env.PI_VERSION = "0.99.0";

      const config = loadConfig({ homeDir: tmpDir });
      expect(config.piVersion).toBe("0.99.0");
    });

    it("falls back to defaults when no config exists", () => {
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir });

      expect(config.piVersion).toBe("0.75.5");
      expect(config.imageTag).toBe("pi-agent:0.75.5");
      expect(config.configDir).toBe(path.join(tmpDir, ".pi"));
    });

    it("user config can override configDir", () => {
      const userPiDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(userPiDir, { recursive: true });
      const customConfigDir = path.join(tmpDir, "custom-pi-config");
      fs.writeFileSync(
        path.join(userPiDir, "pi-container.yml"),
        `configDir: '${customConfigDir}'`
      );

      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir });
      expect(config.configDir).toBe(customConfigDir);
    });

    it("PI_CONFIG_DIR env var overrides user configDir", () => {
      const userPiDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(userPiDir, { recursive: true });
      const userConfigDir2 = path.join(tmpDir, "user-config");
      fs.writeFileSync(
        path.join(userPiDir, "pi-container.yml"),
        `configDir: '${userConfigDir2}'`
      );

      process.chdir(tmpDir);
      const envConfigDir = path.join(tmpDir, "env-config");
      process.env.PI_CONFIG_DIR = envConfigDir;

      const config = loadConfig({ homeDir: tmpDir });
      expect(config.configDir).toBe(envConfigDir);
    });

    it("user config is missing — falls back gracefully", () => {
      // No ~/.pi/pi-container.yml exists
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir });
      expect(config.piVersion).toBe("0.75.5");
    });

    it("project config is missing — falls back gracefully", () => {
      // No .pi/config.yml, just the directory
      fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir });
      expect(config.piVersion).toBe("0.75.5");
    });
  });

  // ── Other tests ──────────────────────────────────────────────

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

  // ── Packages tests ──────────────────────────────────────────

  describe("packages", () => {
    it("returns empty packages by default", () => {
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir });
      expect(config.packages).toEqual([]);
    });

    it("loads packages from project config", () => {
      const containerDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(containerDir, { recursive: true });
      fs.writeFileSync(
        path.join(containerDir, "config.yml"),
        "packages:\n  - npm:@some-team/ext@1.0.0\n  - git:github.com/team/repo@v2"
      );
      process.chdir(tmpDir);

      const config = loadConfig({ homeDir: tmpDir });
      expect(config.packages).toEqual([
        "npm:@some-team/ext@1.0.0",
        "git:github.com/team/repo@v2",
      ]);
    });

    it("returns empty packages when config has no packages field", () => {
      const containerDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(containerDir, { recursive: true });
      fs.writeFileSync(
        path.join(containerDir, "config.yml"),
        "piVersion: '0.75.5'"
      );
      process.chdir(tmpDir);

      const config = loadConfig({ homeDir: tmpDir });
      expect(config.packages).toEqual([]);
    });
  });

  // ── Port parsing tests ──────────────────────────────────────────

  describe("ports", () => {
    it("parses simple port from CLI", () => {
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir, cliPorts: ["3000"] });
      expect(config.ports).toEqual([{ host: 3000, container: 3000 }]);
    });

    it("parses host:container mapping from CLI", () => {
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir, cliPorts: ["8080:3000"] });
      expect(config.ports).toEqual([{ host: 8080, container: 3000 }]);
    });

    it("parses multiple CLI ports", () => {
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir, cliPorts: ["3000", "8080:3001"] });
      expect(config.ports).toEqual([
        { host: 3000, container: 3000 },
        { host: 8080, container: 3001 },
      ]);
    });

    it("parses PI_PORTS env var with comma-separated values", () => {
      process.chdir(tmpDir);
      process.env.PI_PORTS = "3000,8080:3001";
      const config = loadConfig({ homeDir: tmpDir });
      expect(config.ports).toEqual([
        { host: 3000, container: 3000 },
        { host: 8080, container: 3001 },
      ]);
    });

    it("parses PI_PORTS with ranges", () => {
      process.chdir(tmpDir);
      process.env.PI_PORTS = "3000,9000-9002";
      const config = loadConfig({ homeDir: tmpDir });
      expect(config.ports).toEqual([
        { host: 3000, container: 3000 },
        { host: 9000, container: 9000 },
        { host: 9001, container: 9001 },
        { host: 9002, container: 9002 },
      ]);
    });

    it("parses ports from project config", () => {
      const containerDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(containerDir, { recursive: true });
      fs.writeFileSync(
        path.join(containerDir, "config.yml"),
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

    it("CLI ports override env and config ports", () => {
      process.env.PI_PORTS = "3000";
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir, cliPorts: ["8080"] });
      // CLI ports are merged — both appear, CLI takes precedence on conflict
      expect(config.ports).toContainEqual({ host: 8080, container: 8080 });
      expect(config.ports).toContainEqual({ host: 3000, container: 3000 });
    });

    it("env ports override config ports on conflict", () => {
      const containerDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(containerDir, { recursive: true });
      fs.writeFileSync(
        path.join(containerDir, "config.yml"),
        "ports:\n  - 3000"
      );
      process.env.PI_PORTS = "3000:4000";  // Override: host 3000 → container 4000 instead of 3000
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir });
      expect(config.ports).toEqual([{ host: 3000, container: 4000 }]);
    });

    it("returns empty ports by default", () => {
      process.chdir(tmpDir);
      const config = loadConfig({ homeDir: tmpDir });
      expect(config.ports).toEqual([]);
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

    it("rejects port ranges in CLI format", () => {
      expect(() => parsePortMapping("9000-9010")).toThrow(/only supported in config/);
    });

    it("rejects invalid host:container", () => {
      expect(() => parsePortMapping("abc:3000")).toThrow();
      expect(() => parsePortMapping("3000:abc")).toThrow();
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