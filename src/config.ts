// ============================================================
// pi-container — Config discovery and loading
// ============================================================
// Finds .pi-container/ directory and loads config from three
// sources with clear precedence.
//
// Config precedence (highest wins):
//   1. Environment variables (PI_VERSION, PI_IMAGE_TAG, PI_CONFIG_DIR)
//   2. User config            (~/.pi/pi-container.yml)
//   3. Project config           (.pi-container/config.yml)
//   4. Built-in defaults
//
// This means:
//   - Team sets defaults in .pi-container/config.yml (committed to git)
//   - Individual user overrides in ~/.pi/pi-container.yml (personal, not committed)
//   - One-off overrides via environment variables (ephemeral)
// ============================================================

import * as path from "path";
import * as fs from "fs";
import yaml from "js-yaml";

const DEFAULT_PI_VERSION = "0.75.5";

export interface PiContainerConfig {
  piVersion: string;
  imageTag: string;
  configDir: string; // absolute host path (~/.pi/agent)
  containerDir: string; // absolute path to .pi-container dir, "" if none
  projectDir: string; // absolute path — CWD, the workspace mount source
  envFile: string; // absolute path to .env, "" if none
  extensions: string[]; // extension directory names found
  hasPackages: boolean;
  hasSettings: boolean;
}

interface ConfigFile {
  piVersion?: string;
  imageTag?: string;
  configDir?: string;
}

export interface LoadConfigOptions {
  /** Override home directory (for testing). Defaults to os.homedir(). */
  homeDir?: string;
}

export function loadConfig(options?: LoadConfigOptions): PiContainerConfig {
  const projectDir = process.cwd();
  const containerDir = findContainerDir(projectDir);
  const homeDir = options?.homeDir ?? getHomeDir();

  // Load project config: .pi-container/config.yml (team-committed)
  let projectConfig: ConfigFile = {};
  if (containerDir) {
    const configPath = path.join(containerDir, "config.yml");
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      projectConfig = (yaml.load(raw) as ConfigFile) || {};
    }
  }

  // Load user config: ~/.pi/pi-container.yml (personal, not committed)
  let userConfig: ConfigFile = {};
  const userConfigPath = path.join(homeDir, ".pi", "pi-container.yml");
  if (fs.existsSync(userConfigPath)) {
    const raw = fs.readFileSync(userConfigPath, "utf-8");
    userConfig = (yaml.load(raw) as ConfigFile) || {};
  }

  // Resolve pi version: env > user config > project config > default
  const piVersion =
    process.env.PI_VERSION ||
    userConfig.piVersion ||
    projectConfig.piVersion ||
    DEFAULT_PI_VERSION;

  // Resolve image tag: env > user config > project config > derived from version
  const imageTag =
    process.env.PI_IMAGE_TAG ||
    userConfig.imageTag ||
    projectConfig.imageTag ||
    `pi-agent:${piVersion}`;

  // Resolve config dir: env > user config > project config > default
  const configDir =
    process.env.PI_CONFIG_DIR ||
    userConfig.configDir ||
    projectConfig.configDir ||
    path.join(homeDir, ".pi", "agent");

  // Resolve .env file
  const envFile = findEnvFile(projectDir);

  // Discover extensions (only from project .pi-container/)
  const extensions: string[] = [];
  let hasPackages = false;
  let hasSettings = false;

  if (containerDir) {
    const extDir = path.join(containerDir, "extensions");
    if (fs.existsSync(extDir)) {
      for (const entry of fs.readdirSync(extDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          // Only include extensions that have an index.ts or index.js
          const indexPath = path.join(extDir, entry.name, "index.ts");
          const indexPathJs = path.join(extDir, entry.name, "index.js");
          if (fs.existsSync(indexPath) || fs.existsSync(indexPathJs)) {
            extensions.push(entry.name);
          }
        }
      }
    }

    const packagesDir = path.join(containerDir, "packages");
    hasPackages =
      fs.existsSync(path.join(packagesDir, "package.json")) &&
      Object.keys(
        JSON.parse(fs.readFileSync(path.join(packagesDir, "package.json"), "utf-8")).dependencies ||
          {}
      ).length > 0;

    hasSettings = fs.existsSync(path.join(containerDir, "settings", "default-settings.json"));
  }

  return {
    piVersion,
    imageTag,
    configDir,
    containerDir,
    projectDir,
    envFile,
    extensions,
    hasPackages,
    hasSettings,
  };
}

function findContainerDir(projectDir: string): string {
  const candidate = path.join(projectDir, ".pi-container");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return "";
}

function findEnvFile(projectDir: string): string {
  const candidate = path.join(projectDir, ".env");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return "";
}

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "/root";
}

/** Get the user config path for a given home directory. */
export function getUserConfigPath(homeDir?: string): string {
  return path.join(homeDir ?? getHomeDir(), ".pi", "pi-container.yml");
}