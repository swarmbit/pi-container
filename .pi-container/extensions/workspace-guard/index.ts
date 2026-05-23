// ============================================================
// workspace-guard — Keep the model inside /workspace
// ============================================================
// Injects a system prompt reminder that the model should only
// read and write files within /workspace, and should avoid
// modifying system files or working outside the project directory.
//
// This extension is baked into the pi-container image and
// symlinked into ~/.pi/agent/extensions/ on startup.
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GUARD_PROMPT = `## Workspace Guard

You are running inside a Docker container. The project directory is /workspace.

Important rules:
- Only read, write, and edit files within /workspace
- Do not modify system files (/etc, /usr, /bin, /sbin, /lib, /var, /boot, /proc, /sys)
- Do not run commands that modify the system (apt-get install, systemctl, etc.)
- The /home/pi-user/.pi/agent directory is mounted from the host and is safe to use
- If you need a system package, suggest the user add it to the Dockerfile instead of installing it inline
- Prefer project-local tools (npx, nvm, etc.) over system-wide installations`;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (_event, _ctx) => {
    return {
      systemPrompt: GUARD_PROMPT,
    };
  });
}