// `aflow blackboard` — durable project workflow state.
//
// This is the human-facing surface over src/core/blackboard.js, and it exists
// because the most important property of the subsystem is not "it can store a
// task", it is that a stopped agent can pick up where it left off. That only
// works if the state is reachable from a shell, without booting an agent.
//
// The subcommands are shaped around the questions a returning agent actually
// asks, in the order it asks them:
//
//   aflow blackboard                      what is this project, what is next?
//   aflow blackboard goal <text>           record the goal and current objective
//   aflow blackboard task add <title>      add work
//   aflow blackboard task done <id>        finish it
//   aflow blackboard decide <title>        record why something was chosen
//   aflow blackboard block <title>         record what is in the way
//   aflow blackboard next <text>           say what should happen next
//   aflow blackboard timeline              what actually happened
//
// `show` with no subcommand is deliberately a compact briefing rather than a dump
// of the state document: an agent resuming after a break reads the goal, the next
// action and the open work, and should not have to page past 500 findings to get
// there. `--json` gives the full summary for anything that wants to process it.
//
// Errors from the store (not found, corrupt, locked) are allowed to propagate:
// the CLI router already renders `<command>: <message>` with the error code and
// exit 1, which is what those cases want. Only *usage* mistakes are handled
// here, with exit 2.

import path from "node:path";
import process from "node:process";
import { defineCommand } from "../cli/registry.js";
import { BlackboardStore, ValidationError } from "../core/blackboard.js";
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

/**
 * One store per invocation, keyed to the current directory by default.
 *
 * The project root is what identifies a Blackboard, so running this from a repo
 * picks up that repo's state with no flag. `--project` points somewhere else and
 * `--state-dir` moves the whole store, which is what lets tests work against a
 * scratch directory without touching a real user's records.
 */
function storeFor(flags) {
  const projectRoot = flags.project ? path.resolve(String(flags.project)) : process.cwd();
  return new BlackboardStore({
    projectRoot,
    ...(flags["state-dir"] ? { dir: String(flags["state-dir"]) } : {}),
  });
}

function usage(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}

/** Join positional words back together: `task add fix the thing` reads as prose. */
function words(rest) {
  return rest.map((w) => String(w)).join(" ").trim();
}

function requireWords(rest, what) {
  const text = words(rest);
  if (!text) throw usage(`${what} is required`);
  return text;
}

/**
 * Key/value block. `table` drops its header and rule when no column carries a
 * label, which is exactly the key/value case; naming the shape once keeps every
 * block in this file from re-deriving it (and from getting it wrong).
 */
const FACTS = [
  { key: "k", label: "" },
  { key: "v", label: "" },
];

