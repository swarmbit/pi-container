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

import { loadConfig, getUserConfigPath, PiContainerConfig } from "./config";
import { buildImage, runContainer, shellInContainer, buildDockerRunArgs } from "./docker";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

function printHelp(): void {
  const userConfigPath = getUserConfigPath();
  console.log(`
Usage: pi-container [command] [-- PI_ARGS...]

Commands:
  (default)     Run pi in Docker (interactive session)
  build         Build or rebuild the Docker image
  shell         Open a shell in the container
  dry-run       Print resolved config and docker commands without executing

Options:
  --help, -h    Show this help
  --version     Show version

All arguments after -- are passed to pi.

Examples:
  pi-container                              # interactive session
  pi-container -- -p "Summarize"            # print mode
  pi-container -- -r                        # resume session
  pi-container build                        # build image
  pi-container shell                        # container shell

Environment:
  PI_VERSION     Pi version (default: 0.75.5)
  PI_IMAGE_TAG   Docker image tag (default: pi-agent:<version>)
  PI_CONFIG_DIR  Host path for pi config (default: ~/.pi/agent)

Config precedence (highest wins):
  1. Environment variables
  2. User config:    ${userConfigPath}
  3. Project config: .pi-container/config.yml
  4. Built-in defaults

Project config:
  Place a .pi-container/ directory in your project root:
    .pi-container/config.yml          — pi version, image tag overrides
    .pi-container/extensions/         — team extensions (baked into image)
    .pi-container/packages/           — team npm packages
    .pi-container/settings/           — default settings template

User config:
  Create ${userConfigPath} for personal overrides:
    piVersion: "0.75.4"         # Override pi version
    imageTag: "my-registry/pi"  # Override image tag
    configDir: "~/pi-work"      # Use a different pi config directory

  Pi config is mounted from the host at ~/.pi/agent so settings,
  sessions, and auth tokens persist natively on your machine.
`.trim());
}

function printVersion(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require("../package.json");
  console.log(`pi-container ${pkg.version}`);
}

function main(): void {
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

  for (const arg of ourArgs) {
    if (arg === "--help" || arg === "-h") {
      printHelp();
      return;
    }
    if (arg === "--version") {
      printVersion();
      return;
    }
    if (arg === "build") {
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
  const config = loadConfig();

  // Ensure pi config directory exists on host
  for (const sub of ["sessions", "extensions", "npm", "git", "prompts", "skills"]) {
    fs.mkdirSync(path.join(config.configDir, sub), { recursive: true });
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

function printDryRun(config: PiContainerConfig, piArgs: string[]): void {
  const userConfigPath = getUserConfigPath();
  const userConfigExists = fs.existsSync(userConfigPath);

  console.log("Configuration:");
  console.log(`  piVersion:      ${config.piVersion}`);
  console.log(`  imageTag:       ${config.imageTag}`);
  console.log(`  projectDir:     ${config.projectDir}`);
  console.log(`  configDir:      ${config.configDir}`);
  console.log(`  envFile:        ${config.envFile || "(none)"}`);
  console.log(`  containerDir:   ${config.containerDir || "(none)"}`);
  console.log(`  extensions:     ${config.extensions.length > 0 ? config.extensions.join(", ") : "(none)"}`);
  console.log(`  hasPackages:    ${config.hasPackages}`);
  console.log(`  hasSettings:    ${config.hasSettings}`);
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