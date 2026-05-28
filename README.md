# pi-container

Run [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) in Docker with a safety extension and default settings baked into the image.

## Why

Running pi in Docker ensures every team member uses the same environment — same pi version, same safety gates.

`pi-container` makes this simple:

- **CWD-respect mounts**: uses `docker run` directly, so `$(pwd)/` is always mounted as `/<dirname>`
- **One install**: `npm install -g pi-container` works from any directory
- **Baked-in defaults**: safety extension, github theme, and sensible settings — no setup required
- **Port forwarding**: expose container ports for web dev with `-p`

## Install

### From npm (recommended)

```bash
npm install -g pi-container
```

### From source

```bash
git clone https://github.com/your-org/pi-container.git
cd pi-container

# Required dependencies:
#   - Node.js >= 22  (runtime + TypeScript compilation)
#   - Docker         (build and run containers)
#   - npm            (package manager)

npm install        # install TypeScript, vitest, and runtime deps
npm run build      # compile TypeScript → dist/

# Run directly (during development):
node dist/cli.js

# Or install globally from the local checkout:
npm install -g .
pi-container build

# Alternatively, use the quick-install script:
./install.sh       # build, uninstall old, install globally, build image
```

## Usage

```bash
# From any project directory:
cd my-project
pi-container                    # interactive session
pi-container -- -p "Summarize"  # print mode
pi-container -- -r              # resume session

# With port forwarding for web dev:
pi-container -p 3000              # expose port 3000
pi-container -p 3000 -p 6006    # expose multiple ports
pi-container -p 8080:3000        # host 8080 → container 3000

# Management:
pi-container build              # build/rebuild the image
pi-container shell              # open a shell in a new container
pi-container shell <id>         # exec into an existing container
pi-container dry-run            # print config and docker commands (debugging)
```

## How it works

```
┌──────────────────────────────────────────────────────────┐
│                    Docker Container                       │
│                                                          │
│  ┌─────────────────────────────────────────┐             │
│  │  /opt/pi-package/                       │  ◄── Baked  │
│  │    ├── package.json                      │      into   │
│  │    ├── extensions/                       │      image  │
│  │    │   └── confirm-dangerous/           │             │
│  │    └── themes/                          │             │
│  │        └── github.json                  │             │
│  └─────────────────────────────────────────┘             │
│         │                                                  │
│         │ pi install /opt/pi-package                      │
│         │ (registers extensions, themes in settings)      │
│         ▼                                                  │
│  ┌─────────────────────────────────────────┐             │
│  │  /home/pi-user/.pi/                ◄── Host mount     │
│  │    └── agent/                         │             │
│  │        ├── settings.json   (shared w/ native pi)    │
│  │        ├── auth.json       (shared w/ native pi)    │
│  │        ├── sessions/        (shared w/ native pi)    │
│  │        ├── extensions/                             │
│  │        ├── npm/                                    │
│  │        └── skills/                                  │
│  └─────────────────────────────────────────┘             │
│                                                          │
│  ┌─────────────────────────────────────────┐             │
│  │  /<project-dir>/               ◄── CWD mount         │
│  │    (your project directory)             │             │
│  └─────────────────────────────────────────┘             │
└──────────────────────────────────────────────────────────┘
```

- **Baked into the image**: pi binary (pinned version), default pi package (safety extension, github theme), default settings
- **Installed on startup**: `pi install /opt/pi-package` registers the built-in package — extensions and themes are discovered by pi automatically
- **Additional packages**: use `pi install` inside the container to add packages at runtime
- **Mounted from host** (persists across runs): `~/.pi` (settings, auth, sessions, extensions)
- **Mounted from CWD** (your project): mounts `$(pwd)` as `/<dirname>` (e.g., `/myproject`)
- **Port forwarding** (optional): `-p` flags expose container ports on `localhost`

Each invocation creates a fresh container. Multiple instances can run simultaneously (no `--name` collision).

