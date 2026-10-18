// Tribunal personas.
//
// A persona is a lens a Forge reviewer applies to a proposal: elegance
// (simplicity), performance (resource efficiency), defensive (boundary and
// failure handling), security (adversarial input). Each reviewer is assigned
// one persona deterministically from the proposal index, so every proposal is
// examined from a distinct angle and no two reviewers share the same framing
// where the persona count allows.
//
// Personas are configured data, not hardcoded cloud models: a deployer can
// override or extend them through `config.personas` without changing code.

export const PERSONA_ELEGANCE = "elegance";
export const PERSONA_PERFORMANCE = "performance";
export const PERSONA_DEFENSIVE = "defensive";
export const PERSONA_SECURITY = "security";

/** The built-in persona set. Every entry carries a system-prompt modifier that
 *  is prepended to the self-review system prompt when the reviewer acts. */
export const PERSONAS = Object.freeze({
  [PERSONA_ELEGANCE]: {
    id: PERSONA_ELEGANCE,
    name: "Elegance",
    modifier:
      "Prefer the simplest, clearest solution. Penalize unnecessary abstraction, indirection, and cleverness. A correct but convoluted proposal scores worse than a plain one.",
  },
  [PERSONA_PERFORMANCE]: {
    id: PERSONA_PERFORMANCE,
    name: "Performance",
    modifier:
      "Prioritize runtime and resource efficiency. Flag unnecessary allocations, repeated passes, and algorithms with poor scaling for the expected input size.",
  },
  [PERSONA_DEFENSIVE]: {
    id: PERSONA_DEFENSIVE,
    name: "Defensive",
    modifier:
      "Assume hostile input and partial failures. Validate boundaries, assume services can be slow or unavailable, and require explicit error handling at every edge.",
  },
  [PERSONA_SECURITY]: {
    id: PERSONA_SECURITY,
    name: "Security",
    modifier:
      "Treat every input as potentially malicious. Look for injection, authz bypasses, secret leakage, and unsafe deserialization. A proposal that trusts input is defective.",
  },
});

export const PERSONA_IDS = Object.freeze(Object.keys(PERSONAS));

/** Load the persona registry. A deployer may pass `config.personas` (a map of
 *  id -> { name, modifier }) to replace or extend the built-ins; unknown ids
 *  are ignored. Returns a frozen map keyed by persona id.
 *
 * @returns {{ [id: string]: { id: string, name: string, modifier: string } }}
 */
export function loadPersonas(config = {}) {
  const configured = config && config.personas;
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
    return PERSONAS;
  }
  const merged = {};
  for (const id of PERSONA_IDS) merged[id] = PERSONAS[id];
  for (const [id, entry] of Object.entries(configured)) {
    if (entry && typeof entry === "object" && entry.name && typeof entry.modifier === "string") {
      merged[id] = { id, name: String(entry.name), modifier: String(entry.modifier) };
    }
  }
  return Object.freeze(merged);
}

/** Assign one persona to a proposal, deterministically round-robin over the
 *  registry so every proposal gets a distinct lens where the count allows.
 *
 * @param {object} [proposal]
 * @param {number} [index]
 * @param {{ [id: string]: { id: string, name: string, modifier: string } }} [personas]
 * @returns {{ id: string, name: string, modifier: string }|null}
 */
export function assignPersona(proposal, index, personas = PERSONAS) {
  const ids = Object.keys(personas);
  if (ids.length === 0) return null;
  return personas[ids[index % ids.length]];
}

/** Return the system-prompt modifier for a persona (empty string when none). */
export function personaPromptModifier(persona) {
  return persona && typeof persona.modifier === "string" ? persona.modifier : "";
}

export default {
  PERSONA_ELEGANCE,
  PERSONA_PERFORMANCE,
  PERSONA_DEFENSIVE,
  PERSONA_SECURITY,
  PERSONA_IDS,
  PERSONAS,
  loadPersonas,
  assignPersona,
  personaPromptModifier,
};
