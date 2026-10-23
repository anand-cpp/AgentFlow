#!/usr/bin/env node
// Build a single-file AgentFlow executable with Node's Single Executable
// Application (SEA) pipeline.
//
// Why a bundle comes first. SEA embeds exactly one JavaScript file, and the
// injected main script cannot load anything from the filesystem: require() and
// import resolve built-in modules only ("Module loading in the injected main
// script", Node docs). AgentFlow is a multi-file ESM application, so the only
// honest way to run it as a single binary is to collapse it into one
// self-contained file first. esbuild does that here. It is a build-time tool;
// the published package still has zero runtime dependencies.
//
// Steps:
//   1. Bundle bin/agentflow.js -> <tmp>/agentflow.bundle.cjs, with the version
//      constant injected (see versionPlugin) so the binary does not try to read
//      package.json relative to process.execPath.
//   2. Write sea-config.json and run `node --experimental-sea-config`.
//   3. Copy the running node binary into dist/.
//   4. Inject the blob with postject.
//   5. Emit a .sha256 beside the binary.
//
// Node 25.5+ folds steps 2-4 into `node --build-sea`, but that is newer than
// the project's supported floor. This script keeps the older, widely-available
// path (Node 20.6+) so `engines: >=20` remains the only requirement.
//
// Known SEA limitations, by design:
//   - `aflow server start --daemon` re-executes the CLI. Under SEA the child is
//     spawned as the binary itself (src/commands/server.js detects this), so the
//     daemon keeps working, but the binary cannot read companion source files.
//   - Config and keys are read from the user's state directory as usual, so a
//     fresh binary still needs `aflow setup` before it can route.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

// postject ships no type declarations and is CommonJS; loading it through
// require() keeps it out of the ESM type graph without a stub .d.ts.
const require = createRequire(import.meta.url);
const { inject } = require("postject");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "bin", "agentflow.js");
const VERSION_MODULE = path.join(ROOT, "src", "core", "version.js");
const DIST = path.join(ROOT, "dist");
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
}

/**
 * Replace src/core/version.js with a build-time constant.
 *
 * The real module reads package.json from disk relative to import.meta.url. In
 * a SEA that URL is process.execPath, so the lookup would resolve next to the
 * binary and fail. Substituting the value at bundle time removes the filesystem
 * dependency entirely and keeps the version honest (it is read from the same
 * package.json the rest of the build uses).
 */
const versionPlugin = {
  name: "agentflow-version",
  setup(build) {
    build.onResolve({ filter: /version\.js$/ }, (args) => {
      if (!args.importer || !args.path.startsWith(".")) return null;
      const resolved = path.resolve(path.dirname(args.importer), args.path);
      if (path.normalize(resolved) === path.normalize(VERSION_MODULE)) {
        return { path: VERSION_MODULE, namespace: "agentflow-version" };
      }
      return null;
    });
    build.onLoad({ filter: /.*/, namespace: "agentflow-version" }, () => ({
      contents: `export const VERSION = ${JSON.stringify(readVersion())};\n`,
      loader: "js",
    }));
  },
};

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function build() {
  const version = readVersion();
  fs.mkdirSync(DIST, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-sea-"));

  try {
    const bundlePath = path.join(tmp, "agentflow.bundle.cjs");
    console.log("build-sea: bundling bin/agentflow.js");
    await esbuild.build({
      entryPoints: [ENTRY],
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      target: "node20",
      format: "cjs",
      plugins: [versionPlugin],
      legalComments: "none",
      logLevel: "warning",
    });

    const blobPath = path.join(tmp, "sea-prep.blob");
    const configPath = path.join(tmp, "sea-config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true }, null, 2)
    );

    console.log("build-sea: generating SEA preparation blob");
    execFileSync(process.execPath, ["--experimental-sea-config", configPath], {
      stdio: "inherit",
      cwd: tmp,
    });

    const exeName = process.platform === "win32" ? "agentflow.exe" : "agentflow";
    const dest = path.join(DIST, exeName);
    fs.copyFileSync(process.execPath, dest);

    // macOS refuses to inject into a signed binary; the signature has to go
    // first. Windows tolerates an unsigned result (postject only warns).
    if (process.platform === "darwin") {
      try {
        execFileSync("codesign", ["--remove-signature", dest], { stdio: "ignore" });
      } catch {
        /* an unsigned binary is still runnable */
      }
    }

    console.log(`build-sea: injecting blob into ${path.relative(ROOT, dest)}`);
    await inject(dest, "NODE_SEA_BLOB", fs.readFileSync(blobPath), {
      sentinelFuse: SENTINEL_FUSE,
      ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
    });

    const bytes = fs.statSync(dest).size;
    const digest = sha256(dest);
    fs.writeFileSync(`${dest}.sha256`, `${digest}  ${exeName}\n`);

    console.log("");
    console.log("build-sea: ok");
    console.log(`  version ${version}`);
    console.log(`  target  ${process.platform}-${process.arch}`);
    console.log(`  output  ${path.relative(ROOT, dest)} (${(bytes / 1024 / 1024).toFixed(1)} MiB)`);
    console.log(`  sha256  ${digest}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

build().catch((err) => {
  console.error(`build-sea: ${err?.message || String(err)}`);
  process.exitCode = 1;
});
