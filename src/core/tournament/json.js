// JSON extraction shared by every Arena stage.
//
// Models wrap JSON in prose, markdown fences, or both. Each stage used to grow
// its own near-identical extractor, which is how one stage quietly accepts
// output another rejects. The parsing rules live here:
//
//   * accept a bare object or a fenced block;
//   * find the first balanced `{...}`, honouring strings and escapes so a brace
//     inside a quoted example does not end the object early;
//   * never eval, never repair, never invent fields.

/**
 * Slice the first balanced JSON object out of arbitrary text, or null.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function extractBalancedObject(text) {
  const source = String(text ?? "");
  const start = source.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse structured model output. The label appears in every error so a
 * tournament failure says which stage produced the unreadable response.
 *
 * @param {string} text
 * @param {string} [label]
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function parseModelJson(text, label = "model") {
  const source = typeof text === "string" ? text : "";
  if (!source.trim()) return { ok: false, error: `${label} returned an empty response` };

  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : source;
  const slice = extractBalancedObject(body);
  if (slice === null) return { ok: false, error: `no JSON object found in ${label} output` };

  try {
    const value = JSON.parse(slice);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, error: `${label} output is not a JSON object` };
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: `${label} output is not valid JSON: ${err.message}` };
  }
}

export default { extractBalancedObject, parseModelJson };
