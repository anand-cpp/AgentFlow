// `aflow todo` — persistent task tracking for development tasks.
//
// Creates and manages task checklists that adapt to the task type.
// Tasks integrate with the security orchestration lifecycle.

import { defineCommand } from "../cli/registry.js";
import { bold, dim, green, red, yellow, cyan } from "../cli/ui.js";
import { TodoEngine } from "../security/todo.js";

let todoEngine = null;

function getTodoEngine() {
  if (!todoEngine) todoEngine = new TodoEngine({});
  return todoEngine;
}

function renderTask(task, index) {
  const _statusIcon = {
    pending: "○",
    in_progress: "◐",
    completed: "✓",
    blocked: "✗",
    skipped: "~",
    failed: "✖",
  }[task.status] || "?";

  const statusColor = {
    pending: dim,
    in_progress: cyan,
    completed: green,
    blocked: red,
    skipped: yellow,
    failed: red,
  }[task.status] || dim;

  const checkbox = task.status === "completed" ? "[✓]" : "[ ]";
  const lines = [];
  lines.push(`  ${index + 1}. ${checkbox} ${bold(task.title)}`);
  lines.push(`     ${statusColor(task.status.toUpperCase())}  ${dim(task.category)}`);
  if (task.description) lines.push(`     ${dim(task.description)}`);
  if (task.status === "blocked" && task.evidence && task.evidence.blockReason) {
    lines.push(`     ${red("blocked:")} ${task.evidence.blockReason}`);
  }
  return lines.join("\n");
}

export async function run({ args, flags, _config, out }) {
  const engine = getTodoEngine();
  const [sub = "show"] = args;

  switch (sub) {
    case "add": {
      const title = args.slice(1).join(" ") || flags.title || "New task";
      const taskListId = flags["list"] || "default";
      let taskList = engine.getTaskList(taskListId);
      if (!taskList) {
        taskList = engine.generateTaskList("general", { source: "manual" }, {});
        // Replace with empty list and add our task
        taskList.tasks = [];
      }
      const task = taskList.addTask({ title, category: "implementation" });
      engine.taskLists.set(taskList.id, taskList);
      out.init({ taskId: task.id }, () => `Task added: ${task.title}\n`);
      return 0;
    }

    case "show": {
      const taskListId = flags["list"] || "default";
      const taskList = engine.getTaskList(taskListId);
      if (!taskList) {
        // Generate a default general task list
        const generated = engine.generateTaskList("general", { source: "cli" }, {});
        engine.taskLists.set("default", generated);
        const all = engine.getAllTaskLists();
        const defaultList = all[all.length - 1];
        return renderTaskList(out, defaultList);
      }
      return renderTaskList(out, taskList);
    }

    case "complete": {
      const taskListId = flags["list"] || "default";
      const taskId = args[1] || flags["task"];
      const taskList = engine.getTaskList(taskListId);
      if (!taskList) {
        out.error(`Task list not found: ${taskListId}`);
        return 1;
      }
      const task = taskList.getTask(taskId);
      if (!task) {
        out.error(`Task not found: ${taskId}`);
        return 1;
      }
      taskList.completeTask(taskId, { source: "cli" }, { verifiedBy: "cli" });
      out.init({}, () => `Task completed: ${task.title}\n`);
      return 0;
    }

    case "retry": {
      const taskListId = flags["list"] || "default";
      const taskId = args[1] || flags["task"];
      const taskList = engine.getTaskList(taskListId);
      if (!taskList) {
        out.error(`Task list not found: ${taskListId}`);
        return 1;
      }
      const task = taskList.getTask(taskId);
      if (!task) {
        out.error(`Task not found: ${taskId}`);
        return 1;
      }
      task.status = "pending";
      task.completedAt = null;
      task.evidence = null;
      task.verificationResult = null;
      task.updatedAt = new Date().toISOString();
      out.init({}, () => `Task reset to pending: ${task.title}\n`);
      return 0;
    }

    case "generate": {
      const taskType = args[1] || "general";
      const taskList = engine.generateTaskList(taskType, { source: "cli" }, {});
      out.init({ taskListId: taskList.id, taskType }, () => {
        const lines = [];
        lines.push(bold(`Generated task list: ${taskList.title}`));
        lines.push(`type: ${taskType}`);
        lines.push(`tasks: ${taskList.tasks.length}`);
        return lines.join("\n");
      });
      return 0;
    }

    case "list": {
      const all = engine.getAllTaskLists();
      out.init({ count: all.length }, () => {
        const lines = [];
        lines.push(bold("Task lists"));
        lines.push("");
        for (const tl of all) {
          const status = tl.isComplete ? green("complete") : yellow(`${tl.progress}%`);
          lines.push(`  ${tl.id.slice(0, 8)}  ${tl.title}  ${status}`);
        }
        return lines.join("\n");
      });
      return 0;
    }

    case "help":
    default:
      out.init({}, () => {
        const lines = [];
        lines.push(bold("aflow todo — persistent task tracking"));
        lines.push("");
        lines.push("Commands:");
        lines.push("  show [--list ID]     Show a task list");
        lines.push("  add <title>          Add a task to a list");
        lines.push("  complete <id>        Mark a task complete");
        lines.push("  retry <id>           Reset a task to pending");
        lines.push("  generate <type>      Generate a task list (general|frontend|backend|skill|container)");
        lines.push("  list                 List all task lists");
        lines.push("");
        lines.push("Flags:");
        lines.push("  --list ID            Task list ID (default: default)");
        lines.push("  --task ID            Task ID for complete/retry");
        lines.push("  --title TITLE        Task title for add");
        return lines.join("\n");
      });
      return 0;
  }
}

async function renderTaskList(out, taskList) {
  const lines = [];
  lines.push(bold(taskList.title));
  lines.push(`type: ${taskList.taskType}  progress: ${taskList.progress}%`);
  lines.push(`status: ${taskList.isComplete ? green("complete") : yellow("in progress")}`);
  lines.push("");
  for (let i = 0; i < taskList.tasks.length; i += 1) {
    lines.push(renderTask(taskList.tasks[i], i));
  }
  out.init({ taskListId: taskList.id, progress: taskList.progress }, () => lines.join("\n"));
  return 0;
}

defineCommand("todo", {
  summary: "persistent task tracking for development tasks",
  valueFlags: ["list", "task", "title"],
  run,
});

export default { run };
