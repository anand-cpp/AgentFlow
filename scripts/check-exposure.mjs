#!/usr/bin/env node
// Known-exposure monitor.
//
// Why this exists separately from scripts/scan-secrets.mjs:
//
// A clean clone proves nothing about whether a credential is exposed. When this
// repository's history was rewritten to remove a leaked Google API key, a fresh
// clone of the rewritten `main` contained zero occurrences of the value -- and
// the credential was still being served to unauthenticated callers through the
// REST API, from the pre-purge objects. Force-pushing rewrites refs; it does not
// delete objects. The purge looked complete and was not.
//
// So this script checks the thing that actually matters: whether the known-bad
// object ids are still publicly retrievable. It probes them without a token on
// purpose -- if an anonymous request can read it, the exposure is real.
//
// Design rules, all of them load-bearing:
//
//   1. No credential value is stored here. Each entry names a commit id, a path,
//      and a *shape*. The shape comes from the scanner's rule set.
//   2. Retrieved content is inspected in memory and never printed, logged, or
//      written. A finding reports the ref, the path and the rule name. It never
//      reports the matched value, not even truncated -- a truncated secret is
//      still a secret, and this file is committed.
//   3. "Could not check" is never reported as "clean". A network error, a rate
//      limit or an unexpected status produces an error exit. A monitor that
//      fails open is worse than no monitor, because it manufactures confidence.
//
// An entry stays in config/exposure.json until the credential has been rotated
// by its owner AND the platform has dropped the objects. Deleting an entry is
// a claim that remediation is complete; make that claim only when it is true.

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { scanText } from "./scan-secrets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(HERE, "..", "config", "exposure.json");

const API = "https://api.github.com/repos";

/** Statuses that mean "the object is not publicly readable". */
const GONE = new Set([404, 410]);

function loadConfig(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Ask GitHub whether a path is readable at a ref, anonymously.
 *
 * Returns one of:
 *   { state: "retrievable", body }  -- served to the public; body is the content
 *   { state: "gone" }                -- not served (404/410)
 *   { state: "error", detail }       -- could not determine; never treat as gone
 */
export async function probeContent({ repo, ref, filePath, fetchImpl = fetch, timeoutMs = 20000 }) {
  const url = `${API}/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "agentflow-exposure-monitor" },
      signal: ctrl.signal,
    });

    if (GONE.has(res.status)) return { state: "gone" };

    if (res.status === 200) {
      const json = await res.json();
      if (json?.encoding === "base64" && typeof json.content === "string") {
        return { state: "retrievable", body: Buffer.from(json.content, "base64").toString("utf8") };
      }
      // A directory listing or unexpected shape: readable, but not a file.
      return { state: "retrievable", body: "" };
    }

    // 403/429 included. Rate limiting must not read as "not exposed".
    return { state: "error", detail: `HTTP ${res.status}` };
  } catch (err) {
    return { state: "error", detail: err?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check every configured exposure. Pure enough to test: `probe` is injectable.
 *
 * An entry is EXPOSED if any of its refs still serves content containing a
 * credential shape. It is CLEAR only if every ref was positively confirmed
 * gone. Anything else is UNKNOWN, which is a failure.
 */
export async function checkExposures(config, { probe = probeContent } = {}) {
  const results = [];

  for (const entry of config.exposures) {
    const checked = [];
    for (const ref of entry.refs) {
      const r = await probe({ repo: entry.repo, ref, filePath: entry.path });
      let shape = null;
      if (r.state === "retrievable" && r.body) {
        // In-memory inspection only. scanText returns rule names and line
        // numbers; it never returns the matched text.
        const hits = scanText(r.body, { file: entry.path });
        shape = hits.length ? hits.map((h) => h.rule).join(",") : null;
      }
      checked.push({ ref, state: r.state, detail: r.detail, shape });
    }

    const anyRetrievable = checked.some((c) => c.state === "retrievable");
    const anyError = checked.some((c) => c.state === "error");
    const anyShape = checked.some((c) => c.shape);

    let status;
    if (anyRetrievable && anyShape) status = "EXPOSED";
    else if (anyError) status = "UNKNOWN";
    else if (anyRetrievable) status = "UNKNOWN"; // readable but no shape matched; do not claim clean
    else status = "CLEAR";

    results.push({ ...entry, status, checked });
  }

  return results;
}

function report(results, asJson) {
  const exposed = results.filter((r) => r.status === "EXPOSED");
  const unknown = results.filter((r) => r.status === "UNKNOWN");
  const clear = results.filter((r) => r.status === "CLEAR");

  if (asJson) {
    console.log(
      JSON.stringify(
        { exposed: exposed.length, unknown: unknown.length, clear: clear.length, results },
        null,
        2
      )
    );
  } else {
    console.log(`check-exposure: ${results.length} tracked exposure(s)\n`);
    for (const r of results) {
      const mark = r.status === "EXPOSED" ? "EXPOSED" : r.status === "UNKNOWN" ? "UNKNOWN" : "clear  ";
      console.log(`  [${mark}] ${r.id}  (${r.repo}, ${r.path})`);
      for (const c of r.checked) {
        const shape = c.shape ? ` shape=${c.shape}` : "";
        const detail = c.detail ? ` ${c.detail}` : "";
        console.log(`      ${c.ref}  ${c.state}${shape}${detail}`);
      }
      console.log(`      owner action: ${r.ownerAction}`);
      console.log("");
    }
    if (exposed.length) {
      console.error(
        "A credential from this repository is still publicly retrievable.\n" +
          "Do not close the GitHub alert and do not mark it revoked: the value is\n" +
          "live until its owner rotates it. Removing it from git history was\n" +
          "necessary but is not sufficient -- only the credential owner can\n" +
          "invalidate it, and only GitHub can drop the retained objects."
      );
    }
    if (unknown.length) {
      console.error(
        "One or more checks could not be completed. This is reported as a failure\n" +
          "on purpose: an unverified check must never be reported as clean."
      );
    }
  }

  return exposed.length || unknown.length ? 1 : 0;
}

async function main(argv) {
  const asJson = argv.includes("--json");
  const cfgIdx = argv.indexOf("--config");
  const configPath = cfgIdx !== -1 && argv[cfgIdx + 1] ? argv[cfgIdx + 1] : DEFAULT_CONFIG;

  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error(`check-exposure: cannot read config ${configPath}: ${err.message}`);
    return 1;
  }

  const results = await checkExposures(config);
  return report(results, asJson);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

export default { checkExposures, probeContent };