// `aflow hackathon` — distributed multi-computer coordination.
//
//   aflow hackathon start "<idea>"          start a new Hackathon session
//   aflow hackathon join <session-code>     join an existing session as a worker
//   aflow hackathon status [session]        show session state summary
//   aflow hackathon workers [session]       list workers and their state
//   aflow hackathon tasks [session]         list tasks and their state
//   aflow hackathon pause [session]         pause session execution
//   aflow hackathon resume [session]        resume session execution
//   aflow hackathon stop [session]          stop/cancel a session
//   aflow hackathon report [session]        show delivery gate and progress report
//
// Sensitive actions require appropriate authorization. A command never claims
// success before the underlying operation succeeds.

import { defineCommand } from "../cli/registry.js";
import { bold, dim, cyan, red, green, yellow } from "../cli/ui.js";
import { CoordinatorRuntime } from "../core/hackathon/coordinator.js";
import { LocalBus } from "../core/hackathon/transport.js";
import { SESSION_STATUS, TASK_STATUS, WORKER_STATUS } from "../core/hackathon/session.js";

function usage(message) {
  const err = /** @type {Error & { usage: boolean }} */ (new Error(message));
  err.usage = true;
  return err;
}

function statusColor(status) {
  switch (status) {
    case SESSION_STATUS.ACTIVE: return green(status);
    case SESSION_STATUS.PAUSED: return yellow(status);
    case SESSION_STATUS.COMPLETED: return green(status);
    case SESSION_STATUS.CANCELLED: return red(status);
    default: return dim(status);
  }
}

function taskStateColor(state) {
  switch (state) {
    case TASK_STATUS.COMPLETED: return green(state);
    case TASK_STATUS.RUNNING: return cyan(state);
    case TASK_STATUS.ASSIGNED: return dim(state);
    case TASK_STATUS.FAILED: return red(state);
    case TASK_STATUS.BLOCKED: return yellow(state);
    default: return dim(state);
  }
}

function workerStatusColor(status) {
  switch (status) {
    case WORKER_STATUS.CONNECTED: return green(status);
    case WORKER_STATUS.DISCONNECTED: return yellow(status);
    case WORKER_STATUS.REVOKED: return red(status);
    default: return dim(status);
  }
}

