// Single source of truth for the AgentFlow version string.
//
// The version used to live in three places that had to be bumped in lockstep --
// package.json, src/cli/index.js (VERSION) and src/core/gateway-server.js
// (GATEWAY_VERSION) -- and they drifted: the v0.2.0 release shipped while all
// three still advertised 0.1.0. The string is now read once, at import time,
// from package.json, and every consumer imports it from here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8"));

export const VERSION = pkg.version;
