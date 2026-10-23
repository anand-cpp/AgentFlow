// `git status --porcelain=v2` parser.
//
// Porcelain v2 is the machine-readable status format: stable field order,
// explicit entry kinds, and no decoration. We parse it into the shape the rest
// of the app wants -- one bucket per kind of change -- instead of handing raw
// text to a caller.
//
// The line grammar (git-status(1)):
//   # branch.oid <oid> | # branch.head <head> | # branch.upstream <upstream>
//   # branch.ab +<ahead> -<behind>
//   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
//   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\t<origPath>
//   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
//   ? <path>   ! <path>
//
// A single "1"/"2" line carries both index (X) and worktree (Y) status for one
// path. An entry whose X is not "." is staged; one whose Y is not "." is
// unstaged; a path can appear in both (XY == "MM").

/** Human labels for every status code git can emit. */
export const STATUS_LABELS = {
  ".": "unmodified",
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "unmerged",
  T: "typechange",
  X: "unknown",
  B: "broken",
  "?": "untracked",
  "!": "ignored",
};

/** @param {string} code @returns {string} */
export function statusLabel(code) {
  return STATUS_LABELS[code] || STATUS_LABELS.X;
}

const EMPTY = Object.freeze({
  branch: { name: null, oid: null, upstream: null, ahead: 0, behind: 0, detached: false },
  staged: [],
  unstaged: [],
  untracked: [],
  ignored: [],
  unmerged: [],
});

/**
 * Unescape the C-style quoting git applies when core.quotePath is on and a path
 * contains a quote, backslash or control character. Plain paths pass through.
 * @param {string} text
 */
function unquotePath(text) {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  const body = text.slice(1, -1);
  return body.replace(/\\([nrt"\\0]|x[0-9a-fA-F]{2}|[0-7]{1,3})/g, (m, esc) => {
    switch (esc[0]) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "0": return "\0";
      case "x": return String.fromCharCode(parseInt(esc.slice(1), 16));
      default: return String.fromCharCode(parseInt(esc, 8));
    }
  });
}

/**
 * Parse raw porcelain v2 output. Pure -- no git -- so fixtures cover every
 * entry kind without needing a live repository.
 *
 * @param {string} raw
 * @returns {{ branch: object, staged: object[], unstaged: object[], untracked: object[], ignored: object[], unmerged: object[] }}
 */
export function parseStatus(raw) {
  const out = {
    branch: { name: null, oid: null, upstream: null, ahead: 0, behind: 0, detached: false },
    staged: [],
    unstaged: [],
    untracked: [],
    ignored: [],
    unmerged: [],
  };
  if (!raw) return out;

  for (const line of String(raw).split("\n")) {
    if (!line) continue;

    if (line.startsWith("# ")) {
      const rest = line.slice(2);
      const sp = rest.indexOf(" ");
      const key = sp === -1 ? rest : rest.slice(0, sp);
      const value = sp === -1 ? "" : rest.slice(sp + 1);
      switch (key) {
        case "branch.oid": out.branch.oid = value; break;
        case "branch.head":
          out.branch.detached = value === "(detached)";
          out.branch.name = out.branch.detached ? null : value;
          break;
        case "branch.upstream": out.branch.upstream = value; break;
        case "branch.ab": {
          const m = /\+(\d+) -(\d+)/.exec(value);
          if (m) {
            out.branch.ahead = Number(m[1]);
            out.branch.behind = Number(m[2]);
          }
          break;
        }
        default: break;
      }
      continue;
    }

    const kind = line[0];

    if (kind === "?" || kind === "!") {
      const path = unquotePath(line.slice(2));
      const entry = { path, origPath: null, indexStatus: kind, workTreeStatus: kind, mode: null, label: statusLabel(kind) };
      (kind === "?" ? out.untracked : out.ignored).push(entry);
      continue;
    }

    if (kind === "1" || kind === "2") {
      // 1: XY sub mH mI mW hH hI path
      // 2: XY sub mH mI mW hH hI Xscore path<TAB>origPath
      const m = /^([12]) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/.exec(line);
      if (!m) continue;
      const [, , xy, , mH, mI, mW] = m;
      let tail = m[9];
      let origPath = null;
      let score = null;
      if (kind === "2") {
        // The rename/copy score ("R63", "C75") is one token sitting between hI
        // and the path. Drop it so it cannot leak into the filename, but keep
        // the numeric value -- callers use it to sort weak renames.
        const sp = tail.indexOf(" ");
        if (sp !== -1) {
          const sm = /([RC])(\d+)/.exec(tail.slice(0, sp));
          if (sm) score = Number(sm[2]);
          tail = tail.slice(sp + 1);
        }
        const tab = tail.lastIndexOf("\t");
        if (tab !== -1) {
          origPath = unquotePath(tail.slice(tab + 1));
          tail = tail.slice(0, tab);
        }
      }
      const path = unquotePath(tail);
      const indexStatus = xy[0];
      const workTreeStatus = xy[1];
      const common = {
        path,
        origPath,
        score,
        indexStatus,
        workTreeStatus,
        mode: mI === "000000" ? mH : mI,
        modes: { head: mH, index: mI, worktree: mW },
      };
      if (indexStatus !== ".") out.staged.push({ ...common, label: statusLabel(indexStatus) });
      if (workTreeStatus !== ".") out.unstaged.push({ ...common, label: statusLabel(workTreeStatus) });
      continue;
    }

    if (kind === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const m = /^u (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/.exec(line);
      if (!m) continue;
      const [, xy, , m1, m2, m3, mW, h1, h2, h3] = m;
      out.unmerged.push({
        path: unquotePath(m[10]),
        origPath: null,
        indexStatus: xy[0],
        workTreeStatus: xy[1],
        mode: m1 === "000000" ? (m2 === "000000" ? m3 : m2) : m1,
        label: statusLabel("U"),
        status: xy,
        stages: { base: h1, ours: h2, theirs: h3 },
        modes: { base: m1, ours: m2, theirs: m3, worktree: mW },
      });
      continue;
    }
  }

  return out;
}

/**
 * Run `git status` and parse it.
 *
 * @param {import("./discover.js").GitContext} ctx
 * @param {{ untracked?: "no"|"normal"|"all" }} [opts]
 * @returns {Promise<{ ok: boolean, error: string|null } & ReturnType<typeof parseStatus>>}
 */
export async function runStatus(ctx, opts = {}) {
  const untracked = opts.untracked ?? "normal";
  const res = await ctx.run(["status", "--porcelain=v2", "--branch", `--untracked-files=${untracked}`]);
  if (!res.ok) {
    return { ok: false, error: res.error, ...EMPTY };
  }
  return { ok: true, error: null, ...parseStatus(res.stdout) };
}

export default { parseStatus, runStatus, statusLabel, STATUS_LABELS };
