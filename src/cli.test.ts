// ============================================================
// Tests for cli.ts — argument parsing and command dispatch
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execSync } from "child_process";

const CLI_PATH = path.resolve(__dirname, "../dist/cli.js");

// Helper to run CLI with a temp home dir (avoids writing to real ~/.pi)
function runCli(args: string, options: { cwd: string; env?: Record<string, string> }): string {
  const piDir = path.join(options.cwd, ".pi");
  fs.mkdirSync(piDir, { recursive: true });
  const env: Record<string, string | undefined> = {
    ...process.env as Record<string, string | undefined>,
    ...options.env,
    HOME: options.cwd,
  };
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
    expect(output).toContain("pi");
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

  it("shows configuration with no .pi", () => {
    const output = runCli("dry-run", { cwd: tmpDir });

    expect(output).toContain("version:");
    expect(output).toContain("0.75.5");
    expect(output).toContain("image:");
    expect(output).toContain("pi-agent:0.75.5");
  });

  it("detects .pi directory", () => {
    fs.mkdirSync(path.join(tmpDir, ".pi"));
    const output = runCli("dry-run", { cwd: tmpDir });
    expect(output).toContain(".pi");
  });

  it("shows docker run command with correct volume mounts", () => {
    const output = runCli("dry-run", { cwd: tmpDir });

    const basename = path.basename(tmpDir);
    expect(output).toContain(`/${basename}:cached`);
    expect(output).toContain("/.pi:/home/pi-user/.pi");
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

  it("shows ports from pi-container.yml", () => {
    const containerDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(containerDir, { recursive: true });
    fs.writeFileSync(
      path.join(containerDir, "pi-container.yml"),
      "ports:\n  - 3000\n  - 8080:80"
    );

    const output = runCli("dry-run", { cwd: tmpDir });

    expect(output).toContain("3000");
    expect(output).toContain("8080:80");
  });
});
