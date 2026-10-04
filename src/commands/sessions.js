// `aflow sessions` — persistent sessions.
//
// Sessions are how AgentFlow remembers anything between invocations. Without
// them every command starts from zero: an agent that investigated something in
// the last run has to re-derive it in this one. This command is the human-facing
// surface over src/core/sessions.js.
//
// The subcommand set is intentionally small and verb-shaped:
//
//   aflow sessions                     list
//   aflow sessions new "objective"     start one, scoped to this directory
//   aflow sessions resume [<id>]       make one current and print its context
//   aflow sessions current             show the current one
//   aflow sessions inspect <id>        full detail, including entries
//   aflow sessions rename <id> <name>  relabel it
//   aflow sessions note <id> <text>    append a progress note
//   aflow sessions done <id>           mark it complete
//   aflow sessions archive <id>        hide it from the default listing
//
// `resume` with no id resumes the current session, so an agent that already knows
// it has somewhere to be does not have to look the id up first.
//
// Errors from the store (not found, corrupt) are allowed to propagate: the CLI
// router already renders `<command>: <message>` with the error code and exit 1,
// which is what those cases want. Only *usage* mistakes are handled here, with
// exit 2.

import path from "node:path";
import process from "node:process";
import { defineCommand } from "../cli/registry.js";
import {
  SessionStore,
  ENTRY_KIND,
  SESSION_STATE,
  defaultSessionsDir,
} from "../core/sessions.js";
import { bold, dim, heading, table, statusColor, truncate, green, yellow, cyan, red } from "../cli/ui.js";

const USAGE_ERROR = 2;