function renderSummary(summary, state) {
  const lines = [];
  lines.push(heading(`blackboard ${summary.id}`));
  lines.push(
    table(
      [
        { k: "project", v: summary.projectRoot },
        { k: "goal", v: summary.goal ? truncate(summary.goal, 70) : dim("(none)") },
        { k: "objective", v: summary.objective ? truncate(summary.objective, 70) : dim("(none)") },
        {
          k: "next",
          v: summary.nextAction
            ? `${bold(summary.nextAction.text)} ${dim(`(${shortTime(summary.nextAction.createdAt)})`)}`
            : dim("(not set)"),
        },
        { k: "updated", v: `${shortTime(summary.updatedAt)} ${dim(relative(summary.updatedAt))}` },
      ],
      FACTS,
    ),
  );

  const sections = [
    ["in progress", summary.inProgress, (t) => `${t.id} ${truncate(t.title, 58)}`],
    ["open", summary.openTasks, (t) => `${t.id} ${statusColor(t.status)} ${truncate(t.title, 52)}`],
    ["blockers", summary.openBlockers, (b) => `${b.id} ${statusColor(b.severity)} ${truncate(b.title, 52)}`],
    ["bugs", summary.openBugs, (b) => `${b.id} ${statusColor(b.severity)} ${truncate(b.title, 52)}`],
    ["questions", summary.openQuestions, (q) => `${q.id} ${truncate(q.question, 56)}`],
    ["decisions", summary.activeDecisions, (d) => `${d.id} ${dim(d.kind)} ${truncate(d.title, 50)}`],
    ["latest tests", summary.latestTests, (t) => `${statusColor(t.failed ? "critical" : "ok")} ${t.suite}: ${t.passed} passed, ${t.failed} failed`],
  ];

  for (const [label, items, format] of sections) {
    if (!items.length) continue;
    lines.push("");
    lines.push(bold(`${label} (${items.length})`));
    for (const item of items.slice(-5)) lines.push(`  ${format(item)}`);
    if (items.length > 5) lines.push(dim(`  ...and ${items.length - 5} more`));
  }

  if (summary.recentCheckpoints.length) {
    lines.push("");
    lines.push(bold("checkpoints"));
    for (const c of summary.recentCheckpoints.slice(-5)) {
      if (c.corrupt) {
        lines.push(`  ${yellow("corrupt")} ${dim(shortTime(null))} (torn line)`);
        continue;
      }
      lines.push(`  ${dim(shortTime(c.ts))} ${cyan(c.checkpoint)} ${truncate(c.summary, 46)}`);
    }
  }

  const dropped = Object.entries(summary.dropped || {}).filter(([, n]) => n > 0);
  if (dropped.length) {
    lines.push("");
    lines.push(dim(`trimmed: ${dropped.map(([k, n]) => `${k} ${n}`).join(", ")}`));
  }

  lines.push("");
  lines.push(dim(`files ${summary.files.length}  commits ${summary.commits.length}  sessions ${summary.sessionIds.length}  state v${state.version}`));
  return lines.join("\n");
}

function showSub(store, flags, out) {
  if (!store.exists()) {
    const state = store.create({
      ...(flags.goal ? { goal: String(flags.goal) } : {}),
      ...(flags.objective ? { objective: String(flags.objective) } : {}),
    });
    return out.init({ created: true, summary: store.summary() }, () =>
      [
        heading(`blackboard ${state.id}`),
        dim(`created for ${store.projectRoot}`),
        "",
        `Set the goal with   ${bold("aflow blackboard goal <text>")}`,
        `Record work with   ${bold("aflow blackboard task add <title>")}`,
        `Hand off with      ${bold("aflow blackboard next <text>")}`,
      ].join("\n"),
    );
  }

  const summary = store.summary();
  const state = store.require();
  return out.init(summary, () => renderSummary(summary, state));
}

function goalSub(store, rest, flags, out) {
  const text = requireWords(rest, "a goal");
  const result = store.setIntent({
    goal: text,
    ...(flags.objective ? { objective: String(flags.objective) } : {}),
    ...(flags.session ? { sessionId: String(flags.session) } : {}),
  });
  return out.init({ goal: result.goal, objective: result.objective }, () =>
    [
      green("goal recorded"),
      `  goal      ${truncate(result.goal, 76)}`,
      `  objective ${result.objective ? truncate(result.objective, 68) : dim("(unchanged)")}`,
    ].join("\n"),
  );
}

function objectiveSub(store, rest, out) {
  const text = requireWords(rest, "an objective");
  const result = store.setIntent({ objective: text });
  return out.init(result, () => `objective recorded\n  ${truncate(result.objective, 76)}`);
}

function taskAddSub(store, rest, flags, out) {
  const title = requireWords(rest, "a task title");
  const task = store.addTask({
    title,
    ...(flags.detail ? { detail: String(flags.detail) } : {}),
    ...(flags.depends ? { dependsOn: splitList(flags.depends) } : {}),
    ...(flags.session ? { sessionId: String(flags.session) } : {}),
    ...(flags.status ? { status: String(flags.status) } : {}),
  });
  return out.init({ task }, () => `${green("added")} ${bold(task.id)} ${task.title}`);
}

