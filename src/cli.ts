#!/usr/bin/env node
// ============================================================
// pi-container — Run Pi Coding Agent in Docker
// ============================================================
// Usage:
//   pi-container                          # interactive session
//   pi-container -- -p "Summarize this"   # print mode
//   pi-container -- -r                     # resume session
//   pi-container build                    # build/rebuild image
//   pi-container shell                    # drop into container shell
//
// Config precedence (highest wins):
//   1. Environment variables (PI_VERSION, PI_IMAGE_TAG, PI_CONFIG_DIR)
//   2. User config            (~/.pi/pi-container.yml)
//   3. Project config           (.pi-container/config.yml)
//   4. Built-in defaults
// ============================================================

import { loadConfig, getUserConfigPath, PiContainerConfig, checkPortAvailable } from "./config";
import { buildImage, runContainer, shellInContainer, buildDockerRunArgs } from "./docker";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

function printHelp(): void {
  const userConfigPath = getUserConfigPath();
  console.log(`
Usage: pi-container [command] [options] [-- PI_ARGS...]

Commands:
  (default)     Run pi in Docker (interactive session)
  build         Build or rebuild the Docker image
  shell         Open a shell in the container
  dry-run       Print resolved config and docker commands without executing

Options:
  --help, -h        Show this help
  --version         Show version
  -p, --port PORT   Publish container port to localhost (repeatable)
                    PORT can be a simple port (3000) or host:container (8080:3000)

All arguments after -- are passed to pi.

Examples:
  pi-container                              # interactive session
  pi-container -p 3000                      # expose port 3000
  pi-container -p 8080:3000                # host 8080 → container 3000
  pi-container -p 3000 -p 6006             # expose multiple ports
  pi-container -- -p "Summarize"            # print mode
  pi-container -- -r                        # resume session
  pi-container build                        # build image
  pi-container shell                        # container shell

Environment:
  PI_VERSION     Pi version (default: 0.75.5)
  PI_IMAGE_TAG   Docker image tag (default: pi-agent:<version>)
  PI_CONFIG_DIR  Host path for pi config (default: ~/.pi)
  PI_PORTS       Comma-separated ports, e.g. "3000,8080:3000,9000-9010"

Config precedence (highest wins):
  1. Environment variables
  2. User config:    ${userConfigPath}
  3. Project config: .pi-container/config.yml
  4. Built-in defaults

Project config:
  Place a .pi-container/ directory in your project root:
    .pi-container/config.yml          — pi version, image tag, ports, packages
    .pi-container/package/            — team pi package (extensions, themes, skills)
    .pi-container/package/package.json — pi package manifest
    .pi-container/settings/           — default settings template

  Example .pi-container/config.yml:
    piVersion: "0.75.5"
    ports:
      - 3000        # dev server
      - 6006        # storybook
      - 8080:80     # host 8080 → container 80
    packages:
      - npm:@some-team/safety-ext@1.0.0
      - git:github.com/team/repo@v2

User config:
  Create ${userConfigPath} for personal overrides:
    piVersion: "0.75.4"         # Override pi version
    imageTag: "my-registry/pi"  # Override image tag
    configDir: "~/pi-work"      # Use a different pi config directory
    ports:                       # Override ports
      - 3000

  Pi config is mounted from the host at ~/.pi so settings,
  sessions, and auth tokens persist natively on your machine.
`.trim());
}

