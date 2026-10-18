// Command registration.
//
// One import surface: adding a command means adding it here. The router reads
// the resulting table, so `--help` stays in sync automatically.

import "../commands/doctor.js";
import "../commands/models.js";
import "../commands/status.js";
import "../commands/config.js";
import "../commands/init.js";
import "../commands/dashboard.js";
import "../commands/logs.js";
import "../commands/lsp.js";
import "../commands/mcp.js";
import "../commands/plugin.js";
import "../commands/map.js";
import "../commands/route.js";
import "../commands/sessions.js";
import "../commands/blackboard.js";
import "../commands/agent.js";
import "../commands/server.js";
import "../commands/tribunal.js";
import "../commands/chat.js";
import "../commands/git.js";
import "../commands/publish.js";
import "../commands/setup.js";

export { defineCommand, getCommand, getCommands } from "../cli/registry.js";