## Configuration

Pi-container reads config from two files (both in YAML format) and CLI flags. All settings are optional — zero config works out of the box.

### Config files

| File | Purpose | Committed? |
|------|---------|------------|
| `.pi/pi-container.yml` | Project-level defaults (team-shared) | Yes |
| `~/.pi/pi-container.yml` | Personal overrides (all projects) | No |

### Precedence (highest wins)

1. CLI flags (`-p`, `--port`)
2. User config (`~/.pi/pi-container.yml`)
3. Project config (`.pi/pi-container.yml`)

For `env` and `mounts`, user config entries are merged with project config. For `env`, user keys override project keys with the same name; for `mounts`, user mounts override project mounts on matching container paths, and add new mounts for different paths.

---

### Full config reference

Here is every supported key in a `pi-container.yml` file:

```yaml
# ── Ports ──────────────────────────────────────────────────
# Expose container ports on localhost so you can access web
# apps running inside the container (dev servers, Storybook,
# etc.) from your browser. All formats supported:
ports:
  - 3000            # localhost:3000 → container:3000
  - 8080:80         # localhost:8080 → container:80
  - 9000-9010       # port range — expands to 11 entries

# ── Custom mounts ─────────────────────────────────────────
# Mount arbitrary host paths into the container. Useful for
# Docker socket, SSH keys, caches, etc. Format:
#   HOST_PATH:CONTAINER_PATH[:MODE]
#   Mode is optional (default: read-write). Common modes: ro, rw, cached.
# User mounts override project mounts on matching container paths,
# and add new mounts for different paths.
mounts:
  - /var/run/docker.sock:/var/run/docker.sock  # Docker-out-of-Docker
  - ~/.ssh:/home/pi-user/.ssh:ro  # SSH keys (read-only)

# ── Environment variables ──────────────────────────────────
# Inject environment variables into the container at runtime.
# Useful for passing API keys, feature flags, or other config
# that pi or your project needs. These are set via docker -e.
env:
  CUSTOM_VAR: some-value
  NODE_ENV: development

# ── Dockerfile extension ───────────────────────────────────
# Inject extra RUN / COPY / ENV steps into the Docker image
# at build time. Use this to install system packages or tools
# that pi needs (python3, ffmpeg, etc.). After changing this,
# rebuild the image with `pi-container build`.
dockerfileExtension: |
  RUN apt-get update && apt-get install -y python3 pip
  ENV PYTHONUNBUFFERED=1

# ── Git user identity ──────────────────────────────────────
# Set the Git author name and email for commits made inside
# the container. If not set, pi-container infers them from
# your host git config (git config user.name / user.email).
# Precedence: project config > user config > host git config.
gitUserName: John Doe
gitUserEmail: john@example.com
```

> **Important:** After changing `dockerfileExtension` or updating pi-container,
> you must rebuild the image with `pi-container build`. The image is not
> rebuilt automatically on each run — it's only built when it doesn't exist yet.

### Settings reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `ports` | `list` | `[]` | Container ports to expose on `127.0.0.1`. Accepts simple ports (`3000`), host:container mappings (`8080:80`), and ranges (`9000-9010`). Useful for dev servers, Storybook, etc. |
| `mounts` | `list` | `[]` | Custom host-to-container volume mounts. Each entry is a string in `HOST:CONTAINER[:MODE]` format (e.g., `/var/run/docker.sock:/var/run/docker.sock` or `~/.ssh:/home/pi-user/.ssh:ro`). User mounts override project mounts on matching container paths. |
| `env` | `map` | `{}` | Key-value pairs injected as environment variables into the container via `docker run -e`. User config overrides project config per-key. |
| `dockerfileExtension` | `string` | — | Arbitrary Dockerfile content appended during `pi-container build`. Use it to install extra system packages (`python3`, `ffmpeg`, etc.) or set image-level `ENV` vars. Requires a manual rebuild to take effect. |
| `gitUserName` | `string` | *(host git config)* | Git author name for commits made inside the container. Falls back to `git config user.name` from the host if not set. |
| `gitUserEmail` | `string` | *(host git config)* | Git author email for commits made inside the container. Falls back to `git config user.email` from the host if not set. |