function printVersion(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require("../package.json");
  console.log(`pi-container ${pkg.version}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Split on -- to separate our args from pi's args
  const dashDashIdx = args.indexOf("--");
  let ourArgs: string[];
  let piArgs: string[];
  if (dashDashIdx !== -1) {
    ourArgs = args.slice(0, dashDashIdx);
    piArgs = args.slice(dashDashIdx + 1);
  } else {
    ourArgs = args;
    piArgs = [];
  }

  // Parse our args
  let command: "run" | "build" | "shell" | "dry-run" = "run";
  const cliPorts: string[] = [];

  for (let i = 0; i < ourArgs.length; i++) {
    const arg = ourArgs[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      return;
    }
    if (arg === "--version") {
      printVersion();
      return;
    }
    if (arg === "-p" || arg === "--port") {
      const value = ourArgs[i + 1];
      if (!value || value.startsWith("-")) {
        console.error(`Error: ${arg} requires a port argument.`);
        console.error("Example: pi-container -p 3000 or pi-container -p 8080:3000");
        process.exit(1);
      }
      cliPorts.push(value);
      i++; // skip the value
    } else if (arg === "build") {
      command = "build";
    } else if (arg === "shell") {
      command = "shell";
    } else if (arg === "dry-run") {
      command = "dry-run";
    } else {
      console.error(`Unknown argument: ${arg}`);
      console.error("Run 'pi-container --help' for usage.");
      process.exit(1);
    }
  }

  // Check that Docker is available (skip for dry-run)
  if (command !== "dry-run") {
    try {
      execSync("docker --version", { stdio: "pipe" });
    } catch {
      console.error("Error: Docker is not installed or not running.");
      console.error("Please install Docker and ensure it's accessible.");
      process.exit(1);
    }
  }

  // Load config from .pi-container/, user config, and environment
  const config = loadConfig({ cliPorts });

  // Ensure pi config directory exists on host
  for (const sub of ["sessions", "extensions", "npm", "git", "prompts", "skills"]) {
    fs.mkdirSync(path.join(config.configDir, sub), { recursive: true });
  }

  // Check port availability before running
  if ((command === "run" || command === "shell") && config.ports.length > 0) {
    const conflicts = await checkPorts(config.ports);
    if (conflicts.length > 0) {
      console.error("Error: The following ports are already in use on localhost:");
      for (const { host } of conflicts) {
        console.error(`  - ${host}`);
      }
      console.error("");
      console.error("To fix, either:");
      console.error("  - Change the host port in .pi-container/config.yml (e.g., \"3001:3000\")");
      console.error("  - Stop the process using the port");
      process.exit(1);
    }
  }

  // Dispatch command
  switch (command) {
    case "build":
      buildImage(config);
      break;
    case "shell":
      shellInContainer(config);
      break;
    case "run":
      runContainer(config, piArgs.length > 0 ? piArgs : ["pi"]);
      break;
    case "dry-run":
      printDryRun(config, piArgs);
      break;
  }
}

async function checkPorts(ports: { host: number; container: number }[]): Promise<{ host: number }[]> {
  const conflicts: { host: number }[] = [];
  for (const port of ports) {
    const available = await checkPortAvailable(port.host);
    if (!available) {
      conflicts.push({ host: port.host });
    }
  }
  return conflicts;
}

function printDryRun(config: PiContainerConfig, piArgs: string[]): void {
  const userConfigPath = getUserConfigPath();
  const userConfigExists = fs.existsSync(userConfigPath);

  console.log("Configuration:");
  console.log(`  piVersion:      ${config.piVersion}`);
  console.log(`  imageTag:       ${config.imageTag}`);
  console.log(`  projectDir:     ${config.projectDir}`);
  console.log(`  workspaceDir:   ${config.workspaceDir}`);
  console.log(`  configDir:      ${config.configDir}`);
  console.log(`  envFile:        ${config.envFile || "(none)"}`);
  console.log(`  containerDir:   ${config.containerDir || "(none)"}`);
  console.log(`  hasPackage:    ${config.hasPackage}`);
  console.log(`  hasSettings:    ${config.hasSettings}`);
  if (config.packages.length > 0) {
    console.log(`  packages:`);
    for (const pkg of config.packages) {
      console.log(`    - ${pkg}`);
    }
  } else {
    console.log(`  packages:       (none)`);
  }
  if (config.ports.length > 0) {
    console.log("  ports:");
    for (const p of config.ports) {
      const arrow = p.host === p.container ? String(p.host) : `${p.host}:${p.container}`;
      console.log(`    ${arrow} → ${p.container} (localhost)`);
    }
  } else {
    console.log(`  ports:          (none)`);
  }
  console.log();
  console.log("Config sources:");
  console.log(`  User config:    ${userConfigPath} ${userConfigExists ? "(found)" : "(not found)"}`);
  console.log(`  Project config: ${config.containerDir ? config.containerDir + "/config.yml" : "(no .pi-container dir)"}`);
  console.log(`  .env file:      ${config.envFile || "(none)"}`);
  console.log();
  const command = piArgs.length > 0 ? piArgs : ["pi"];
  const runArgs = buildDockerRunArgs(config, command);
  console.log("Docker run command:");
  console.log(`  docker ${runArgs.join(" ")}`);
  console.log();
  const buildArgs = [
    "docker",
    "build",
    "--build-arg",
    `PI_VERSION=${config.piVersion}`,
    "-t",
    config.imageTag,
    ".",
  ];
  console.log("Docker build command (would be run in temp build context):");
  console.log(`  ${buildArgs.join(" ")}`);
}

main();