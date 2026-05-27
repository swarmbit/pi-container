// ============================================================
// pi-container — Template loading
// ============================================================
// Reads Dockerfile and entrypoint.sh from the templates/
// directory and injects the pi version. The template files
// are plain Dockerfile/bash with {{piVersion}} placeholders.
//
// This keeps the infrastructure code in real files that are
// easy to read and edit, rather than embedded strings.
// ============================================================

import * as path from "path";
import * as fs from "fs";
import { PI_VERSION } from "./config";

// Templates are in the templates/ directory, sibling to dist/
const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

/**
 * Load and populate the Dockerfile template.
 * {{piVersion}} is injected, and an optional extension block
 * (from .pi/pi-container.yml) is appended at the end.
 */
export function generateDockerfile(extension?: string, privileged?: boolean): string {
  const templatePath = path.join(TEMPLATES_DIR, "Dockerfile");
  let content = fs.readFileSync(templatePath, "utf-8");
  content = content.replace(/\{\{piVersion\}\}/g, PI_VERSION);

  // Inject Docker CLI installation for privileged mode (container-in-container)
  if (privileged) {
    const installMarker = "&& rm -rf /var/lib/apt/lists/*\n";
    const dockerInstall =
      "\n# Install Docker CLI for container-in-container (privileged mode)\n" +
      "RUN apt-get update && apt-get install -y --no-install-recommends \\\n" +
      "    docker.io \\\n" +
      "    && rm -rf /var/lib/apt/lists/*\n";
    content = content.replace(installMarker, installMarker + dockerInstall);
  }

  if (extension) {
    content =
      content.trimEnd() +
      "\n\n# ---------- Extension from .pi/pi-container.yml ----------\n" +
      extension.trimEnd() +
      "\n";
  }

  return content;
}

/**
 * Load the entrypoint.sh template.
 * No dynamic injection needed — it's fully static.
 */
export function generateEntrypoint(): string {
  const templatePath = path.join(TEMPLATES_DIR, "entrypoint.sh");
  return fs.readFileSync(templatePath, "utf-8");
}
