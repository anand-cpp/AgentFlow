// Repository map, phase 2: the symbol extractor.
//
// One source file becomes { file, language, symbols, imports } via a
// line-based regex pass per language. This is a heuristic indexer, not a
// parser: it is fast, zero-dependency, and allowed to be occasionally wrong
// in the direction of *missing* a symbol. What it may never be is slow or
// fragile — every pattern is line-scoped, every extractor is total (a line
// that looks like nothing is skipped, never a crash).
//
// Resolution policy stays with the caller (graph.js finishes import targets
// against the real walk). Here a raw specifier becomes *candidates*, ordered;
// the caller keeps the first one that really exists, else `null` (a bare
// "node:path" import is a real edge to nothing internal).

import path from "node:path";

export const MAX_SYMBOLS_PER_FILE = 400;

/**
 * Language families the extractors know. Detection is extension-based and
 * deliberately coarse: TS-family counts as JS-family here (its keywords are a
 * superset of the JS patterns).
 */
export function detectLanguage(rel) {
  const ext = path.extname(rel).toLowerCase();
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "js";
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "ts";
  if (ext === ".py") return "python";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rust";
  if (
    [".rb", ".php", ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs", ".lua", ".zig", ".sql", ".sh"].includes(
      ext,
    )
  ) {
    return "generic";
  }
  return "unknown";
}

