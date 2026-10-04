import { platform, arch } from "os";

// === OS/Arch helpers (Stainless fingerprint) ===
export function mapStainlessOs() {
  switch (platform()) {
    case "darwin": return "MacOS";
    case "win32": return "Windows";
    case "linux": return "Linux";
    case "freebsd": return "FreeBSD";
    default: return `Other::${platform()}`;
  }
}

export function mapStainlessArch() {
  switch (arch()) {
    case "x64": return "x64";
    case "arm64": return "arm64";
    case "ia32": return "x86";
    default: return `other::${arch()}`;
  }
}

// Anthropic API version (single source — reused across claude-format providers/executors)
export const ANTHROPIC_API_VERSION = "2023-06-01";
export const CLAUDE_CLI_VERSION = "2.1.280";

// Shared Claude-compatible API headers (reused across claude-format providers)
export const CLAUDE_API_HEADERS = {
  "Anthropic-Version": ANTHROPIC_API_VERSION,
  "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14"
};

// Full Claude CLI fingerprint — required by providers that gate on client identity (e.g. agentrouter)
export const CLAUDE_CLI_SPOOF_HEADERS = {
  "Anthropic-Version": ANTHROPIC_API_VERSION,
  "Anthropic-Beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28",
  "Anthropic-Dangerous-Direct-Browser-Access": "true",
  "User-Agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`,
  "X-App": "cli",
  "X-Stainless-Helper-Method": "stream",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime-Version": "v24.14.0",
  "X-Stainless-Package-Version": "0.80.0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Lang": "js",
  "X-Stainless-Arch": mapStainlessArch(),
  "X-Stainless-Os": mapStainlessOs(),
  "X-Stainless-Timeout": "600"
};

const ANTHROPIC_BETA_BASE = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
];
const ANTHROPIC_BETA_HEAVY_AGENT = ["advanced-tool-use-2025-11-20", "effort-2025-11-24"];

// Heavy-agent beta flags are gated to opus/sonnet — cheaper models don't need them.
// `redact-thinking` asks Anthropic to return signature-only thinking blocks, which
// is right for clients that never render thinking but blanks the summaries a
// client explicitly requested with `thinking.display: "summarized"`.
const ANTHROPIC_BETA_REDACT_THINKING = "redact-thinking-2026-02-12";

export function wantsThinkingSummaries(body) {
  return body?.thinking?.display === "summarized";
}

export function selectAnthropicBeta(model = "", body = null) {
  const flags = ANTHROPIC_BETA_BASE.filter((flag) => flag !== ANTHROPIC_BETA_REDACT_THINKING || !wantsThinkingSummaries(body));
  if (/^claude-(opus|sonnet)/.test(model)) flags.push(...ANTHROPIC_BETA_HEAVY_AGENT);
  return flags.join(",");
}

export function mergeAnthropicBeta(...values) {
  const flags = values.flatMap((v) => (typeof v === "string" ? v.split(",") : [])).map((f) => f.trim()).filter(Boolean);
  return [...new Set(flags)].join(",");
}

// Shared baseUrls
export const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1/messages";

// Default base for dynamic compat providers (openai-compatible-* / anthropic-compatible-*) when user gives no baseUrl
export const OPENAI_COMPAT_BASE = "https://api.openai.com/v1";
export const ANTHROPIC_COMPAT_BASE = "https://api.anthropic.com/v1";

// Official Antigravity IDE Desktop 2.11.0 fingerprint captured from macOS arm64.
// Keep this static even when 9router runs on Linux: the provider profile is
// intentionally matching the IDE client, not the server host.
export const ANTIGRAVITY_IDE_VERSION = "2.11.0";
export const ANTIGRAVITY_IDE_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_IDE_USER_AGENT = `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} darwin/arm64`;

// OAuth client credentials.
//
// AgentFlow change: upstream hardcoded Google/Antigravity OAuth client secrets in
// this file. Those are third-party credentials that belong to upstream, not to this
// project, and GitHub push protection correctly blocks them. They are now read from
// the environment instead. Providers requiring them will report "not configured"
// via `aflow doctor` until the operator supplies their own OAuth client.
//
// Derived from 9Router open-sse/providers/shared.js @ a99cf572 (MIT).
// Copyright (c) 2024-2026 decolua and contributors. See THIRD_PARTY_NOTICES.md.

export function oauthClientFromEnv(name) {
  const id = process.env[`${name}_OAUTH_CLIENT_ID`] || "";
  const secret = process.env[`${name}_OAUTH_CLIENT_SECRET`] || "";
  return { clientId: id, clientSecret: secret };
}

/** True when the operator supplied credentials for this OAuth client. */
export function oauthClientConfigured(name) {
  const { clientId, clientSecret } = oauthClientFromEnv(name);
  return Boolean(clientId && clientSecret);
}

export const ANTIGRAVITY_OAUTH_CLIENT = oauthClientFromEnv("ANTIGRAVITY");

export const GOOGLE_OAUTH_CLIENT = oauthClientFromEnv("GOOGLE");

export const IFLOW_OAUTH_CLIENT = oauthClientFromEnv("IFLOW");

export const WINDSURF_OAUTH_CLIENT = oauthClientFromEnv("WINDSURF");

// Firebase web API keys are lower-risk than OAuth client secrets — they are
// designed to ship in client bundles and are restricted by Firebase security
// rules rather than treated as secrets. Hardcoding one still pins this fork to
// upstream's Firebase project, so it is operator-supplied here like the rest.
export const WINDSURF_FIREBASE_API_KEY = process.env.WINDSURF_FIREBASE_API_KEY || "";

/** True when a provider's OAuth client *and* extra key are both supplied. */
export function windsurfConfigured() {
  return oauthClientConfigured("WINDSURF") && Boolean(WINDSURF_FIREBASE_API_KEY);
}
