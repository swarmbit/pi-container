// ============================================================
// token-stats — Token throughput footer for pi
// ============================================================
// Shows cumulative token counts (in/out) and throughput rates
// (tokens/sec) in the pi footer bar.
//
// Toggle: /token-stats
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface TokenCounts {
  input: number;
  output: number;
  cost: number;
}

// Rolling rate tracker
class RateTracker {
  private samples: { time: number; value: number }[] = [];
  private windowMs: number;

  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
  }

  add(timestamp: number, value: number): void {
    this.samples.push({ time: timestamp, value });
    // Prune old samples
    const cutoff = timestamp - this.windowMs;
    this.samples = this.samples.filter((s) => s.time >= cutoff);
  }

  rate(now: number): number {
    if (this.samples.length < 2) return 0;
    const oldest = this.samples[0];
    const latest = this.samples[this.samples.length - 1];
    const dt = (latest.time - oldest.time) / 1000;
    if (dt <= 0) return 0;
    const dv = latest.value - oldest.value;
    return dv / dt;
  }

  reset(): void {
    this.samples = [];
  }
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatRate(n: number): string {
  if (n < 1) return "0";
  if (n < 10_000) return String(Math.round(n));
  return `${(n / 1000).toFixed(1)}k`;
}

export default function (pi: ExtensionAPI) {
  let enabled = false;

  // Cumulative totals for the session
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;

  // Rate tracking during streaming
  let messageStartTime = 0;
  let inputRate = new RateTracker(3000);
  let outputRate = new RateTracker(3000);

  // Snapshot of totals at message start for delta calculation
  let startInput = 0;
  let startOutput = 0;
  let lastKnownOutput = 0;

  pi.registerCommand("token-stats", {
    description: "Toggle token stats footer",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (enabled) {
        recalcTotals(ctx);
        installFooter(ctx);
        ctx.ui.notify("Token stats footer enabled", "info");
      } else {
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("Default footer restored", "info");
      }
    },
  });

  function recalcTotals(ctx: any) {
    totalInput = 0;
    totalOutput = 0;
    totalCost = 0;
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type === "message" && e.message.role === "assistant") {
        const m = e.message as AssistantMessage;
        totalInput += m.usage.input;
        totalOutput += m.usage.output;
        totalCost += m.usage.cost.total;
      }
    }
  }

  function installFooter(ctx: any) {
    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          const model = ctx.model;
          const modelStr = model?.id || "no-model";

          // Token totals
          const tokensStr = `${theme.fg("success", "↑")}${formatTokens(totalInput)} ${theme.fg("accent", "↓")}${formatTokens(totalOutput)}`;

          // Throughput rates (only during streaming)
          const inRate = inputRate.rate(Date.now());
          const outRate = outputRate.rate(Date.now());
          const rateStr = inRate > 0 || outRate > 0
            ? ` ${theme.fg("success", "↑")}${formatRate(inRate)}/s ${theme.fg("accent", "↓")}${formatRate(outRate)}/s`
            : "";

          // Cost
          const costStr = ` $${totalCost.toFixed(3)}`;

          // Branch info
          const branch = footerData.getGitBranch();
          const branchStr = branch ? ` (${branch})` : "";

          const left = `${tokensStr}${rateStr}${costStr}`;
          const right = theme.fg("dim", `${modelStr}${branchStr}`);

          const leftWidth = visibleWidth(left);
          const rightWidth = visibleWidth(right);
          const pad = Math.max(1, width - leftWidth - rightWidth);

          return [truncateToWidth(left + " ".repeat(pad) + right, width)];
        },
      };
    });
  }

  // Track message start for rate calculation
  pi.on("message_start", async (_event, ctx) => {
    if (!enabled) return;
    messageStartTime = Date.now();
    startInput = totalInput;
    startOutput = totalOutput;
    lastKnownOutput = totalOutput;
    inputRate.reset();
    outputRate.reset();
  });

  // Track streaming updates for live throughput
  pi.on("message_update", async (event, ctx) => {
    if (!enabled || event.message.role !== "assistant") return;
    const m = event.message as AssistantMessage;
    const now = Date.now();

    const currentInput = m.usage.input;
    const currentOutput = m.usage.output;

    // Track deltas from message start for rate
    inputRate.add(now, currentInput);
    outputRate.add(now, currentOutput);
    lastKnownOutput = currentOutput;
  });

  // Finalize totals on message end
  pi.on("message_end", async (event, ctx) => {
    if (!enabled) return;
    if (event.message.role !== "assistant") return;

    const m = event.message as AssistantMessage;
    // Accumulate — message_end gives final usage for this message
    totalInput += m.usage.input;
    totalOutput += m.usage.output;
    totalCost += m.usage.cost.total;

    // Clear rates after message completes
    inputRate.reset();
    outputRate.reset();
  });

  // Restore footer on session switch/reload
  pi.on("session_start", async (_event, ctx) => {
    if (!enabled) return;
    recalcTotals(ctx);
    installFooter(ctx);
  });
}