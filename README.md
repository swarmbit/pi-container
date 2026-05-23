# pi-container

Run [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) in Docker with team-standard extensions, settings, and packages baked into the image.

## Why

Running pi in Docker ensures every team member uses the same environment — same pi version, same extensions, same safety gates. But the previous approach (shell script + docker compose) had problems:

- **CWD bug**: docker compose resolves mounts relative to the compose file, not the caller's directory
- **Per-project boilerplate**: every project needed `docker-compose.yml`, `pi-container.sh`, and `.pi-container/`
- **Not distributable**: teams had to copy-paste the shell script across projects

`pi-container` fixes all of these:

- **CWD-respect mounts**: uses `docker run` directly, so `$(pwd)/` is always `/workspace`
- **One install**: `npm install -g pi-container` works from any directory
- **Project customization**: `.pi-container/` is optional — only needed for team extensions

## Install

```bash
npm install -g pi-container
```

## Usage

```bash
# From any project directory:
cd my-project
pi-container                    # interactive session
pi-container -- -p "Summarize"  # print mode
pi-container -- -r               # resume session

# Management:
pi-container build              # build/rebuild the image
pi-container shell              # open a shell in the container
pi-container dry-run            # print config and docker commands (debugging)

# Override pi version:
PI_VERSION=0.75.4 pi-container
```

## How it works

```
┌──────────────────────────────────────────────────────────┐
│                    Docker Container                       │
│                                                          │
│  ┌─────────────────────────────────────────┐             │
│  │  /opt/pi-extensions/                    │  ◄── Baked  │
│  │    confirm-dangerous/                   │      into   │
│  │    workspace-guard/                     │      image  │
│  └─────────────────────────────────────────┘             │
│         │ symlinked on startup                             │
│         ▼                                                 │
│  ┌─────────────────────────────────────────┐             │
│  │  /home/pi-user/.pi/agent/    ◄── Host mount           │
│  │    ├── settings.json          (shared w/ native pi)    │
│  │    ├── auth.json              (shared w/ native pi)    │
│  │    ├── sessions/              (shared w/ native pi)    │
│  │    ├── extensions/                                     │
│  │    │   └── confirm-dangerous ◄─┘ symlinked from image │
│  │    │   └── workspace-guard   ◄─┘                     │
│  │    ├── npm/                                            │
│  │    └── skills/                                          │
│  └─────────────────────────────────────────┘             │
│                                                          │
│  ┌─────────────────────────────────────────┐             │
│  │  /workspace/                   ◄── CWD mount           │
│  │    (your project directory)             │             │
│  └─────────────────────────────────────────┘             │
└──────────────────────────────────────────────────────────┘
```

- **Baked into the image**: pi binary (pinned version), team extensions, team packages, default settings
- **Mounted from host** (persists across runs): `~/.pi/agent` (settings, auth, sessions, extensions)
- **Mounted from CWD** (your project): always mounts `$(pwd)` as `/workspace`

Each invocation creates a fresh container. Multiple instances can run simultaneously (no `--name` collision).

## Configuration

### Zero config

Run `pi-container` from any directory. It uses defaults:

- pi version: `0.75.5`
- image tag: `pi-agent:<version>`
- config dir: `~/.pi/agent`

### Project config: `.pi-container/`

Place a `.pi-container/` directory in your project root to customize:

```
my-project/
├── .pi-container/
│   ├── config.yml                # Optional overrides
│   ├── extensions/
│   │   └── confirm-dangerous/    # Team extensions (baked into image)
│   │       └── index.ts
│   ├── packages/
│   │   └── package.json          # Team npm packages
│   └── settings/
│       └── default-settings.json # Default pi settings
└── .env                          # API keys (gitignored)
```

#### `.pi-container/config.yml` (optional)

```yaml
piVersion: "0.75.5"
imageTag: "pi-agent:0.75.5"    # Override image tag
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_VERSION` | `0.75.5` | Pi version to install (overrides user & project config) |
| `PI_IMAGE_TAG` | `pi-agent:<version>` | Docker image tag (overrides user & project config) |
| `PI_CONFIG_DIR` | `~/.pi/agent` | Host path for pi config (overrides user & project config) |

### User config: `~/.pi/pi-container.yml`

For personal overrides that apply across all projects:

```yaml
# ~/.pi/pi-container.yml
piVersion: "0.75.4"        # Pin a different version than the team default
imageTag: "my-registry/pi"  # Use a custom registry image
configDir: "~/pi-work"      # Use a different pi config directory
```

This file is not committed to git — it's for individual user preferences.

### Config precedence (highest wins)

1. Environment variables (`PI_VERSION`, `PI_IMAGE_TAG`, `PI_CONFIG_DIR`)
2. User config (`~/.pi/pi-container.yml`) — personal, not committed
3. Project config (`.pi-container/config.yml`) — team, committed to git
4. Built-in defaults

### API keys

Add API keys to `.env` in your project root:

```bash
cp .env.example .env
# Edit .env with your keys
```

The `.env` file is automatically loaded and passed to the container.

## Multiple instances

Each `pi-container` invocation creates a new ephemeral container (`docker run --rm`). Containers don't interfere with each other. The pi config directory (`~/.pi/agent`) is shared on the host, so settings and auth persist across runs.

If you need to run two agents on the same project simultaneously, that's a workflow concern (like two editors on the same files), not a container concern.

## Where config lives

| Host path | Container path | Contents |
|-----------|---------------|----------|
| `$(pwd)` | `/workspace` | Your project (CWD mount) |
| `~/.pi/agent/settings.json` | `/home/pi-user/.pi/agent/settings.json` | Model, thinking level, preferences |
| `~/.pi/agent/auth.json` | `/home/pi-user/.pi/agent/auth.json` | OAuth tokens |
| `~/.pi/agent/sessions/` | `/home/pi-user/.pi/agent/sessions/` | Conversation history |
| `~/.pi/agent/extensions/` | `/home/pi-user/.pi/agent/extensions/` | User + team extensions |
| `~/.pi/pi-container.yml` | *(not mounted)* | User-level pi-container config |

If you use pi both natively and in the container, they share the same config.

## Safety

The baked-in extensions provide baseline protection:

- **confirm-dangerous** — Prompts before destructive commands (`rm -rf`, `sudo`, force push, etc.), writes to system paths, and modifications to the pi config directory
- **workspace-guard** — Adds a system prompt keeping the model inside `/workspace`

## Migrating from the shell script

If you previously used `pi-container.sh` and `docker-compose.yml`:

1. Install `pi-container` globally: `npm install -g pi-container`
2. Keep your `.pi-container/` directory (extensions, packages, settings) — it works as-is
3. Delete `pi-container.sh` and `docker-compose.yml`
4. Run `pi-container` instead of `./pi-container.sh`

The `.pi-container/` directory structure is unchanged. The npm package replaces the shell script and compose file.

## Development

```bash
cd pi-container
npm install
npm run build          # Compile TypeScript to dist/
node dist/cli.js dry-run  # Test config resolution
```

## License

MIT