// `aflow sessions` command tests.
//
// The store is tested in sessions.test.js; this file covers the command layer:
// subcommand dispatch, exit codes, usage errors, and -- critically -- that the
// human renderer actually runs for every subcommand. A renderer is only invoked
// in text mode, so a stub that never calls `renderText` would let a crash in the
// rendering path ship. Every test here calls it.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionsCommand } from "../src/commands/sessions.js";
import { SessionNotFoundError, SessionIdError, SESSION_STATE } from "../src/core/sessions.js";

/**
 * Stand-in for cli/output.js that records what was rendered instead of writing
 * to stdout, so assertions can look at both the payload and the human text.
 */
function stubOut() {
  const rendered = [];
  const out = {
    json: false,
    quiet: false,
    verbose: false,
    rendered,
    last() {
      return rendered[rendered.length - 1];
    },
    async init(result, renderText) {
      const text = typeof renderText === "function" ? renderText(result) : null;
      rendered.push({ result, text });
      return text;
    },
    error(message) {
      rendered.push({ error: message });
    },
    warn(message) {
      rendered.push({ warn: message });
    },
    detail(message) {
      rendered.push({ detail: message });
    },
  };
  return out;
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-sessions-cli-"));
  return dir;
}

/**
 * `args` are positionals only -- the CLI router has already split argv into
 * args and flags, so a test that passes "--model x" inside `args` is testing a
 * shape the command never sees. Flags go in via `extraFlags`.
 */
async function run(args, dir, extraFlags = {}) {
  const out = stubOut();
  const returned = await sessionsCommand.run({
    args,
    flags: { "state-dir": dir, ...extraFlags },
    config: {},
    out,
  });
  // Mirror the CLI router: a subcommand that returns out.init() resolves to the
  // rendered text, and anything that is not a number is success.
  const code = typeof returned === "number" ? returned : 0;
  return { code, out, payload: out.last().result };
}

test("no subcommand lists rather than erroring", async () => {
  const dir = scratch();
  const { code, payload, out } = await run([], dir);
  assert.equal(code, 0);
  assert.equal(payload.count, 0);
  // The renderer must survive the empty case; this is the assertion that catches
  // crashes in the human path.
  assert.match(out.last().text, /no sessions yet/);
});

test("new records the objective and becomes the current session", async () => {
  const dir = scratch();
  const { code, payload } = await run(["new", "fix", "the", "cascade"], dir, { model: "oc/muse" });

  assert.equal(code, 0);
  assert.equal(payload.created, true);
  assert.equal(payload.session.objective, "fix the cascade", "words must rejoin in order");
  assert.equal(payload.session.model, "oc/muse");
  assert.equal(payload.current, payload.session.id);
});

test("new derives a name from the objective and scopes it to a project", async () => {
  const dir = scratch();
  const { payload } = await run(["new", "ship the session store"], dir);
  assert.equal(payload.session.name, "ship the session store");
  // Default project is the working directory, so `list --project` can scope.
  assert.equal(payload.session.project.root, path.resolve(process.cwd()));
});

test("new accepts agents as a comma list", async () => {
  const dir = scratch();
  const { payload } = await run(["new", "work"], dir, { agents: "planner,coder,planner" });
  assert.deepEqual(payload.session.agents, ["planner", "coder"]);
});

test("new with no objective is a usage error, not an empty session", async () => {
  const dir = scratch();
  const { code, out } = await run(["new"], dir);
  assert.equal(code, 2);
  assert.match(out.last().text, /nothing to start/);
  assert.match(out.last().text, /aflow sessions new/, "usage text should be shown");
});

test("note appends and preserves the text verbatim", async () => {
  const dir = scratch();
  const made = await run(["new", "work"], dir);
  const id = made.payload.session.id;

  const { code, payload } = await run(["note", id, "found", "the", "root", "cause"], dir, { as: "coder" });
  assert.equal(code, 0);
  assert.equal(payload.entry.text, "found the root cause");
  assert.equal(payload.entry.agent, "coder");
  assert.equal(payload.entry.seq, 1);
});

