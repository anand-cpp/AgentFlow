// LSP capability helpers: hover, definition, completion, document symbols.
//
// Each of these is a thin translation between the tool/CLI world (file path,
// 1-based-ish coordinates, plain text out) and the wire shapes the protocol
// returns (URI + 0-based position, three different hover encodings, definition
// as Location or LocationLink). Keeping the translation here means the tool
// layer never sees a `MarkupContent` union or a `targetUri` field.
//
// All helpers assume the document is already open on the client. The session
// facade in tools.js is what opens files before calling in.

import { pathToUri, uriToPath } from "./client.js";

/** Collapse the three legal hover encodings to plain text. */
export function formatHover(result) {
  const contents = result?.contents;
  if (contents == null) return null;
  if (typeof contents === "string") return contents.trim() || null;
  if (Array.isArray(contents)) {
    const text = contents
      .map((part) => (typeof part === "string" ? part : String(part?.value ?? "")))
      .join("\n\n")
      .trim();
    return text || null;
  }
  const value = String(contents.value ?? "").trim();
  return value || null;
}

/** Reduce a Location or LocationLink to `{ file, range, line, character }`. */
export function normaliseLocation(loc) {
  if (!loc) return null;
  const uri = loc.uri ?? loc.targetUri ?? null;
  const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange ?? null;
  if (!uri) return null;
  return {
    file: uriToPath(uri),
    range,
    line: range?.start?.line ?? 0,
    character: range?.start?.character ?? 0,
  };
}

/** @param {string} filePath @param {number} line @param {number} character */
function docPos(filePath, line, character) {
  return {
    textDocument: { uri: pathToUri(filePath) },
    position: { line: Number(line) || 0, character: Number(character) || 0 },
  };
}

/**
 * @param {import("./client.js").LspClient} client
 * @param {string} filePath
 * @param {number} line 0-based
 * @param {number} character 0-based
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string|null>}
 */
export async function getHover(client, filePath, line, character, { timeoutMs } = {}) {
  return formatHover(await client.request("textDocument/hover", docPos(filePath, line, character), { timeoutMs }));
}

/**
 * @param {import("./client.js").LspClient} client
 * @param {string} filePath
 * @param {number} line 0-based
 * @param {number} character 0-based
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Array<{ file: string, range: any, line: number, character: number }>>}
 */
export async function getDefinition(client, filePath, line, character, { timeoutMs } = {}) {
  const result = await client.request("textDocument/definition", docPos(filePath, line, character), { timeoutMs });
  const list = Array.isArray(result) ? result : result ? [result] : [];
  return list.map(normaliseLocation).filter(Boolean);
}

/**
 * @param {import("./client.js").LspClient} client
 * @param {string} filePath
 * @param {number} line 0-based
 * @param {number} character 0-based
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Array<{ label: string, kind: number|null, detail: string|null }>>}
 */
export async function getCompletions(client, filePath, line, character, { timeoutMs } = {}) {
  const result = await client.request("textDocument/completion", docPos(filePath, line, character), { timeoutMs });
  const items = Array.isArray(result) ? result : result?.items ?? [];
  return items.map((item) => ({
    label: String(item?.label ?? ""),
    kind: item?.kind ?? null,
    detail: item?.detail ?? null,
    insertText: item?.insertText ?? item?.label ?? null,
  }));
}

/**
 * Document symbols, flattened to a list with a `container` breadcrumb.
 * @param {import("./client.js").LspClient} client
 * @param {string} filePath
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Array<{ name: string, kind: number|null, container: string|null, line: number, character: number }>>}
 */
export async function getDocumentSymbols(client, filePath, { timeoutMs } = {}) {
  const result = await client.request(
    "textDocument/documentSymbol",
    { textDocument: { uri: pathToUri(filePath) } },
    { timeoutMs },
  );
  const out = [];
  const walk = (nodes, container) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const range = node.range ?? node.location?.range ?? null;
      out.push({
        name: String(node.name ?? ""),
        kind: node.kind ?? null,
        container: container ?? null,
        line: range?.start?.line ?? 0,
        character: range?.start?.character ?? 0,
      });
      if (node.children) walk(node.children, node.name);
    }
  };
  walk(result, null);
  return out;
}

export default { getHover, getDefinition, getCompletions, getDocumentSymbols, formatHover, normaliseLocation };

