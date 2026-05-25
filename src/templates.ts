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
 * Only {{piVersion}} is injected — everything else is static.
 */
export function generateDockerfile(): string {
  const templatePath = path.join(TEMPLATES_DIR, "Dockerfile");
  let content = fs.readFileSync(templatePath, "utf-8");
  content = content.replace(/\{\{piVersion\}\}/g, PI_VERSION);
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
