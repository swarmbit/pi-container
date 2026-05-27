// ============================================================
// pi-container — Docker operations
// ============================================================
// Builds images, runs containers, opens shells. All Docker
// interaction goes through here.
//
// Key design decisions:
//   - Uses `docker run` directly (not docker compose) so paths
//     resolve relative to CWD — fixes the mounting bug
//   - Fresh container per invocation — no state to manage
//   - Build context is a temp directory created per build,
//     incorporating only what's needed from .pi/
//   - Built-in package/ and settings/ are always copied from
//     the installed module — pi install at runtime handles
//     any additional packages
// ============================================================

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawnSync, spawn, SpawnSyncReturns } from "child_process";
import { PiContainerConfig, RuntimeContext, PI_VERSION, PI_IMAGE, debugLog, isDebug } from "./config";
import { generateDockerfile, generateEntrypoint } from "./templates";

// Module root (sibling to dist/)
const MODULE_ROOT = path.join(__dirname, "..");

// ── Image management ────────────────────────────────────────

export function imageExists(tag: string): boolean {
  debugLog(`Checking if image exists: ${tag}`);
  const result = spawnSync("docker", ["image", "inspect", tag], { stdio: "pipe" });
  const exists = result.status === 0;
  debugLog(`Image ${tag} exists: ${exists}${exists ? "" : " (stderr: " + result.stderr.toString().trim() + ")"}`);
  return exists;
}

// ── Build ───────────────────────────────────────────────────

export function buildImage(dockerfileExtension?: string, privileged?: boolean): void {
  console.log(`🔨 Building ${PI_IMAGE} (pi v${PI_VERSION})...`);

  const buildCtx = createBuildContext(dockerfileExtension);
  debugLog(`Build context created at: ${buildCtx}`);

  try {
    const args = [
      "build",
      "--build-arg",
      `PI_VERSION=${PI_VERSION}`,
      "-t",
      PI_IMAGE,
      ".",
    ];

    debugLog(`Running: docker ${args.join(" ")} (cwd: ${buildCtx})`);
    const result = spawnSync("docker", args, {
      cwd: buildCtx,
      stdio: isDebug() ? "pipe" : "inherit",
    });

    if (isDebug()) {
      const out = result.stdout?.toString() || "";
      const err = result.stderr?.toString() || "";
      if (out) { process.stdout.write(out); debugLog("Build stdout:", out); }
      if (err) { process.stderr.write(err); debugLog("Build stderr:", err); }
    }

    debugLog(`Docker build exited with status: ${result.status}${result.error ? ", error: " + result.error.message : ""}`);
    if (result.status !== 0 && result.status !== null) {
      console.error(`Build failed with status ${result.status}`);
      process.exit(result.status);
    }

    console.log(`✅ Built ${PI_IMAGE}`);
  } finally {
    // Clean up temp directory
    debugLog(`Cleaning up build context: ${buildCtx}`);
    fs.rmSync(buildCtx, { recursive: true, force: true });
  }
}

export function buildIfNeeded(dockerfileExtension?: string, privileged?: boolean): void {
  debugLog(`buildIfNeeded: checking for ${PI_IMAGE}`);
  if (!imageExists(PI_IMAGE)) {
    console.log("📦 Image not found. Building...");
    buildImage(dockerfileExtension, privileged);
  } else {
    debugLog(`Image ${PI_IMAGE} already exists, skipping build`);
  }
}

// ── Run ─────────────────────────────────────────────────────

/**
 * When debug mode is on, use async spawn so we can inherit stdin
 * (preserving TTY interactivity) while piping stdout/stderr for capture.
 * Without debug, use spawnSync with stdio "inherit" for direct passthrough.
 */
