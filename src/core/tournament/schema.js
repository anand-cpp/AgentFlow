// Small validation helpers shared by the Arena stages.
//
// Every stage validates model output against a closed vocabulary: unknown
// fields are errors, not extras. That rule is what stops a judge from smuggling
// `"confidence": 0.99` into a schema that never looks at it, and it only works
// if every stage applies it the same way. Keeping the helpers here means the
// judge and the match schema cannot drift into two slightly different ideas of
// "a plain object".

/** @param {unknown} value */
export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Record an error for every key the schema does not allow.
 *
 * @param {string[]} errors
 * @param {object} object
 * @param {Set<string>} allowed
 * @param {string} [where] prefix, already ending in "." when nested
 */
export function addUnknownFields(errors, object, allowed, where = "") {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) errors.push(`${where}unknown field "${key}"`);
  }
}
