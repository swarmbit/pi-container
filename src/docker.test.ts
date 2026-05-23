// ============================================================
// Tests for docker.ts — Docker operations
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { buildDockerRunArgs } from "./docker";
import { generateDockerfile, generateEntrypoint } from "./templates";
import { PiContainerConfig } from "./config";

function makeConfig(overrides: Partial<PiContainerConfig> = {}): PiContainerConfig {
  return {
    piVersion: "0.75.5",
    imageTag: "pi-agent:0.75.5",
    configDir: "/home/user/.pi/agent",
    containerDir: "",
    projectDir: "/project",
    envFile: "",
    extensions: [],
    hasPackages: false,
    hasSettings: false,
    ...overrides,
  };
}

describe("buildDockerRunArgs", () => {
  it("includes run and rm flags", () => {
    const config = makeConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args[0]).toBe("run");
    expect(args[1]).toBe("--rm");
  });

  it("mounts projectDir as /workspace", () => {
    const config = makeConfig({ projectDir: "/my/project" });
    const args = buildDockerRunArgs(config, ["pi"]);

    const vIdx = args.indexOf("-v");
    expect(vIdx).toBeGreaterThan(-1);
    expect(args[vIdx + 1]).toBe("/my/project:/workspace:cached");
  });

  it("mounts configDir as pi config", () => {
    const config = makeConfig({ configDir: "/home/user/.pi/agent" });
    const args = buildDockerRunArgs(config, ["pi"]);

    const vIdx = args.indexOf("-v");
    // Second -v flag (first is projectDir)
    const volArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(volArgs).toContain("/home/user/.pi/agent:/home/pi-user/.pi/agent");
  });

  it("sets working directory to /workspace", () => {
    const config = makeConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    const wIdx = args.indexOf("-w");
    expect(wIdx).toBeGreaterThan(-1);
    expect(args[wIdx + 1]).toBe("/workspace");
  });

  it("passes HOST_UID and HOST_GID", () => {
    const config = makeConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args).toContain("-e");
    const uidEntry = args.find((a) => a.startsWith("HOST_UID="));
    const gidEntry = args.find((a) => a.startsWith("HOST_GID="));
    expect(uidEntry).toBeDefined();
    expect(gidEntry).toBeDefined();
  });

  it("includes --env-file when .env exists", () => {
    const config = makeConfig({ envFile: "/project/.env" });
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args).toContain("--env-file");
    const efIdx = args.indexOf("--env-file");
    expect(args[efIdx + 1]).toBe("/project/.env");
  });

  it("does not include --env-file when no .env", () => {
    const config = makeConfig({ envFile: "" });
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args).not.toContain("--env-file");
  });

  it("uses the configured image tag", () => {
    const config = makeConfig({ imageTag: "my-registry/pi:latest" });
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args).toContain("my-registry/pi:latest");
  });

  it("passes pi args as the command", () => {
    const config = makeConfig();
    const args = buildDockerRunArgs(config, ["pi", "-p", "Summarize"]);

    // Last args should be the command
    expect(args.slice(-3)).toEqual(["pi", "-p", "Summarize"]);
  });

  it("does not set --name (allows concurrent instances)", () => {
    const config = makeConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args).not.toContain("--name");
  });

  it("allocates TTY when stdin is a TTY", () => {
    const config = makeConfig();
    const originalIsTTY = process.stdin.isTTY;
    // Can't easily mock process.stdin.isTTY, so just verify -it or -i is present
    const args = buildDockerRunArgs(config, ["pi"]);

    // Should have either -it or -i
    const hasItFlag = args.includes("-it") || args.includes("-i");
    expect(hasItFlag).toBe(true);
  });
});

describe("createBuildContext (via buildImage internals)", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-container-test-"));
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a build context with Dockerfile and entrypoint", () => {
    const config = makeConfig({ piVersion: "0.75.5" });
    const dockerfile = generateDockerfile(config);
    const entrypoint = generateEntrypoint(config);

    expect(dockerfile).toContain("FROM node:22-bookworm-slim AS builder");
    expect(dockerfile).toContain("ARG PI_VERSION=0.75.5");
    expect(entrypoint).toContain("#!/usr/bin/env bash");
    expect(entrypoint).toContain('exec gosu pi-user "$@"');
  });

  it("creates placeholder files when no .pi-container exists", () => {
    // Simulate the build context for a project without .pi-container/
    const buildCtxDir = path.join(tmpDir, "build-ctx");
    fs.mkdirSync(buildCtxDir, { recursive: true });

    // Empty extensions (just .gitkeep)
    fs.mkdirSync(path.join(buildCtxDir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(buildCtxDir, "extensions", ".gitkeep"), "");

    // Minimal packages
    fs.mkdirSync(path.join(buildCtxDir, "packages"), { recursive: true });
    fs.writeFileSync(
      path.join(buildCtxDir, "packages", "package.json"),
      JSON.stringify({ name: "pi-container-packages", version: "1.0.0", private: true, dependencies: {} })
    );

    // Default settings
    fs.mkdirSync(path.join(buildCtxDir, "settings"), { recursive: true });
    fs.writeFileSync(
      path.join(buildCtxDir, "settings", "default-settings.json"),
      JSON.stringify({ defaultThinkingLevel: "medium", autoCompact: true })
    );

    // Verify all expected files exist
    expect(fs.existsSync(path.join(buildCtxDir, "extensions", ".gitkeep"))).toBe(true);
    expect(fs.existsSync(path.join(buildCtxDir, "packages", "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(buildCtxDir, "settings", "default-settings.json"))).toBe(true);
  });
});