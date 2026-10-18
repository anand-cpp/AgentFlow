// Shared JSDoc typedefs for the core subsystem.
//
// This file exports no runtime value. It exists so type-checking has one place
// to define the shapes that multiple core modules construct and consume, and so
// a shape change in one place cannot silently desynchronise the annotations of
// another. Each typedef below is derived from the module that owns the shape --
// that module is the source of truth, not this file.
//
// All properties are optional unless the owning module makes them mandatory, so
// annotating a caller never invents new required inputs.

/**
 * @typedef {Object} SessionEntry
 * @property {string} id Unique entry id.
 * @property {string} [kind] One of "conversation", "toolCall", "system", "error".
 * @property {string} [role] Speaker role ("user", "assistant", "system", "tool").
 * @property {*} [content] The content itself (string for text, object for tool calls).
 * @property {string} [tool] Tool name, when kind is "toolCall".
 * @property {*} [result] Tool result, when kind is "toolCall".
 * @property {number} [ts] Milliseconds since epoch.
 * @property {string} [at] ISO-8601 timestamp.
 */

/**
 * @typedef {Object} SessionState A session as stored and returned by src/core/sessions.js.
 * @property {number} version Schema version.
 * @property {string} id
 * @property {string} [name]
 * @property {{ root: string, name: string }|null} [project]
 * @property {string} createdAt ISO-8601.
 * @property {string} [updatedAt]
 * @property {string|null} [archivedAt]
 * @property {string|null} [completedAt]
 * @property {string} [state]
 * @property {string|null} [objective]
 * @property {string|null} [provider]
 * @property {string|null} [model]
 * @property {string[]} [agents]
 * @property {string[]} [blackboardRefs]
 * @property {number} [maxEntries]
 * @property {Object} [counters]
 * @property {SessionEntry[]} [entries]
 */

/**
 * @typedef {Object} BlackboardTask A task as recorded by src/core/blackboard.js addTask/updateTask.
 * @property {string} id
 * @property {string} title
 * @property {string|null} [detail]
 * @property {string} [status]
 * @property {string[]} [dependsOn]
 * @property {string|null} [sessionId]
 * @property {string[]} [commits]
 * @property {string[]} [blockedBy]
 * @property {string} [createdAt]
 * @property {string} [updatedAt]
 * @property {string|null} [goal]
 * @property {string|null} [plan]
 */

/**
 * @typedef {Object} BlackboardFinding A finding as recorded by src/core/blackboard.js recordFinding.
 * @property {string} id
 * @property {string} source
 * @property {string|null} [author]
 * @property {string} severity
 * @property {string} title
 * @property {string|null} [detail]
 * @property {string} status
 * @property {string|null} [taskId]
 * @property {string|null} [sessionId]
 * @property {string[]} [files]
 * @property {string} [createdAt]
 * @property {string|null} [updatedAt]
 */

/**
 * @typedef {Object} BlackboardDecision A decision as recorded by src/core/blackboard.js recordDecision.
 * @property {string} id
 * @property {string} kind
 * @property {string} title
 * @property {string|null} [detail]
 * @property {string} [rationale]
 * @property {string[]} [alternatives]
 * @property {string} [status]
 * @property {string|null} [supersedes]
 * @property {string|null} [supersededBy]
 * @property {string|null} [taskId]
 * @property {string|null} [sessionId]
 * @property {string|null} [commit]
 * @property {string} [createdAt]
 */

/**
 * @typedef {Object} RouteCandidate A routing candidate, see src/core/routing.js.
 * @property {string} model Model id.
 * @property {string} [provider] Provider id.
 * @property {string} [tier] Quality tier name.
 * @property {boolean} [preferred]
 * @property {boolean} [healthy]
 * @property {string} [reason] Why this candidate was chosen.
 */

/**
 * @typedef {Object} RouteFailure A routing attempt record, see src/core/routing.js.
 * @property {string} model
 * @property {string} [provider]
 * @property {string|number} [tier]
 * @property {string} outcome One of the FAILURE kinds or "ok".
 * @property {number} [elapsedMs]
 * @property {string|null} [error]
 */

