// ============================================================
// pi-container — Config discovery and loading
// ============================================================
// The only user-configurable setting is ports.
// Pi version and image are baked into this npm package.
//
// Config precedence for ports (highest wins):
//   1. CLI flags              (-p, --port)
//   2. User config            (~/.pi/pi-container.yml)
//   3. Project config           (.pi/pi-container.yml)
//   4. (none — ports have no built-in default)
//
// Config file schema:
//   ports:
//     - 3000
//     - 8080:80
// ============================================================

import * as path from "path";
import * as fs from "fs";
import yaml from "js-yaml";

// ── Package constants ──────────────────────────────────────────

/** Pi version shipped by this version of pi-container. */
export const PI_VERSION = "0.75.5";

/** Docker image tag derived from the pi version. */
export const PI_IMAGE = `pi-agent:${PI_VERSION}`;

// ── Types ──────────────────────────────────────────────────────

export interface PortMapping {
  /** Host port */
  host: number;
  /** Container port */
  container: number;
}

/** User-configurable settings (from pi-container.yml). */
export interface PiContainerConfig {
  ports: PortMapping[];
}

/** Runtime context (derived from environment, not user-configurable). */
export interface RuntimeContext {
  configDir: string;      // absolute host path (~/.pi)
  containerDir: string;   // absolute path to .pi dir, "" if none
  projectDir: string;     // absolute path — CWD
  workspaceDir: string;   // container path — e.g. /myproject
  envFile: string;        // absolute path to .env, "" if none
}

export interface LoadConfigOptions {
  /** Override home directory (for testing). */
  homeDir?: string;
  /** Port mappings from CLI -p flags (highest precedence). */
  cliPorts?: string[];
}

// ── Config file schema ────────────────────────────────────────

interface ConfigFile {
  ports?: (number | string)[];
}

// ── Loading ────────────────────────────────────────────────────

export function loadConfig(options?: LoadConfigOptions): PiContainerConfig & RuntimeContext {
  const projectDir = process.cwd();
  const containerDir = findContainerDir(projectDir);
  const homeDir = options?.homeDir ?? getHomeDir();

  // Load project config: .pi/pi-container.yml (team-committed)
  let projectConfig: ConfigFile = {};
  if (containerDir) {
    const configPath = path.join(containerDir, "pi-container.yml");
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

  const configDir = path.join(homeDir, ".pi");
  const envFile = findEnvFile(projectDir);

  // Resolve port mappings: CLI > user config > project config
  const cliPorts: PortMapping[] = (options?.cliPorts ?? []).map(parsePortMapping);
  const userPorts: PortMapping[] = parseConfigPorts(userConfig.ports);
  const projectPorts: PortMapping[] = parseConfigPorts(projectConfig.ports);
  const ports = mergePorts(cliPorts, userPorts, projectPorts);

  return {
    ports,
    configDir,
    containerDir,
    projectDir,
    workspaceDir: `/${path.basename(projectDir)}`,
    envFile,
  };
}

// ── Discovery helpers ─────────────────────────────────────────

function findContainerDir(projectDir: string): string {
  const candidate = path.join(projectDir, ".pi");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return "";
}

function findEnvFile(projectDir: string): string {
  const candidate = path.join(projectDir, ".pi-container-env");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return "";
}

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "/root";
}

// ── Port parsing ────────────────────────────────────────────────

/** Parse a single port string like "3000" or "8080:3000". */
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
    if (
      isNaN(host) || isNaN(container) ||
      String(host) !== parts[0] || String(container) !== parts[1] ||
      host <= 0 || container <= 0 || host > 65535 || container > 65535
    ) {
      throw new Error(`Invalid port mapping: "${input}". Ports must be 1-65535.`);
    }
    return { host, container };
  }

  // Range — "9000-9010"
  if (trimmed.includes("-")) {
    throw new Error(
      `Port ranges ("${input}") are only supported in config files, not as individual mappings. Use separate entries instead.`
    );
  }

  // Simple port — "3000"
  const port = parseInt(trimmed, 10);
  if (isNaN(port) || String(port) !== trimmed || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: "${input}". Must be 1-65535.`);
  }
  return { host: port, container: port };
}

/** Parse a comma-separated port string (from config file). Supports ranges. */
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
    if (
      isNaN(start) || isNaN(end) ||
      String(start) !== startStr || String(end) !== endStr ||
      start > end || start <= 0 || end > 65535
    ) {
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
    const parts = part.split(":");
    if (parts.length !== 2) {
      throw new Error(`Invalid port mapping: "${part}". Expected HOST:CONTAINER format.`);
    }
    const host = parseInt(parts[0], 10);
    const container = parseInt(parts[1], 10);
    if (
      isNaN(host) || isNaN(container) ||
      String(host) !== parts[0] || String(container) !== parts[1] ||
      host <= 0 || container <= 0 || host > 65535 || container > 65535
    ) {
      throw new Error(`Invalid port mapping: "${part}"`);
    }
    return [{ host, container }];
  }

  // Simple port: "3000"
  const port = parseInt(part, 10);
  if (isNaN(port) || String(port) !== part || port <= 0 || port > 65535) {
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
 *  Highest precedence first: CLI > user > project. */
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
