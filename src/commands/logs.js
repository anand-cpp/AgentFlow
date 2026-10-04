// `aflow logs` — read the structured event log.

import { defineCommand } from "../cli/registry.js";
import { defaultLogPath, readEvents, summarize, formatEvent, LEVELS } from "../core/events.js";
import { bold, dim, heading, table, statusColor } from "../cli/ui.js";

function parseLimit(raw, fallback = 50) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

async function runLogs({ config, out, flags }) {
  const file = flags.file || defaultLogPath();
  const level = LEVELS.includes(flags.level) ? flags.level : null;
  const limit = parseLimit(flags.limit, 50);

  const { events, skipped, missing } = readEvents({
    file,
    limit,
    level,
    since: flags.since || null,
    type: flags.type || null,
  });

  const payload = {
    file,
    missing,
    skipped,
    count: events.length,
    summary: summarize(events),
    events,
  };

  await out.init(payload, (r) => {
    const lines = [];
    lines.push(heading(bold("aflow logs")));

    if (r.missing) {
      lines.push(`no log at ${r.file}`);
      lines.push(dim("events are written once a command runs with a logger attached"));
      return lines.join("\n");
    }

    const s = r.summary;
    lines.push(
      table(
        [
          { k: "file", v: r.file },
          { k: "events", v: String(s.total) },
        ],
        [
          { key: "k", label: "" },
          { key: "v", label: "" },
        ]
      )
    );
    lines.push("");

    if (!r.events.length) {
      lines.push(dim("no events matched"));
      if (r.skipped) lines.push(dim(`${r.skipped} unparseable line(s) skipped`));
      return lines.join("\n");
    }

    for (const ev of r.events) {
      lines.push(`${statusColor(ev.level === "error" ? "error" : ev.level === "warn" ? "warn" : "ok")}  ${formatEvent(ev)}`);
    }

    if (s.byType.length) {
      lines.push("");
      lines.push(bold("by type"));
      lines.push(
        table(
          s.byType.map(([type, n]) => ({ k: type, v: String(n) })),
          [
            { key: "k", label: "event" },
            { key: "v", label: "count", align: "right" },
          ]
        )
      );
    }

    if (r.skipped) lines.push("", dim(`${r.skipped} unparseable line(s) skipped`));
    return lines.join("\n");
  });

  return 0;
}

export const logsCommand = defineCommand("logs", {
  summary: "read the structured event log",
  valueFlags: ["limit", "level", "since", "type", "file"],
  usage: `aflow logs [--limit N] [--level LEVEL] [--since ISO] [--type NAME] [--file PATH]

Reads AgentFlow's append-only JSONL event log. Every routing decision,
tool approval, and provider error is recorded, so you can answer "why did it
do that?" without re-running anything.

  --limit N     most recent N events (default 50; 0 for all)
  --level L     minimum level: ${LEVELS.join(", ")}
  --since ISO   only events at or after this timestamp
  --type NAME   only this event type, e.g. route.decision
  --file PATH   read a specific log file

The log is JSONL: one JSON object per line, greppable with jq.

  aflow logs --type route.fallback --json | jq '.events[].to'`,
  run: runLogs,
});

export default logsCommand;