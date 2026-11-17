// Neural Flowline — live model routing pipeline visualization.
//
// Shows: USER → ROUTER → PROVIDER → MODEL → TOOLS → RESULT
// Uses real routing events from AgentFlow's router and provider health.
// Never simulates model health or execution activity.

import { paintToken } from "./theme-engine.js";
import { bold, dim, width, truncate } from "../cli/ui.js";

/** Pipeline node definitions with semantic color tokens. */
export const PIPELINE_NODES = [
  { key: "user", label: "USER", token: "userMessage" },
  { key: "router", label: "ROUTER", token: "accentSecondary" },
  { key: "provider", label: "PROVIDER", token: "flowlineIdle" },
  { key: "model", label: "MODEL", token: "assistantMessage" },
  { key: "tools", label: "TOOLS", token: "toolPending" },
  { key: "result", label: "RESULT", token: "success" },
];

/** Arrow glyph between nodes. */
const ARROW = "→";

/**
 * Render the flowline as a horizontal pipeline.
 *
 * @param {object} state   { currentNode, provider, model, latency, health, toolCalls, result }
 * @param {object} opts    { w }
 * @returns {string}
 */
export function renderFlowline(state = {}, opts = {}) {
  const { w = 60 } = opts;
  const lines = [];

  lines.push(paintToken("Neural Flowline — Live Routing Pipeline", "accent", "bold"));
  lines.push("");

  const nodes = [...PIPELINE_NODES];
  const totalWidth = nodes.length * 3 + (nodes.length - 1) * ARROW.length;
  const available = w - 4;

  // Build the pipeline line
  let pipeline = "";
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const isActive = state.currentNode === node.key;
    const nodePaint = paintToken(node.label, isActive ? "accent" : node.token, isActive ? "bold" : "");

    if (i > 0) {
      const arrowPaint = paintToken(ARROW, "mutedText");
      pipeline += arrowPaint;
    }
    pipeline += nodePaint;
  }

  lines.push(pipeline);
  lines.push("");

  // Details line
  const details = [];
  if (state.provider) {
    details.push(`provider: ${paintToken(state.provider, "accentSecondary")}`);
  }
  if (state.model) {
    details.push(`model: ${paintToken(state.model, "assistantMessage")}`);
  }
  if (state.latency !== undefined) {
    details.push(`latency: ${paintToken(state.latency + "ms", "mutedText")}`);
  }
  if (state.health) {
    details.push(`health: ${paintToken(state.health, "mutedText")}`);
  }
  if (state.toolCalls !== undefined) {
    details.push(`tools: ${paintToken(state.toolCalls.toString(), "toolPending")}`);
  }

  if (details.length > 0) {
    lines.push(details.join("  "));
  }

  // Current status
  if (state.currentNode) {
    const activeNode = nodes.find((n) => n.key === state.currentNode);
    if (activeNode) {
      lines.push(`active: ${paintToken(activeNode.label, "accent", "bold")}`);
    }
  }

  if (state.result) {
    lines.push(`result: ${paintToken(state.result, "success")}`);
  }

  if (lines.length <= 2) {
    lines.push(dim("Waiting for routing activity…"));
  }

  return lines.join("\n");
}
