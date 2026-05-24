# pi-container

Run [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) in Docker with team-standard packages, extensions, and settings baked into the image.

## Why

Running pi in Docker ensures every team member uses the same environment — same pi version, same extensions, same safety gates.

`pi-container` makes this simple:

- **CWD-respect mounts**: uses `docker run` directly, so `$(pwd)/` is always mounted as `/<dirname>`
- **One install**: `npm install -g pi-container` works from any directory
- **Project customization**: `.pi-container/` is optional — only needed for team customization

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

# With port forwarding for web dev:
pi-container -p 3000              # expose port 3000
pi-container -p 3000 -p 6006    # expose multiple ports
pi-container -p 8080:3000        # host 8080 → container 3000

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
│  │  /home/pi-user/.pi/                ◄── Host mount           │
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
│  │  /<project-dir>/               ◄── CWD mount           │
│  │    (your project directory)             │             │
│  └─────────────────────────────────────────┘             │
└──────────────────────────────────────────────────────────┘
```

- **Baked into the image**: pi binary (pinned version), team pi package (extensions, themes), default settings
- **Installed on startup**: `pi install /opt/pi-package` registers the team package — extensions, themes, and skills are discovered by pi automatically
- **Additional packages**: third-party packages (from npm, git, or local paths) are installed on startup via `pi install`
- **Mounted from host** (persists across runs): `~/.pi` (settings, auth, sessions, extensions)
- **Mounted from CWD** (your project): mounts `$(pwd)` as `/<dirname>` (e.g., `/myproject`)
- **Port forwarding** (optional): `-p` flags expose container ports on `localhost`

Each invocation creates a fresh container. Multiple instances can run simultaneously (no `--name` collision).

## Configuration

### Zero config

Run `pi-container` from any directory. It uses defaults:

- pi version: `0.75.5`
- image tag: `pi-agent:<version>`
- config dir: `~/.pi`

### Project config: `.pi-container/`

Place a `.pi-container/` directory in your project root to customize:

```
my-project/
├── .pi-container/
│   ├── config.yml                # Optional overrides
│   ├── package/                   # Team pi package (baked into image)
│   │   ├── package.json           # Pi package manifest
│   │   ├── extensions/
│   │   │   └── confirm-dangerous/ # Team extensions
│   │   │       └── index.ts
│   │   └── themes/
│   │       └── github.json       # Team themes
│   └── settings/
│       └── default-settings.json # Default pi settings (theme, etc.)
└── .env                          # API keys (gitignored)
```

#### `.pi-container/package/package.json`

The [pi package](https://github.com/earendil-works/pi-coding-agent) manifest declares what resources the package provides:

```json
{
  "name": "my-team-defaults",
  "version": "1.0.0",
  "private": true,
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "themes": ["./themes"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

Pi convention directories (`extensions/`, `themes/`, `skills/`, `prompts/`) are auto-discovered. You can also add runtime dependencies to `dependencies` — they'll be installed during the Docker build.

#### `.pi-container/config.yml` (optional)

```yaml
piVersion: "0.75.5"
imageTag: "pi-agent:0.75.5"    # Override image tag
ports:                          # Export container ports to localhost
  - 3000                        # Dev server
  - 6006                        # Storybook
  - 8080:80                     # Host 8080 → container 80
packages:                       # Pre-install third-party pi packages
  - npm:@some-team/safety-ext@1.0.0
  - git:github.com/team/repo@v2
```

Packages listed in `config.yml` are passed to `pi install` on container startup. They're installed on first run and cached in `~/.pi` for subsequent runs.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_VERSION` | `0.75.5` | Pi version to install (overrides user & project config) |
| `PI_IMAGE_TAG` | `pi-agent:<version>` | Docker image tag (overrides user & project config) |
| `PI_CONFIG_DIR` | `~/.pi` | Host path for pi config (overrides user & project config) |
| `PI_PORTS` | *(none)* | Comma-separated ports, e.g. `3000,8080:3000,9000-9010` |

### User config: `~/.pi/pi-container.yml`

For personal overrides that apply across all projects:

```yaml
# ~/.pi/pi-container.yml
piVersion: "0.75.4"        # Pin a different version than the team default
imageTag: "my-registry/pi"  # Use a custom registry image
configDir: "~/pi-work"      # Use a different pi config directory
ports:                       # Override ports
  - 3000
```

This file is not committed to git — it's for individual user preferences.

### Config precedence (highest wins)

1. CLI flags (`-p`, `--port`)
2. Environment variables (`PI_VERSION`, `PI_IMAGE_TAG`, `PI_CONFIG_DIR`, `PI_PORTS`)
3. User config (`~/.pi/pi-container.yml`) — personal, not committed
4. Project config (`.pi-container/config.yml`) — team, committed to git
5. Built-in defaults

### API keys

Add API keys to `.env` in your project root:

```bash
cp .env.example .env
# Edit .env with your keys
```

The `.env` file is automatically loaded and passed to the container.

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

### Port forwarding

Expose container ports so you can access web apps from your host machine:

```bash
# CLI flag
pi-container -p 3000                # localhost:3000 → container:3000
pi-container -p 8080:3000           # localhost:8080 → container:3000
pi-container -p 3000 -p 6006       # multiple ports

# Environment variable
PI_PORTS=3000,6006 pi-container
PI_PORTS=3000,8080:3000,9000-9010 pi-container   # ranges supported in env/config

# Config file
# .pi-container/config.yml
ports:
  - 3000
  - 6006
  - 8080:80
```

All ports bind to `127.0.0.1` (localhost only) for security. If a host port is already in use, `pi-container` will report the conflict and exit.

## Safety

The default package includes a safety extension:

- **confirm-dangerous** — Prompts before destructive commands (`rm -rf`, `sudo`, force push, etc.), writes to system paths, and modifications to the pi config directory

## Development

```bash
cd pi-container
npm install
npm run build          # Compile TypeScript to dist/
node dist/cli.js dry-run  # Test config resolution
```

## License

MIT