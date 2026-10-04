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
import "../commands/route.js";
import "../commands/sessions.js";

export { defineCommand, getCommand, getCommands } from "../cli/registry.js";