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

/**
 * The Reviewer is read-only on purpose.
 *
 * A reviewer that can edit is not a reviewer: it finds the problem, fixes it, and
 * reports "reviewed, looks good" -- reviewing its own work with no second pair of
 * eyes anywhere in the process. The fix belongs to the Coder, who can be judged on
 * it afterwards.
 */
export const REVIEWER = defineAgent({
  id: "reviewer",
  name: "Reviewer",
  purpose: "Judge a change against what it was supposed to do.",
  instructions: [
    "You review changes other people made.",
    "",
    "Read the diff and the surrounding code, not the description of the change. The",
    "description is a claim; the code is the evidence, and the two are frequently",
    "different.",
    "",
    "Judge against the change's stated intent. A correct implementation of the wrong",
    "thing is a finding, not a pass.",
    "",
    "Report what is actually wrong, ranked by consequence, with the file and line. If",
    "you cannot point at a line, you do not have a finding -- you have a feeling, and",
    "feelings do not belong in a review. Say plainly when a change looks correct; a",
    "review that manufactures objections to seem thorough is as useless as one that",
    "rubber-stamps.",
    "",
    "You cannot edit files. If something needs fixing, say so precisely and let the",
    "Coder do it.",
  ].join("\n"),
  capabilities: [CAPABILITY.CODING, CAPABILITY.REASONING, CAPABILITY.LONG_CONTEXT],
  tools: READ_ONLY,
  model: { requireCapabilities: [CAPABILITY.REASONING, CAPABILITY.CODING], maxTokens: 8192 },
  routing: { tierSize: 2 },
  bounds: { maxIterations: 10, maxToolCalls: 40, timeoutMs: 420_000, maxContextChars: 96_000 },
  input: {
    fields: [
      { name: "change", type: "string", required: true, description: "what was changed, or where to look" },
      { name: "intent", type: "string", description: "what the change is supposed to accomplish" },
    ],
    unknownFields: "ignore",
  },
  output: {
    fields: [
      { name: "summary", type: "string", required: true, description: "the verdict in a few sentences" },
      { name: "verdict", type: "string", required: true, description: "approve, or request_changes, or comment" },
      { name: "findings", type: "array", description: "each with a file, a line and a consequence" },
    ],
    unknownFields: "reject",
  },
  failure: { maxRetries: 1 },
});

/**
 * The Debugger is the only agent with write plus shell, and it is bounded tightly on
 * purpose: a debugging loop that can edit files, run commands and retry can turn a
 * small bug report into a large diff nobody asked for.
 */
const DEBUGGER_SHELL = {
  scopes: [T.READ, T.SEARCH, T.WRITE, T.TEST, T.SHELL],
  allow: [
    "read:*",
    "search:*",
    "write:*",
    "test:*",
    "shell:git status",
    "shell:git diff",
    "shell:git log",
    "shell:npm test",
    "shell:npm run",
  ],
  ask: ["shell:*"],
};

export const DEBUGGER = defineAgent({
  id: "debugger",
  name: "Debugger",
  purpose: "Find the actual cause of a failure, then fix that and nothing else.",
  instructions: [
    "You find the cause of a failure and fix it.",
    "",
    "Reproduce it before you change anything. A fix applied to a cause you guessed at",
    "is a coincidence that will read as a success and fail again later.",
    "",
    "Follow the evidence. Read the error, read the code path it names, and keep going",
    "until you can say why this input produces this output -- not merely what changed",
    "to stop the symptom. A change that makes the test go away without explaining the",
    "cause is a deletion of evidence, not a fix.",
    "",
    "Change as little as the cause requires. While debugging you will notice unrelated",
    "problems; note them and leave them alone. A fix bundled with three refactors is a",
    "fix nobody can review.",
    "",
    "Verify the original failure is gone, and say what you ran to confirm it.",
  ].join("\n"),
  capabilities: [CAPABILITY.REASONING, CAPABILITY.TOOL_CALLING, CAPABILITY.CODING],
  tools: DEBUGGER_SHELL,
  model: { requireCapabilities: [CAPABILITY.REASONING, CAPABILITY.TOOL_CALLING], maxTokens: 8192 },
  routing: { tierSize: 2 },
  bounds: { maxIterations: 16, maxToolCalls: 60, timeoutMs: 600_000, maxContextChars: 64_000 },
  input: {
    fields: [
      { name: "symptom", type: "string", required: true, description: "what is failing, and how it was observed" },
      { name: "repro", type: "string", description: "the command or input that triggers it" },
    ],
    unknownFields: "ignore",
  },
  output: {
    fields: [
      { name: "summary", type: "string", required: true, description: "the cause and the fix, briefly" },
      { name: "diagnosis", type: "string", required: true, description: "why the failure happened" },
      { name: "fix", type: "array", description: "the files and lines changed" },
      { name: "verification", type: "array", description: "commands run and their results" },
    ],
    unknownFields: "reject",
  },
  failure: { maxRetries: 2 },
});

export const BUILT_INS = { planner: PLANNER, coder: CODER, reviewer: REVIEWER, debugger: DEBUGGER };

export function builtinSpecs() {
  return Object.values(BUILT_INS);
}

export function builtins() {
  return builtinSpecs();
}

export default { BUILT_INS, builtinSpecs, PLANNER, CODER, REVIEWER, DEBUGGER };