# Providers

AgentFlow talks to one OpenAI-compatible endpoint. That endpoint can be an
external gateway (a 9Router instance by default) or the in-repo gateway started
with `aflow server`. When you use the in-repo gateway, it can forward to any of
the twelve upstream providers below.

This document is the reference for **which providers exist, what credential each
needs, and how a request finds one**. The registry itself is
`PROVIDERS` in [`src/core/gateway-server.js`](../src/core/gateway-server.js);
this file mirrors it and is checked against it by `test/gateway-remote-providers.test.js`.

## The twelve upstreams

| Provider | Model id prefix | Required env var(s) | Notes |
|---|---|---|---|
| Groq | `groq/` | `GROQ_API_KEY` | free tier, no credit card |
| Cerebras | `cerebras/` | `CEREBRAS_API_KEY` | free tier, no credit card |
| Mistral | `mistral/` | `MISTRAL_API_KEY` | free tier, rate-limited |
| Google Gemini | `gemini/` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | either key works |
| OpenRouter | `openrouter/` | `OPENROUTER_API_KEY` | free models available |
| Cloudflare Workers AI | `cloudflare/` | `CLOUDFLARE_API_TOKEN` **and** `CLOUDFLARE_ACCOUNT_ID` | multi-key; account id is part of the URL |
| HuggingFace Inference | `hf/` | `HF_TOKEN` | shared rate limit |
| Together AI | `together/` | `TOGETHER_API_KEY` | $5 free credit on signup |
| Fireworks AI | `fireworks/` | `FIREWORKS_API_KEY` | $1 free credit on signup |
| DeepInfra | `deepinfra/` | `DEEPINFRA_API_KEY` | free tier available |
| SambaNova | `sambanova/` | `SAMBANOVA_API_KEY` | free tier available |
| Ollama (local) | `ollama/` | — (no key) | local; never needs a credential |

The fastest way to configure any of them is the wizard:

```sh
aflow setup                 # pick a provider, paste a key, it is tested before it is saved
aflow setup --check         # probe every configured provider and report reachability
aflow setup --export        # print shell exports for the saved keys
```

## How a model id resolves to a provider

`resolveTargetProvider(modelId, env, providers)` decides where a request goes.

1. **An explicit prefix wins.** `groq/llama-3.3-70b-versatile` routes to Groq
   with the model `llama-3.3-70b-versatile`. The prefix is stripped before the
   upstream call. `cloudflare/@cf/meta/llama-3.1-8b-instruct` builds the
   Cloudflare URL from the account id.
