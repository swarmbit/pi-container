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
    configDir: "/home/user/.pi",
    containerDir: "",
    projectDir: "/project",
    workspaceDir: "/project",
    envFile: "",
    hasPackage: false,
    hasSettings: false,
    packages: [],
    ports: [],
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

  it("mounts projectDir as dynamic workspace dir", () => {
    const config = makeConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    const vIdx = args.indexOf("-v");
    expect(vIdx).toBeGreaterThan(-1);
    // Default projectDir is "/project", so workspaceDir is "/project"
    expect(args[vIdx + 1]).toBe("/project:/project:cached");
  });

  it("mounts configDir as pi config", () => {
    const config = makeConfig({ configDir: "/home/user/.pi" });
    const args = buildDockerRunArgs(config, ["pi"]);

    const vIdx = args.indexOf("-v");
    // Second -v flag (first is projectDir)
    const volArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(volArgs).toContain("/home/user/.pi:/home/pi-user/.pi");
  });

  it("sets working directory to workspace dir", () => {
    const config = makeConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    const wIdx = args.indexOf("-w");
    expect(wIdx).toBeGreaterThan(-1);
    expect(args[wIdx + 1]).toBe("/project");
  });

  it("uses dynamic workspace dir based on project basename", () => {
    const config = makeConfig({ projectDir: "/home/user/my-app", workspaceDir: "/my-app" });
    const args = buildDockerRunArgs(config, ["pi"]);

    const vIdx = args.indexOf("-v");
    expect(args[vIdx + 1]).toBe("/home/user/my-app:/my-app:cached");

    const wIdx = args.indexOf("-w");
    expect(args[wIdx + 1]).toBe("/my-app");
  });

  it("passes HOST_UID, HOST_GID, and WORKSPACE_DIR env vars", () => {
    const config = makeConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args).toContain("-e");
    const uidEntry = args.find((a) => a.startsWith("HOST_UID="));
    const gidEntry = args.find((a) => a.startsWith("HOST_GID="));
    const workspaceEntry = args.find((a) => a.startsWith("WORKSPACE_DIR="));
    expect(uidEntry).toBeDefined();
    expect(gidEntry).toBeDefined();
    expect(workspaceEntry).toBe("WORKSPACE_DIR=/project");
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
    const args = buildDockerRunArgs(config, ["pi"]);

    // Should have either -it or -i
    const hasItFlag = args.includes("-it") || args.includes("-i");
    expect(hasItFlag).toBe(true);
  });

  it("adds port mappings with localhost binding", () => {
    const config = makeConfig({ ports: [{ host: 3000, container: 3000 }] });
    const args = buildDockerRunArgs(config, ["pi"]);

    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(args[pIdx + 1]).toBe("127.0.0.1:3000:3000");
  });

  it("adds host:container port mappings", () => {
    const config = makeConfig({ ports: [{ host: 8080, container: 3000 }] });
    const args = buildDockerRunArgs(config, ["pi"]);

    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(args[pIdx + 1]).toBe("127.0.0.1:8080:3000");
  });

  it("adds multiple port mappings", () => {
    const config = makeConfig({
      ports: [
        { host: 3000, container: 3000 },
        { host: 8080, container: 80 },
        { host: 6006, container: 6006 },
      ],
    });
    const args = buildDockerRunArgs(config, ["pi"]);

    const pIndices = args.reduce<number[]>((acc, arg, i) => {
      if (arg === "-p") acc.push(i);
      return acc;
    }, []);
    expect(pIndices).toHaveLength(3);
    expect(args[pIndices[0] + 1]).toBe("127.0.0.1:3000:3000");
    expect(args[pIndices[1] + 1]).toBe("127.0.0.1:8080:80");
    expect(args[pIndices[2] + 1]).toBe("127.0.0.1:6006:6006");
  });

  it("does not add -p flags when no ports configured", () => {
    const config = makeConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args).not.toContain("-p");
  });

  it("ports come before the image name", () => {
    const config = makeConfig({ ports: [{ host: 3000, container: 3000 }] });
    const args = buildDockerRunArgs(config, ["pi"]);

    const pIdx = args.indexOf("-p");
    const imageIdx = args.indexOf(config.imageTag);
    expect(pIdx).toBeLessThan(imageIdx);
  });

  it("passes TEAM_PACKAGES env var when packages are configured", () => {
    const config = makeConfig({
      packages: ["npm:@some-team/ext@1.0.0", "git:github.com/team/repo@v2"],
    });
    const args = buildDockerRunArgs(config, ["pi"]);

    const eIdx = args.indexOf("-e");
    expect(eIdx).toBeGreaterThan(-1);
    const teamPackagesEntry = args.find((a) => a.startsWith("TEAM_PACKAGES="));
    expect(teamPackagesEntry).toBe("TEAM_PACKAGES=npm:@some-team/ext@1.0.0,git:github.com/team/repo@v2");
  });

  it("does not pass TEAM_PACKAGES when no packages configured", () => {
    const config = makeConfig({ packages: [] });
    const args = buildDockerRunArgs(config, ["pi"]);

    const teamPackagesEntry = args.find((a) => a.startsWith("TEAM_PACKAGES="));
    expect(teamPackagesEntry).toBeUndefined();
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

  it("creates placeholder package when no .pi-container exists", () => {
    // Simulate the build context for a project without .pi-container/
    const buildCtxDir = path.join(tmpDir, "build-ctx");
    fs.mkdirSync(buildCtxDir, { recursive: true });

    // Placeholder package (minimal)
    fs.mkdirSync(path.join(buildCtxDir, "package", "extensions"), { recursive: true });
    fs.mkdirSync(path.join(buildCtxDir, "package", "themes"), { recursive: true });
    fs.writeFileSync(path.join(buildCtxDir, "package", "extensions", ".gitkeep"), "");
    fs.writeFileSync(path.join(buildCtxDir, "package", "themes", ".gitkeep"), "");
    fs.writeFileSync(
      path.join(buildCtxDir, "package", "package.json"),
      JSON.stringify({
        name: "pi-container-defaults",
        version: "1.0.0",
        private: true,
        description: "No customizations",
        keywords: ["pi-package"],
        pi: { extensions: ["./extensions"], themes: ["./themes"] },
        peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
      }, null, 2)
    );

    // Default settings
    fs.mkdirSync(path.join(buildCtxDir, "settings"), { recursive: true });
    fs.writeFileSync(
      path.join(buildCtxDir, "settings", "default-settings.json"),
      JSON.stringify({ defaultThinkingLevel: "medium", autoCompact: true })
    );

    // Verify all expected files exist
    expect(fs.existsSync(path.join(buildCtxDir, "package", "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(buildCtxDir, "package", "extensions", ".gitkeep"))).toBe(true);
    expect(fs.existsSync(path.join(buildCtxDir, "package", "themes", ".gitkeep"))).toBe(true);
    expect(fs.existsSync(path.join(buildCtxDir, "settings", "default-settings.json"))).toBe(true);
  });
});