const JS_PATTERNS = [
  { re: /^export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function", exported: true },
  { re: /^export\s+default\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", exported: true },
  { re: /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: "type" },
  { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, kind: "const" },
  { re: /^(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "type" },
];

const PY_IMPORTS = [/^import\s+([A-Za-z_][\w.]*)/, /^from\s+([A-Za-z_.][\w.]*)\s+import\b/];

/**
 * Extract symbols and import statements from one source blob.
 *
 * @param {string} file workspace-relative path (tagged on every result)
 * @param {string} text the file's text
 * @param {{language?: string, maxSymbols?: number}} [options]
 * @returns {{ file: string, language: string, symbols: Array<{name,kind,line,exported}>, imports: Array<{raw, resolved}> }}
 */
export function extractSource(file, text, options = {}) {
  const language = options.language ?? detectLanguage(file);
  const maxSymbols = options.maxSymbols ?? MAX_SYMBOLS_PER_FILE;
  const lines = String(text).split(/\r?\n/);
  /** @type {Array<{name:string,kind:string,line:number,exported:boolean}>} */
  const symbols = [];
  /** @type {Array<{raw:string, resolved:null}>} */
  const imports = [];
  const seenSymbols = new Set();

  const push = (name, kind, line, exported) => {
    if (!name || symbols.length >= maxSymbols || seenSymbols.has(name)) return;
    seenSymbols.add(name);
    symbols.push({ name, kind, line, exported: Boolean(exported) });
  };
  const addImport = (raw) => {
    if (!raw || !imports.some((i) => i.raw === raw)) imports.push({ raw, resolved: null });
  };

  if (language === "python") extractPython({ lines, push, addImport });
  else if (language === "go") extractGo({ lines, push, addImport });
  else if (language === "rust") extractRust({ lines, push, addImport });
  else if (language === "generic") extractGeneric({ lines, push, addImport });
  else extractJs({ file, lines, push, addImport });

  return { file, language, symbols, imports };
}

// --- JS / TS -----------------------------------------------------------------

const JS_IMPORTS = [
  /^import\s+(?:[\w*${},\s]+?)\s+from\s+['"]([^'"]+)['"]/,
  /^import\s+['"]([^'"]+)['"]/,
  /^export\s+(?:[\w*${},\s]+?)\s+from\s+['"]([^'"]+)['"]/,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/,
];

/**
 * @param {{ file?: string, lines: string[], push: (name: string, kind: string, line: number, exported: boolean) => void, addImport: (raw: string) => void }} s
 */
function extractJs({ file, lines, push, addImport }) {
  const isTypeScript = file.endsWith(".ts") || file.endsWith(".tsx");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;

    // ES imports / re-exports / CJS require, first match on the line wins.
    for (const re of JS_IMPORTS) {
      const m = line.match(re);
      if (m?.[1]) {
        addImport(m[1]);
        break;
      }
    }

    // `module.exports.foo = ` and `exports.foo = ` are CJS exports.
    const cjs = line.match(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/);
    if (cjs) push(cjs[1], "const", i + 1, true);
    if (/^module\.exports\s*=\s*\{/.test(line)) push("module.exports", "module", i + 1, true);

    for (const pat of JS_PATTERNS) {
      const m = line.match(pat.re);
      if (!m) continue;
      const exported = /^export\b/.test(line) || pat.exported === true;
      const kind = isTypeScript && pat.kind === "unknown" ? "unknown" : pat.kind;
      push(m[1], kind, i + 1, exported);
      break;
    }

    // Methods: an indented `name(...) {` line inside a class or object, with
    // TS modifier keywords skipped. Kept last so named `function`
    // declarations never double-report.
    const method = line.match(/^(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\((?:[^()]|\([^()]*\))*\)\s*\{/);
    if (method) push(method[1], "method", i + 1, false);
  }
}

// --- Python ------------------------------------------------------------------

/** @param {{ file?: string, lines: string[], push: (name: string, kind: string, line: number, exported: boolean) => void, addImport: (raw: string) => void }} s */
function extractPython({ lines, push, addImport }) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith('"""') || line.startsWith("'''")) continue;

    for (const re of PY_IMPORTS) {
      const m = line.match(re);
      if (m?.[1]) {
        addImport(m[1]);
        break;
      }
    }

    let m = line.match(/^(?:async\s+)?def\s+([A-Za-z_][\w]*)/);
    if (m) {
      // Python convention: a leading underscore marks a private symbol; the
      // exported flag is our own bound on what the packer may promote.
      push(m[1], "function", i + 1, !m[1].startsWith("_"));
      continue;
    }
    m = line.match(/^class\s+([A-Za-z_][\w]*)/);
    if (m) push(m[1], "class", i + 1, !m[1].startsWith("_"));
  }
}

// --- Go ---------------------------------------------------------------------

/** @param {{ lines: string[], push: (name: string, kind: string, line: number, exported: boolean) => void, addImport: (raw: string) => void }} s */
function extractGo({ lines, push, addImport }) {
  let inImportBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith("//")) continue;

    const pkg = line.match(/^package\s+([A-Za-z_][\w]*)/);
    if (pkg) {
      push(pkg[1], "module", i + 1, true);
      continue;
    }

    if (/^import\s*(\(|")/.test(line)) {
      if (line.endsWith("(") && !line.includes('"')) inImportBlock = true;
      const single = line.match(/"([^"]+)"/);
      if (single) addImport(single[1]);
      continue;
    }
    if (inImportBlock) {
      const m = line.match(/"([^"]+)"/);
      if (m) addImport(m[1]);
      if (line.startsWith(")")) inImportBlock = false;
      continue;
    }

    let m = line.match(/^func\s+\([^)]*\)\s*([A-Za-z_][\w]*)\s*\(/);
    if (m) {
      push(m[1], "method", i + 1, /^[A-Z]/.test(m[1]));
      continue;
    }
    m = line.match(/^func\s+([A-Za-z_][\w]*)\s*\(/);
    if (m) {
      push(m[1], "function", i + 1, /^[A-Z]/.test(m[1]));
      continue;
    }
    m = line.match(/^type\s+([A-Za-z_][\w]*)\s+(\w+)/);
    if (m) {
      push(m[1], m[2] === "interface" ? "interface" : "type", i + 1, /^[A-Z]/.test(m[1]));
      continue;
    }
  }
}

// --- Rust -------------------------------------------------------------------

/** @param {{ lines: string[], push: (name: string, kind: string, line: number, exported: boolean) => void, addImport: (raw: string) => void }} s */
function extractRust({ lines, push, addImport }) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith("//")) continue;

    const use = line.match(/^use\s+([\w:{};,\s*]+?);/);
    if (use) {
      addImport(use[1]);
      continue;
    }

    const exported = line.startsWith("pub");
    let m = line.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/);
    if (m) {
      push(m[1], "function", i + 1, exported || /^(main|new)$/.test(m[1]));
      continue;
    }
    m = line.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|union)\s+([A-Za-z_][\w]*)/);
    if (m) {
      push(m[1], "type", i + 1, exported);
      continue;
    }
    m = line.match(/^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/);
    if (m) {
      push(m[1], "interface", i + 1, exported);
      continue;
    }
    m = line.match(/^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][\w]*)/);
    if (m) {
      push(m[1], "module", i + 1, exported);
      continue;
    }
    m = line.match(/^impl(?:<[^>]*>)?\s+(?:[\w:]+\s+for\s+)?([A-Za-z_][\w:]*)/);
    if (m) push(m[1], "module", i + 1, false);
  }
}

