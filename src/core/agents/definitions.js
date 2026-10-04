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

/**
 * The Tester gets the test scope and a shell allowlist made of test commands, and
 * explicitly no network. A test agent that can reach a package registry can change
 * which code it is testing by installing something, which quietly invalidates every
 * result it reports.
 */
const TESTER_TOOLS = {
  scopes: [T.READ, T.SEARCH, T.WRITE, T.TEST, T.SHELL],
  allow: [
    "read:*",
    "search:*",
    "write:*",
    "test:*",
    "shell:npm test",
    "shell:npm run test",
    "shell:npm run",
  ],
  ask: ["shell:*"],
};

export const TESTER = defineAgent({
  id: "tester",
  name: "Tester",
  purpose: "Prove a change works, or prove precisely that it does not.",
  instructions: [
    "You decide whether something actually works.",
    "",
    "Run the thing. Do not read the test file, conclude it looks fine, and report that",
    "it passes -- a test nobody ran is an assumption wearing a lab coat.",
    "",
    "When a test fails, report the failure, not a summary of your intentions. Include",
    "what was expected, what happened, and the command you ran. \"Some tests fail\" is",
    "not a result; it is a way of avoiding one.",
    "",
    "If you cannot run the tests, say so and stop. A Tester that reports success",
    "without having run anything is worse than no Tester, because the claim is",
    "believed.",
    "",
    "Write tests that fail for the right reason. A test that passes against broken",
    "code is worse than no test: it is a false assurance with a coverage number",
    "attached.",
  ].join("\n"),
  capabilities: [CAPABILITY.CODING, CAPABILITY.TOOL_CALLING],
  tools: TESTER_TOOLS,
  model: { requireCapabilities: [CAPABILITY.CODING, CAPABILITY.TOOL_CALLING], maxTokens: 4096 },
  routing: { tierSize: 2 },
  bounds: { maxIterations: 12, maxToolCalls: 50, timeoutMs: 600_000, maxContextChars: 48_000 },
  input: {
    fields: [
      { name: "target", type: "string", required: true, description: "what to exercise, or what to test" },
      { name: "expectations", type: "array", description: "the behaviours that must hold" },
    ],
    unknownFields: "ignore",
  },
  output: {
    fields: [
      { name: "summary", type: "string", required: true, description: "what passed, what failed, what was run" },
      { name: "ran", type: "boolean", required: true, description: "true only if the tests were actually executed" },
      { name: "failures", type: "array", description: "each with expected, actual and the command run" },
    ],
    unknownFields: "reject",
  },
  failure: { maxRetries: 1 },
});

/**
 * The Researcher is the only agent that asks before it touches the network, and the
 * policy is deliberately blunt: read and search freely, every fetch asks.
 *
 * There is no host allowlist here. Hard-coding a few well-known hosts would be
 * arbitrary and would rot; the honest version is "this agent can read your disk and
 * your search results without asking, and every outbound request is a decision you
 * make".
 */
const RESEARCHER_TOOLS = {
  scopes: [T.READ, T.SEARCH, T.NETWORK],
  allow: ["read:*", "search:*"],
  ask: ["network:*"],
};

export const RESEARCHER = defineAgent({
  id: "researcher",
  name: "Researcher",
  purpose: "Answer a question from evidence, and say how confident that is.",
  instructions: [
    "You answer questions from sources you can point at.",
    "",
    "Cite where each claim came from, and separate what a source says from what you",
    "inferred. An inference presented as a finding is how a wrong answer acquires",
    "authority.",
    "",
    "Prefer primary sources -- the specification, the documentation, the source",
    "itself. Secondary summaries drift, and a confident wrong citation is worse than",
    "no citation because it discourages anyone from checking.",
    "",
    "Say when you could not find something, or when the sources disagree. \"The docs",
    "say X, the code does Y\" is a useful answer. A single smooth answer that quietly",
    "picks a side is not.",
    "",
    "Stop when you have enough to answer. Research that keeps gathering after the",
    "question is settled is how a three-line answer becomes a two-thousand-line",
    "report.",
  ].join("\n"),
  capabilities: [CAPABILITY.RESEARCH, CAPABILITY.LONG_CONTEXT, CAPABILITY.REASONING],
  tools: RESEARCHER_TOOLS,
  model: { requireCapabilities: [CAPABILITY.RESEARCH, CAPABILITY.REASONING], maxTokens: 8192 },
  routing: { tierSize: 3 },
  bounds: { maxIterations: 8, maxToolCalls: 30, timeoutMs: 420_000, maxContextChars: 128_000 },
  input: {
    fields: [
      { name: "question", type: "string", required: true, description: "what to find out" },
      { name: "sources", type: "array", description: "places worth starting from" },
    ],
    unknownFields: "ignore",
  },
  output: {
    fields: [
      { name: "summary", type: "string", required: true, description: "the answer in a few sentences" },
      { name: "findings", type: "array", description: "each claim with its source" },
      { name: "confidence", type: "string", required: true, description: "high, medium or low, and why" },
      { name: "gaps", type: "array", description: "what remains unanswered" },
    ],
    unknownFields: "reject",
  },
  failure: { maxRetries: 1 },
});

/**
 * The Security agent audits and does not remediate.
 *
 * Same reasoning as the Reviewer: an auditor that patches what it finds has
 * destroyed the evidence and marked its own homework. The finding goes to the
 * Debugger or the Coder, and the fix lands in the open.
 */
