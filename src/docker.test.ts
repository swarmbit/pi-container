// ============================================================
// Tests for docker.ts — Docker operations
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { buildDockerRunArgs } from "./docker";
import { generateDockerfile, generateEntrypoint } from "./templates";
import { PiContainerConfig, PI_VERSION, PI_IMAGE } from "./config";

function makeConfig(overrides: Partial<PiContainerConfig> = {}): PiContainerConfig {
  return {
    ports: [],
    ...overrides,
  };
}

// Runtime context needed by buildDockerRunArgs
interface FullConfig extends PiContainerConfig {
  configDir: string;
  containerDir: string;
  projectDir: string;
  workspaceDir: string;
  envFile: string;
}

function makeFullConfig(overrides: Partial<FullConfig> = {}): FullConfig {
  return {
    ports: [],
    configDir: "/home/user/.pi",
    containerDir: "",
    projectDir: "/project",
    workspaceDir: "/project",
    envFile: "",
    ...overrides,
  };
}

describe("buildDockerRunArgs", () => {
  it("includes run and rm flags", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args[0]).toBe("run");
    expect(args[1]).toBe("--rm");
  });

  it("mounts projectDir as dynamic workspace dir", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    const vIdx = args.indexOf("-v");
    expect(vIdx).toBeGreaterThan(-1);
    expect(args[vIdx + 1]).toBe("/project:/project:cached");
  });

  it("mounts configDir as pi config", () => {
    const config = makeFullConfig({ configDir: "/home/user/.pi" });
    const args = buildDockerRunArgs(config, ["pi"]);

    const volArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(volArgs).toContain("/home/user/.pi:/home/pi-user/.pi");
  });

  it("sets working directory to workspace dir", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    const wIdx = args.indexOf("-w");
    expect(wIdx).toBeGreaterThan(-1);
    expect(args[wIdx + 1]).toBe("/project");
  });

  it("uses dynamic workspace dir based on project basename", () => {
    const config = makeFullConfig({ projectDir: "/home/user/my-app", workspaceDir: "/my-app" });
    const args = buildDockerRunArgs(config, ["pi"]);

    const vIdx = args.indexOf("-v");
    expect(args[vIdx + 1]).toBe("/home/user/my-app:/my-app:cached");

    const wIdx = args.indexOf("-w");
    expect(args[wIdx + 1]).toBe("/my-app");
  });

  it("passes HOST_UID, HOST_GID, and WORKSPACE_DIR env vars", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    const uidEntry = args.find((a) => a.startsWith("HOST_UID="));
    const gidEntry = args.find((a) => a.startsWith("HOST_GID="));
    const workspaceEntry = args.find((a) => a.startsWith("WORKSPACE_DIR="));
    expect(uidEntry).toBeDefined();
    expect(gidEntry).toBeDefined();
    expect(workspaceEntry).toBe("WORKSPACE_DIR=/project");
  });

  it("includes --env-file when .pi-container-env exists", () => {
    const config = makeFullConfig({ envFile: "/project/.pi-container-env" });
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args).toContain("--env-file");
    const efIdx = args.indexOf("--env-file");
    expect(args[efIdx + 1]).toBe("/project/.pi-container-env");
  });

  it("does not include --env-file when no .pi-container-env", () => {
    const config = makeFullConfig({ envFile: "" });
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args).not.toContain("--env-file");
  });

  it("uses the PI_IMAGE constant", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args).toContain(PI_IMAGE);
  });

  it("passes pi args as the command", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi", "-p", "Summarize"]);

    expect(args.slice(-3)).toEqual(["pi", "-p", "Summarize"]);
  });

  it("does not set --name (allows concurrent instances)", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args).not.toContain("--name");
  });

  it("allocates TTY when stdin is a TTY", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    const hasItFlag = args.includes("-it") || args.includes("-i");
    expect(hasItFlag).toBe(true);
  });

  it("adds port mappings with localhost binding", () => {
    const config = makeFullConfig({ ports: [{ host: 3000, container: 3000 }] });
    const args = buildDockerRunArgs(config, ["pi"]);

    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(args[pIdx + 1]).toBe("127.0.0.1:3000:3000");
  });

  it("adds host:container port mappings", () => {
    const config = makeFullConfig({ ports: [{ host: 8080, container: 3000 }] });
    const args = buildDockerRunArgs(config, ["pi"]);

    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(args[pIdx + 1]).toBe("127.0.0.1:8080:3000");
  });

  it("adds multiple port mappings", () => {
    const config = makeFullConfig({
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
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args).not.toContain("-p");
  });

  it("ports come before the image name", () => {
    const config = makeFullConfig({ ports: [{ host: 3000, container: 3000 }] });
    const args = buildDockerRunArgs(config, ["pi"]);

    const pIdx = args.indexOf("-p");
    const imageIdx = args.indexOf(PI_IMAGE);
    expect(pIdx).toBeLessThan(imageIdx);
  });

  it("does not pass TEAM_PACKAGES (removed)", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    const teamPackagesEntry = args.find((a) => a.startsWith("TEAM_PACKAGES="));
    expect(teamPackagesEntry).toBeUndefined();
  });
});

describe("build context", () => {
  it("creates a build context with Dockerfile and entrypoint", () => {
    const dockerfile = generateDockerfile();
    const entrypoint = generateEntrypoint();

    expect(dockerfile).toContain("FROM node:22-bookworm-slim AS builder");
    expect(dockerfile).toContain(`ARG PI_VERSION=${PI_VERSION}`);
    expect(entrypoint).toContain("#!/usr/bin/env bash");
    expect(entrypoint).toContain('exec gosu pi-user "$@"');
  });
});
