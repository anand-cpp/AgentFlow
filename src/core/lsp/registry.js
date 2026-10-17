// Language-server registry.
//
// Which server speaks for which language, how to launch it, and whether it is
// actually installed. The mapping is data, not code, so the rest of the LSP
// layer never hard-codes a language: it asks `getServerForFile(path)` and gets
// a launch recipe or nothing.

import { execFile } from "node:child_process";
import path from "node:path";

/**
 * @typedef {object} LanguageServer
 * @property {string} id
 * @property {string} language human label
 * @property {string[]} extensions lowercased, dot-prefixed
 * @property {string} command
 * @property {string[]} args
 * @property {string} install install hint shown when the command is missing
 */

/** @type {LanguageServer[]} */
export const LANGUAGE_SERVERS = [
  {
    id: "typescript",
    language: "TypeScript / JavaScript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    command: "typescript-language-server",
    args: ["--stdio"],
    install: "npm i -g typescript-language-server typescript",
  },
  {
    id: "rust",
    language: "Rust",
    extensions: [".rs"],
    command: "rust-analyzer",
    args: [],
    install: "rustup component add rust-analyzer",
  },
  {
    id: "go",
    language: "Go",
    extensions: [".go"],
    command: "gopls",
    args: [],
    install: "go install golang.org/x/tools/gopls@latest",
  },
  {
    id: "clangd",
    language: "C / C++",
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx", ".hh"],
    command: "clangd",
    args: [],
    install: "install clangd (shipped with LLVM)",
  },
  {
    id: "python",
    language: "Python",
    extensions: [".py", ".pyi"],
    command: "pylsp",
    args: [],
    install: "pip install python-lsp-server",
  },
  {
    id: "html",
    language: "HTML",
    extensions: [".html", ".htm"],
    command: "vscode-html-language-server",
    args: ["--stdio"],
    install: "npm i -g vscode-langservers-extracted",
  },
  {
    id: "css",
    language: "CSS",
    extensions: [".css", ".scss", ".less"],
    command: "vscode-css-language-server",
    args: ["--stdio"],
    install: "npm i -g vscode-langservers-extracted",
  },
  {
    id: "json",
    language: "JSON",
    extensions: [".json", ".jsonc"],
    command: "vscode-json-language-server",
    args: ["--stdio"],
    install: "npm i -g vscode-langservers-extracted",
  },
];

const WHICH = process.platform === "win32" ? "where" : "which";

/**
 * Look a command up on PATH. Splits the platform difference so the rest of the
 * registry is unaware of `where` vs `which`.
 *
 * @param {string} command
 * @returns {Promise<{ ok: boolean, path: string|null, error: string|null }>}
 */
function defaultProbe(command) {
  return new Promise((resolve) => {
    execFile(WHICH, [command], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false, path: null, error: err.message });
      const first = String(stdout).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
      resolve({ ok: true, path: first, error: null });
    });
  });
}

/** Normalise a path (or bare name) to a lowercased, dot-prefixed extension. */
export function extensionOf(filePath) {
  const ext = path.extname(String(filePath ?? "")).toLowerCase();
  return ext;
}

/**
 * The server responsible for a file, or null when no language is registered for
 * its extension.
 * @param {string} filePath
 * @returns {LanguageServer|null}
 */
export function getServerForFile(filePath) {
  const ext = extensionOf(filePath);
  if (!ext) return null;
  return LANGUAGE_SERVERS.find((s) => s.extensions.includes(ext)) ?? null;
}

/** @param {string} id */
export function getServerById(id) {
  return LANGUAGE_SERVERS.find((s) => s.id === id) ?? null;
}

/**
 * Probe every registered server for presence on PATH.
 *
 * Never throws: a missing server is a normal state, reported as
 * `{ installed: false }` with the install hint, not an error.
 *
 * @param {{ probe?: (command: string) => Promise<{ ok: boolean, path: string|null, error: string|null }> }} [options]
 * @returns {Promise<Array<{ id: string, language: string, command: string, args: string[], installed: boolean, path: string|null, install: string }>>}
 */
export async function detectInstalledServers({ probe = defaultProbe } = {}) {
  return Promise.all(
    LANGUAGE_SERVERS.map(async (s) => {
      const found = await probe(s.command);
      return {
        id: s.id,
        language: s.language,
        command: s.command,
        args: s.args,
        installed: found.ok,
        path: found.path,
        install: s.install,
      };
    }),
  );
}

export default { LANGUAGE_SERVERS, extensionOf, getServerForFile, getServerById, detectInstalledServers };
