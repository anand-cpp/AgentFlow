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
import {
  collectSessionInputs,
  isInteractive,
  prompt,
  renderSessionSummary,
} from "../core/hackathon/session-inputs.js";

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

      // Collect the three required session inputs via the shared service.
      const inputs = await collectSessionInputs(flags);
      const {
        totalDurationHours,
        elapsedHours,
        remainingHours,
        teammateCount,
      } = inputs;

      const reserveFraction = Number(flags["reserve-fraction"]) || 0.1;
      const reserveHours = Math.max(0, remainingHours * reserveFraction);
      const workerBudgetHours = Math.max(0, remainingHours - reserveHours);

      // Display the calculated budget for user review before creating the session.
      const summaryLines = renderSessionSummary({
        totalDurationHours,
        elapsedHours,
        remainingHours,
        teammateCount,
        reserveFraction,
        workerBudgetHours,
        reserveHours,
      });
      for (const line of summaryLines) {
        process.stdout.write(line + "\n");
      }
      process.stdout.write("\n");

      // Ask the user to confirm before creating the session and generating invitations.
      // In non-interactive environments (CI, scripts), auto-confirm since all
      // inputs were explicitly provided via flags.
      let confirmed = true;
      if (isInteractive) {
        process.stdout.write(bold("Create this session and generate invitations? [y/N] "));
        const confirmAnswer = await prompt("");
        confirmed = (confirmAnswer || "").trim().toLowerCase() === "y";
      }
      if (!confirmed) {
        await out.init({}, () => "Session creation cancelled.\n");
        return 0;
      }

      const bus = new LocalBus();
      const coord = new CoordinatorRuntime({ bus });
      const result = await coord.startSession({
        leaderId: flags["leader-id"] || "leader-1",
        projectIdea,
        projectRoot: flags.workspace || process.cwd(),
        timeBudget: {
          totalDurationHours,
          elapsedHours,
          teammateCount,
          reserveFraction,
        },
      });

      if (!result.ok) {
        await out.init({ error: result.error }, () => `hackathon start failed: ${result.error.message}\n`);
        return 1;
      }

      // Generate one unique invitation per teammate.
      const workerIds = [];
      for (let i = 1; i <= teammateCount; i += 1) {
        workerIds.push(`worker-${i}`);
      }

      const invResult = coord.createInvitations({ workerIds });
      if (!invResult.ok) {
        await out.init({ error: invResult.error }, () => `failed to generate invitations: ${invResult.error.message}\n`);
        return 1;
      }

      const invitations = invResult.data.invitations;

      const lines = [];
      lines.push(bold("aflow hackathon — session started"));
      lines.push("");
      lines.push(`  session: ${cyan(result.data.sessionId)}`);
      lines.push(`  leader:  ${dim(result.data.leaderId)}`);
      lines.push(`  status:  ${statusColor(result.data.status)}`);
      lines.push(`  root:    ${dim(coord.session.projectRoot)}`);
      lines.push("");
      lines.push(bold("time budget (confirmed)"));
      lines.push(`  total duration:   ${dim(`${totalDurationHours} hours`)}`);
      lines.push(`  elapsed:          ${dim(`${elapsedHours} hours`)}`);
      lines.push(`  remaining:        ${dim(`${remainingHours} hours`)}`);
      lines.push(`  worker budget:    ${dim(`${Math.round(result.data.timeBudget.workerBudgetHours)} hours`)}`);
      lines.push(`  integration reserve: ${dim(`${Math.round(result.data.timeBudget.reserveHours)} hours`)}`);
      lines.push(`  teammates:        ${dim(`${teammateCount} (excludes Admin PC)`)}`);
      lines.push(`  total machines:   ${dim(`${teammateCount + 1}`)}`);
      lines.push("");
      lines.push(bold("worker invitations"));
      lines.push(dim("  Each teammate gets a unique, single-use pairing code."));
      lines.push("");
      for (const inv of invitations) {
        lines.push(`  ${dim(`Worker ${inv.workerId.slice(-1)}`)}: ${cyan(inv.token.slice(0, 12))}...`);
        lines.push(`    expires: ${dim(new Date(inv.expiresAt).toISOString())}  status: ${dim(inv.status)}`);
        lines.push("");
      }
      lines.push(dim("join:   aflow hackathon join <session-code>  (on each worker PC)"));
      lines.push(dim("status: aflow hackathon status " + result.data.sessionId));
      lines.push(dim("The Admin PC also runs as worker-0 — register it with its own invitation."));

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
      const deadline = coord.getDeadlineStatus();
      const devices = coord.getDevices();

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
      if (deadline) {
        lines.push(bold("time budget"));
        lines.push(`  remaining:   ${dim(`${deadline.remainingHours} hours`)}`);
        lines.push(`  worker budget: ${dim(`${Math.round(deadline.workerBudgetHours)} hours`)}`);
        lines.push(`  reserve:     ${dim(`${Math.round(deadline.reserveHours)} hours`)}`);
        lines.push(`  percentage:  ${dim(`${deadline.percentageRemaining}%`)}`);
        lines.push("");
      }
      lines.push(bold("devices"));
      lines.push(`  total:      ${dim(devices.length)}`);
      lines.push(`  approved:   ${dim(devices.filter((d) => d.status === "approved").length)}`);
      lines.push(`  pending:    ${dim(devices.filter((d) => d.status === "pending_approval").length)}`);
      lines.push(`  rejected:   ${dim(devices.filter((d) => d.status === "rejected").length)}`);
      lines.push(`  revoked:    ${dim(devices.filter((d) => d.status === "revoked").length)}`);
      lines.push("");

      await out.init({ sessionId, state }, () => lines.join("\n"));
      return 0;
    }

    case "dashboard": {
      const [sessionId] = rest;
      if (!sessionId) {
        throw usage('which session: aflow hackathon dashboard <session-id>');
      }

      const coord = new CoordinatorRuntime();
      const result = await coord.loadExistingSession(sessionId);
      if (!result.ok) {
        await out.init({ error: result.error }, () => `hackathon dashboard failed: ${result.error.message}\n`);
        return 1;
      }

      const state = coord.getSessionState();
      const tasks = coord.getTasks();
      const workers = coord.getWorkers();
      const devices = coord.getDevices();
      const deadline = coord.getDeadlineStatus();
      const policy = coord.getExecutionPolicy();

      const completed = tasks.filter((t) => t.state === TASK_STATUS.COMPLETED).length;
      const failed = tasks.filter((t) => t.state === TASK_STATUS.FAILED).length;
      const inProgress = tasks.filter((t) => t.state === TASK_STATUS.RUNNING).length;
      const blocked = tasks.filter((t) => t.state === TASK_STATUS.BLOCKED).length;
      const pending = tasks.filter((t) => t.state === TASK_STATUS.PENDING).length;

      const lines = [];
      lines.push(bold("aflow hackathon — admin dashboard"));
      lines.push("");
      lines.push(bold("session"));
      lines.push(`  id:     ${cyan(state.sessionId)}`);
      lines.push(`  status: ${statusColor(state.status)}`);
      lines.push(`  root:   ${dim(coord.session.projectRoot)}`);
      lines.push("");
      lines.push(bold("time budget"));
      if (deadline) {
        lines.push(`  total:        ${dim(`${deadline.totalDurationHours} hours`)}`);
        lines.push(`  elapsed:      ${dim(`${deadline.elapsedHours} hours`)}`);
        lines.push(`  remaining:    ${dim(`${deadline.remainingHours} hours`)}`);
        lines.push(`  worker budget: ${dim(`${Math.round(deadline.workerBudgetHours)} hours`)}`);
        lines.push(`  reserve:      ${dim(`${Math.round(deadline.reserveHours)} hours`)}`);
        lines.push(`  policy:       ${dim(policy.label)} (${policy.description})`);
        lines.push(`  accept optional: ${dim(String(policy.acceptOptional))}`);
      } else {
        lines.push(dim("no time budget configured"));
      }
      lines.push("");
      lines.push(bold("task summary"));
      lines.push(`  total:       ${dim(state.taskCount)}`);
      lines.push(`  completed:   ${green(completed)}`);
      lines.push(`  failed:      ${red(failed)}`);
      lines.push(`  in progress: ${cyan(inProgress)}`);
      lines.push(`  blocked:     ${yellow(blocked)}`);
      lines.push(`  pending:     ${dim(pending)}`);
      lines.push("");
      lines.push(bold("devices"));
      for (const d of devices) {
        const approved = d.status === "approved" ? green(d.status) : d.status === "pending_approval" ? yellow(d.status) : red(d.status);
        lines.push(`  ${approved.padEnd(18)} ${dim(d.deviceId)}  ${(d.deviceInfo?.capabilities || []).join(", ")}`);
      }
      if (!devices.length) lines.push(dim("no devices"));
      lines.push("");
      lines.push(bold("workers"));
      for (const w of workers) {
        const wstatus = workerStatusColor(w.status).padEnd(14);
        lines.push(`  ${wstatus} ${dim(w.workerId)}  task: ${dim(w.currentTaskId || "—")}  caps: ${(w.capabilities || []).join(", ")}`);
      }
      if (!workers.length) lines.push(dim("no workers"));
      lines.push("");

      await out.init({ sessionId, state }, () => lines.join("\n"));
      return 0;
    }

    case "approve": {
      const [sessionId, workerId] = rest;
      if (!sessionId || !workerId) {
        throw usage('usage: aflow hackathon approve <session-id> <worker-id>');
      }

      const coord = new CoordinatorRuntime();
      const result = await coord.loadExistingSession(sessionId);
      if (!result.ok) {
        await out.init({ error: result.error }, () => `hackathon approve failed: ${result.error.message}\n`);
        return 1;
      }

      const r = await coord.approveDevice({ workerId, approvedBy: flags["leader-id"] || "leader-1" });
      if (!r.ok) {
        await out.init({ error: r.error }, () => `approve failed: ${r.error.message}\n`);
        return 1;
      }

      const lines = [];
      lines.push(bold("aflow hackathon — device approved"));
      lines.push("");
      lines.push(`  worker: ${cyan(workerId)}`);
      lines.push(`  session: ${cyan(sessionId)}`);
      lines.push(`  approved by: ${dim(r.data.device.approvedBy)}`);
      lines.push("");

      await out.init({ sessionId, workerId }, () => lines.join("\n"));
      return 0;
    }

    case "reject": {
      const [sessionId, workerId] = rest;
      if (!sessionId || !workerId) {
        throw usage('usage: aflow hackathon reject <session-id> <worker-id>');
      }

      const coord = new CoordinatorRuntime();
      const result = await coord.loadExistingSession(sessionId);
      if (!result.ok) {
        await out.init({ error: result.error }, () => `hackathon reject failed: ${result.error.message}\n`);
        return 1;
      }

      const r = await coord.rejectDevice({ workerId, rejectedBy: flags["leader-id"] || "leader-1", reason: flags.reason || "rejected by admin" });
      if (!r.ok) {
        await out.init({ error: r.error }, () => `reject failed: ${r.error.message}\n`);
        return 1;
      }

      const lines = [];
      lines.push(bold("aflow hackathon — device rejected"));
      lines.push("");
      lines.push(`  worker: ${cyan(workerId)}`);
      lines.push(`  session: ${cyan(sessionId)}`);
      lines.push(`  reason: ${dim(r.data.device.rejectionReason || "—")}`);
      lines.push("");

      await out.init({ sessionId, workerId }, () => lines.join("\n"));
      return 0;
    }

    case "revoke": {
      const [sessionId, workerId] = rest;
      if (!sessionId || !workerId) {
        throw usage('usage: aflow hackathon revoke <session-id> <worker-id>');
      }

      const coord = new CoordinatorRuntime();
      const result = await coord.loadExistingSession(sessionId);
      if (!result.ok) {
        await out.init({ error: result.error }, () => `hackathon revoke failed: ${result.error.message}\n`);
        return 1;
      }

      const r = await coord.revokeDevice({ workerId, revokedBy: flags["leader-id"] || "leader-1", reason: flags.reason || "revoked by admin" });
      if (!r.ok) {
        await out.init({ error: r.error }, () => `revoke failed: ${r.error.message}\n`);
        return 1;
      }

      const lines = [];
      lines.push(bold("aflow hackathon — device revoked"));
      lines.push("");
      lines.push(`  worker: ${cyan(workerId)}`);
      lines.push(`  session: ${cyan(sessionId)}`);
      lines.push(`  reason: ${dim(r.data.device.revokedReason || "—")}`);
      lines.push("");

      await out.init({ sessionId, workerId }, () => lines.join("\n"));
      return 0;
    }

    case "pause": {
      const [sessionId] = rest;
      if (!sessionId) {
        throw usage('which session: aflow hackathon pause <session-id>');
      }

      const coord = new CoordinatorRuntime();
      const result = await coord.loadExistingSession(sessionId);
      if (!result.ok) {
        await out.init({ error: result.error }, () => `hackathon pause failed: ${result.error.message}\n`);
        return 1;
      }

      const r = coord.pauseSession();
      if (!r.ok) {
        await out.init({ error: r.error }, () => `pause failed: ${r.error.message}\n`);
        return 1;
      }

      const lines = [];
      lines.push(bold("aflow hackathon — session paused"));
      lines.push("");
      lines.push(`  session: ${cyan(sessionId)}`);
      lines.push("");

      await out.init({ sessionId }, () => lines.join("\n"));
      return 0;
    }

    case "resume": {
      const [sessionId] = rest;
      if (!sessionId) {
        throw usage('which session: aflow hackathon resume <session-id>');
      }

      const coord = new CoordinatorRuntime();
      const result = await coord.loadExistingSession(sessionId);
      if (!result.ok) {
        await out.init({ error: result.error }, () => `hackathon resume failed: ${result.error.message}\n`);
        return 1;
      }

      const r = coord.resumeSession();
      if (!r.ok) {
        await out.init({ error: r.error }, () => `resume failed: ${r.error.message}\n`);
        return 1;
      }

      const lines = [];
      lines.push(bold("aflow hackathon — session resumed"));
      lines.push("");
      lines.push(`  session: ${cyan(sessionId)}`);
      lines.push("");

      await out.init({ sessionId }, () => lines.join("\n"));
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
      lines.push("  aflow hackathon dashboard <session>   admin dashboard");
      lines.push("  aflow hackathon approve <session> <worker>  approve a device");
      lines.push("  aflow hackathon reject <session> <worker>   reject a device");
      lines.push("  aflow hackathon revoke <session> <worker>   revoke a device");
      lines.push("  aflow hackathon pause <session>     pause session execution");
      lines.push("  aflow hackathon resume <session>    resume session execution");
      lines.push("");
      lines.push(dim("flags:"));
      lines.push(`  ${dim("--leader-id")}    leader identity for new sessions`);
      lines.push(`  ${dim("--workspace")}    workspace root for new sessions`);
      lines.push(`  ${dim("--duration-hours")} total hackathon duration in hours`);
      lines.push(`  ${dim("--elapsed-hours")}  hours already elapsed`);
      lines.push(`  ${dim("--teammates")}      number of teammates excluding Admin PC`);
      lines.push(`  ${dim("--reserve-fraction")} fraction reserved for integration (default 0.1)`);
      lines.push(`  ${dim("--reason")}         reason for reject/revoke`);
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
  valueFlags: ["leader-id", "workspace", "duration-hours", "elapsed-hours", "teammates", "reserve-fraction", "reason"],
  usage: `aflow hackathon start "<idea>"
    aflow hackathon join <session-code>
    aflow hackathon status <session-id>
    aflow hackathon workers <session-id>
    aflow hackathon tasks <session-id>
    aflow hackathon stop <session-id>
    aflow hackathon report <session-id>
    aflow hackathon dashboard <session-id>
    aflow hackathon approve <session-id> <worker-id>
    aflow hackathon reject <session-id> <worker-id>
    aflow hackathon revoke <session-id> <worker-id>
    aflow hackathon pause <session-id>
    aflow hackathon resume <session-id>

  start   create a new Hackathon session as leader
  join    join an existing session as a worker (TUI Ctrl+P)
  status  show session state summary
  workers list connected workers and capabilities
  tasks   list tasks and their execution state
  stop    cancel all active tasks in a session
  report  show progress summary
  dashboard show admin dashboard (time budget, tasks, devices, workers)
  approve approve a device for project-task access
  reject  reject a device (deny project-task access)
  revoke  revoke a device (immediate isolation)
  pause   pause session execution (no new task dispatching)
  resume  resume session execution

  --duration-hours    total hackathon duration in hours (interactive if omitted)
  --elapsed-hours     hours already elapsed (interactive if omitted)
  --teammates         number of teammates excluding Admin PC (interactive if omitted)
  --reserve-fraction  fraction reserved for integration (default 0.1)
  --reason            reason for reject/revoke
  --leader-id         leader identity for new sessions (default: leader-1)
  --workspace         workspace root for new sessions (default: cwd)

  Entry point: Ctrl+P in the TUI command palette.
  Hackathon Mode is not in the Tab mode cycle.`,
  run,
});

export default { run };
