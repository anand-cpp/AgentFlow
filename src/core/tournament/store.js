// Persistence for Arena tournaments.
//
// A tournament is expensive and long-running, so progress has to survive a
// closed laptop or a killed process. The store keeps two kinds of records:
//
//   arena/<id>.json            the validated tournament state (bracket)
//   arena/<id>/matches/<m>.json  one match's artifacts and decision
//
// The split is deliberate. State is small, validated on load, and safe to read
// into memory at every step. Match artifacts are large, already redacted, and
// only needed when resuming the match that produced them -- keeping them out of
// state is what lets the bracket stay readable.
//
// Writes are atomic (persist.writeAtomicFile), so a crash leaves either the old
// record or the new one, never half of each.

import path from "node:path";
import os from "node:os";
import process from "node:process";

import { readJsonFile, writeAtomicFile } from "../persist.js";
import { TournamentStateError, parseTournamentState } from "./tournament-state.js";

export const ARENA_STORE_VERSION = 1;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MATCH_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Default `arena/` directory, mirroring the other state directories. */
export function defaultArenaDir() {
  if (process.env.AGENTFLOW_STATE_DIR) return path.join(process.env.AGENTFLOW_STATE_DIR, "arena");
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "agentflow", "arena");
  }
  const base =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "agentflow", "arena");
}

function assertId(id) {
  const value = String(id ?? "");
  if (!ID_RE.test(value)) {
    throw new TournamentStateError(`invalid arena id: ${JSON.stringify(value)}`, "invalid_id");
  }
  return value;
}

function assertMatchId(id) {
  const value = String(id ?? "");
  if (!MATCH_RE.test(value)) {
    throw new TournamentStateError(`invalid match id: ${JSON.stringify(value)}`, "invalid_match_id");
  }
  return value;
}

/**
 * Read one Arena record.
 *
 * A missing file is the normal "nothing here yet" case. An unreadable or
 * version-mismatched file is not: silently treating it as absent makes the
 * caller regenerate proposals, replay a match, or re-run the final Tribunal --
 * spending money on work that may already have been done. Corruption is
 * reported so the operator can decide, never repaired by guessing.
 *
 * @returns {object|null} the stored envelope, or null when the file is absent
 */
function readRecord(file, { id, what }) {
  const read = readJsonFile(file);
  if (!read.ok) {
    if (read.reason === "missing") return null;
    throw new TournamentStateError(
      `${what} ${String(id)} is unreadable: ${read.error?.message ?? "invalid JSON"}`,
      "corrupt_record",
    );
  }
  if (read.value.version !== ARENA_STORE_VERSION) {
    throw new TournamentStateError(
      `${what} ${String(id)} has version ${String(read.value.version)}, expected ${ARENA_STORE_VERSION}`,
      "unsupported_version",
    );
  }
  return read.value;
}

function assertRecordObject(value, { id, what }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TournamentStateError(`${what} ${String(id)} is not an object`, "corrupt_record");
  }
  return value;
}

export class ArenaStore {
  constructor({ dir = defaultArenaDir() } = {}) {
    this.dir = path.resolve(String(dir));
  }

  statePath(id) {
    return path.join(this.dir, `${assertId(id)}.json`);
  }

  matchPath(id, matchId) {
    return path.join(this.dir, assertId(id), "matches", `${assertMatchId(matchId)}.json`);
  }

  proposalsPath(id) {
    return path.join(this.dir, assertId(id), "proposals.json");
  }

  validationPath(id) {
    return path.join(this.dir, assertId(id), "validation.json");
  }

  /**
   * Persist a tournament state. Validation runs before writing, so a bug in a
   * caller fails at the boundary instead of producing a file that cannot be
   * resumed.
   */
  saveState(state) {
    const check = parseTournamentState(state);
    writeAtomicFile(
      this.statePath(state.id),
      `${JSON.stringify({ version: ARENA_STORE_VERSION, state: check }, null, 2)}\n`,
    );
    return this.statePath(state.id);
  }

  /** @returns {object|null} validated state, or null when the record is missing */
  loadState(id) {
    const stored = readRecord(this.statePath(id), { id, what: "arena record" });
    if (!stored) return null;
    return parseTournamentState(stored.state);
  }

  saveMatch(id, matchId, record) {
    const file = this.matchPath(id, matchId);
    writeAtomicFile(file, `${JSON.stringify({ version: ARENA_STORE_VERSION, record }, null, 2)}\n`);
    return file;
  }

  /** @returns {object|null} the saved match record, or null */
  loadMatch(id, matchId) {
    const stored = readRecord(this.matchPath(id, matchId), {
      id: `${id}/${matchId}`,
      what: "arena match record",
    });
    if (!stored) return null;
    return assertRecordObject(stored.record, { id: `${id}/${matchId}`, what: "arena match record" });
  }

  saveProposals(id, proposals) {
    const file = this.proposalsPath(id);
    writeAtomicFile(file, `${JSON.stringify({ version: ARENA_STORE_VERSION, proposals }, null, 2)}\n`);
    return file;
  }

  /** @returns {Record<string, string>|null} candidate id -> proposal text */
  loadProposals(id) {
    const stored = readRecord(this.proposalsPath(id), { id, what: "arena proposals" });
    if (!stored) return null;
    const proposals = assertRecordObject(stored.proposals, { id, what: "arena proposals" });
    for (const [candidateId, text] of Object.entries(proposals)) {
      if (typeof text !== "string" || !text.trim()) {
        throw new TournamentStateError(
          `arena proposals ${String(id)} has no usable text for ${candidateId}`,
          "corrupt_record",
        );
      }
    }
    return proposals;
  }

  /**
   * The champion's final Trial/Oracle validation. Stored separately because the
   * bracket can finish long before validation does, and re-running the tribunal
   * on resume would quietly charge the user twice for the same answer.
   */
  saveValidation(id, record) {
    const file = this.validationPath(id);
    writeAtomicFile(file, `${JSON.stringify({ version: ARENA_STORE_VERSION, record }, null, 2)}\n`);
    return file;
  }

  /** @returns {object|null} the saved validation, or null */
  loadValidation(id) {
    const stored = readRecord(this.validationPath(id), { id, what: "arena validation" });
    if (!stored) return null;
    return assertRecordObject(stored.record, { id, what: "arena validation" });
  }

  /** True when a state file exists, without parsing it. */
  has(id) {
    const read = readJsonFile(this.statePath(id));
    return read.ok;
  }
}

export default { ARENA_STORE_VERSION, defaultArenaDir, ArenaStore };
