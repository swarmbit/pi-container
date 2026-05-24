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
//     incorporating only what's needed from .pi-container/
// ============================================================

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execSync, spawnSync } from "child_process";
import { PiContainerConfig } from "./config";
import { generateDockerfile, generateEntrypoint } from "./templates";

// ── Image management ────────────────────────────────────────

export function imageExists(tag: string): boolean {
  try {
    execSync(`docker image inspect ${tag}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ── Build ───────────────────────────────────────────────────

export function buildImage(config: PiContainerConfig): void {
  console.log(`🔨 Building ${config.imageTag} (pi v${config.piVersion})...`);

  const buildCtx = createBuildContext(config);

  try {
    const cmd = [
      "docker",
      "build",
      "--build-arg",
      `PI_VERSION=${config.piVersion}`,
      "-t",
      config.imageTag,
      ".",
    ].join(" ");

    execSync(cmd, {
      cwd: buildCtx,
      stdio: "inherit",
    });

    console.log(`✅ Built ${config.imageTag}`);
  } finally {
    // Clean up temp directory
    fs.rmSync(buildCtx, { recursive: true, force: true });
  }
}

export function buildIfNeeded(config: PiContainerConfig): void {
  if (!imageExists(config.imageTag)) {
    console.log("📦 Image not found. Building...");
    buildImage(config);
  }
}

// ── Run ─────────────────────────────────────────────────────

export function runContainer(config: PiContainerConfig, piArgs: string[]): void {
  buildIfNeeded(config);

  const args = buildDockerRunArgs(config, piArgs);
  const result = spawnSync("docker", args, { stdio: "inherit" });

  if (result.status !== 0 && result.status !== null) {
    process.exit(result.status);
  }
}

// ── Shell ───────────────────────────────────────────────────

export function shellInContainer(config: PiContainerConfig): void {
  buildIfNeeded(config);

  console.log("🐚 Opening shell in pi container...");
  const args = buildDockerRunArgs(config, ["/bin/bash"]);
  const result = spawnSync("docker", args, { stdio: "inherit" });

  if (result.status !== 0 && result.status !== null) {
    process.exit(result.status);
  }
}

// ── Docker run arg construction ──────────────────────────────

export function buildDockerRunArgs(config: PiContainerConfig, command: string[]): string[] {
  const args: string[] = ["run", "--rm"];

  // TTY: allocate if we're connected to a terminal
  if (process.stdin.isTTY) {
    args.push("-it");
  } else {
    args.push("-i");
  }

  // No --name flag — docker generates unique names, allowing
  // multiple pi-container instances to run simultaneously.

  // Mount project directory (CWD → /workspace)
  args.push("-v", `${config.projectDir}:/workspace:cached`);

  // Mount pi config directory (host → container)
  // Mount the entire ~/.pi directory so the container has access
  // to the full pi config tree (agent/, themes/, etc.)
  args.push("-v", `${config.configDir}:/home/pi-user/.pi`);

  // Environment file (if .env exists)
  if (config.envFile) {
    args.push("--env-file", config.envFile);
  }

  // Team packages (comma-separated list for the entrypoint to install)
  if (config.packages.length > 0) {
    args.push("-e", `TEAM_PACKAGES=${config.packages.join(",")}`);
  }

  // Port mappings (localhost only)
  for (const port of config.ports) {
    args.push("-p", `127.0.0.1:${port.host}:${port.container}`);
  }

  // Working directory
  args.push("-w", "/workspace");

  // Host UID/GID for file permissions
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  args.push("-e", `HOST_UID=${uid}`);
  args.push("-e", `HOST_GID=${gid}`);

  // Image
  args.push(config.imageTag);

  // Command (pi or shell)
  args.push(...command);

  return args;
}

// ── Build context creation ───────────────────────────────────
//
// Creates a temp directory with everything needed for `docker build`:
//   - Dockerfile (generated from template)
//   - entrypoint.sh (generated from template)
//   - package/ (from project, or minimal placeholder)
//   - settings/ (from project, or minimal default)
//
// The Dockerfile always expects these directories to exist.
// If the project doesn't provide them, we supply fallback content.

function createBuildContext(config: PiContainerConfig): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-container-build-"));

  // Generate Dockerfile
  const dockerfile = generateDockerfile(config);
  fs.writeFileSync(path.join(tmpDir, "Dockerfile"), dockerfile);

  // Generate entrypoint
  const entrypoint = generateEntrypoint(config);
  fs.writeFileSync(path.join(tmpDir, "entrypoint.sh"), entrypoint);

  // Copy team package (or create minimal placeholder)
  if (config.containerDir && config.hasPackage) {
    const pkgSrc = path.join(config.containerDir, "package");
    copyDir(pkgSrc, path.join(tmpDir, "package"));
  } else {
    // Minimal placeholder package so pi install /opt/pi-package succeeds
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

  // Copy settings (or create minimal default)
  if (config.containerDir && config.hasSettings) {
    const settingsSrc = path.join(config.containerDir, "settings");
    copyDir(settingsSrc, path.join(tmpDir, "settings"));
  } else {
    fs.mkdirSync(path.join(tmpDir, "settings"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "settings", "default-settings.json"),
      JSON.stringify({ defaultThinkingLevel: "medium", autoCompact: true }, null, 2)
    );
  }

  return tmpDir;
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