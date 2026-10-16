#!/usr/bin/env node
// `aflow` is the historical command name; `agentflow` is the name the package
// publishes under. They are the same program, so this file is a one-line alias
// rather than a second copy of the launcher. Keep it thin: if you are looking
// for the CLI entry point, it lives in bin/agentflow.js.
import "./agentflow.js";
