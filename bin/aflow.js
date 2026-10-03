#!/usr/bin/env node
// AgentFlow CLI entry point.
//
// Derived from 9Router cli/cli.js @ a99cf572 (MIT).
// Copyright (c) 2024-2026 decolua and contributors. See THIRD_PARTY_NOTICES.md.
//
// AgentFlow change: upstream's launcher scanned process.argv imperatively to
// start/stop a Next.js server and manage a system tray. AgentFlow is a
// terminal-first client with no bundled web server, so the entry point is a
// real command router with global flags, structured output modes, and help.

import { run } from "../src/cli/index.js";
// Side-effect import: registers every command with the router.
import "../src/commands/index.js";

// The router returns a process exit code; propagate it. Assigning only in the
// catch block meant a non-zero return (127 for an unknown command, 1 for a
// failed check) was silently dropped and the CLI always exited 0.
run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = typeof code === "number" ? code : 0;
  })
  .catch((err) => {
    // Last-resort handler: the router handles its own errors, so reaching here
    // means an unexpected throw escaped. Report it without a stack dump unless
    // the user asked for verbose output.
    const wantsStack = process.argv.includes("--verbose") || process.argv.includes("--debug");
    process.stderr.write(`aflow: unexpected error: ${err?.message || String(err)}\n`);
    if (wantsStack && err?.stack) process.stderr.write(`${err.stack}\n`);
    process.exitCode = 1;
  });