function taskUpdateSub(store, rest, flags, out) {
  const id = rest[0];
  if (!id) throw usage("a task id is required");
  const patch = {};
  if (flags.status) patch.status = String(flags.status);
  if (flags.detail) patch.detail = String(flags.detail);
  if (flags.session) patch.sessionId = String(flags.session);
  if (flags.commit) patch.commits = splitList(flags.commit);
  if (!Object.keys(patch).length) throw usage("nothing to update; pass --status, --detail, --session or --commit");

  const task = store.updateTask(String(id), patch);
  return out.init({ task }, () => `updated ${bold(task.id)} ${statusColor(task.status)} ${truncate(task.title, 60)}`);
}

function taskListSub(store, flags, out) {
  if (!store.exists()) {
    return out.init({ count: 0, tasks: [] }, () => dim("no blackboard yet -- run `aflow blackboard` to create one"));
  }
  const tasks = store.listTasks({ ...(flags.status ? { status: String(flags.status) } : {}) });
  const limit = parseCount(flags.limit, 0);
  const shown = limit > 0 ? tasks.slice(0, limit) : tasks;
  return out.init({ count: shown.length, tasks: shown }, () =>
    shown.length
      ? shown
          .map((t) => `  ${t.id} ${statusColor(t.status)} ${truncate(t.title, 64)}`)
          .join("\n")
      : dim("no tasks yet"),
  );
}

