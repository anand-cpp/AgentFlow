// shell.execute.
//
// The most dangerous tool here, and the one with the least excuse to be casual:
// it runs a string a language model produced. Three properties make it
// defensible.
//
// 1. It is behind the SHELL scope, which no agent gets by accident. The waterfall
//    in tools.js decides, and `shell.execute` asks for nothing special.
//
// 2. There is no shell. `spawn` with an argv array and `shell: false`, so `;`,
//    `&&`, backticks and `$(...)` are literal arguments rather than syntax. The
//    alternative -- handing a model a string to `sh -c` -- means one approval
//    covers every command the model can think of next.
//
// 3. It does not claim to be a sandbox, because it is not one. See the honest
//    note on `shell.execute` below; the docs say so too.
//
// What it does do: run in a directory inside the workspace, hand over an
// environment with credential-shaped variables removed, cap stdout and stderr
// separately, kill the process tree on timeout or cancellation, and report the
// exit code and signal.

import { spawn, spawnSync } from "node:child_process";

import { TOOL_SCOPE } from "./registry.js";
import { TOOL_ERROR, ToolInvocationError } from "./tool-errors.js";
import { resolveInWorkspace, requireWorkspaceRoot } from "./tool-paths.js";
import { boundOutput, DEFAULT_MAX_BYTES } from "./tool-bounds.js";
import { scrubEnv } from "./tools.js";
import { redact } from "../redact.js";

/**
 * Commands refused outright, whatever the permission decision was.
 *
 * This is not a permission layer and does not pretend to be one -- the waterfall
 * already decided. It is a last check for the commands where being *approved* is
 * not the same as being *safe*: `rm -rf /` destroys the filesystem, and no
 * approval prompt should be able to talk a user into it by not reading carefully.
 *
 * Matched against the program name only, and anchored, so `rm` in
 * `/usr/bin/rm` is caught while `firmware-check` is not.
 */
const FORBIDDEN_PROGRAMS = [
  // Destroys a filesystem, and takes the arguments with it.
  /^rm$/,
  // Recursive force-delete under another name; also `find -delete`, `shred`.
  /^shred$/,
  // Writes raw devices. `dd if=/dev/zero of=/dev/sda`.
  /^dd$/,
  // Fork bombs and disk fill.
  /^(mkfs(\.\w+)?|fdisk|parted)$/,
  // Rewrites the boot chain.
  /^shutdown$/,
];

/**
 * Refusals that are about a *subcommand*, not a program.
 *
 * `npm publish` cannot live in the list above: that list is matched against
 * argv[0], which is `npm`, and a regex for `npm publish` tested against the string
 * `npm` never matches. A rule that looks like a guard and cannot fire is worse than
 * no rule, because the code reads as though publishing is handled.
 */
const FORBIDDEN_SUBCOMMANDS = [
  // Publishing is irreversible the same way a deploy is: the registry keeps the
  // tarball forever. `release` is its own permission scope for this, but approval
  // of `npm` should not silently cover it.
  { program: /^npm$/, subcommand: /^publish$/ },
  { program: /^npm$/, subcommand: /^unpublish$/ },
  { program: /^git$/, subcommand: /^push$/, extra: /(--force|-f|--delete)/ },
];

function refuseRefusal(what) {
  throw new ToolInvocationError(
    TOOL_ERROR.PERMISSION_DENIED,
    `refusing to run ${what}: this tool will not execute it even with approval`,
    { command: what },
  );
}

/**
 * Kill the child and everything it started.
 *
 * On Windows `taskkill /T` walks the tree. On POSIX the child is made a process
 * *group* leader (see `detached` below) so the group can be signalled; without
 * that, `kill(-pid)` has no group to signal and only the direct child dies,
 * leaving `sh -c 'sleep 1000 & wait'` running after the tool reported it was killed.
 */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    }
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // No group (or already reaped): fall back to the direct child.
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Refuse rather than truncate: a command that printed 10MB has not been
 *  usefully observed, and the bound exists to keep the context window sane. */
export const MAX_CAPTURE_BYTES = 1024 * 1024;

