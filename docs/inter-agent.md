# inter-agent — Bidirectional Communication Between Pi Containers

A protocol for pi coding agents running in separate containers on the same machine to communicate, enabling a higher-capability model to delegate tasks to a cheaper model and synthesize results.

## Problem

When using a powerful (expensive) model for complex tasks, much of the work is routine — listing files, reading boilerplate, summarizing output. A cheaper model can handle these tasks, but currently each pi instance is isolated. There's no way for one agent to ask another for information.

The goal: a **supervisor agent** (expensive model) delegates research and synthesis to a **worker agent** (cheap model), getting back concise results that save context window tokens.

## Architecture

```
┌──────────────────────────────┐      ┌──────────────────────────────┐
│  Container: supervisor        │      │  Container: worker            │
│                              │      │                              │
│  ┌────────────────────────┐  │      │  ┌────────────────────────┐  │
│  │  pi + inter-agent ext   │  │      │  │  pi + inter-agent ext   │  │
│  │                        │  │      │  │                        │  │
│  │  Role: supervisor      │──┼──┐   │  │  Role: worker           │  │
│  │  - Sends tasks         │  │  │   │  │  - Receives tasks      │  │
│  │  - Synthesizes results │  │  │   │  │  - Returns summaries   │  │
│  └────────────────────────┘  │  │   │  └────────────────────────┘  │
│                              │  │   │                              │
└──────────────────────────────┘  │   └──────────────────────────────┘
                                  │
                          ┌───────┴────────┐
                          │  Unix Socket    │
                          │  /tmp/pi-agent/ │
                          │  supervisor.sock│
                          │  worker.sock     │
                          └─────────────────┘
```

## Communication Protocol

### Transport: Unix Domain Sockets

Why Unix sockets over alternatives:

| Transport | Pros | Cons |
|-----------|------|------|
| **Unix sockets** | Fast, no network overhead, filesystem permissions, works across containers with mounted volume | Requires shared volume for socket files |
| TCP localhost | Works without shared volume | Port management, no built-in auth, containers may have different loopback |
| Named pipes | Simple | Unidirectional, no multiplexing |
| File-based IPC | Dead simple | Polling latency, no real-time |

**Decision: Unix sockets on a shared volume** (`/tmp/pi-agent/`), which is mounted into all pi-containers that need to communicate.

### Socket Location

The socket directory must be accessible from all containers. We mount a host directory:

```
Host:   ~/.pi/agent/sockets/    → mounted into every container at /tmp/pi-agent/
```

This is small, ephemeral, and cleaned up on container exit.

### Message Format

JSON-delimited messages over the socket, each message on a single line (JSONL):

```typescript
// Task from supervisor to worker
interface TaskMessage {
  type: "task";
  id: string;              // UUID
  from: string;            // "supervisor" | agent name
  to: string;              // "worker" | agent name
  prompt: string;          // The task description
  context?: string;        // Optional context the worker should know
  priority: "low" | "normal" | "high";
  replyTo: string;         // Socket path to send response to
}

// Worker acknowledges receiving the task
interface AckMessage {
  type: "ack";
  taskId: string;
}

// Result from worker to supervisor
interface ResultMessage {
  type: "result";
  taskId: string;
  status: "success" | "error" | "partial";
  content: string;         // The worker's response
  tokensUsed: {            // Token accounting
    input: number;
    output: number;
    cost: number;
  };
}

// Heartbeat keep-alive
interface HeartbeatMessage {
  type: "heartbeat";
  agentId: string;
  role: "supervisor" | "worker" | "peer";
  model: string;           // Current model
  status: "idle" | "busy";
}
```

### Connection Lifecycle

```
1. Container starts, extension loads
2. Extension creates its socket at /tmp/pi-agent/<name>.sock
3. Extension broadcasts heartbeat to discover peers
4. Supervisor sends TaskMessage to worker socket
5. Worker acks, processes task using its pi instance
6. Worker sends ResultMessage back to supervisor's socket
7. Supervisor receives result, injects into its context
```

## Extension Design

### Two Modes

The extension runs in one of two modes, configured per container:

```yaml
# .pi-container/config.yml
interAgent:
  role: "supervisor"       # "supervisor" | "worker" | "peer"
  name: "supervisor"       # Unique name for this agent
  workers:                 # For supervisor: known workers
    - name: "worker"
      model: "deepseek-chat"
  socketDir: "/tmp/pi-agent"  # Shared socket directory
```

**Supervisor mode:**
- Registers a `delegate` tool that the LLM can call
- Sends tasks to workers via their socket
- Receives results and injects them into the conversation
- Manages worker health via heartbeats

**Worker mode:**
- Listens on its socket for task messages
- Processes tasks by sending them to its own pi instance (as a user message)
- Returns results to the supervisor
- Reports model and token usage back

**Peer mode (future):**
- Both agents can send and receive tasks
- Useful for multi-agent collaboration where neither is clearly superior

### Custom Tool: `delegate`

The supervisor gets a new tool:

