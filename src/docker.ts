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
import { spawnSync } from "child_process";
import { PiContainerConfig, RuntimeContext, PI_VERSION, PI_IMAGE } from "./config";
import { generateDockerfile, generateEntrypoint } from "./templates";

// Module root (sibling to dist/)
const MODULE_ROOT = path.join(__dirname, "..");

// ── Image management ────────────────────────────────────────

export function imageExists(tag: string): boolean {
  const result = spawnSync("docker", ["image", "inspect", tag], { stdio: "pipe" });
  return result.status === 0;
}

// ── Build ───────────────────────────────────────────────────

export function buildImage(): void {
  console.log(`🔨 Building ${PI_IMAGE} (pi v${PI_VERSION})...`);

  const buildCtx = createBuildContext();

  try {
    const args = [
      "build",
      "--build-arg",
      `PI_VERSION=${PI_VERSION}`,
      "-t",
      PI_IMAGE,
      ".",
    ];

    const result = spawnSync("docker", args, {
      cwd: buildCtx,
      stdio: "inherit",
    });

    if (result.status !== 0 && result.status !== null) {
      process.exit(result.status);
    }

    console.log(`✅ Built ${PI_IMAGE}`);
  } finally {
    // Clean up temp directory
    fs.rmSync(buildCtx, { recursive: true, force: true });
  }
}

export function buildIfNeeded(): void {
  if (!imageExists(PI_IMAGE)) {
    console.log("📦 Image not found. Building...");
    buildImage();
  }
}

// ── Run ─────────────────────────────────────────────────────

export function runContainer(config: PiContainerConfig & RuntimeContext, piArgs: string[]): void {
  buildIfNeeded();

  const args = buildDockerRunArgs(config, piArgs);
  const result = spawnSync("docker", args, { stdio: "inherit" });

  if (result.status !== 0 && result.status !== null) {
    process.exit(result.status);
  }
}

// ── Shell ───────────────────────────────────────────────────

export function shellInContainer(config: PiContainerConfig & RuntimeContext): void {
  buildIfNeeded();

  console.log("🐚 Opening shell in pi container...");
  const args = buildDockerRunArgs(config, ["/bin/bash"]);
  const result = spawnSync("docker", args, { stdio: "inherit" });

  if (result.status !== 0 && result.status !== null) {
    process.exit(result.status);
  }
}

// ── Docker run arg construction ──────────────────────────────

export function buildDockerRunArgs(config: PiContainerConfig & RuntimeContext, command: string[]): string[] {
  const args: string[] = ["run", "--rm"];

  // TTY: allocate if we're connected to a terminal
  if (process.stdin.isTTY) {
    args.push("-it");
  } else {
    args.push("-i");
  }

  // No --name flag — docker generates unique names, allowing
  // multiple pi-container instances to run simultaneously.

  // Mount project directory (CWD → workspace dir named after the project)
  args.push("-v", `${config.projectDir}:${config.workspaceDir}:cached`);

  // Mount pi config directory (host → container)
  args.push("-v", `${config.configDir}:/home/pi-user/.pi`);

  // Environment variables from config
  for (const [key, value] of Object.entries(config.env)) {
    args.push("-e", `${key}=${value}`);
  }

  // Port mappings (localhost only)
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

function createBuildContext(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-container-build-"));

  // Generate Dockerfile
  const dockerfile = generateDockerfile();
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
