# port-export — Container Port Forwarding for Local Web Dev

Export container ports so you can access web apps running inside pi-container from your local machine.

## Problem

When a web application runs inside a Docker container, it's isolated from the host network. You can't open `http://localhost:3000` in your browser and reach a dev server running inside the container — unless ports are explicitly forwarded.

Docker provides `-p` (publish) flags for this, but `pi-container` doesn't currently support any port configuration. Users who develop web apps need an easy way to declare which ports should be accessible from the host.

## Design

### User Interface

Add port configuration to `.pi-container/config.yml`:

```yaml
# .pi-container/config.yml
ports:
  - 3000        # Map container port 3000 → host port 3000
  - 8080:8080   # Explicit host:container mapping
  - 9000-9010   # Port ranges
```

Or via environment variable for one-off overrides:

```bash
PI_PORTS="3000,8080:8080" pi-container
```

Or on the CLI:

```bash
pi-container -p 3000 -p 8080:8080
```

### Docker Mapping

Every port entry translates to a `docker run -p` flag:

| Config | Docker flag | Meaning |
|--------|-------------|---------|
| `3000` | `-p 3000:3000` | Container 3000 → Host 3000 |
| `8080:3000` | `-p 8080:3000` | Container 3000 → Host 8080 |
| `9000-9010` | `-p 9000:9000 -p 9001:9001 ...` | Range expansion |

The host port always binds to `127.0.0.1` (localhost only) for security:

```
-p 127.0.0.1:3000:3000
```

### Config Precedence

Same pattern as other settings (highest wins):

1. Environment variable: `PI_PORTS`
2. User config: `~/.pi/pi-container.yml`
3. Project config: `.pi-container/config.yml`
4. CLI flags: `-p` / `--port`
5. (No defaults — no ports exposed unless configured)

### Resolving Port Conflicts

If a host port is already in use, Docker will fail to start. Options:

1. **Auto-assign** — Use `-p 127.0.0.1::3000` (empty host port) and let Docker pick an available port. Then report the mapped port to the user.
2. **Fail fast** — Check if the port is available before `docker run` and report a clear error.
3. **Override** — Let the user specify a different host port in the config.

**Decision: Fail fast with a clear message.** Auto-assigning random ports is confusing (what URL do you open?). Better to tell the user which port is blocked and let them fix it.

## Implementation

### config.ts Changes

Add `ports` to `PiContainerConfig`:

```typescript
export interface PiContainerConfig {
  // ... existing fields
  ports: PortMapping[];
}

export interface PortMapping {
  host: number;
  container: number;
}

// Parse port strings like "3000", "8080:3000", "9000-9010"
function parsePorts(input: string): PortMapping[] {
  const mappings: PortMapping[] = [];
  for (const part of input.split(",").map(s => s.trim())) {
    if (part.includes("-")) {
      // Range: "9000-9010"
      const [start, end] = part.split("-").map(Number);
      for (let i = start; i <= end; i++) {
        mappings.push({ host: i, container: i });
      }
    } else if (part.includes(":")) {
      // Host:Container mapping: "8080:3000"
      const [host, container] = part.split(":").map(Number);
      mappings.push({ host, container });
    } else {
      // Simple port: "3000"
      const port = Number(part);
      mappings.push({ host: port, container: port });
    }
  }
  return mappings;
}
```

### config.yml Schema

```yaml
# .pi-container/config.yml
piVersion: "0.75.5"
ports:
  - 3000        # Dev server
  - 8080:8080   # API server
  - 6006        # Storybook
```

### docker.ts Changes

In `buildDockerRunArgs()`, add `-p` flags for each port mapping:

```typescript
for (const port of config.ports) {
  args.push("-p", `127.0.0.1:${port.host}:${port.container}`);
}
```

### cli.ts Changes

Add `-p` / `--port` flag parsing:

```bash
pi-container -p 3000 -p 8080:8080
```

Each `-p` adds to the `ports` array. These are merged with config file ports (CLI takes precedence if there are conflicts — but since each port is independent, they just accumulate).

### Environment Variable

`PI_PORTS` accepts the same format as config:

```bash
PI_PORTS="3000,8080:8080,9000-9010" pi-container
```

### dry-run Output

Update `printDryRun` to show port mappings:

```
Ports:
  3000 → 3000 (localhost)
  8080 → 8080 (localhost)
```

## Port Conflict Detection

Before running Docker, check if configured host ports are available:

```typescript
function checkPortAvailable(port: number): boolean {
  const net = require("net");
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
```

Run this check before `docker run` and report conflicts clearly:

```
Error: Port 3000 is already in use on localhost.
  - Change the host port in .pi-container/config.yml: "3001:3000"
  - Or stop the process using port 3000
```

## Implementation Plan

### Step 1: Config and CLI parsing

1. Add `ports` and `PortMapping` to `config.ts`
2. Parse `PI_PORTS` env var
3. Parse `ports` from `.pi-container/config.yml`
4. Parse `-p` / `--port` CLI flags
5. Add tests for port parsing

### Step 2: Docker integration

1. Add `-p` flags to `buildDockerRunArgs()`
2. Update `docker.test.ts`
3. Update `printDryRun` output

### Step 3: Port conflict check

1. Add `checkPortAvailable()` utility
2. Run before `docker run`
3. Clear error messages on conflict

### Step 4: Documentation

1. Update README with port configuration
2. Add to config.yml schema docs

## Example Usage

```bash
# Expose a dev server
pi-container -p 3000

# Multiple ports
pi-container -p 3000 -p 8080

# Port mapping (host 8080 → container 3000)
pi-container -p 8080:3000

# With config file
# .pi-container/config.yml:
#   ports:
#     - 3000
#     - 6006

pi-container  # Reads ports from config

# Environment variable override
PI_PORTS="3000,6006" pi-container
```

## Open Questions

- **Should we support UDP ports?** → No, web dev is TCP-only. Add later if needed.
- **Should we bind to 0.0.0.0 by default?** → No, localhost-only by default. If someone needs external access, they can configure Docker directly.
- **Should we detect ports from running dev servers?** → No, that would require listening inside the container, which is a different feature. Keep it config-driven.
- **What about `docker compose` compatibility?** → Not relevant since we use `docker run` directly, but we should document the port syntax is similar to Docker's for familiarity.