### CLI flags

| Flag | Description |
|------|-------------|
| `-p`, `--port PORT` | Publish a container port on localhost (repeatable). Formats: `3000` or `8080:3000`. Port ranges are not supported via CLI — use the config file. |
| `--debug`, `-d` | Enable debug logging. Prints resolved config, docker commands, and container output to stderr. |

### Commands

| Command | Description |
|---------|-------------|
| *(default)* | Run pi interactively in a new container |
| `build` | Build or rebuild the Docker image. Run this after changing `dockerfileExtension` or updating pi-container. |
| `shell` | Open a bash shell in a new container (useful for debugging or running arbitrary commands) |
| `shell <id>` | Exec into an existing running container by ID or name. The container must be running and must have been created by pi-container. |
| `dry-run` | Print the resolved config and the docker commands that would run, without executing anything. Useful for debugging config resolution. |

### Port details

All ports bind to `127.0.0.1` (localhost only) for security. Ranges (`9000-9010`) are supported in config files but not via CLI flags. If a host port is already in use, `pi-container` will report the conflict and exit.

### Example: full project config

```yaml
# .pi/pi-container.yml — committed to git, shared by the team
ports:
  - 3000            # Next.js dev server
  - 6006            # Storybook
  - 8080:80         # Reverse proxy

mounts:
  - /var/run/docker.sock:/var/run/docker.sock  # Docker access

env:
  NODE_ENV: development
  CUSTOM_API_URL: https://api.example.com

dockerfileExtension: |
  RUN apt-get update && apt-get install -y python3

gitUserName: Team Bot
gitUserEmail: bot@example.com
```

After adding `dockerfileExtension`, rebuild the image:

```bash
pi-container build
```

### Example: personal override

```yaml
# ~/.pi/pi-container.yml — not committed, personal overrides
ports:
  - 3000            # also expose port 3000 everywhere

env:
  CUSTOM_VAR: personal-value
```

## Multiple instances

Each `pi-container` invocation creates a new ephemeral container (`docker run --rm`). Containers don't interfere with each other. The pi config directory (`~/.pi`) is shared on the host, so settings and auth persist across runs.

If you need to run two agents on the same project simultaneously, that's a workflow concern (like two editors on the same files), not a container concern.

## Where config lives

| Host path | Container path | Contents |
|-----------|---------------|----------|
| `$(pwd)` | `/<basename>` | Your project (CWD mount, named after directory) |
| `~/.pi` | `/home/pi-user/.pi` | Full pi config (mounted) |
| `~/.pi/agent/settings.json` | `/home/pi-user/.pi/agent/settings.json` | Model, thinking level, preferences |
| `~/.pi/agent/auth.json` | `/home/pi-user/.pi/agent/auth.json` | OAuth tokens |
| `~/.pi/agent/sessions/` | `/home/pi-user/.pi/agent/sessions/` | Conversation history |
| `~/.pi/agent/extensions/` | `/home/pi-user/.pi/agent/extensions/` | User extensions |
| `~/.pi/agent/npm/` | `/home/pi-user/.pi/agent/npm/` | Installed package data |
| `~/.pi/pi-container.yml` | *(not mounted)* | User-level pi-container config |

If you use pi both natively and in the container, they share the same config.

## Safety

The default package includes a safety extension:

- **confirm-dangerous** — Prompts before destructive commands (`rm -rf`, `sudo`, force push, etc.), writes to system paths, and modifications to the pi config directory

## Development

```bash
cd pi-container
npm install
npm run build          # Compile TypeScript to dist/
npm test               # Run tests
node dist/cli.js dry-run  # Test config resolution
```

## License

MIT
