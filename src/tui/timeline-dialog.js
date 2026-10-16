// Session timeline dialog.
//
// A dialog wrapper around src/tui/timeline.js that makes the timeline
// keyboard-navigable in the chat UI. It mirrors the diff viewer's contract:
// `render(options)` returns ANSI text, and `handleKey(str, key)` returns
// `{done, value}`. Keys: Up/Down move, Home/End (via Up/Down semantics or
// we handle "home"/"end" key names), Enter jump (value carries active node), f
// fork, q/Esc close. For now "f fork" yields `{done:true, value:{fork:true,node}}`
// so the caller can decide how to act; actual forking is left to the session
// command layer (already handled elsewhere if needed).

import { dim } from "../cli/ui.js";
import { buildTimeline, renderTimeline, navigateTimeline, TIMELINE_DIRECTIONS } from "./timeline.js";

export function timelineDialog(sessionEntries, options = {}) {
  const nodes = Array.isArray(sessionEntries) ? sessionEntries : [];
  let timeline = buildTimeline(nodes);
  const height = Number.isInteger(options.height) && options.height > 6 ? options.height : 16;
  const width = Number.isInteger(options.width) && options.width > 40 ? options.width : 80;
  let offset = 0;

  function updateOffset() {
    const h = height - 2; // account for header + footer
    const limit = Math.max(1, h);
    if (timeline.active < 0) {
      offset = 0;
      return;
    }
    if (timeline.active < offset) offset = timeline.active;
    if (timeline.active >= offset + limit) offset = timeline.active - limit + 1;
  }

  updateOffset();

  return {
    type: "timeline",
    get state() {
      return { timeline, offset };
    },

    render() {
      updateOffset();
      const body = renderTimeline(timeline, { width, height: height - 2, offset });
      const active = timeline.nodes[timeline.active];
      const nodeInfo = active
        ? `seq ${active.seq} · ${active.kind}${active.agent ? ` · ${active.agent}` : ""}`
        : "end";
      const hints = dim(`[↑↓]move [home/end]top/bottom [Enter]jump [f]fork [q/Esc]close`);
      return `${body}\n${hints}  ${dim(nodeInfo)}`;
    },

    handleKey(str, key = {}) {
      const name = (key.name || str || "").toLowerCase();
      const ctrl = !!key.ctrl;

      if (ctrl && name === "c") return { done: true, value: null };
      if (name === "q" || name === "escape") return { done: true, value: null };

      if (name === "up") {
        timeline = navigateTimeline(timeline, TIMELINE_DIRECTIONS.UP);
        return { done: false };
      }
      if (name === "down") {
        timeline = navigateTimeline(timeline, TIMELINE_DIRECTIONS.DOWN);
        return { done: false };
      }
      if (name === "home") {
        timeline = navigateTimeline(timeline, TIMELINE_DIRECTIONS.TOP);
        return { done: false };
      }
      if (name === "end") {
        timeline = navigateTimeline(timeline, TIMELINE_DIRECTIONS.BOTTOM);
        return { done: false };
      }

      if (name === "enter" || name === "return") {
        const node = timeline.nodes[timeline.active];
        return node ? { done: true, value: { jump: true, node } } : { done: true, value: null };
      }
      if (name === "f") {
        const node = timeline.nodes[timeline.active];
        return node ? { done: true, value: { fork: true, node } } : { done: false };
      }

      return { done: false };
    },
  };
}

/**
 * Run the interactive timeline viewer. Reuses the shared dialog driver.
 *
 * @param {Array<object>} sessionEntries
 * @param {object} options { input, output, width, height }
 */
export async function runTimeline(sessionEntries, options = {}) {
  const { input, output } = options;
  const width = Number.isInteger(options.width) && options.width > 40 ? options.width : 80;
  const height = Number.isInteger(options.height) && options.height > 10 ? options.height : 20;
  const dialog = timelineDialog(sessionEntries, { width, height });
  const { driveDialog } = await import("./interact.js");
  return driveDialog(dialog, { input, output, width, height });
}

export default { timelineDialog, runTimeline, buildTimeline, renderTimeline, navigateTimeline };
