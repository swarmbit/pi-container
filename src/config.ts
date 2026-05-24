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

export interface PortMapping {
  /** Host port */
  host: number;
  /** Container port */
  container: number;
}

export interface PiContainerConfig {
  piVersion: string;
  imageTag: string;
  configDir: string; // absolute host path (~/.pi)
  containerDir: string; // absolute path to .pi-container dir, "" if none
  projectDir: string; // absolute path — CWD, the workspace mount source
  workspaceDir: string; // container path — e.g. /workspace or /myproject
  envFile: string; // absolute path to .env, "" if none
  hasPackage: boolean; // .pi-container/package/ exists
  hasSettings: boolean; // .pi-container/settings/default-settings.json exists
  packages: string[]; // third-party packages from config.yml
  ports: PortMapping[]; // port mappings (host:container)
}

interface ConfigFile {
  piVersion?: string;
  imageTag?: string;
  configDir?: string;
  ports?: (number | string)[];
  packages?: string[];
}

export interface LoadConfigOptions {
  /** Override home directory (for testing). Defaults to os.homedir(). */
  homeDir?: string;
  /** Port mappings from CLI -p flags (highest precedence). */
  cliPorts?: string[];
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
    path.join(homeDir, ".pi");

  // Resolve .env file
  const envFile = findEnvFile(projectDir);

  // Discover package directory
  const hasPackage = containerDir
    ? fs.existsSync(path.join(containerDir, "package", "package.json"))
    : false;

  // Discover settings
  const hasSettings = containerDir
    ? fs.existsSync(path.join(containerDir, "settings", "default-settings.json"))
    : false;

  // Resolve packages from project config (third-party packages to pre-install)
  const packages = projectConfig.packages ?? [];

  // Resolve port mappings: CLI > env > user config > project config
  const cliPorts: PortMapping[] = (options?.cliPorts ?? []).map(parsePortMapping);
  const envPorts: PortMapping[] = (process.env.PI_PORTS ? parsePortsString(process.env.PI_PORTS) : []);
  const userPorts: PortMapping[] = parseConfigPorts(userConfig.ports);
  const projectPorts: PortMapping[] = parseConfigPorts(projectConfig.ports);
  const ports = mergePorts(cliPorts, envPorts, userPorts, projectPorts);

  return {
    piVersion,
    imageTag,
    configDir,
    containerDir,
    projectDir,
    workspaceDir: `/${path.basename(projectDir)}`,
    envFile,
    hasPackage,
    hasSettings,
    packages,
    ports,
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

// ── Port parsing ────────────────────────────────────────────────

/** Parse a single port string like "3000", "8080:3000", or "9000-9010". */
export function parsePortMapping(input: string): PortMapping {
  const trimmed = input.trim();

  // Host:Container — "8080:3000"
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":");
    if (parts.length !== 2) {
      throw new Error(`Invalid port mapping: "${input}". Expected HOST:CONTAINER format.`);
    }
    const host = parseInt(parts[0], 10);
    const container = parseInt(parts[1], 10);
    if (isNaN(host) || isNaN(container) || host <= 0 || container <= 0 || host > 65535 || container > 65535) {
      throw new Error(`Invalid port mapping: "${input}". Ports must be 1-65535.`);
    }
    return { host, container };
  }

  // Range — "9000-9010"
  if (trimmed.includes("-")) {
    throw new Error(
      `Port ranges ("${input}") are only supported in config files and PI_PORTS, not as individual mappings. Use separate entries instead.`
    );
  }

  // Simple port — "3000"
  const port = parseInt(trimmed, 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: "${input}". Must be 1-65535.`);
  }
  return { host: port, container: port };
}

/** Parse a comma-separated port string (from PI_PORTS env var). Supports ranges. */
export function parsePortsString(input: string): PortMapping[] {
  const mappings: PortMapping[] = [];
  for (const part of input.split(",").map((s) => s.trim()).filter(Boolean)) {
    mappings.push(...expandPortPart(part));
  }
  return mappings;
}

/** Parse a single part from config/ports — can be a number, "host:container", or "start-end". */
function expandPortPart(part: string): PortMapping[] {
  // Range: "9000-9010"
  if (part.includes("-") && !part.includes(":")) {
    const [startStr, endStr] = part.split("-");
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    if (isNaN(start) || isNaN(end) || start > end || start <= 0 || end > 65535) {
      throw new Error(`Invalid port range: "${part}"`);
    }
    const mappings: PortMapping[] = [];
    for (let i = start; i <= end; i++) {
      mappings.push({ host: i, container: i });
    }
    return mappings;
  }

  // Host:Container: "8080:3000"
  if (part.includes(":")) {
    const [hostStr, containerStr] = part.split(":");
    const host = parseInt(hostStr, 10);
    const container = parseInt(containerStr, 10);
    if (isNaN(host) || isNaN(container) || host <= 0 || container <= 0 || host > 65535 || container > 65535) {
      throw new Error(`Invalid port mapping: "${part}"`);
    }
    return [{ host, container }];
  }

  // Simple port: "3000"
  const port = parseInt(part, 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: "${part}"`);
  }
  return [{ host: port, container: port }];
}

/** Parse port entries from config file (can be numbers or strings). */
function parseConfigPorts(ports: (number | string)[] | undefined): PortMapping[] {
  if (!ports) return [];
  const mappings: PortMapping[] = [];
  for (const entry of ports) {
    mappings.push(...expandPortPart(String(entry)));
  }
  return mappings;
}

/** Merge port lists with later entries overriding earlier ones on conflict.
 *  Highest precedence first: CLI > env > user > project. */
function mergePorts(...lists: PortMapping[][]): PortMapping[] {
  const seen = new Map<number, PortMapping>();
  // Process in reverse so higher precedence wins
  for (let i = lists.length - 1; i >= 0; i--) {
    for (const mapping of lists[i]) {
      seen.set(mapping.host, mapping);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.host - b.host);
}

/** Check if a port is available on localhost. Returns true if available. */
export async function checkPortAvailable(port: number): Promise<boolean> {
  const net = await import("net");
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, "127.0.0.1");
  });
}

/** Get the user config path for a given home directory. */
export function getUserConfigPath(homeDir?: string): string {
  return path.join(homeDir ?? getHomeDir(), ".pi", "pi-container.yml");
}