2. **A bare, provider-shaped id is inferred — only when that provider has a
   key.** The heuristics are deliberately narrow, because a wrong guess silently
   sends a request to the wrong place:

   | Shape | Provider |
   |---|---|
   | `@cf/...` | cloudflare |
   | `gemini-...` | gemini |
   | `mistral-...`, `codestral...`, `open-mistral...`, `open-mixtral...`, `pixtral...` | mistral |
   | `llama3.1-...` (Cerebras's dotted shape) | cerebras |
   | `llama-...`, `mixtral...`, `gemma...`, `deepseek-...` | groq |
   | `Meta-Llama-...` (SambaNova's capitalised shape) | sambanova |

   Bare HuggingFace/Together ids such as `meta-llama/...` are **not** inferred:
   the slash looks like a provider prefix and would be guessed ambiguously.
3. **Anything unmatched, or a shaped id with no key present, falls back to
   Ollama** (local).

## Free-first routing

Candidate lists are ordered **free → free-tier → unknown → paid**. The sort is
stable, so within a class the catalogue's own order is preserved. Explicit
intent always wins: a model named on the command line, a pinned agent model, an
agent's `prefer` list, and a `--fallback` order are never re-ordered.

The classification is deliberately evidence-based:

| Class | Evidence |
|---|---|
| `free` | A local provider (`ollama/`), an OpenRouter-style `:free` id, or a declared hint |
| `free-tier` | The provider advertises a no-card free tier, but the quota is rate-limited (Groq, Cerebras, Mistral, Gemini, Cloudflare, HuggingFace, DeepInfra, SambaNova) |
| `unknown` | No direct evidence. Includes OpenRouter `auto`, signup-credit providers, and bare ids |
| `paid` | Only a declared hint or catalogue metadata can say this for certain |

A provider advertising a free tier is **not** the same as a specific model being
free forever, which is why it gets its own class rather than `free`. Nothing is
silently labelled free because a provider's marketing page says so.

Declare an override in `.agentflow.json` when you know better:

```json
{
  "preferFree": true,
  "modelHints": {
    "acme/enterprise-model": { "costClass": "paid" },
    "openrouter/auto": { "costClass": "paid" }
  }
}
```

Disable the policy with `"preferFree": false` or
`AGENTFLOW_PREFER_FREE=0`. The resolved agent plan records
`cost.preference` and the class of every candidate, so `aflow logs` and
`aflow agent run --json` can explain why a model was tried before another.

Paid models are not used as anonymous fallbacks by default. Set
`"allowPaidFallback": true` (or `AGENTFLOW_ALLOW_PAID_FALLBACK=1`) to permit
them. This only governs candidates nobody named: an explicit model, a pinned
agent model, an agent's `prefer` list, and a `--fallback` order still win.

## Request limits, cooldowns, and quota

Three different facts are deliberately kept separate:

| Fact | Source | What it means |
|---|---|---|
| Request-rate limit | `ratePerMin` in the provider registry | At most N requests per rolling 60s window, locally |
| Provider cooldown | A provider's `Retry-After` header | Do not send this provider another request until the stated time |
| Account quota | Not modelled | Unknown unless a provider says so in an error |

`ratePerMin` is **request-rate metadata only**. It is not a daily quota, a token
budget, or a billing limit. Only providers with a confirmed value are limited
locally:

| Provider | `ratePerMin` |
|---|---|
| Groq | 30 |
| Cerebras | 30 |
| Gemini | 15 |
| All others | `null` — no local limit is invented |

A provider with no declared limit is unlimited *locally*. That is not a claim
that the provider has quota left: unknown stays unknown. The rolling window is
process-local and is not persisted across invocations; it exists to stop one
process from oversubscribing a rate it can see. A permit is reserved before a
request is dispatched. A request that provably never left the process releases
its permit; a request that may have reached the provider stays counted even if
it failed. Waiting for a slot is bounded (`maxRateLimitWaitMs`, default 5s) and
cancellable, so routing moves to another candidate instead of hanging.

`Retry-After` is honored in both RFC 9110 forms — delay-seconds and HTTP-date.
Missing, malformed, negative, and already-past values do not create a cooldown.
A value beyond 24 hours is clamped rather than trusted forever. The cooldown is
provider-scoped: after `groq` answers 429 with `Retry-After: 30`, the rest of the
Groq models are skipped for 30 seconds, not just the model that failed. Cooldown
state lives in `ProviderHealth` and survives `toJSON()`/`fromJSON()`; the local
rolling-window state does not.

Failures are classified before fallback:

- `rate_limited` tries another candidate; the provider is not penalised.
- `quota`, `auth`, and `no_credentials` are permanent for the run and skip the
  rest of that provider.
- `invalid_request` is permanent for the run but does not skip the provider,
  because the next model may accept the request.
- `timeout`, `network`, `server`, and `empty` are transient and fall through.

When no candidate is permitted, the error names the evidence it has — local
rate limit, cooldown, open circuit, auth, quota — and the earliest retry time
when a `Retry-After` established one.

Usage observations are recorded without inventing numbers. Token counts come
only from a provider-supplied `usage` object; a missing field stays unknown. A
cost is stored only when the caller supplies both a finite amount and a named
pricing source. The ledger never reports a remaining free-tier balance, because
no provider here exposes one reliably.

## Missing credentials fail loudly, not silently

A request for a remote provider whose key is absent throws
`ProviderAuthMissingError` with a message that names the exact variable(s):

- one key: `Provider groq requires GROQ_API_KEY to be set in environment`
- either-of: `Provider gemini requires GEMINI_API_KEY (or GOOGLE_API_KEY) ...`
- all-of: `Provider cloudflare requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID ...`

The message never contains a key. `/v1/models` only advertises a remote
provider once its credential is present, so a model you can select is one the
gateway can actually authenticate.

## Keys file

Keys can live in the environment or in a keys file written by `aflow setup`
(owner-only on Unix). Precedence: **`process.env` wins over the keys file**, so a
key exported in your shell always overrides one saved on disk.
