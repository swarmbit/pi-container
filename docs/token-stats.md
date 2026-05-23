# token-stats — Token Throughput Footer

Show token counts and throughput rates in pi's footer bar.

## Problem

Pi's default footer shows working directory, session name, total tokens, cost, context usage, and model. But it doesn't show **token throughput rates** (tokens/second) or a **per-prompt breakdown** of tokens in vs. tokens out. When you're optimizing for cost or latency, these numbers matter.

## What to Display

| Metric | Description |
|--------|-------------|
| `↑ tokens in` | Total input tokens for the current session |
| `↓ tokens out` | Total output tokens for the current session |
| `↑/s` | Input tokens per second (during active streaming) |
| `↓/s` | Output tokens per second (during active streaming) |
| `$cost` | Total cost so far |

Example footer line:

```
↑12.4k ↓3.2k  ↑842/s ↓127/s  $0.042  │  claude-sonnet-4-20250514
```

## Extension Design

### Data Sources

The pi extension API provides all the data we need:

| Source | What it gives |
|--------|---------------|
| `message_update` event | Streaming token-by-token updates with `assistantMessageEvent` containing usage deltas |
| `message_end` event | Final message with `usage.inputTokens`, `usage.outputTokens`, `usage.cost` |
| `ctx.sessionManager.getBranch()` | Historical messages with cumulative usage |
| `ctx.model` | Current model info |

### Throughput Calculation

We need tokens/second. The cleanest approach:

1. **On `message_start`** — record the timestamp and cumulative input/output tokens
2. **On `message_update`** — track streaming output tokens with timestamps. We can calculate instantaneous throughput from the delta between updates, but a rolling average is more stable:

```
output_rate = Δtokens / Δtime  (rolling window of last 2-5 seconds)
```

3. **On `message_end`** — final totals, calculate average throughput for the whole message
4. **When idle** — show cumulative totals, zero out the rate display

### Footer Layout

Using `ctx.ui.setFooter()`, we replace the default footer with a custom one that includes throughput:

```
┌──────────────────────────────────────────────────────────────┐
│ ↑12.4k ↓3.2k  ↑842/s ↓127/s  $0.042 │ claude-sonnet-4... │
└──────────────────────────────────────────────────────────────┘
```

Left section: token stats. Right section: model info. Padding between them.

### Events Used

| Event | Purpose |
|-------|---------|
| `session_start` | Initialize counters, install footer |
| `message_start` | Record start time and baseline tokens |
| `message_update` | Update throughput rate (rolling window) |
| `message_end` | Update cumulative totals, clear rate |
| `model_select` | Update model display in footer |

### File Structure

```
.pi-container/extensions/token-stats/
├── index.ts          # Main extension, event wiring
└── package.json
```

This is a single-file extension. No need for a multi-file structure.

### Implementation Sketch

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  let enabled = false;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;

  // Throughput tracking
  let messageStartTime = 0;
  let messageInputTokens = 0;
  let messageOutputTokens = 0;
  let rateInput = 0;   // tokens/sec rolling average
  let rateOutput = 0;
  let lastRateTime = 0;
  let lastRateOutputTokens = 0;

  pi.registerCommand("token-stats", {
    description: "Toggle token stats footer",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (enabled) {
        // Calculate initial totals from existing session
        recalcTotals(ctx);
        installFooter(ctx);
        ctx.ui.notify("Token stats footer enabled", "info");
      } else {
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("Default footer restored", "info");
      }
    },
  });

  pi.on("message_start", async (event, ctx) => {
    if (!enabled) return;
    messageStartTime = Date.now();
    messageInputTokens = 0;
    messageOutputTokens = 0;
    lastRateTime = Date.now();
    lastRateOutputTokens = 0;
  });

  pi.on("message_update", async (event, ctx) => {
    if (!enabled) return;
    // Update rolling throughput from the streaming event
    // event.assistantMessageEvent has partial token info
    // We calculate rate from deltas since last measurement
    const now = Date.now();
    const elapsed = (now - lastRateTime) / 1000;
    if (elapsed > 0.5) {  // Update every 500ms
      // ... calculate rate from delta tokens / delta time
      // ... requestRender via footer handle
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (!enabled) return;
    const m = event.message;
    if (m.role === "assistant") {
      const usage = (m as AssistantMessage).usage;
      totalInput += usage.input;
      totalOutput += usage.output;
      totalCost += usage.cost.total;
    }
    rateInput = 0;
    rateOutput = 0;
  });

  // ... installFooter implementation using ctx.ui.setFooter()
}

function recalcTotals(ctx: any) {
  // Walk session branch to sum up all assistant message usage
}

function installFooter(ctx: any) {
  // ctx.ui.setFooter((tui, theme, footerData) => { ... })
  // Render: ↑{totalInput} ↓{totalOutput} ↑{rateInput}/s ↓{rateOutput}/s ${cost}
}
```

### Number Formatting

| Range | Format | Example |
|-------|--------|---------|
| < 1000 | Raw number | `842` |
| 1k–999k | `X.Xk` | `12.4k` |
| 1M+ | `X.XM` | `1.2M` |

Rates: always show as raw tokens/sec up to 9999, then `X.Xk/s`.

### Open Questions

- **Should this be a toggle command or always-on?** → Toggle via `/token-stats`, default off. Users who want it always-on can add it to their settings.
- **Cache tokens?** → The `usage` object from pi includes cache read/write tokens. We could show `↑12.4k (8.2k cached)` but that might be too detailed for the footer. Start simple.
- **Per-prompt or cumulative?** → Cumulative for the session. Per-prompt could be a `/token-stats` command that shows a detailed breakdown.