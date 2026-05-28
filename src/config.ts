// ============================================================
// pi-container — Config discovery and loading
// ============================================================
// Configurable settings: ports, env, and mounts.
// Pi version and image are baked into this npm package.
//
// Config precedence (highest wins):
//   1. CLI flags              (-p, --port)
//   2. User config            (~/.pi/pi-container.yml)
//   3. Project config           (.pi/pi-container.yml)
//   4. (none — no built-in defaults for ports/env/mounts)
//
// Config file schema:
//   ports:
//     - 3000
//     - 8080:80
//   env:
//     ANTHROPIC_API_KEY: sk-xxx
//   mounts:
//     - /var/run/docker.sock:/var/run/docker.sock
//     - ~/.ssh:/home/pi-user/.ssh:ro
//   gitUserName: John Doe
//   gitUserEmail: john@example.com
// ============================================================

import * as path from "path";
import * as fs from "fs";
import { spawnSync } from "child_process";
import yaml from "js-yaml";

// ── Debug logging ────────────────────────────────────────────

let DEBUG = false;

export function setDebug(enabled: boolean): void {
  DEBUG = enabled;
}

export function isDebug(): boolean {
  return DEBUG;
}

export function debugLog(...args: unknown[]): void {
  if (DEBUG) {
    console.error("[DEBUG]", ...args);
  }
}

// ── Package constants ──────────────────────────────────────────

/** Pi version shipped by this version of pi-container. */
export const PI_VERSION = "0.76.0";

/** Docker image tag derived from the pi version. */
export const PI_IMAGE = `pi-agent:${PI_VERSION}`;

// ── Types ──────────────────────────────────────────────────────

export interface PortMapping {
  /** Host port */
  host: number;
  /** Container port */
  container: number;
}

export interface MountMapping {
  /** Host path */
  host: string;
  /** Container path */
  container: string;
  /** Mount mode (e.g. "ro", "rw", "cached"). Default: no mode (read-write). */
  mode?: string;
}

/** User-configurable settings (from pi-container.yml). */
export interface PiContainerConfig {
  ports: PortMapping[];
  env: Record<string, string>;
  mounts: MountMapping[];
  dockerfileExtension?: string;
  /** Git user name for commits made inside the container. */
  gitUserName?: string;
  /** Git user email for commits made inside the container. */
  gitUserEmail?: string;
}

/** Runtime context (derived from environment, not user-configurable). */
export interface RuntimeContext {
  configDir: string;      // absolute host path (~/.pi)
  containerDir: string;   // absolute path to .pi dir, "" if none
  projectDir: string;     // absolute path — CWD
  workspaceDir: string;   // container path — e.g. /myproject
  debug: boolean;         // debug mode enabled
}

export interface LoadConfigOptions {
  /** Override home directory (for testing). */
  homeDir?: string;
  /** Port mappings from CLI -p flags (highest precedence). */
  cliPorts?: string[];
  /** Enable debug logging. */
  debug?: boolean;
}

// ── Config file schema ────────────────────────────────────────

interface ConfigFile {
  ports?: (number | string)[];
  env?: Record<string, string>;
  mounts?: string[];
  dockerfileExtension?: string;
  gitUserName?: string;
  gitUserEmail?: string;
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

  // Resolve port mappings: CLI > user config > project config
  const cliPorts: PortMapping[] = (options?.cliPorts ?? []).map(parsePortMapping);
  const userPorts: PortMapping[] = parseConfigPorts(userConfig.ports);
  const projectPorts: PortMapping[] = parseConfigPorts(projectConfig.ports);
  const ports = mergePorts(cliPorts, userPorts, projectPorts);

  // Resolve env: user config overrides project config
  const env: Record<string, string> = {
    ...(projectConfig.env ?? {}),
    ...(userConfig.env ?? {}),
  };

  // Dockerfile extension: project config overrides user config
  const dockerfileExtension =
    (projectConfig.dockerfileExtension ?? userConfig.dockerfileExtension)?.trimEnd();

  // Mounts: merge project + user (user can add to project mounts, not replace)
  const projectMounts: MountMapping[] = parseConfigMounts(projectConfig.mounts);
  const userMounts: MountMapping[] = parseConfigMounts(userConfig.mounts);
  // Merge with later mounts overriding earlier ones on matching container paths
  const mounts = mergeMounts(projectMounts, userMounts);

  // Git user name: project config > user config > host git config
  const gitUserName: string | undefined =
    projectConfig.gitUserName ??
    userConfig.gitUserName ??
    inferGitConfig(homeDir, "user.name");

  // Git user email: project config > user config > host git config
  const gitUserEmail: string | undefined =
    projectConfig.gitUserEmail ??
    userConfig.gitUserEmail ??
    inferGitConfig(homeDir, "user.email");

  return {
    ports,
    env,
    mounts,
    dockerfileExtension,
    gitUserName,
    gitUserEmail,
    configDir,
    containerDir,
    projectDir,
    workspaceDir: `/${path.basename(projectDir)}`,
    debug: options?.debug ?? false,
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

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "/root";
}

/**
 * Infer a git config value from the host machine.
 * Runs `git config <key>` to read the user's git configuration.
 * Returns undefined if the command fails or produces no output.
 */
function inferGitConfig(homeDir: string, key: string): string | undefined {
  try {
    const result = spawnSync("git", ["config", key], {
      cwd: homeDir,
      stdio: "pipe",
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      const value = result.stdout.toString().trim();
      if (value) {
        debugLog(`Inferred git ${key} from host: ${value}`);
        return value;
      }
    }
    debugLog(`Could not infer git ${key} from host (status: ${result.status})`);
    return undefined;
  } catch (e) {
    debugLog(`Error inferring git ${key}: ${e}`);
    return undefined;
  }
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

/** Parse mount entries from config file (each is a string like /host:/container or /host:/container:ro). */
function parseConfigMounts(mounts: string[] | undefined): MountMapping[] {
  if (!mounts) return [];
  const mappings: MountMapping[] = [];
  for (const entry of mounts) {
    mappings.push(parseMountMapping(entry));
  }
  return mappings;
}

/** Parse a single mount string like "/host:/container" or "/host:/container:ro". */
export function parseMountMapping(input: string): MountMapping {
  const trimmed = input.trim();
  const parts = trimmed.split(":");

  if (parts.length === 2) {
    // /host:/container
    const [host, container] = parts;
    if (!host || !container) {
      throw new Error(`Invalid mount mapping: "${input}". Expected HOST:CONTAINER format.`);
    }
    return { host, container };
  }

  if (parts.length === 3) {
    // /host:/container:mode
    const [host, container, mode] = parts;
    if (!host || !container || !mode) {
      throw new Error(`Invalid mount mapping: "${input}". Expected HOST:CONTAINER:MODE format.`);
    }
    return { host, container, mode };
  }

  throw new Error(`Invalid mount mapping: "${input}". Expected HOST:CONTAINER or HOST:CONTAINER:MODE format.`);
}

/** Merge mount lists. Later entries override earlier ones on matching container paths. */
function mergeMounts(project: MountMapping[], user: MountMapping[]): MountMapping[] {
  // Use Map keyed by container path for dedup; user mounts win over project
  const seen = new Map<string, MountMapping>();
  for (const m of project) {
    seen.set(m.container, m);
  }
  for (const m of user) {
    seen.set(m.container, m);
  }
  return Array.from(seen.values());
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