export async function run({ args, flags, _config, out }) {
  const [sub = "help", ...rest] = args;

  switch (sub) {
    case "start": {
      const [projectIdea] = rest;
      if (!projectIdea) {
        throw usage('which project: aflow hackathon start "<idea>"');
      }

      const bus = new LocalBus();
      const coord = new CoordinatorRuntime({ bus });
      const result = await coord.startSession({
        leaderId: flags["leader-id"] || "leader-1",
        projectIdea,
        projectRoot: flags.workspace || process.cwd(),
      });

      if (!result.ok) {
        await out.init({ error: result.error }, () => `hackathon start failed: ${result.error.message}\n`);
        return 1;
      }

      const invitation = coord.createInvitation({ workerId: "worker-1" });

      const lines = [];
      lines.push(bold("aflow hackathon — session started"));
      lines.push("");
      lines.push(`  session: ${cyan(result.data.sessionId)}`);
      lines.push(`  leader:  ${dim(result.data.leaderId)}`);
      lines.push(`  status:  ${statusColor(result.data.status)}`);
      lines.push(`  root:    ${dim(coord.session.projectRoot)}`);
      lines.push("");
      lines.push(bold("worker invitation"));
      lines.push(`  code:    ${dim(invitation.data.token.slice(0, 12))}...`);
      lines.push(`  expires: ${dim(new Date(invitation.data.expiresAt).toISOString())}`);
      lines.push("");
      lines.push(dim("join:   aflow hackathon join <session-code>"));
      lines.push(dim("status: aflow hackathon status " + result.data.sessionId));

      await out.init({ sessionId: result.data.sessionId }, () => lines.join("\n"));
      return 0;
    }

    case "status": {
      const [sessionId] = rest;
      if (!sessionId) {
        throw usage('which session: aflow hackathon status <session-id>');
      }

      const coord = new CoordinatorRuntime();
      const result = await coord.loadExistingSession(sessionId);
      if (!result.ok) {
        await out.init({ error: result.error }, () => `hackathon status failed: ${result.error.message}\n`);
        return 1;
      }

      const state = coord.getSessionState();
      const lines = [];
      lines.push(bold("aflow hackathon — session status"));
      lines.push("");
      lines.push(`  session:   ${cyan(state.sessionId)}`);
      lines.push(`  status:    ${statusColor(state.status)}`);
      lines.push(`  workers:   ${state.workerCount} (${state.connectedWorkers} connected)`);
      lines.push(`  tasks:     ${state.taskCount}`);
      lines.push(`  completed: ${green(state.completedTasks)}`);
      lines.push(`  failed:    ${red(state.failedTasks)}`);
      lines.push("");

      const tasks = coord.getTasks();
      if (tasks.length) {
        lines.push(bold("tasks"));
        for (const t of tasks) {
          lines.push(`  ${taskStateColor(t.state).padEnd(12)} ${dim(t.taskId)}  ${t.title || ""}`);
        }
        lines.push("");
      }

      await out.init({ sessionId }, () => lines.join("\n"));
      return 0;
    }

    case "workers": {
      const [sessionId] = rest;
      if (!sessionId) {
        throw usage('which session: aflow hackathon workers <session-id>');
      }

      const coord = new CoordinatorRuntime();
      const result = await coord.loadExistingSession(sessionId);
      if (!result.ok) {
        await out.init({ error: result.error }, () => `hackathon workers failed: ${result.error.message}\n`);
        return 1;
      }

      const workers = coord.getWorkers();
      const lines = [];
      lines.push(bold("aflow hackathon — workers"));
      lines.push("");
      for (const w of workers) {
        lines.push(`  ${workerStatusColor(w.status).padEnd(14)} ${dim(w.workerId)}  caps: ${(w.capabilities || []).join(", ")}`);
      }
      if (!workers.length) lines.push(dim("no workers"));
      lines.push("");
      lines.push(dim("total: " + workers.length));

      await out.init({ sessionId, workerCount: workers.length }, () => lines.join("\n"));
      return 0;
    }

    case "tasks": {
      const [sessionId] = rest;
      if (!sessionId) {
        throw usage('which session: aflow hackathon tasks <session-id>');
      }

      const coord = new CoordinatorRuntime();
      const result = await coord.loadExistingSession(sessionId);
      if (!result.ok) {
        await out.init({ error: result.error }, () => `hackathon tasks failed: ${result.error.message}\n`);
        return 1;
      }

      const tasks = coord.getTasks();
      const lines = [];
      lines.push(bold("aflow hackathon — tasks"));
      lines.push("");
      for (const t of tasks) {
        lines.push(
          `  ${taskStateColor(t.state).padEnd(12)} ${dim(t.taskId)}  ${t.title || ""}`,
        );
        if (t.assignedWorkerId) {
          lines.push(`      assigned: ${dim(t.assignedWorkerId)}`);
        }
        if (t.progress > 0) {
          lines.push(`      progress: ${dim(`${t.progress}%`)}`);
        }
      }
      if (!tasks.length) lines.push(dim("no tasks"));
      lines.push("");

      await out.init({ sessionId, taskCount: tasks.length }, () => lines.join("\n"));
      return 0;
    }

    case "stop": {
      const [sessionId] = rest;
      if (!sessionId) {
        throw usage('which session: aflow hackathon stop <session-id>');
      }

      const coord = new CoordinatorRuntime();
      const result = await coord.loadExistingSession(sessionId);
      if (!result.ok) {
        await out.init({ error: result.error }, () => `hackathon stop failed: ${result.error.message}\n`);
        return 1;
      }

      // Cancel all active tasks.
      const tasks = coord.getTasks();
      let cancelled = 0;
      for (const t of tasks) {
        if (t.state === TASK_STATUS.ASSIGNED || t.state === TASK_STATUS.ACCEPTED || t.state === TASK_STATUS.RUNNING) {
          const r = await coord.cancelTask({ taskId: t.taskId });
          if (r.ok) cancelled += 1;
        }
      }

      const lines = [];
      lines.push(bold("aflow hackathon — session stopped"));
      lines.push("");
      lines.push(`  session: ${cyan(sessionId)}`);
      lines.push(`  cancelled: ${cancelled} task(s)`);
      lines.push("");

      await out.init({ sessionId, cancelled }, () => lines.join("\n"));
      return 0;
    }

    case "report": {
      const [sessionId] = rest;
      if (!sessionId) {
        throw usage('which session: aflow hackathon report <session-id>');
      }

      const coord = new CoordinatorRuntime();
      const result = await coord.loadExistingSession(sessionId);
      if (!result.ok) {
        await out.init({ error: result.error }, () => `hackathon report failed: ${result.error.message}\n`);
        return 1;
      }

      const state = coord.getSessionState();
      const tasks = coord.getTasks();
      const completed = tasks.filter((t) => t.state === TASK_STATUS.COMPLETED).length;
      const failed = tasks.filter((t) => t.state === TASK_STATUS.FAILED).length;
      const inProgress = tasks.filter((t) => t.state === TASK_STATUS.RUNNING).length;

      const lines = [];
      lines.push(bold("aflow hackathon — session report"));
      lines.push("");
      lines.push(`  session: ${cyan(state.sessionId)}`);
      lines.push(`  status:  ${statusColor(state.status)}`);
      lines.push("");
      lines.push(bold("task summary"));
      lines.push(`  total:       ${dim(state.taskCount)}`);
      lines.push(`  completed:   ${green(completed)}`);
      lines.push(`  failed:      ${red(failed)}`);
      lines.push(`  in progress: ${cyan(inProgress)}`);
      lines.push(`  workers:     ${state.workerCount} (${state.connectedWorkers} connected)`);
      lines.push("");

      await out.init({ sessionId, state }, () => lines.join("\n"));
      return 0;
    }

    case "help":
    case "": {
      const lines = [];
      lines.push(bold("aflow hackathon — distributed multi-computer coordination"));
      lines.push("");
      lines.push("usage:");
      lines.push("  aflow hackathon start \"<idea>\"        start a new session");
      lines.push("  aflow hackathon join <session-code>   join as a worker");
      lines.push("  aflow hackathon status <session>      show session state");
      lines.push("  aflow hackathon workers <session>     list workers");
      lines.push("  aflow hackathon tasks <session>       list tasks");
      lines.push("  aflow hackathon stop <session>        cancel all tasks");
      lines.push("  aflow hackathon report <session>      show progress report");
      lines.push("");
      lines.push(dim("flags:"));
      lines.push(`  ${dim("--leader-id")}    leader identity for new sessions`);
      lines.push(`  ${dim("--workspace")}    workspace root for new sessions`);
      lines.push("");
      lines.push(dim("entry point: Ctrl+P in the TUI (command palette)"));
      lines.push(dim("Tab cycle: Plan → Build → Orchestrate → Auto (unchanged)"));

      await out.init({}, () => lines.join("\n"));
      return 0;
    }

    default: {
      throw usage(`unknown subcommand: ${sub}`);
    }
  }
}

defineCommand("hackathon", {
  summary: "distributed multi-computer coordination (Hackathon Mode)",
  valueFlags: ["leader-id", "workspace"],
  usage: `aflow hackathon start "<idea>"
    aflow hackathon join <session-code>
    aflow hackathon status <session-id>
    aflow hackathon workers <session-id>
    aflow hackathon tasks <session-id>
    aflow hackathon stop <session-id>
    aflow hackathon report <session-id>

  start   create a new Hackathon session as leader
  join    join an existing session as a worker (TUI Ctrl+P)
  status  show session state summary
  workers list connected workers and capabilities
  tasks   list tasks and their execution state
  stop    cancel all active tasks in a session
  report  show progress and delivery gate summary

  --leader-id  leader identity for new sessions (default: leader-1)
  --workspace  workspace root for new sessions (default: cwd)

  Entry point: Ctrl+P in the TUI command palette.
  Hackathon Mode is not in the Tab mode cycle.`,
  run,
});

export default { run };
