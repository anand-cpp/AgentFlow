// Secret redaction for anything that gets logged or printed.
//
// Two rules:
//   1. Never let a credential reach stdout, stderr, or the event log.
//   2. Redact by pattern, not by allow-list, because new secret shapes appear
//      in provider code constantly and an allow-list silently misses them.
//
// Patterns cover the credential formats actually seen in this ecosystem:
// bearer tokens, provider API keys, Google OAuth secrets, GitHub tokens,
// JWTs, and long provider-specific key formats.

const PATTERNS = [
  // Order matters: more specific first so a JWT isn't partially masked.
  { name: "google-oauth-secret", re: /GOCSPX-[A-Za-z0-9_-]{10,}/g, mask: "GOCSPX-***" },
  // Firebase/Google API keys: `AIza` + exactly 35. Pinned to the exact length to
  // match scripts/scan-secrets.mjs, so incidental `AIza` text (including this
  // comment and the scanner's own regex source) is not masked. Lower risk than
  // an OAuth secret -- these ship in client bundles -- but hardcoding one still
  // pins a fork to someone else's Firebase project.
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, mask: "AIza***" },
  { name: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, mask: "github_***" },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, mask: "eyJ***" },
  { name: "sk-key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, mask: "sk-***" },
  { name: "google-client-id", re: /\b\d{10,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com\b/g, mask: "***.apps.googleusercontent.com" },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, mask: "AKIA***" },
  { name: "bearer", re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g, mask: "Bearer ***" },
  { name: "x-api-key", re: /\bx-api-key\s*[:=]\s*[A-Za-z0-9._~+/-]{12,}/gi, mask: "x-api-key: ***" },
  { name: "query-secret", re: /([?&](?:key|api_key|apikey|access_token|token|secret|password)=)[^&\s"']{8,}/gi, mask: "$1***" },
  { name: "assignment", re: /\b(?:api[_-]?key|client[_-]?secret|password|passwd|secret|token)\b\s*[:=]\s*["']?([A-Za-z0-9._~+/-]{12,})["']?/gi,
    mask: (m) => m.replace(/([:=]\s*["']?)[A-Za-z0-9._~+/-]{12,}/, "$1***") },
];

/**
 * Redact secrets from an arbitrary string.
 * Never throws: a redaction failure must not block logging.
 */
export function redact(input) {
  if (input === null || input === undefined) return input;
  let s = typeof input === "string" ? input : String(input);
  for (const { re, mask } of PATTERNS) {
    s = s.replace(re, mask);
  }
  return s;
}

/**
 * Deep-redact an object. Walks nested structures, including arrays, and
 * redacts key names that are themselves sensitive.
 */
const SENSITIVE_KEYS = /^(?:api[_-]?key|apikey|client[_-]?secret|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|authorization|cookie|session[_-]?id|jwt|private[_-]?key)$/i;

export function redactDeep(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value);
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redactDeep(v, seen));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.test(k) ? "***" : redactDeep(v, seen);
  }
  return out;
}

export default { redact, redactDeep };