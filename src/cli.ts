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
// Port config precedence (highest wins):
//   1. CLI flags              (-p, --port)
//   2. User config            (~/.pi/pi-container.yml)
//   3. Project config           (.pi/pi-container.yml)
// ============================================================

import { loadConfig, getUserConfigPath, PI_VERSION, PI_IMAGE, checkPortAvailable } from "./config";
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

Port config precedence (highest wins):
  1. CLI flags (-p, --port)
  2. User config:    ${userConfigPath}
  3. Project config: .pi/pi-container.yml

Config file schema:
  ports:
    - 3000        # dev server
    - 6006        # storybook
    - 8080:80     # host 8080 → container 80
  env:
    CUSTOM_ENV: sk-xxx  # passed to the container
`.trim());
}

function printVersion(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require("../package.json");
  console.log(`pi-container ${pkg.version} (pi v${PI_VERSION})`);
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

  // Load config from .pi/, user config
  const config = loadConfig({ cliPorts });

  fs.mkdirSync(config.configDir + "/agent", { recursive: true });

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
      console.error("  - Change the host port in .pi/pi-container.yml (e.g., \"3001:3000\")");
      console.error("  - Stop the process using the port");
      process.exit(1);
    }
  }

  // Dispatch command
  switch (command) {
    case "build":
      buildImage();
      break;
    case "shell":
      shellInContainer(config);
      break;
    case "run":
      runContainer(config, piArgs.length > 0 ? ["pi", ...piArgs] : ["pi"]);
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

function printDryRun(config: ReturnType<typeof loadConfig>, piArgs: string[]): void {
  const userConfigPath = getUserConfigPath();
  const userConfigExists = fs.existsSync(userConfigPath);

  console.log("Configuration:");
  console.log(`  version:        ${PI_VERSION}`);
  console.log(`  image:          ${PI_IMAGE}`);
  console.log(`  projectDir:     ${config.projectDir}`);
  console.log(`  workspaceDir:   ${config.workspaceDir}`);
  console.log(`  configDir:      ${config.configDir}`);
  if (Object.keys(config.env).length > 0) {
    console.log("  env:");
    for (const [key, value] of Object.entries(config.env)) {
      console.log(`    ${key}: ${value}`);
    }
  } else {
    console.log(`  env:            (none)`);
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
  console.log(`  Project config: ${config.containerDir ? config.containerDir + "/pi-container.yml" : "(no .pi dir)"}`);
  console.log();
  const cmd = piArgs.length > 0 ? ["pi", ...piArgs] : ["pi"];
  const runArgs = buildDockerRunArgs(config, cmd);
  console.log("Docker run command:");
  console.log(`  docker ${runArgs.join(" ")}`);
  console.log();
  const buildArgs = [
    "docker",
    "build",
    "--build-arg",
    `PI_VERSION=${PI_VERSION}`,
    "-t",
    PI_IMAGE,
    ".",
  ];
  console.log("Docker build command (would be run in temp build context):");
  console.log(`  ${buildArgs.join(" ")}`);
}

main();
