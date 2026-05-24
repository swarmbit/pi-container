// ============================================================
// Tests for cli.ts — argument parsing and command dispatch
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// We test CLI behavior by running it as a child process
// since it calls process.exit and process.argv
import { execSync } from "child_process";

const CLI_PATH = path.resolve(__dirname, "../dist/cli.js");

// Helper to run CLI with a temp config dir (avoids writing to real ~/.pi)
function runCli(args: string, options: { cwd: string; env?: Record<string, string> }): string {
  const tmpConfigDir = path.join(options.cwd, ".pi-config");
  fs.mkdirSync(tmpConfigDir, { recursive: true });
  const env: Record<string, string | undefined> = {
    ...process.env as Record<string, string | undefined>,
    ...options.env,
    PI_CONFIG_DIR: tmpConfigDir,
  };
  // Remove HOME to prevent writing to real ~/.pi
  delete env.HOME;
  return execSync(`node ${CLI_PATH} ${args}`, {
    encoding: "utf-8",
    cwd: options.cwd,
    env,
  });
}

describe("CLI", () => {
  it("prints help with --help", () => {
    const output = execSync(`node ${CLI_PATH} --help`, { encoding: "utf-8" });
    expect(output).toContain("pi-container [command]");
    expect(output).toContain("build");
    expect(output).toContain("shell");
    expect(output).toContain("dry-run");
    expect(output).toContain("PI_VERSION");
  });

  it("prints version with --version", () => {
    const output = execSync(`node ${CLI_PATH} --version`, { encoding: "utf-8" });
    expect(output).toContain("pi-container");
  });

  it("prints help with -h", () => {
    const output = execSync(`node ${CLI_PATH} -h`, { encoding: "utf-8" });
    expect(output).toContain("pi-container [command]");
  });

  it("exits with error for unknown arguments", () => {
    try {
      execSync(`node ${CLI_PATH} --bogus 2>&1`, { encoding: "utf-8" });
      expect.fail("Should have exited with error");
    } catch (e: any) {
      expect(e.status).not.toBe(0);
      expect(e.stderr || e.stdout || e.message).toContain("Unknown argument");
    }
  });

  it("separates pi args after --", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cli-test-"));
    const output = runCli("dry-run -- -p \"test\"", { cwd: tmpDir });
    expect(output).toContain("-p");
    expect(output).toContain("test");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("CLI dry-run", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cli-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shows configuration with no .pi-container", () => {
    const output = runCli("dry-run", { cwd: tmpDir });

    expect(output).toContain("piVersion:");
    expect(output).toContain("0.75.5");
    expect(output).toContain("imageTag:");
    expect(output).toContain("pi-agent:0.75.5");
    expect(output).toContain("projectDir:");
    expect(output).toContain(tmpDir);
    expect(output).toContain("(none)"); // no containerDir, no envFile
  });

  it("detects .pi-container directory", () => {
    fs.mkdirSync(path.join(tmpDir, ".pi-container"));
    const output = runCli("dry-run", { cwd: tmpDir });

    expect(output).toContain(tmpDir + "/.pi-container");
  });

  it("shows docker run command with correct volume mounts", () => {
    const output = runCli("dry-run", { cwd: tmpDir });

    // Should mount CWD as /workspace
    expect(output).toContain(`${tmpDir}:/workspace:cached`);
    // Should mount config dir under .pi-config (our test override)
    expect(output).toContain("/.pi-config:/home/pi-user/.pi");
  });

  it("respects PI_VERSION env var", () => {
    const output = runCli("dry-run", { cwd: tmpDir, env: { PI_VERSION: "1.0.0" } });

    expect(output).toContain("1.0.0");
  });

  it("shows config sources in dry-run output", () => {
    const output = runCli("dry-run", { cwd: tmpDir });

    expect(output).toContain("Config sources:");
    expect(output).toContain("User config:");
    expect(output).toContain("not found");
    expect(output).toContain("Project config:");
  });

  it("detects .env file", () => {
    fs.writeFileSync(path.join(tmpDir, ".env"), "ANTHROPIC_API_KEY=sk-test");
    const output = runCli("dry-run", { cwd: tmpDir });

    expect(output).toContain("--env-file");
    expect(output).toContain(".env");
  });

  it("detects package directory", () => {
    const pkgDir = path.join(tmpDir, ".pi-container", "package");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "test-pkg", pi: { extensions: ["./extensions"] } })
    );

    const output = runCli("dry-run", { cwd: tmpDir });

    expect(output).toContain("hasPackage");
  });

  it("detects settings directory", () => {
    const settingsDir = path.join(tmpDir, ".pi-container", "settings");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, "default-settings.json"),
      JSON.stringify({ theme: "github" })
    );

    const output = runCli("dry-run", { cwd: tmpDir });

    expect(output).toContain("hasSettings");
  });

  it("shows packages from config.yml", () => {
    const containerDir = path.join(tmpDir, ".pi-container");
    fs.mkdirSync(containerDir, { recursive: true });
    fs.writeFileSync(
      path.join(containerDir, "config.yml"),
      "packages:\n  - npm:@some-team/ext@1.0.0"
    );

    const output = runCli("dry-run", { cwd: tmpDir });

    expect(output).toContain("npm:@some-team/ext@1.0.0");
  });
});