export const shellTool = {
  name: "shell.execute",
  scope: TOOL_SCOPE.SHELL,
  description:
    "Run one program inside the workspace with an explicit argument list and no shell. Runs in a scrubbed environment, is bounded in output, and is killed on timeout. Not a sandbox: the command has this process's OS privileges.",
  inputSchema: {
    type: "object",
    required: ["command"],
    additionalProperties: false,
    properties: {
      command: { type: "string", description: "Program to run. Passed to spawn as argv[0]; never interpreted by a shell." },
      args: { type: "array", items: { type: "string" }, description: "Arguments, passed as argv. Not shell-parsed." },
      cwd: { type: "string", description: "Working directory, workspace-relative. Defaults to the workspace root." },
      timeoutMs: { type: "integer", minimum: 1, maximum: 600_000, description: "Defaults to 30000." },
      maxBytes: { type: "integer", minimum: 1, maximum: MAX_CAPTURE_BYTES, description: "Per-stream output bound." },
    },
  },
  resultSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      args: { type: "array", items: { type: "string" }, description: "Exactly what was passed as argv." },
      cwd: { type: "string" },
      exitCode: { type: "integer", description: "Null when killed by a signal." },
      signal: { type: "string", description: "Null when the process exited on its own." },
      stdout: { type: "string", description: "Bounded, with a notice appended when truncated." },
      stderr: { type: "string" },
      stdoutTruncated: { type: "boolean" },
      stderrTruncated: { type: "boolean" },
      stdoutBytes: { type: "integer", description: "True byte count even when output was cut." },
      stderrBytes: { type: "integer" },
      durationMs: { type: "integer" },
      redacted: { type: "boolean" },
      sandboxed: { type: "boolean", description: "Always false. Stated so no caller assumes containment." },
    },
  },
  failureBehavior: {
    INVALID_INPUT: "error (bad command or args)",
    OUTSIDE_WORKSPACE: "error (cwd escapes the workspace)",
    PERMISSION_DENIED: "error (destructive program or publishing subcommand, even with approval)",
    NOT_FOUND: "error (program is not on PATH)",
    PROCESS_FAILED: "error (could not be started)",
    TIMEOUT: "error (killed, with the timeout that fired)",
    CANCELLED: "error (killed on abort)",
    NON_ZERO_EXIT: "NOT an error -- returned as a result with exitCode, because grep finding nothing is a successful grep",
  },
  limits: { defaultTimeoutMs: DEFAULT_TIMEOUT_MS, maxTimeoutMs: 600_000, perStreamCaptureBytes: MAX_CAPTURE_BYTES },
  redaction: "Applied to stdout and stderr. The child also receives a scrubbed environment, so it never holds a key to print in the first place.",
  events: ["tool.call", "tool.denied", "tool.error"],

  async execute(args = {}, ctx = {}) {
    const root = requireWorkspaceRoot(ctx);
    const command = args.command;
    if (typeof command !== "string" || command.trim() === "") {
      throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, "command must be a non-empty string");
    }
    const argv = args.args == null ? [] : args.args;
    if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) {
      throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, "args must be an array of strings");
    }

    // The program name is the part that gets executed. A forbidden check against
    // the whole joined string would be trivially bypassed by an argument that
    // happens to start with `rm -rf`, so this is anchored on argv[0] alone.
    const program = path_basename(command);
    for (const pattern of FORBIDDEN_PROGRAMS) {
      if (pattern.test(program)) refuseRefusal(program);
    }
    for (const rule of FORBIDDEN_SUBCOMMANDS) {
      if (!rule.program.test(program)) continue;
      // Only a *leading* subcommand counts. `npm run publish-later` is not publish,
      // and refusing it would be the kind of over-broad rule that trains people to
      // disable the tool.
      const sub = argv.find((a) => typeof a === "string" && !a.startsWith("-"));
      if (sub === undefined) continue;
      if (!rule.subcommand.test(sub)) continue;
      if (rule.extra && !argv.some((a) => rule.extra.test(a))) continue;
      refuseRefusal(`${program} ${sub}`);
    }

    const { resolved: cwd } = resolveInWorkspace(root, args.cwd ?? ".", { label: "cwd" });

    const timeoutMs = clampInt(args.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 600_000);
    const maxBytes = clampInt(args.maxBytes, DEFAULT_MAX_BYTES, 1, MAX_CAPTURE_BYTES);

    if (ctx.signal?.aborted) {
      throw new ToolInvocationError(TOOL_ERROR.CANCELLED, "cancelled before the process started");
    }

    const startedAt = Date.now();

    // Not the ambient environment, and not anything the call supplied. scrubEnv is
    // the same function the waterfall passes to every tool, so a spawned `git` or
    // `npm` cannot echo a key that tools.js already decided must not reach
    // untrusted output.
    //
    // There is deliberately no per-call env override, even though one would be
    // convenient: the schema forbids extra properties, so honouring one would mean
    // accepting input the tool claims to reject -- and an env override is an
    // arbitrary-code-execution primitive (`NODE_OPTIONS=--require ...`,
    // `LD_PRELOAD`) that no later scrubbing of *values* would catch. The operator
    // sets the environment; the model does not.
    const env = scrubEnv(ctx.env || process.env);

    const result = await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(command, argv, {
          cwd,
          env,
          // The load-bearing line. No shell means `;`, `&&`, `|`, backticks and
          // `$(...)` are ordinary characters in ordinary arguments, so approving
          // `git status` cannot become approving `git status; rm -rf /`.
          shell: false,
          windowsHide: true,
          // POSIX only. A group leader is what makes `kill(-pid)` able to reach the
          // child *and its descendants*; without it a timeout kills one process and
          // orphans whatever it spawned. Windows has no equivalent, and `detached`
          // there would only detach the console, so taskkill /T does that job.
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        reject(
          new ToolInvocationError(TOOL_ERROR.PROCESS_FAILED, `could not start ${program}: ${err?.code || "spawn failed"}`, {
            command: program,
          }),
        );
        return;
      }

      const stdout = [];
      const stderr = [];
      let outBytes = 0;
      let errBytes = 0;
      // Tracked per stream, not as one flag. A shared flag cannot answer "was
      // *this* stream cut?", and getting that wrong makes a tool claim it returned
      // complete output after silently discarding it.
      let outOverflowed = false;
      let errOverflowed = false;
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let timer = null;

      const onAbort = () => {
        cancelled = true;
        killTree(child);
      };
      ctx.signal?.addEventListener?.("abort", onAbort, { once: true });

      // Counts past the cap are dropped, not buffered: the point of a bound is
      // that a program printing without limit cannot exhaust memory. The total is
      // still counted so the result can say how much was discarded.
      //
      // `chunk` is one Buffer. Iterating it with for..of would yield byte *values*,
      // not chunks, which is the sort of mistake that reads as a stream bug.
      const capture = (chunks, chunk, isOut) => {
        const overflowed = isOut ? outOverflowed : errOverflowed;
        const used = isOut ? outBytes : errBytes;
        if (overflowed) {
          if (isOut) outBytes += chunk.length;
          else errBytes += chunk.length;
          return;
        }
        const room = maxBytes - used;
        if (chunk.length <= room) {
          chunks.push(chunk);
          if (isOut) outBytes += chunk.length;
          else errBytes += chunk.length;
        } else {
          chunks.push(chunk.subarray(0, room));
          if (isOut) {
            outBytes += room;
            outOverflowed = true;
          } else {
            errBytes += room;
            errOverflowed = true;
          }
        }
      };

      child.stdout.on("data", (c) => capture(stdout, c, true));
      child.stderr.on("data", (c) => capture(stderr, c, false));

      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        ctx.signal?.removeEventListener?.("abort", onAbort);
        fn(value);
      };

      child.on("error", (err) => {
        // ENOENT is the common one: the program simply is not installed. That is a
        // caller error, not an internal fault, and conflating the two makes every
        // missing binary look like a bug in the tool.
        if (err?.code === "ENOENT") {
          finish(
            reject,
            new ToolInvocationError(TOOL_ERROR.PROCESS_FAILED, `${program} was not found on PATH`, {
              command: program,
            }),
          );
          return;
        }
        finish(
          reject,
          new ToolInvocationError(TOOL_ERROR.PROCESS_FAILED, `${program} could not be run: ${err?.code || "error"}`, {
            command: program,
          }),
        );
      });

      child.on("close", (code, signal) => {
        const outBuf = Buffer.concat(stdout);
        const errBuf = Buffer.concat(stderr);
        finish(resolve, {
          code,
          signal,
          timedOut,
          cancelled,
          stdout: outBuf,
          stderr: errBuf,
          outBytes,
          errBytes,
          outOverflowed,
          errOverflowed,
          durationMs: Date.now() - startedAt,
        });
      });
    });

    if (result.timedOut) {
      throw new ToolInvocationError(TOOL_ERROR.TIMEOUT, `${program} exceeded ${timeoutMs}ms and was killed`, {
        command: program,
        timeoutMs,
        stdoutBytes: result.outBytes,
        stderrBytes: result.errBytes,
      });
    }
    if (result.cancelled) {
      throw new ToolInvocationError(TOOL_ERROR.CANCELLED, `${program} was cancelled and killed`, {
        command: program,
        stdoutBytes: result.outBytes,
        stderrBytes: result.errBytes,
      });
    }

    // The capture cap and this bound are the same number, so a stream dropped while
    // being captured arrives here sitting *exactly* on the limit. Measuring alone
    // would call that complete, so the real byte count is passed through: a command
    // that printed 17KB through a 1KB cap has to be reported as truncated, and the
    // notice appended to the text so a model reading it as prose sees the cut.
    const stdout = boundOutput(result.stdout.toString("utf8"), maxBytes, {
      label: "stdout",
      redaction: redact,
      originalSize: result.outBytes,
    });
    const stderr = boundOutput(result.stderr.toString("utf8"), maxBytes, {
      label: "stderr",
      redaction: redact,
      originalSize: result.errBytes,
    });

    const stdoutTruncated = result.outOverflowed || stdout.truncated;
    const stderrTruncated = result.errOverflowed || stderr.truncated;

    // A non-zero exit is a *result*, not a tool failure: `grep` finding nothing and
    // `git diff --quiet` both exit non-zero on success. The caller branches on
    // `exitCode`. Only an actual inability to run is PROCESS_FAILED.
    return {
      command,
      args: argv,
      cwd,
      exitCode: result.code,
      signal: result.signal,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated,
      stderrTruncated,
      stdoutBytes: result.outBytes,
      stderrBytes: result.errBytes,
      durationMs: result.durationMs,
      redacted: Boolean(stdout.redacted || stderr.redacted),
      sandboxed: false,
    };
  },
};

function path_basename(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export const shellTools = [shellTool];

export default { shellTool, shellTools, FORBIDDEN_PROGRAMS, DEFAULT_TIMEOUT_MS, MAX_CAPTURE_BYTES };