```typescript
pi.registerTool({
  name: "delegate",
  label: "Delegate to Worker",
  description: "Send a task to a worker agent for research or summarization. Use this to get information from a cheaper model without using your own context window.",
  parameters: Type.Object({
    task: Type.String({ description: "The task to delegate" }),
    context: Type.Optional(Type.String({ description: "Additional context for the worker" })),
    worker: Type.Optional(Type.String({ description: "Worker name (default: first available)" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 1. Find worker socket
    // 2. Send TaskMessage
    // 3. Wait for ResultMessage (with abort signal)
    // 4. Return result to supervisor's LLM
    return {
      content: [{ type: "text", text: result.content }],
      details: { tokensUsed: result.tokensUsed },
    };
  },
});
```

### Worker Task Processing

When a worker receives a task:

1. **`tool_call` event handler** — Actually, workers receive tasks over the socket, not via the LLM. So the extension:
   - Receives a `TaskMessage` on its socket
   - Sends the task as a user message to its own pi instance: `pi.sendUserMessage(taskPrompt, { deliverAs: "steer" })`
   - Captures the response via `message_end` event
   - Sends a `ResultMessage` back to the supervisor

2. **Capturing the response** — The worker needs to capture the LLM's response to the delegated task. This can be done with:
   - `turn_end` / `agent_end` events — watch for the response after injecting the message
   - The extension stores a pending task and resolves it when the agent finishes

```typescript
// Worker-side handler
pi.on("agent_end", async (event, ctx) => {
  const pendingTask = currentTask;
  if (!pendingTask) return;

  // Collect all assistant messages from this turn
  const response = event.messages
    .filter(m => m.role === "assistant")
    .map(m => m.content.map(c => c.type === "text" ? c.text : "").join(""))
    .join("\n");

  // Send result back to supervisor
  const result: ResultMessage = {
    type: "result",
    taskId: pendingTask.id,
    status: "success",
    content: response,
    tokensUsed: extractTokenUsage(event.messages),
  };

  sendToSocket(pendingTask.replyTo, result);
  currentTask = null;
});
```

### Supervisor Result Injection

When the supervisor receives a result:

```typescript
// Supervisor-side: result handler receives via socket
pi.on("message_end", ...)  // or direct injection via socket handler

// The `delegate` tool already returned the result to the LLM
// so no additional injection is needed — the tool result is
// automatically part of the conversation.
```

### Events Used

| Event | Role | Purpose |
|-------|------|---------|
| `session_start` | Both | Initialize socket, discover peers |
| `agent_end` | Worker | Capture completed task response |
| `message_end` | Both | Track token usage |
| `tool_call` | Supervisor | The `delegate` tool sends tasks |

### File Structure

```
.pi-container/extensions/inter-agent/
├── index.ts           # Extension entry, mode selection, event wiring
├── socket.ts          # Unix socket server/client
├── protocol.ts        # Message types (Task, Result, Ack, Heartbeat)
├── supervisor.ts      # Supervisor logic (delegate tool, result handling)
├── worker.ts          # Worker logic (task processing, response capture)
└── package.json
```

### Docker / pi-container Integration

The socket directory needs to be shared between containers. Update `docker.ts`:

```typescript
// In buildDockerRunArgs:
if (config.socketDir) {
  args.push("-v", `${config.socketDir}:/tmp/pi-agent`);
}
```

And in `.pi-container/config.yml`:

```yaml
interAgent:
  role: "supervisor"
  name: "supervisor"
  socketDir: "~/.pi/agent/sockets"
```

The `pi-container` CLI would create `~/.pi/agent/sockets/` on the host and mount it into all containers.

### Security Considerations

- **Filesystem permissions**: Unix sockets use filesystem permissions. Only containers with the mounted volume can communicate.
- **No network exposure**: Sockets are local-only, never exposed to the network.
- **Task validation**: Workers should validate task messages (schema check) before executing.
- **Timeout**: Tasks must have a timeout to prevent workers from hanging indefinitely.
- **Abort propagation**: If the supervisor cancels (Esc), the abort should propagate to the worker.

## Implementation Plan

### Phase 1: Foundation

1. `protocol.ts` — Message types and serialization
2. `socket.ts` — Unix socket server (listen) and client (connect/send)
3. `index.ts` — Extension skeleton with config loading and mode selection

### Phase 2: Worker Mode

1. Accept task messages on socket
2. Process with local pi instance via `pi.sendUserMessage()`
3. Capture response via `agent_end` event
4. Send `ResultMessage` back to supervisor

### Phase 3: Supervisor Mode

1. Register `delegate` tool
2. Send `TaskMessage` to worker socket
3. Wait for `ResultMessage`
4. Return result to LLM

### Phase 4: pi-container Integration

1. Add socket directory config to `config.yml`
2. Update `docker.ts` to mount socket volume
3. Update `pi-container` CLI to manage the socket directory

### Phase 5: Advanced

1. Heartbeat and peer discovery
2. Worker pool (multiple workers, load balancing)
3. Task queuing and priority
4. Context budget management (supervisor tells worker its token limit)

## Open Questions

- **Should workers be able to call `delegate` themselves (recursive delegation)?** → No in v1. Workers should process tasks directly. Recursive delegation creates complex failure modes.
- **What if the supervisor's context window fills up while waiting for a worker?** → The `delegate` tool should stream progress updates via `onUpdate`, and the supervisor can compact if needed.
- **Should results be stored in the session?** → Yes, via `pi.appendEntry()` with a custom type, so they persist across compaction.
- **What about multiple supervisors?** → In v1, one supervisor per socket directory. Future: namespaced sockets.