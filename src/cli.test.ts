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
    // dry-run doesn't need docker
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cli-test-"));
    const output = execSync(
      `node ${CLI_PATH} dry-run -- -p "test"`,
      { encoding: "utf-8", cwd: tmpDir }
    );
    // The pi args should include -p and "test" but dry-run should show them
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
    const output = execSync(`node ${CLI_PATH} dry-run`, {
      encoding: "utf-8",
      cwd: tmpDir,
    });

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
    const output = execSync(`node ${CLI_PATH} dry-run`, {
      encoding: "utf-8",
      cwd: tmpDir,
    });

    expect(output).toContain(tmpDir + "/.pi-container");
  });

  it("shows docker run command with correct volume mounts", () => {
    const output = execSync(`node ${CLI_PATH} dry-run`, {
      encoding: "utf-8",
      cwd: tmpDir,
    });

    // Should mount CWD as /workspace
    expect(output).toContain(`${tmpDir}:/workspace:cached`);
    // Should mount config dir
    expect(output).toContain("/home/pi-user/.pi/agent");
  });

  it("respects PI_VERSION env var", () => {
    const output = execSync(`PI_VERSION=1.0.0 node ${CLI_PATH} dry-run`, {
      encoding: "utf-8",
      cwd: tmpDir,
    });

    expect(output).toContain("1.0.0");
  });

  it("shows config sources in dry-run output", () => {
    const output = execSync(`node ${CLI_PATH} dry-run`, {
      encoding: "utf-8",
      cwd: tmpDir,
    });

    expect(output).toContain("Config sources:");
    expect(output).toContain("User config:");
    expect(output).toContain("not found");
    expect(output).toContain("Project config:");
  });

  it("detects .env file", () => {
    fs.writeFileSync(path.join(tmpDir, ".env"), "ANTHROPIC_API_KEY=sk-test");
    const output = execSync(`node ${CLI_PATH} dry-run`, {
      encoding: "utf-8",
      cwd: tmpDir,
    });

    expect(output).toContain("--env-file");
    expect(output).toContain(".env");
  });

  it("detects extensions", () => {
    const extDir = path.join(tmpDir, ".pi-container", "extensions", "test-ext");
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, "index.ts"), "export default function() {}");

    const output = execSync(`node ${CLI_PATH} dry-run`, {
      encoding: "utf-8",
      cwd: tmpDir,
    });

    expect(output).toContain("test-ext");
  });
});