export const SECURITY = defineAgent({
  id: "security",
  name: "Security",
  purpose: "Find the vulnerability that is actually there, not the one that is easy to report.",
  instructions: [
    "You look for vulnerabilities and report what you can demonstrate.",
    "",
    "Trace untrusted input to where it is used. A finding is a path from something an",
    "attacker controls to something that matters -- not a function name that looks",
    "concerning.",
    "",
    "Rank by what an attacker gains, not by how interesting the bug is. Report the",
    "boring SQL injection with real reach above the elegant theoretical one with",
    "none.",
    "",
    "Say what you did not check. An audit that lists findings without stating its",
    "limits reads as comprehensive when it is partial, and someone will rely on the",
    "implied completeness.",
    "",
    "Suggest the fix, but do not apply it. An auditor that edits the code has removed",
    "the proof and reviewed its own work in the same step.",
    "",
    "Report a suspected credential as a credential -- do not reproduce it. Name the",
    "file and the line and stop.",
  ].join("\n"),
  capabilities: [CAPABILITY.SECURITY, CAPABILITY.REASONING, CAPABILITY.LONG_CONTEXT],
  tools: READ_ONLY,
  model: { requireCapabilities: [CAPABILITY.SECURITY, CAPABILITY.REASONING], maxTokens: 8192 },
  routing: { tierSize: 2 },
  bounds: { maxIterations: 12, maxToolCalls: 50, timeoutMs: 600_000, maxContextChars: 96_000 },
  input: {
    fields: [
      { name: "scope", type: "string", required: true, description: "what to audit" },
      { name: "threatModel", type: "string", description: "what an attacker is assumed to be able to do" },
    ],
    unknownFields: "ignore",
  },
  output: {
    fields: [
      { name: "summary", type: "string", required: true, description: "the audit's conclusion in a few sentences" },
      { name: "findings", type: "array", description: "each with severity, a demonstrated path and a suggested fix" },
      { name: "notChecked", type: "array", required: true, description: "what was outside the audit" },
    ],
    unknownFields: "reject",
  },
  failure: { maxRetries: 1 },
});

/**
 * Release is the highest-privilege agent in the system, so its policy is built
 * backwards from the irreversible actions rather forwards from the useful ones.
 *
 * Everything that can change the outside world is `ask`. There is no silent path to
 * publish, push, tag or deploy -- not because those are forbidden, but because the
 * release operator is the one who should decide when they happen. The allowlist is
 * only what is genuinely read-only: version checks, status, and a dry run.
 */
const RELEASE_TOOLS = {
  scopes: [T.READ, T.SEARCH, T.TEST, T.SHELL],
  allow: [
    "read:*",
    "search:*",
    "test:*",
    "shell:git status",
    "shell:git diff",
    "shell:git log",
    "shell:npm test",
    "shell:npm pack --dry-run",
  ],
  // Note there is no `shell:git tag`, even for listing. Entries match on token
  // prefixes, so allowing `git tag` also allows `git tag -f v1` -- which
  // force-moves a published tag and breaks anyone who already fetched it. Listing
  // tags is not worth that, so the whole verb asks.
  ask: ["shell:*", "network:*"],
};

export const RELEASE = defineAgent({
  id: "release",
  name: "Release",
  purpose: "Prepare a release and verify it, publishing only on explicit instruction.",
  instructions: [
    "You prepare releases. You do not decide to ship one.",
    "",
    "Check the release criteria before anything else and report each one with its",
    "evidence: clean tests, no uncommitted changes, version bumped, changelog written,",
    "disclosure status reviewed. Report the ones that fail as plainly as the ones that",
    "pass -- a checklist reported optimistically is worse than no checklist.",
    "",
    "Propose the release notes from what actually changed. Do not describe features you",
    "cannot point at in the diff.",
    "",
    "Treat publishing as a separate, explicit step that requires its own instruction.",
    "Prepare everything, then stop and say what you are about to do. If you were asked",
    "to publish, publish exactly what you said you would publish -- no extra tags, no",
    "last-minute fixes that were not part of the release.",
    "",
    "Never skip a failing check to keep a release moving. A release that ships known",
    "broken is recoverable; the trust that made the rollback possible is not.",
  ].join("\n"),
  capabilities: [CAPABILITY.PLANNING, CAPABILITY.TOOL_CALLING, CAPABILITY.REASONING],
  tools: RELEASE_TOOLS,
  model: { requireCapabilities: [CAPABILITY.TOOL_CALLING, CAPABILITY.PLANNING], maxTokens: 4096 },
  routing: { tierSize: 2 },
  bounds: { maxIterations: 8, maxToolCalls: 30, timeoutMs: 300_000, maxContextChars: 48_000 },
  input: {
    fields: [
      { name: "version", type: "string", required: true, description: "the version being released" },
      { name: "notes", type: "string", description: "draft release notes, if they exist" },
    ],
    unknownFields: "ignore",
  },
  output: {
    fields: [
      { name: "summary", type: "string", required: true, description: "what was prepared, and whether it is ready" },
      { name: "checks", type: "array", required: true, description: "each release criterion with pass or fail" },
      { name: "blockers", type: "array", description: "what must be resolved before shipping" },
      { name: "published", type: "boolean", required: true, description: "true only if publishing was explicitly done" },
    ],
    unknownFields: "reject",
  },
  failure: { maxRetries: 0 },
});

export const BUILT_INS = {
  planner: PLANNER,
  coder: CODER,
  reviewer: REVIEWER,
  debugger: DEBUGGER,
  tester: TESTER,
  researcher: RESEARCHER,
  security: SECURITY,
  release: RELEASE,
};

export function builtinSpecs() {
  return Object.values(BUILT_INS);
}

export function builtins() {
  return builtinSpecs();
}

export default {
  BUILT_INS,
  builtinSpecs,
  PLANNER,
  CODER,
  REVIEWER,
  DEBUGGER,
  TESTER,
  RESEARCHER,
  SECURITY,
  RELEASE,
};