/**
 * @typedef {Object} HealthState A provider's circuit-breaker memory, see src/core/provider-health.js.
 * @property {string} [provider]
 * @property {string} [state] "ok" | "cooldown" | "degraded".
 * @property {number} [until] Epoch ms until the cooldown expires.
 * @property {number} [at] Epoch ms when the probe was recorded.
 * @property {number} [attempts] Consecutive failures.
 */

/**
 * @typedef {Object} TribunalProposal A proposal evaluated by the tribunal, see src/core/tribunal/.
 * @property {string} [id]
 * @property {string} [title]
 * @property {string} [question]
 * @property {string} [problem]
 * @property {string} [proposal]
 * @property {string} [rationale]
 * @property {string[]} [alternatives]
 * @property {string[]} [scope]
 */

/**
 * @typedef {Object} TribunalFinding A single finding in a tribunal report.
 * @property {string} [title]
 * @property {string} [detail]
 * @property {string} [severity]
 * @property {string} [category]
 * @property {string|null} [file]
 * @property {number} [line]
 */

/**
 * @typedef {Object} TribunalReport The verdict a tribunal stage produces.
 * @property {string} [verdict]
 * @property {string} [summary]
 * @property {TribunalFinding[]} [findings]
 * @property {string|null} [next_action]
 * @property {string} [schema_version]
 */

/**
 * @typedef {Object} GatewayRequest A completion request as the gateway handles it.
 * @property {string} [model]
 * @property {Array<{role: string, content: string}>} [messages]
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 * @property {boolean} [stream]
 * @property {string} [provider]
 */

/**
 * @typedef {Object} GatewayResponse A completion response as the gateway returns it.
 * @property {string} [text]
 * @property {string} [model]
 * @property {string} [provider]
 * @property {string} [id]
 * @property {number} [created]
 * @property {Object} [usage]
 */

/**
 * @typedef {Object} AgentCapability A capability as declared by an agent definition, see src/core/agents/.
 * @property {string} [name]
 * @property {string} [description]
 * @property {boolean} [allowed]
 * @property {boolean} [requiresApproval]
 * @property {Object} [params]
 */

/**
 * @typedef {Object} AgentPermission A permission entry as resolved by the agents subsystem.
 * @property {string[]} [allow]
 * @property {string[]} [deny]
 * @property {string[]} [tools]
 * @property {string[]} [paths]
 * @property {string} [reason]
 */

/**
 * @typedef {Object} AgentContext The per-run context handed to agent tools, see src/core/agents/context.js.
 * @property {Object} [agent]
 * @property {BlackboardTask|null} [task]
 * @property {Object} [identity]
 * @property {string} [projectRoot]
 * @property {number} [budget]
 */

/**
 * @typedef {Object} ResolvedConfig The effective configuration surface handed
 * to commands by src/config/index.js. Keys mirror DEFAULTS but values are
 * widened to their runtime types: literal defaults may be overridden by config
 * files, AGENTFLOW_* environment variables, and CLI flags.
 * @property {string} baseUrl          gateway base URL
 * @property {string|null} apiKey      provider credential (may be split into apiKeys)
 * @property {number} probeTimeoutMs   provider probe timeout, ms
 * @property {string|null} defaultModel  model used when a command needs one
 * @property {Record<string, unknown>} modelHints  declared capability hints by model id
 * @property {string} theme            auto | dark | light
 * @property {number} serverPort       local gateway server port
 * @property {string} serverHost       local gateway server host
 * @property {string} ollamaUrl        base URL of the local Ollama instance
 * @property {string|null} serverApiKey  auth key for the local gateway, if any
 * @property {boolean} json            emit structured JSON on stdout
 * @property {boolean} quiet           suppress non-essential output
 * @property {boolean} verbose         include diagnostic detail
 * @property {boolean} noColor         disable ANSI colour
 * @property {string} logLevel         debug | info | warn | error
 * @property {string|null} logPath     explicit event-log path, or null for default
 * @property {boolean} mapEnabled      repository map injected into agent context
 * @property {number} mapMaxFiles      hard cap on walked files before ranking
 * @property {number} mapMaxPromptTokens  token budget of the injected map section
 * @property {string[]|null} mapLanguages  language-family allowlist, null = all known
 */

export {};