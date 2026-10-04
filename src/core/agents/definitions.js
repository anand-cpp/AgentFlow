// Built-in agent declarations.
//
// Every one of these is a *declaration*, not a prompt with a name. The runtime
// reads the fields; nothing anywhere switches on `agent.id`.
//
// The dominant concern in this file is least privilege, and it is worth being
// explicit about why, because the tempting alternative is to grant a broad scope
// and rely on the instruction text to keep the agent in line. That does not work:
// instructions are model input, and the model is the untrusted party in this
// system. The Coder's instructions say to run tests before claiming success, and
// the Coder nonetheless cannot run `rm -rf /` -- not because it was told not to,
// but because the permission layer has no entry for it.
//
// Two rules applied throughout:
//
//   1. An agent is granted the narrowest set of scopes that lets it do its job.
//      A Reviewer cannot write files, so it cannot "fix" the bug it found and
//      report success.
//   2. A shell allowlist is explicit and short. Anything outside it asks, rather
//      than being refused outright -- so the agent is useful interactively while
//      a destructive command is still one confirmation away rather than one
//      config edit away.
//
// Commands are token-prefix matched, so `git status` does not permit
// `git status; rm -rf /`.

import { defineAgent, CAPABILITY, TOOL_SCOPE } from "./registry.js";

const T = TOOL_SCOPE;

/**
 * Read and search are the safe pair. Every agent that needs to understand the
 * project gets these and nothing else.
 */
const READ_ONLY = { scopes: [T.READ, T.SEARCH], allow: ["read:*", "search:*"] };

/** Read, plus write for agents whose job is to change files. */
const READ_WRITE = { ...READ_ONLY, scopes: [T.READ, T.SEARCH, T.WRITE], allow: ["read:*", "search:*", "write:*"] };

export const PLANNER = defineAgent({
  id: "planner",
  name: "Planner",
  purpose: "Turn an objective into an ordered, checkable plan.",
  instructions: [
    "You turn an objective into a plan someone else can execute.",
    "",
    "Produce the smallest plan that actually reaches the goal, then stop. A plan with",
    "twelve steps where four would do is worse than four steps, because every step",
    "you cannot justify is work someone has to review and undo.",
    "",
    "For each step, say what changes and how you will know it worked. A step whose",
    "success you cannot check is a step you are guessing at.",
    "",
    "Call out the riskiest assumption you are making. If the plan depends on",
    "something you have not verified, say which thing, so it can be verified before",
    "the work starts rather than after.",
  ].join("\n"),
  capabilities: [CAPABILITY.PLANNING, CAPABILITY.REASONING, CAPABILITY.LONG_CONTEXT],
  // Planning is a reading job. It gets no write, no shell, no network -- so a plan
  // that "helpfully" applies itself is not a reachable outcome.
  tools: READ_ONLY,
  model: { requireCapabilities: [CAPABILITY.REASONING], maxTokens: 4096 },
  routing: { tierSize: 2 },
  bounds: { maxIterations: 4, maxToolCalls: 8, timeoutMs: 180_000, maxContextChars: 32_000 },
  input: {
    fields: [
      { name: "objective", type: "string", required: true, description: "what needs to be achieved" },
      { name: "constraints", type: "array", description: "things the plan must respect" },
    ],
    unknownFields: "ignore",
  },
  output: {
    fields: [
      { name: "summary", type: "string", required: true, description: "the plan in a few sentences" },
      { name: "steps", type: "array", required: true, description: "ordered steps, each with a checkable outcome" },
      { name: "risks", type: "array", description: "assumptions that need verifying first" },
    ],
    unknownFields: "reject",
  },
  failure: { maxRetries: 1, escalateTo: null },
});

/**
 * The Coder's shell policy, spelled out.
 *
 * `git status`, `git diff` and `git log` are inspection -- they change nothing, so
 * running them freely costs nothing and saves a prompt on every turn. `npm test` is
 * there because a Coder that cannot see whether its change works is guessing.
 *
 * `ask: ["shell:*"]` catches everything else in the scope. That pairing is the whole
 * trick: the agent is genuinely useful at a terminal, while `git push origin main`
 * stays one deliberate confirmation away rather than one config edit away.
 */
const CODER_SHELL = {
  scopes: [T.READ, T.SEARCH, T.WRITE, T.SHELL],
  allow: [
    "read:*",
    "search:*",
    "write:*",
    "shell:git status",
    "shell:git diff",
    "shell:git log",
    "shell:npm test",
  ],
  ask: ["shell:*"],
};

export const CODER = defineAgent({
  id: "coder",
  name: "Coder",
  purpose: "Implement a change and show evidence it works.",
  instructions: [
    "You implement changes.",
    "",
    "Read before you write. Match the surrounding style rather than your own -- a",
    "correct change that looks foreign costs the reviewer more than a slightly worse",
    "change that fits.",
    "",
    "Run the tests before you say you are done. If you cannot run them, say that",
    "plainly rather than describing what you expect them to do. \"I believe this",
    "works\" is worth nothing; \"I ran the suite and these three fail\" is worth",
    "something the next person can act on.",
    "",
    "If the task turns out to need a decision you were not asked to make -- changing",
    "a public interface, dropping a test, anything you cannot undo with a revert --",
    "stop and ask rather than deciding quietly.",
    "",
    "Report what you actually changed, including what you tried and abandoned.",
  ].join("\n"),
  capabilities: [CAPABILITY.CODING, CAPABILITY.TOOL_CALLING, CAPABILITY.LONG_CONTEXT],
  tools: CODER_SHELL,
  model: { requireCapabilities: [CAPABILITY.TOOL_CALLING, CAPABILITY.CODING], maxTokens: 8192 },
  routing: { tierSize: 2 },
  bounds: { maxIterations: 16, maxToolCalls: 60, timeoutMs: 600_000, maxContextChars: 64_000 },
  input: {
    fields: [
      { name: "task", type: "string", required: true, description: "the change to make" },
      { name: "acceptance", type: "array", description: "how the change will be judged" },
    ],
    unknownFields: "ignore",
  },
  output: {
    fields: [
      { name: "summary", type: "string", required: true, description: "what changed and why" },
      { name: "files", type: "array", description: "paths touched" },
      { name: "testsRun", type: "array", description: "the commands run and their outcome" },
      { name: "openQuestions", type: "array", description: "decisions deferred to the caller" },
    ],
    unknownFields: "reject",
  },
  failure: { maxRetries: 2 },
});

export const BUILT_INS = { planner: PLANNER, coder: CODER };

export function builtinSpecs() {
  return Object.values(BUILT_INS);
}

export function builtins() {
  return builtinSpecs();
}

export default { BUILT_INS, builtinSpecs, PLANNER, CODER };