function parseCount(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function splitList(raw) {
  if (raw === undefined || raw === null || raw === true) return [];
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `2026-10-04T07:15:30.000Z` -> `10-04 07:15`, which is enough to place an event. */
function shortTime(iso) {
  if (!iso) return "-";
  return String(iso).slice(5, 16).replace("T", " ");
}

function relative(iso) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${Math.max(secs, 0)}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function storeFor(flags) {
  // A store per invocation, pointed at the state directory. Passing the flag
  // through lets tests and experiments work against a scratch directory without
  // touching a real user's sessions.
  return new SessionStore(flags["state-dir"] ? { dir: String(flags["state-dir"]) } : {});
}

function usage(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}

/** Header block shared by resume/inspect so both read identically. */
function renderHeader(s, current) {
  const lines = [];
  lines.push(
    table(
      [
        { k: "id", v: s.id },
        { k: "name", v: s.name },
        { k: "state", v: s.state === SESSION_STATE.COMPLETED ? green("completed") : cyan("active") },
        { k: "updated", v: `${shortTime(s.updatedAt)} ${dim(relative(s.updatedAt))}` },
        { k: "project", v: s.project ? s.project.root : dim("(none)") },
        { k: "objective", v: s.objective ? truncate(s.objective, 70) : dim("(none)") },
        { k: "model", v: s.model || dim("(none)") },
        { k: "agents", v: s.agents.length ? s.agents.join(", ") : dim("(none)") },
        {
          k: "entries",
          v: `${s.counters.entries}${
            s.counters.dropped ? yellow(` (${s.counters.dropped} trimmed)`) : ""
          }  ${dim(`conv ${s.counters.conversation} · tools ${s.counters.toolCalls} · errors ${s.counters.errors}`)}`,
        },
      ],
      [
        { key: "k", label: "" },
        { key: "v", label: "" },
      ]
    )
  );

  if (current) lines.push("", dim(`current session (resume any time with: aflow sessions resume ${s.id})`));
  if (s.archivedAt) lines.push("", yellow(`archived ${shortTime(s.archivedAt)}`) + dim("  (aflow sessions unarchive " + s.id + ")"));
  if (s.blackboardRefs?.length) lines.push("", dim(`blackboard: ${s.blackboardRefs.join(", ")}`));
  return lines;
}

/** One-line summary of an entry, for the tail of `inspect` and `resume`. */
function renderEntry(e) {
  const body =
    e.text ??
    e.message ??
    (e.tool ? `${e.tool}${e.ok === false ? " (failed)" : ""}` : null) ??
    (e.model ? `${e.model}${e.ok === false ? " (no answer)" : ""}` : null) ??
    (e.slug ? e.slug : null) ??
    (e.objective ? e.objective : null);

  const detail = body === null || body === undefined ? dim(JSON.stringify(e).slice(0, 120)) : truncate(String(body), 78);
  const tag = e.kind.padEnd(14);
  const who = e.agent ? dim(`[${e.agent}] `) : "";
  return `  ${String(e.seq).padStart(4)} ${dim(shortTime(e.ts))} ${statusColor(
    e.kind === ENTRY_KIND.ERROR ? "error" : e.kind === ENTRY_KIND.ROUTING ? "warn" : "ok",
  )} ${dim(tag)} ${who}${detail}`;
}

function tailEntries(session, limit) {
  if (limit === 0) return session.entries;
  return session.entries.slice(-limit);
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

function listSub(store, flags, out, current) {
  const includeArchived = flags.archived === true || flags["include-archived"] === true;
  const projectRoot = flags.project ? String(flags.project) : null;
  const sessions = store.list({
    includeArchived,
    projectRoot,
    limit: parseCount(flags.limit, 0),
  });

  // "no sessions yet" is the wrong thing to print when the only sessions exist
  // but are archived. Only pay for the second scan in that case.
  const hiddenCount =
    sessions.length === 0 && !includeArchived ? store.list({ includeArchived: true, projectRoot }).length : 0;

  const payload = {
    dir: store.dir,
    current,
    count: sessions.length,
    includeArchived,
    hiddenCount,
    sessions,
  };

  return out.init(payload, (r) => {
    const lines = [heading(bold("aflow sessions"))];

    if (!r.sessions.length) {
      if (r.hiddenCount) {
        lines.push(dim(`${r.hiddenCount} archived session(s), hidden`));
        lines.push(dim("add --archived to include them"));
      } else {
        lines.push(dim("no sessions yet"));
        lines.push(dim(`start one: aflow sessions new "what you are working on"`));
      }
      lines.push(dim(`stored in ${r.dir}`));
      return lines.join("\n");
    }

    const corrupt = r.sessions.filter((s) => s.corrupt);
    const ok = r.sessions.filter((s) => !s.corrupt);

    if (ok.length) {
      // Widths follow the data so ids and names line up, but are capped: one very
      // long name should not push every other column off the terminal.
      const idWidth = Math.min(Math.max(...ok.map((s) => s.id.length)), 30);
      const nameWidth = Math.min(Math.max(...ok.map((s) => s.name.length), 8), 40);

      for (const s of ok) {
        const marker = s.id === r.current ? cyan("*") : " ";
        const state =
          s.state === SESSION_STATE.COMPLETED
            ? dim("done")
            : s.archivedAt
              ? dim("archived")
              : dim(`${s.counters.entries} entries`);
        lines.push(
          `${marker} ${s.id.padEnd(idWidth)} ${s.name.padEnd(nameWidth).slice(0, nameWidth)} ${dim(relative(s.updatedAt).padStart(8))} ${state}`,
        );
      }
    }

    for (const c of corrupt) {
      lines.push(`${red("!")} ${c.id} ${red("corrupt")} ${dim(c.error)}`);
    }

    lines.push("");
    lines.push(dim(`${r.count} session(s)${r.includeArchived ? " including archived" : ""} in ${r.dir}`));
    if (r.hiddenCount) lines.push(dim(`${r.hiddenCount} archived session(s) hidden; add --archived to include them`));
    lines.push(dim(`* = current   inspect: aflow sessions inspect <id>`));
    return lines.join("\n");
  });
}

function newSub(store, flags, args, out) {
  const objective = args.length ? args.join(" ") : flags.objective ? String(flags.objective) : null;
  if (!objective) {
    throw usage('nothing to start: aflow sessions new "the objective", or pass --objective');
  }

  const projectRoot = flags.project ? String(flags.project) : process.cwd();
  const session = store.create({
    objective,
    name: flags.name ? String(flags.name) : null,
    projectRoot,
    provider: flags.provider ? String(flags.provider) : null,
    model: flags.model ? String(flags.model) : null,
    agents: splitList(flags.agents),
  });
  store.setCurrent(session.id);

  return out.init({ dir: store.dir, created: true, current: session.id, session }, (r) => {
    const lines = [heading(bold("aflow sessions new")), ""];
    lines.push(...renderHeader(r.session, true));
    lines.push("");
    lines.push(dim(`resume it:  aflow sessions resume ${r.session.id}`));
    lines.push(dim(`record work: aflow sessions note ${r.session.id} "what you found"`));
    return lines.join("\n");
  });
}

function resumeSub(store, args, flags, out) {
  const requested = args[0] || flags.id || null;
  const id = requested || store.getCurrent();

  if (!id) {
    throw usage("no session to resume: pass an id, or start one with aflow sessions new");
  }

  const session = store.read(id);
  store.setCurrent(session.id);
  const limit = parseCount(flags.entries, 10);

  return out.init({ dir: store.dir, current: session.id, entries: tailEntries(session, limit), session }, (r) => {
    const lines = [heading(bold("aflow sessions resume")), ""];
    lines.push(...renderHeader(r.session, true));

    const shown = r.entries;
    if (shown.length) {
      lines.push("");
      lines.push(bold(`recent entries`) + dim(` (showing ${shown.length} of ${r.session.entries.length})`));
      for (const e of shown) lines.push(renderEntry(e));
    } else {
      lines.push("");
      lines.push(dim("no entries recorded yet"));
    }

    lines.push("");
    lines.push(dim(`continue: aflow sessions note ${r.session.id} "..."`));
    return lines.join("\n");
  });
}

function currentSub(store, out) {
  const id = store.getCurrent();
  if (!id) {
    return out.init({ dir: store.dir, current: null, session: null }, () =>
      [heading(bold("aflow sessions current")), "", dim("no current session"), dim("start one: aflow sessions new \"objective\"")].join("\n"),
    );
  }

  const session = store.read(id);
  return out.init({ dir: store.dir, current: id, session }, (r) => {
    const lines = [heading(bold("aflow sessions current")), ""];
    lines.push(...renderHeader(r.session, true));
    return lines.join("\n");
  });
}

function inspectSub(store, args, flags, out) {
  const id = args[0];
  if (!id) throw usage("which session: aflow sessions inspect <id>");

  const session = store.read(id);
  const limit = parseCount(flags.entries, 20);
  const all = limit === 0;

  return out.init(
    { dir: store.dir, current: store.getCurrent(), showing: all ? "all" : `last ${limit}`, entries: tailEntries(session, limit), session },
    (r) => {
      const lines = [heading(bold("aflow sessions inspect")), ""];
      lines.push(...renderHeader(r.session, r.session.id === r.current));

      const shown = r.entries;
      lines.push("");
      if (!shown.length) {
        lines.push(dim("no entries recorded yet"));
      } else {
        lines.push(bold(`entries`) + dim(` (showing ${shown.length} of ${r.session.entries.length})`));
        for (const e of shown) lines.push(renderEntry(e));
        if (!all && r.session.entries.length > shown.length) {
          lines.push(dim(`  ... ${r.session.entries.length - shown.length} earlier (--entries 0 for all)`));
        }
      }

      if (r.session.counters.dropped) {
        lines.push("");
        lines.push(
          yellow(`${r.session.counters.dropped} oldest entr(y/ies) were trimmed to bound file size`) +
            dim("  counters above still total every entry ever recorded"),
        );
      }

      return lines.join("\n");
    },
  );
}

function renameSub(store, args, out) {
  const [id, ...rest] = args;
  if (!id) throw usage("which session: aflow sessions rename <id> <new name>");
  const name = rest.join(" ").trim();
  if (!name) throw usage("new name required: aflow sessions rename <id> <new name>");

  const session = store.rename(id, name);
  return out.init({ dir: store.dir, renamed: true, session, current: store.getCurrent() }, (r) => {
    const lines = [heading(bold("aflow sessions rename")), ""];
    lines.push(...renderHeader(r.session, r.session.id === r.current));
    return lines.join("\n");
  });
}

function archiveSub(store, args, out, archived) {
  const id = args[0];
  if (!id) throw usage(`which session: aflow sessions ${archived ? "archive" : "unarchive"} <id>`);

  const session = store.setArchived(id, archived);
  return out.init({ dir: store.dir, archived, session }, (r) => {
    const lines = [heading(bold(`aflow sessions ${r.archived ? "archive" : "unarchive"}`)), ""];
    lines.push(...renderHeader(r.session, false));
    lines.push("");
    lines.push(
      r.archived
        ? dim("hidden from the default listing; the file is kept. aflow sessions list --archived to see it.")
        : dim("back in the default listing."),
    );
    return lines.join("\n");
  });
}

function noteSub(store, args, flags, out) {
  const [id, ...rest] = args;
  if (!id) throw usage('which session: aflow sessions note <id> "what happened"');
  const text = rest.join(" ").trim();
  if (!text) throw usage('note text required: aflow sessions note <id> "what happened"');

  const session = store.append(id, ENTRY_KIND.NOTE, { text }, { agent: flags.as || null });
  const last = session.entries[session.entries.length - 1];
  return out.init({ dir: store.dir, noted: true, entry: last, session, current: store.getCurrent() }, (r) => {
    const lines = [heading(bold("aflow sessions note")), ""];
    lines.push(renderEntry(r.entry));
    lines.push("");
    lines.push(dim(`${r.session.counters.entries} entries in ${r.session.id}`));
    return lines.join("\n");
  });
}

function doneSub(store, args, out) {
  const id = args[0];
  if (!id) throw usage("which session: aflow sessions done <id>");

  const session = store.complete(id);
  return out.init({ dir: store.dir, completed: true, session }, (r) => {
    const lines = [heading(bold("aflow sessions done")), ""];
    lines.push(...renderHeader(r.session, false));
    return lines.join("\n");
  });
}

// ---------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------

export const sessionsCommand = defineCommand("sessions", {
  summary: "start, resume, and inspect persistent sessions",
  valueFlags: ["objective", "name", "project", "limit", "entries", "state-dir", "agents", "provider", "id", "as"],
  usage: `aflow sessions [list] [--archived] [--limit N] [--project PATH]
  aflow sessions new <objective> [--name NAME] [--project PATH] [--model ID]
  aflow sessions resume [<id>] [--entries N]
  aflow sessions current
  aflow sessions inspect <id> [--entries N]
  aflow sessions rename <id> <new name>
  aflow sessions note <id> <text> [--as AGENT]
  aflow sessions done <id>
  aflow sessions archive <id> | unarchive <id>

A session is one unit of work that survives process exit, so the next command --
or the next agent -- continues instead of starting over. Sessions live under the
platform state directory (override with --state-dir or AGENTFLOW_STATE_DIR).

  list        newest first; * marks the current session
  new         records the objective, scoped to the current directory
  resume      makes a session current and prints recent entries as context;
              with no id, resumes the current one
  inspect     full detail; --entries 0 prints every entry
  rename      relabel a session
  note        append a progress note (optionally attributed with --as)
  done        mark complete
  archive     hide from the default listing without deleting anything

  --archived      include archived sessions in the listing
  --project PATH  only sessions rooted at this directory
  --limit N       newest N sessions (0 for all)
  --entries N     how many entries to show; 0 for all
  --as AGENT      attribute a note to an agent
  --json          machine-readable output

Exit codes: 0 ok, 1 not found or corrupt, 2 usage.

Examples
  aflow sessions new "fix the routing cascade" --model oc/muse
  aflow sessions note ses_20261004T071530Z_a1b2c3 "cascade now falls through"
  aflow sessions resume
  aflow sessions inspect ses_20261004T071530Z_a1b2c3 --entries 0 --json | jq '.session.counters'

Credentials are redacted before anything is written, so quoting a key in an
objective or note masks it instead of persisting it.`,
  run: async ({ args, flags, out }) => {
    const store = storeFor(flags);
    const [sub = "list", ...rest] = args;
    const current = store.getCurrent();

    try {
      switch (sub) {
        case "list":
          return listSub(store, flags, out, current);
        case "new":
          return newSub(store, flags, rest, out);
        case "resume":
          return resumeSub(store, rest, flags, out);
        case "current":
          return currentSub(store, out);
        case "inspect":
        case "show":
          return inspectSub(store, rest, flags, out);
        case "rename":
          return renameSub(store, rest, out);
        case "note":
          return noteSub(store, rest, flags, out);
        case "done":
        case "complete":
          return doneSub(store, rest, out);
        case "archive":
          return archiveSub(store, rest, out, true);
        case "unarchive":
          return archiveSub(store, rest, out, false);
        default:
          throw usage(`unknown subcommand: ${sub}\n\n${sessionsCommand.usage}`);
      }
    } catch (err) {
      // Usage mistakes exit 2 with the full usage text; everything else is a real
      // store error and the router's generic handling (message + code) is right.
      if (err.usage) {
        await out.init({ error: err.message, usage: sessionsCommand.usage }, () => `${err.message}\n\n${sessionsCommand.usage}`);
        return USAGE_ERROR;
      }
      throw err;
    }
  },
});

export default sessionsCommand;