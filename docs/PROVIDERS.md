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