function decideSub(store, rest, flags, out) {
  const title = requireWords(rest, "a decision title");
  const decision = store.recordDecision({
    title,
    ...(flags.kind ? { kind: String(flags.kind) } : {}),
    ...(flags.detail ? { detail: String(flags.detail) } : {}),
    ...(flags.rationale ? { rationale: String(flags.rationale) } : {}),
    ...(flags.alternatives ? { alternatives: splitList(flags.alternatives) } : {}),
    ...(flags.supersedes ? { supersedes: String(flags.supersedes) } : {}),
    ...(flags.task ? { taskId: String(flags.task) } : {}),
    ...(flags.session ? { sessionId: String(flags.session) } : {}),
    ...(flags.commit ? { commit: String(flags.commit) } : {}),
  });
  return out.init({ decision }, () =>
    [
      `${green("recorded")} ${bold(decision.id)} ${decision.title}`,
      `  kind       ${decision.kind}`,
      `  rationale  ${decision.rationale ? truncate(decision.rationale, 68) : dim("(none)")}`,
      decision.supersedes ? dim(`  supersedes ${decision.supersedes}`) : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function blockSub(store, rest, flags, out) {
  const title = requireWords(rest, "a blocker title");
  const blocker = store.recordBlocker({
    title,
    ...(flags.detail ? { detail: String(flags.detail) } : {}),
    ...(flags.severity ? { severity: String(flags.severity) } : {}),
    ...(flags.task ? { taskId: String(flags.task) } : {}),
    ...(flags.session ? { sessionId: String(flags.session) } : {}),
  });
  return out.init({ blocker }, () =>
    [
      `${yellow("blocked")} ${bold(blocker.id)} ${blocker.title}`,
      blocker.taskId ? dim(`  task ${blocker.taskId}`) : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function unblockSub(store, rest, out) {
  const id = rest[0];
  if (!id) throw usage("a blocker id is required");
  const blocker = store.resolveBlocker(String(id), words(rest.slice(1)) || "resolved");
  return out.init({ blocker }, () => `${green("resolved")} ${bold(blocker.id)} ${truncate(blocker.title, 60)}`);
}

function bugSub(store, rest, flags, out) {
  const title = requireWords(rest, "a bug title");
  const bug = store.recordBug({
    title,
    ...(flags.detail ? { detail: String(flags.detail) } : {}),
    ...(flags.severity ? { severity: String(flags.severity) } : {}),
    ...(flags.task ? { taskId: String(flags.task) } : {}),
  });
  return out.init({ bug }, () => `${red("bug")} ${bold(bug.id)} ${bug.title}`);
}

function fixSub(store, rest, out) {
  const id = rest[0];
  if (!id) throw usage("a bug id is required");
  const bug = store.fixBug(String(id), words(rest.slice(1)) || null);
  return out.init({ bug }, () => `${green("fixed")} ${bold(bug.id)} ${truncate(bug.title, 60)}`);
}

function findingSub(store, rest, flags, out) {
  const title = requireWords(rest, "a finding title");
  const finding = store.recordFinding({
    title,
    ...(flags.detail ? { detail: String(flags.detail) } : {}),
    ...(flags.source ? { source: String(flags.source) } : {}),
    ...(flags.severity ? { severity: String(flags.severity) } : {}),
    ...(flags.author ? { author: String(flags.author) } : {}),
    ...(flags.task ? { taskId: String(flags.task) } : {}),
    ...(flags.files ? { files: splitList(flags.files) } : {}),
  });
  return out.init({ finding }, () => `${cyan("finding")} ${bold(finding.id)} ${finding.title}`);
}

function reviewSub(store, rest, flags, out) {
  const summary = requireWords(rest, "a review summary");
  const review = store.recordReview({
    summary,
    ...(flags.verdict ? { verdict: String(flags.verdict) } : {}),
    ...(flags.session ? { sessionId: String(flags.session) } : {}),
  });
  return out.init({ review }, () => `${green("review recorded")} ${truncate(review.summary, 64)}`);
}

function noteSub(store, rest, flags, out) {
  const text = requireWords(rest, "note text");
  const result = store.recordQuestion({
    question: text,
    ...(flags.task ? { taskId: String(flags.task) } : {}),
    ...(flags.session ? { sessionId: String(flags.session) } : {}),
  });
  return out.init({ question: result }, () => `${cyan("question")} ${bold(result.id)} ${truncate(result.question, 62)}`);
}

function testSub(store, rest, flags, out) {
  const suite = String(flags.suite ?? words(rest) ?? "tests");
  const result = store.recordTest({
    suite: suite || "tests",
    ...(flags.command ? { command: String(flags.command) } : {}),
    ...(flags.passed !== undefined ? { passed: Number(flags.passed) } : {}),
    ...(flags.failed !== undefined ? { failed: Number(flags.failed) } : {}),
    ...(flags.skipped !== undefined ? { skipped: Number(flags.skipped) } : {}),
    ...(flags.commit ? { commit: String(flags.commit) } : {}),
    ...(flags.task ? { taskId: String(flags.task) } : {}),
  });
  const lines = [
    result.failed
      ? `${red("recorded")} ${result.suite}: ${result.passed} passed, ${result.failed} failed`
      : `${green("recorded")} ${result.suite}: ${result.passed} passed`,
  ];
  for (const failure of result.failures.slice(0, 5)) lines.push(`  ${red("x")} ${truncate(failure, 66)}`);
  return out.init({ test: result }, () => lines.join("\n"));
}

function implementationSub(store, rest, flags, out) {
  const summary = requireWords(rest, "a summary");
  const result = store.recordImplementation({
    summary,
    ...(flags.files ? { files: splitList(flags.files) } : {}),
    ...(flags.commit ? { commits: splitList(flags.commit) } : {}),
    ...(flags.task ? { taskId: String(flags.task) } : {}),
    ...(flags.session ? { sessionId: String(flags.session) } : {}),
  });
  return out.init(result, () =>
    [
      `${green("recorded")} ${truncate(summary, 70)}`,
      dim(`  files   ${result.files.length}`),
      dim(`  commits ${result.commits.length}`),
    ].join("\n"),
  );
}

function nextSub(store, rest, flags, out) {
  const text = requireWords(rest, "the next action");
  const action = store.setNextAction({
    text,
    ...(flags.task ? { taskId: String(flags.task) } : {}),
    ...(flags.session ? { sessionId: String(flags.session) } : {}),
  });
  return out.init({ nextAction: action }, () => `${bold("next")} ${truncate(action.text, 72)}`);
}

function linkSub(store, rest, out) {
  const ids = rest.length ? rest : [];
  if (!ids.length) throw usage("a session id is required");
  const before = store.require().sessionIds;
  for (const id of ids) store.linkSession(String(id));
  const after = store.require().sessionIds;
  const added = after.filter((id) => !before.includes(id));
  return out.init({ linked: added, sessionIds: after }, () =>
    added.length
      ? `${green("linked")} ${added.join(", ")}`
      : dim(`already linked: ${after.join(", ") || "(none)"}`),
  );
}

function timelineSub(store, flags, out) {
  if (!store.exists()) {
    return out.init({ count: 0, entries: [] }, () => dim("no checkpoints yet"));
  }
  const entries = store.timeline();
  const limit = parseCount(flags.limit, 20);
  const shown = limit > 0 ? entries.slice(-limit) : entries;
  return out.init({ count: entries.length, entries: shown }, () =>
    shown.length
      ? shown
          .map((c) =>
            c.corrupt
              ? `  ${yellow("corrupt")} ${dim("(torn line)")}`
              : `  ${dim(shortTime(c.ts))} ${cyan(c.checkpoint)} ${truncate(c.summary, 56)}`,
          )
          .join("\n")
      : dim("no checkpoints yet"),
  );
}

function destroySub(store, flags, out) {
  const removed = store.destroy({ confirm: String(flags.confirm ?? "") });
  return out.init({ destroyed: true, removed }, () => `${red("destroyed")} blackboard ${store.id}`);
}

export const blackboardCommand = defineCommand("blackboard", {
  summary: "record and recover durable project workflow state",
  valueFlags: [
    "goal",
    "objective",
    "project",
    "state-dir",
    "limit",
    "status",
    "detail",
    "kind",
    "rationale",
    "alternatives",
    "supersedes",
    "severity",
    "source",
    "author",
    "files",
    "commit",
    "session",
    "task",
    "depends",
    "suite",
    "command",
    "passed",
    "failed",
    "skipped",
    "verdict",
    "confirm",
  ],
  usage: `aflow blackboard [show|list] [--project PATH] [--json]
  aflow blackboard goal <text> [--objective TEXT]
  aflow blackboard objective <text>
  aflow blackboard task add <title> [--detail TEXT] [--status STATUS] [--depends IDS] [--session ID]
  aflow blackboard task <id> --status STATUS [--detail TEXT] [--commit SHAS]
  aflow blackboard task list [--status STATUS] [--limit N]
  aflow blackboard decide <title> [--kind KIND] [--rationale TEXT] [--alternatives A,B]
  aflow blackboard decide <title> --supersedes <id>
  aflow blackboard block <title> [--severity SEV] [--task ID]
  aflow blackboard unblock <id> [resolution]
  aflow blackboard bug <title> [--severity SEV] [--task ID]
  aflow blackboard fix <id> [resolution]
  aflow blackboard finding <title> [--source WHO] [--severity SEV] [--files A,B]
  aflow blackboard review <summary> [--verdict V]
  aflow blackboard note <question> [--task ID]
  aflow blackboard test [suite] [--passed N] [--failed N] [--command CMD] [--commit SHA]
  aflow blackboard implemented <summary> [--files A,B] [--commit SHAS] [--task ID]
  aflow blackboard next <text> [--task ID] [--session ID]
  aflow blackboard link <session id...>
  aflow blackboard timeline [--limit N]
  aflow blackboard destroy --confirm <id>

The blackboard holds what we were doing to the project; git holds what the code
is. It records references -- paths, shas, commands -- never file contents, so the
two cannot fall out of sync. State is scoped to the current directory.

  show          goal, next action, open work, recent checkpoints. Created on
                first run, with an empty state.
  goal          record the project goal and current objective
  task          add work, move it through pending/in_progress/blocked/done, list it
  decide        record a decision with its rationale; --supersedes retires the old one
  block         record a blocker; naming a task marks that task blocked
  bug/fix       record a known bug and later mark it fixed
  finding       record an agent or reviewer finding
  review        record that a review gate was cleared
  note          record an open question
  test          record a run; the checkpoint follows the outcome
  implemented   record which files and commits changed
  next          state what should happen next -- the field a handoff depends on
  link          point the blackboard at session ids
  timeline      the append-only checkpoint log
  destroy       delete the blackboard; requires the exact id as --confirm

  --project PATH   act on another project's blackboard
  --state-dir PATH override the state directory
  --json           machine-readable output

Exit codes: 0 ok, 1 not found, corrupt or locked, 2 usage.

Examples
  aflow blackboard goal "ship durable workflow state" --objective "blackboard"
  aflow blackboard task add "extract persistence helpers"
  aflow blackboard task t1 --status in_progress
  aflow blackboard decide "two files, not one" --kind architecture \\
    --rationale "the state doc is bounded, the timeline is not"
  aflow blackboard test unit --passed 261 --failed 0
  aflow blackboard next "add the CLI and docs"
  aflow blackboard --json | jq '.nextAction.text'

Credentials are redacted before anything is written, so quoting a key in a task,
decision or note masks it instead of persisting it.`,
  run: async ({ args, flags, out }) => {
    const store = storeFor(flags);
    const [sub = "show", ...rest] = args;

    // Subcommands that only read. Everything else is a write, and a write against a
    // blackboard that does not exist yet should create it rather than fail: the
    // alternative is making the user run a bare `aflow blackboard` before every
    // other command, which is a rule nobody will remember.
    const readOnly = sub === "show" || sub === "list" || sub === "timeline" || sub === "destroy" || (sub === "task" && rest[0] === "list");

    try {
      if (!readOnly && !store.exists()) store.create();

      switch (sub) {
        case "show":
        case "list":
          return showSub(store, flags, out);
        case "goal":
          return goalSub(store, rest, flags, out);
        case "objective":
          return objectiveSub(store, rest, out);
        case "task": {
          const action = rest[0];
          if (action === "add" || action === "new") return taskAddSub(store, rest.slice(1), flags, out);
          if (action === "list") return taskListSub(store, flags, out);
          if (!action) throw usage(`task needs a subcommand\n\n${blackboardCommand.usage}`);
          return taskUpdateSub(store, rest, flags, out);
        }
        case "decide":
        case "decision":
          return decideSub(store, rest, flags, out);
        case "block":
        case "blocker":
          return blockSub(store, rest, flags, out);
        case "unblock":
        case "resolve":
          return unblockSub(store, rest, out);
        case "bug":
          return bugSub(store, rest, flags, out);
        case "fix":
          return fixSub(store, rest, out);
        case "finding":
          return findingSub(store, rest, flags, out);
        case "review":
          return reviewSub(store, rest, flags, out);
        case "note":
        case "question":
          return noteSub(store, rest, flags, out);
        case "test":
          return testSub(store, rest, flags, out);
        case "implemented":
        case "implementation":
          return implementationSub(store, rest, flags, out);
        case "next":
          return nextSub(store, rest, flags, out);
        case "link":
          return linkSub(store, rest, out);
        case "timeline":
          return timelineSub(store, flags, out);
        case "destroy":
          return destroySub(store, flags, out);
        default:
          throw usage(`unknown subcommand: ${sub}\n\n${blackboardCommand.usage}`);
      }
    } catch (err) {
      // A ValidationError means the caller passed something the store refused to
      // interpret -- bad status, missing title, wrong confirm token. That is a
      // usage mistake, so it exits 2 with guidance.
      //
      // Everything else -- not found, corrupt, locked, a secret that survived
      // redaction -- is a real condition of the stored state, and the router's
      // generic handling (message + code, exit 1) is right.
      if (err.usage || err instanceof ValidationError) {
        await out.init({ error: err.message, usage: blackboardCommand.usage }, () => `${err.message}\n\n${blackboardCommand.usage}`);
        return USAGE_ERROR;
      }
      throw err;
    }
  },
});

export default blackboardCommand;