// --- Generic (unrecognised but interesting languages) ------------------------

const GENERIC_DEFS = [
  { re: /^(?:export\s+)?(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
  { re: /^(?:export\s+)?\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?class\s+([A-Za-z_]\w*)/, kind: "class" },
  { re: /^(?:export\s+)?(?:async\s+)?function\s*([A-Za-z_]\w*)/, kind: "function" },
  { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*=/, kind: "const" },
];

/** @param {{ lines: string[], push: (name: string, kind: string, line: number, exported: boolean) => void, addImport: (raw: string) => void }} s */
function extractGeneric({ lines, push, addImport }) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;

    const imp = line.match(/\b(?:import\s+|require\s*\(\s*['"]|from\s+['"]|include\s+['"]|#include\s*[<"])([^'"\s<>]+)/);
    if (imp?.[1]) addImport(imp[1]);

    for (const pat of GENERIC_DEFS) {
      const m = line.match(pat.re);
      if (m) {
        push(m[1], pat.kind, i + 1, true);
        break;
      }
    }
  }
}

/**
 * Where a raw import specifier *could* live inside the workspace, closest
 * guess first. The caller checks the real walk and keeps the first existing
 * candidate. Unresolvable specifiers (bare packages, urls) yield nothing.
 *
 * @param {string} raw specifier from the source
 * @param {string} fromFile workspace-relative importing file
 * @returns {string[]} candidates, workspace-relative, "/"-separated
 */
export function importCandidates(raw, fromFile) {
  if (!raw || typeof raw !== "string") return [];
  if (/^[a-z][\w.-]*:/.test(raw) || /^https?:/.test(raw)) return [];
  const out = [];
  const add = (p) => {
    const norm = p.replaceAll("\\", "/").replace(/^\.\//, "");
    if (norm && !out.includes(norm)) out.push(norm);
  };
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.js", ".py", ".go", ".rs"];

  let base;
  if (raw.startsWith("./") || raw.startsWith("../")) {
    // Relative: walk segment by segment from the importing file's directory.
    base = resolveRelative(fromFile, raw);
    // A specifier that already carries a real extension gets no more guesses:
    // appending ".ts.ts" to "./b.ts" would only ever miss.
    if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/.test(base)) {
      add(base);
      return out;
    }
    add(base);
  } else {
    base = raw.replace(/\/+$/, "");
    add(base);
  }

  for (const ext of exts) add(`${base}${ext}`);
  if (base.includes(".")) {
    const slashed = base.split(".").join("/");
    for (const ext of exts) add(`${slashed}${ext}`);
  }
  return out;
}

/**
 * Apply a "./"-or-"../"-led specifier against a workspace-relative file, with
 * plain array maths — no process-cwd involvement, so the result stays
 * workspace-relative and Windows/Unix identical.
 */
function resolveRelative(fromFile, raw) {
  const dir = fromFile ? fromFile.replaceAll("\\", "/").split("/").slice(0, -1) : [];
  const out = [...dir];
  for (const seg of raw.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

export default { extractSource, detectLanguage, importCandidates, MAX_SYMBOLS_PER_FILE };
