// ============================================================
// Tests for config.ts — config discovery and loading
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { loadConfig, getUserConfigPath } from "./config";

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
});

describe("loadConfig", () => {
  it("uses defaults when no .pi-container/ directory exists", () => {
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir: tmpDir });

    expect(config.piVersion).toBe("0.75.5");
    expect(config.imageTag).toBe("pi-agent:0.75.5");
    expect(config.projectDir).toBe(tmpDir);
    expect(config.containerDir).toBe("");
    expect(config.extensions).toEqual([]);
    expect(config.hasPackages).toBe(false);
    expect(config.hasSettings).toBe(false);
  });

  it("discovers .pi-container/ in CWD", () => {
    const containerDir = path.join(tmpDir, ".pi-container");
    fs.mkdirSync(containerDir);
    process.chdir(tmpDir);

    const config = loadConfig({ homeDir: tmpDir });
    expect(config.containerDir).toBe(containerDir);
  });

  it("detects extensions with index.ts", () => {
    const extDir = path.join(tmpDir, ".pi-container", "extensions", "my-ext");
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, "index.ts"), "export default function() {}");
    process.chdir(tmpDir);

    const config = loadConfig({ homeDir: tmpDir });
    expect(config.extensions).toContain("my-ext");
  });

  it("detects extensions with index.js", () => {
    const extDir = path.join(tmpDir, ".pi-container", "extensions", "js-ext");
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, "index.js"), "module.exports = {};");
    process.chdir(tmpDir);

    const config = loadConfig({ homeDir: tmpDir });
    expect(config.extensions).toContain("js-ext");
  });

  it("ignores directories without index.ts or index.js", () => {
    const extDir = path.join(tmpDir, ".pi-container", "extensions", "incomplete-ext");
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, "README.md"), "incomplete");
    process.chdir(tmpDir);

    const config = loadConfig({ homeDir: tmpDir });
    expect(config.extensions).not.toContain("incomplete-ext");
  });

  it("detects packages with dependencies", () => {
    const pkgDir = path.join(tmpDir, ".pi-container", "packages");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "test", dependencies: { lodash: "^4.0.0" } })
    );
    process.chdir(tmpDir);

    const config = loadConfig({ homeDir: tmpDir });
    expect(config.hasPackages).toBe(true);
  });

  it("ignores packages with empty dependencies", () => {
    const pkgDir = path.join(tmpDir, ".pi-container", "packages");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "test", dependencies: {} })
    );
    process.chdir(tmpDir);

    const config = loadConfig({ homeDir: tmpDir });
    expect(config.hasPackages).toBe(false);
  });

  it("detects settings", () => {
    const settingsDir = path.join(tmpDir, ".pi-container", "settings");
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
      const containerDir = path.join(tmpDir, ".pi-container");
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
      const containerDir = path.join(tmpDir, ".pi-container");
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
      const containerDir = path.join(tmpDir, ".pi-container");
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
      expect(config.configDir).toBe(path.join(tmpDir, ".pi", "agent"));
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
      // No .pi-container/config.yml, just the directory
      fs.mkdirSync(path.join(tmpDir, ".pi-container"), { recursive: true });
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