test("note without text is a usage error", async () => {
  const dir = scratch();
  const id = (await run(["new", "work"], dir)).payload.session.id;
  const { code, out } = await run(["note", id], dir);
  assert.equal(code, 2);
  assert.match(out.last().text, /note text required/);
});

test("note without an id is a usage error", async () => {
  const dir = scratch();
  const { code } = await run(["note", "some text"], dir);
  assert.equal(code, 2);
});

test("resume with no id resumes the current session", async () => {
  const dir = scratch();
  const id = (await run(["new", "work"], dir)).payload.session.id;
  await run(["note", id, "a finding"], dir);

  const { code, payload, out } = await run(["resume"], dir);
  assert.equal(code, 0);
  assert.equal(payload.current, id);
  assert.match(out.last().text, /a finding/);
});

test("resume with nothing to resume is a usage error", async () => {
  const dir = scratch();
  const { code, out } = await run(["resume"], dir);
  assert.equal(code, 2);
  assert.match(out.last().text, /no session to resume/);
});

test("resume on a missing session surfaces a not-found error", async () => {
  const dir = scratch();
  await assert.rejects(() => run(["resume", "ses_20260101T000000000Z_aaaaaa"], dir), SessionNotFoundError);
});

test("inspect shows entries and reports how many it chose to show", async () => {
  const dir = scratch();
  const id = (await run(["new", "work"], dir)).payload.session.id;
  for (let i = 0; i < 5; i++) await run(["note", id, `note ${i}`], dir);

  const { payload } = await run(["inspect", id], dir, { entries: "2" });
  assert.equal(payload.showing, "last 2");
  assert.equal(payload.entries.length, 2);
  assert.deepEqual(payload.entries.map((e) => e.seq), [4, 5]);

  const all = await run(["inspect", id], dir, { entries: "0" });
  assert.equal(all.payload.showing, "all");
  assert.equal(all.payload.entries.length, 5);
});

test("inspect renders an earlier-entries hint when truncating", async () => {
  const dir = scratch();
  const id = (await run(["new", "work"], dir)).payload.session.id;
  for (let i = 0; i < 5; i++) await run(["note", id, `note ${i}`], dir);

  const { out } = await run(["inspect", id], dir, { entries: "1" });
  assert.match(out.last().text, /4 earlier/);
});

test("inspect without an id is a usage error", async () => {
  const dir = scratch();
  const { code } = await run(["inspect"], dir);
  assert.equal(code, 2);
});

test("an invalid id is rejected before any read", async () => {
  const dir = scratch();
  await assert.rejects(() => run(["inspect", "../../../etc/passwd"], dir), SessionIdError);
});

test("rename relabels and requires a name", async () => {
  const dir = scratch();
  const id = (await run(["new", "work"], dir)).payload.session.id;

  const ok = await run(["rename", id, "better", "name"], dir);
  assert.equal(ok.payload.session.name, "better name");

  const { code } = await run(["rename", id], dir);
  assert.equal(code, 2);
});

test("archive hides a session and unarchive brings it back", async () => {
  const dir = scratch();
  const id = (await run(["new", "work"], dir)).payload.session.id;

  await run(["archive", id], dir);
  assert.equal((await run([], dir)).payload.count, 0);
  assert.equal((await run(["list"], dir)).payload.count, 0);
  assert.equal((await run(["list"], dir, { archived: true })).payload.count, 1);

  await run(["unarchive", id], dir);
  assert.equal((await run([], dir)).payload.count, 1);
});

test("an all-archived listing says so instead of claiming there are none", async () => {
  const dir = scratch();
  const id = (await run(["new", "work"], dir)).payload.session.id;
  await run(["archive", id], dir);

  const { payload, out } = await run([], dir);
  assert.equal(payload.count, 0);
  assert.equal(payload.hiddenCount, 1);
  // "no sessions yet" here would be a lie: the session exists, it is archived.
  assert.match(out.last().text, /1 archived session\(s\), hidden/);
  assert.doesNotMatch(out.last().text, /no sessions yet/);
});

