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

```bash
npm install -g pi-container
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
pi-container shell              # open a shell in the container
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

The only configurable setting is **ports**. Pi version and image are determined by the pi-container npm package you have installed.

### Zero config

Run `pi-container` from any directory. No configuration needed.

### Port forwarding

Expose container ports so you can access web apps from your host machine:

```bash
# CLI flag
pi-container -p 3000                # localhost:3000 → container:3000
pi-container -p 8080:3000           # localhost:8080 → container:3000
pi-container -p 3000 -p 6006       # multiple ports

# Config file — .pi/pi-container.yml
ports:
  - 3000
  - 6006
  - 8080:80

# Config file — ~/.pi/pi-container.yml
ports:
  - 3000
```

All ports bind to `127.0.0.1` (localhost only) for security. If a host port is already in use, `pi-container` will report the conflict and exit.

### Project config: `.pi/pi-container.yml`

Place a `.pi/` directory in your project root for team-shared port configuration:

```yaml
# .pi/pi-container.yml
ports:
  - 3000        # dev server
  - 6006        # storybook
  - 8080:80     # host 8080 → container 80
```

This file is committed to git — it's for team defaults.

### User config: `~/.pi/pi-container.yml`

For personal port overrides that apply across all projects:

```yaml
# ~/.pi/pi-container.yml
ports:
  - 3000
```

This file is not committed to git — it's for individual user preferences.

### Config precedence for ports (highest wins)

1. CLI flags (`-p`, `--port`)
2. User config (`~/.pi/pi-container.yml`) — personal, not committed
3. Project config (`.pi/pi-container.yml`) — team, committed to git

### API keys

Add API keys to `.pi-container-env` in your project root:

```bash
cp .pi-container-env.example .pi-container-env
# Edit .pi-container-env with your keys
```

The `.pi-container-env` file is automatically loaded and passed to the container.

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