function spawnDocker(args: string[], debug: boolean): Promise<SpawnSyncReturns<Buffer>> {
  if (!debug) {
    // Fast path: inherit all stdio, synchronous
    const result = spawnSync("docker", args, { stdio: "inherit" });
    return Promise.resolve(result);
  }

  // Debug path: inherit stdin (keep TTY working), pipe stdout/stderr for capture
  return new Promise((resolve) => {
    const child = spawn("docker", args, {
      stdio: ["inherit", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout?.on("data", (data: Buffer) => {
      chunks.push(data);
      process.stdout.write(data);
    });
    child.stderr?.on("data", (data: Buffer) => {
      errChunks.push(data);
      process.stderr.write(data);
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks);
      const stderr = Buffer.concat(errChunks);
      debugLog("Container stdout:", stdout.toString());
      debugLog("Container stderr:", stderr.toString());
      // Build a SpawnSyncReturns-shaped object so callers can use the same shape
      resolve({
        status: code,
        stdout,
        stderr,
        pid: child.pid ?? 0,
        output: [stdout, stderr],
        signal: null,
        error: undefined,
      } as unknown as SpawnSyncReturns<Buffer>);
    });

    child.on("error", (err) => {
      resolve({
        status: null,
        stdout: Buffer.concat(chunks),
        stderr: Buffer.concat(errChunks),
        pid: child.pid ?? 0,
        output: [Buffer.concat(chunks), Buffer.concat(errChunks)],
        signal: null,
        error: err,
      } as unknown as SpawnSyncReturns<Buffer>);
    });
  });
}

export async function runContainer(config: PiContainerConfig & RuntimeContext, piArgs: string[]): Promise<void> {
  debugLog("runContainer called with piArgs:", piArgs);
  buildIfNeeded(config.dockerfileExtension, config.privileged);

  const args = buildDockerRunArgs(config, piArgs);
  debugLog(`Running: docker ${args.join(" ")}`);
  const result = await spawnDocker(args, config.debug);

  debugLog(`Docker run exited with status: ${result.status}${result.error ? ", error: " + result.error.message : ""}`);
  if (result.status !== 0 && result.status !== null) {
    console.error(`Container exited with status ${result.status}`);
    process.exit(result.status);
  }
}

// ── Shell ───────────────────────────────────────────────────

export async function shellInContainer(config: PiContainerConfig & RuntimeContext): Promise<void> {
  debugLog("shellInContainer called");
  buildIfNeeded(config.dockerfileExtension, config.privileged);

  console.log("🐚 Opening shell in pi container...");
  const args = buildDockerRunArgs(config, ["/bin/bash"]);
  debugLog(`Running: docker ${args.join(" ")}`);
  const result = await spawnDocker(args, config.debug);

  debugLog(`Docker shell exited with status: ${result.status}${result.error ? ", error: " + result.error.message : ""}`);
  if (result.status !== 0 && result.status !== null) {
    process.exit(result.status);
  }
}

/**
 * Open a shell in an existing container via docker exec.
 * Runs /bin/bash as pi-user so file permissions match the host.
 */
export async function execInContainer(containerId: string): Promise<void> {
  debugLog(`execInContainer called for: ${containerId}`);

  // Verify the container exists and is running
  const inspect = spawnSync("docker", ["container", "inspect", containerId], { stdio: "pipe" });
  if (inspect.status !== 0) {
    console.error(`Error: Container "${containerId}" not found.`);
    console.error(inspect.stderr.toString().trim());
    process.exit(1);
  }

  let containerData: any;
  try {
    containerData = JSON.parse(inspect.stdout.toString());
  } catch {
    console.error(`Error: Failed to inspect container "${containerId}".`);
    process.exit(1);
  }

  if (!containerData[0]?.State?.Running) {
    console.error(`Error: Container "${containerId}" is not running.`);
    process.exit(1);
  }

  console.log(`🐚 Opening shell in container ${containerId}...`);
  const isTTY = process.stdin.isTTY;
  const args = ["exec"];
  if (isTTY) {
    args.push("-it");
  } else {
    args.push("-i");
  }
  args.push("-u", "pi-user", containerId, "/bin/bash");

  debugLog(`Running: docker ${args.join(" ")}`);
  const result = await spawnDocker(args, false);

  debugLog(`Docker exec exited with status: ${result.status}${result.error ? ", error: " + result.error.message : ""}`);
  if (result.status !== 0 && result.status !== null) {
    process.exit(result.status);
  }
}

// ── Docker run arg construction ──────────────────────────────

export function buildDockerRunArgs(config: PiContainerConfig & RuntimeContext, command: string[]): string[] {
  const args: string[] = ["run", "--rm"];

  // TTY: allocate if we're connected to a terminal
  const isTTY = process.stdin.isTTY;
  if (isTTY) {
    args.push("-it");
  } else {
    args.push("-i");
  }
  debugLog(`TTY mode: ${isTTY ? "-it (interactive terminal)" : "-i (non-TTY)"}`);

  // No --name flag — docker generates unique names, allowing
  // multiple pi-container instances to run simultaneously.

  // Mount project directory (CWD → workspace dir named after the project)
  args.push("-v", `${config.projectDir}:${config.workspaceDir}:cached`);
  debugLog(`Mount: ${config.projectDir} -> ${config.workspaceDir}`);

  // Mount pi config directory (host → container)
  args.push("-v", `${config.configDir}:/home/pi-user/.pi`);
  debugLog(`Mount: ${config.configDir} -> /home/pi-user/.pi`);

  // Environment variables from config
  debugLog(`Environment vars: ${Object.keys(config.env).length > 0 ? Object.keys(config.env).join(", ") : "(none)"}`);
  for (const [key, value] of Object.entries(config.env)) {
    args.push("-e", `${key}=${value}`);
  }

  // Port mappings (localhost only)
  if (config.ports.length > 0) {
    debugLog(`Port mappings: ${config.ports.map(p => `${p.host}:${p.container}`).join(", ")}`);
  }
  for (const port of config.ports) {
    args.push("-p", `127.0.0.1:${port.host}:${port.container}`);
  }

  // Working directory
  args.push("-w", config.workspaceDir);

  // Pass workspace dir to container (for extensions)
  args.push("-e", `WORKSPACE_DIR=${config.workspaceDir}`);

  // Host UID/GID for file permissions
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  args.push("-e", `HOST_UID=${uid}`);
  args.push("-e", `HOST_GID=${gid}`);
  debugLog(`Host UID=${uid}, GID=${gid}`);

  // Docker socket mount for privileged mode (Docker-out-of-Docker)
  if (config.privileged) {
    debugLog(`Privileged mode: mounting Docker socket ${config.dockerSocket}`);
    args.push("-v", `${config.dockerSocket}:/var/run/docker.sock`);
  }

  // Image
  args.push(PI_IMAGE);

  // Command (pi or shell)
  args.push(...command);

  return args;
}

// ── Build context creation ───────────────────────────────────
//
// Creates a temp directory with everything needed for `docker build`:
//   - Dockerfile (generated from template)
//   - entrypoint.sh (generated from template)
//   - package/ (built-in, from installed module)
//   - settings/ (built-in, from installed module)

function createBuildContext(dockerfileExtension?: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-container-build-"));

  // Generate Dockerfile
  const dockerfile = generateDockerfile(dockerfileExtension);
  fs.writeFileSync(path.join(tmpDir, "Dockerfile"), dockerfile);

  // Generate entrypoint
  const entrypoint = generateEntrypoint();
  fs.writeFileSync(path.join(tmpDir, "entrypoint.sh"), entrypoint);

  // Copy built-in package (always present in installed module)
  const builtinPackageDir = path.join(MODULE_ROOT, "package");
  if (fs.existsSync(builtinPackageDir)) {
    copyDir(builtinPackageDir, path.join(tmpDir, "package"));
  } else {
    createPlaceholderPackage(tmpDir);
  }

  // Copy built-in settings (always present in installed module)
  const builtinSettingsDir = path.join(MODULE_ROOT, "settings");
  if (fs.existsSync(builtinSettingsDir)) {
    copyDir(builtinSettingsDir, path.join(tmpDir, "settings"));
  } else {
    createPlaceholderSettings(tmpDir);
  }

  return tmpDir;
}

function createPlaceholderPackage(tmpDir: string): void {
  fs.mkdirSync(path.join(tmpDir, "package", "extensions"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "package", "themes"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "package", "extensions", ".gitkeep"), "");
  fs.writeFileSync(path.join(tmpDir, "package", "themes", ".gitkeep"), "");
  fs.writeFileSync(
    path.join(tmpDir, "package", "package.json"),
    JSON.stringify(
      {
        name: "pi-container-defaults",
        version: "1.0.0",
        private: true,
        description: "No customizations",
        keywords: ["pi-package"],
        pi: {
          extensions: ["./extensions"],
          themes: ["./themes"],
        },
        peerDependencies: {
          "@earendil-works/pi-coding-agent": "*",
        },
      },
      null,
      2
    )
  );
}

function createPlaceholderSettings(tmpDir: string): void {
  fs.mkdirSync(path.join(tmpDir, "settings"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "settings", "default-settings.json"),
    JSON.stringify({ defaultThinkingLevel: "medium", autoCompact: true }, null, 2)
  );
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // Skip node_modules — the Docker build runs npm install for the package
    if (entry.name === "node_modules") continue;
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}