test("list --project scopes to a directory", async () => {
  const dir = scratch();
  const one = path.join(os.tmpdir(), "proj-alpha");
  const two = path.join(os.tmpdir(), "proj-beta");

  const a = (await run(["new", "in alpha"], dir, { project: one })).payload.session.id;
  await run(["new", "in beta"], dir, { project: two });

  assert.equal((await run(["list"], dir, { project: one })).payload.count, 1);
  assert.equal((await run(["list"], dir, { project: one })).payload.sessions[0].id, a);
  assert.equal((await run(["list"], dir)).payload.count, 2);
});

test("done marks a session complete", async () => {
  const dir = scratch();
  const id = (await run(["new", "work"], dir)).payload.session.id;
  const { payload } = await run(["done", id], dir);
  assert.equal(payload.session.state, SESSION_STATE.COMPLETED);
  assert.ok(payload.session.completedAt);
});

test("current reports nothing before any session exists", async () => {
  const dir = scratch();
  const { code, payload, out } = await run(["current"], dir);
  assert.equal(code, 0);
  assert.equal(payload.current, null);
  assert.match(out.last().text, /no current session/);
});

test("current shows the pointed-at session", async () => {
  const dir = scratch();
  const id = (await run(["new", "work"], dir)).payload.session.id;
  const { payload } = await run(["current"], dir);
  assert.equal(payload.current, id);
  assert.equal(payload.session.id, id);
});

test("an unknown subcommand is a usage error and prints usage", async () => {
  const dir = scratch();
  const { code, out } = await run(["bogus"], dir);
  assert.equal(code, 2);
  assert.match(out.last().text, /unknown subcommand: bogus/);
  assert.match(out.last().text, /aflow sessions \[list\]/);
});

test("a corrupt session is reported in the listing instead of vanishing", async () => {
  const dir = scratch();
  const id = (await run(["new", "work"], dir)).payload.session.id;
  fs.writeFileSync(path.join(dir, `${id}.json`), "{ truncated");

  const { payload, out } = await run([], dir);
  assert.equal(payload.sessions.length, 1);
  assert.equal(payload.sessions[0].corrupt, true);
  assert.match(out.last().text, /corrupt/);

  // And inspecting it must not silently produce an empty session.
  await assert.rejects(() => run(["inspect", id], dir), /corrupt/);
});

test("JSON payloads carry the session, not the file path only", async () => {
  const dir = scratch();
  const id = (await run(["new", "work"], dir)).payload.session.id;
  const { payload } = await run(["inspect", id], dir);

  // Round-trips cleanly: the contract a script depends on.
  const parsed = JSON.parse(JSON.stringify(payload));
  assert.equal(parsed.session.id, id);
  assert.ok(Array.isArray(parsed.entries));
  assert.equal(typeof parsed.dir, "string");
});

test("every subcommand renders without throwing", async () => {
  const dir = scratch();
  const id = (await run(["new", "work"], dir)).payload.session.id;
  await run(["note", id, "something"], dir);

  // A renderer crash only shows up in text mode, so exercise every branch.
  const invocations = [
    { args: [] },
    { args: ["list"], flags: { archived: true } },
    { args: ["current"] },
    { args: ["resume"] },
    { args: ["resume", id] },
    { args: ["inspect", id] },
    { args: ["inspect", id], flags: { entries: "0" } },
    { args: ["note", id, "another"] },
    { args: ["rename", id, "renamed"] },
    { args: ["done", id] },
    { args: ["archive", id] },
    { args: ["unarchive", id] },
  ];

  for (const { args, flags } of invocations) {
    const label = args.join(" ") || "(list)";
    const { code, out } = await run(args, dir, flags);
    assert.equal(code, 0, `${label} exited ${code}`);
    assert.equal(typeof out.last().text, "string", `${label} produced no text`);
    assert.ok(!/undefined/.test(out.last().text), `${label} rendered "undefined"`);
  }
});