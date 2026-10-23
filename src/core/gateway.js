// Gateway client: the HTTP boundary between the CLI and a running gateway.
//
// AgentFlow is a client. It does not embed a server; it talks to a 9Router-
// derived gateway over its OpenAI-compatible API. Keeping that behind one
// module means every command shares auth, timeout, and error handling.

import { redactDeep } from "../core/redact.js";

export class GatewayError extends Error {
  /**
   * @param {string} [message]
   * @param {{ status?: number|null, code?: string|null, detail?: *|null }} [opts]
   */
  constructor(message, { status, code, detail } = {}) {
    super(message);
    this.name = "GatewayError";
    this.status = status ?? null;
    this.code = code ?? null;
    this.detail = detail ?? null;
  }
}

function buildHeaders({ apiKey, json }) {
  const h = { Accept: "application/json" };
  if (json) h["Content-Type"] = "application/json";
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

/**
 * Perform a request against the gateway with a hard timeout.
 *
 * Uses AbortSignal.timeout so a hung provider cannot wedge the CLI. The
 * timeout is reported distinctly from other failures because "timed out" and
 * "refused" mean very different things to an operator.
 */
/**
 * @param {object} config
 * @param {string} pathname
 * @param {{ method?: string, body?: *, timeoutMs?: number, json?: boolean }} [opts]
 */
async function request(config, pathname, { method = "GET", body, timeoutMs, json = false } = {}) {
  const url = `${String(config.baseUrl).replace(/\/+$/, "")}${pathname}`;
  const ms = timeoutMs ?? config.probeTimeoutMs ?? 15000;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: buildHeaders({ apiKey: config.apiKey, json }),
      body: json ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(ms),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new GatewayError(`gateway timed out after ${ms}ms (${url})`, { code: "timeout" });
    }
    throw new GatewayError(`cannot reach gateway at ${config.baseUrl}`, { code: "unreachable", detail: err?.message });
  }

  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
  }

  if (!res.ok) {
    const err = parsed?.error || {};
    throw new GatewayError(err.message || `gateway returned ${res.status}`, {
      status: res.status,
      code: err.code || "http_error",
      detail: redactDeep(parsed),
    });
  }

  return { status: res.status, body: parsed };
}

/** Version/health probe. Cheap; used by doctor and status. */
export async function getVersion(config) {
  const { body } = await request(config, "/api/version");
  return body;
}

/**
 * Full model catalogue as the gateway advertises it.
 *
 * IMPORTANT: this is a catalogue, not proof of reachability. A model can be
 * listed and still fail every request because its provider has no active
 * credentials. Use probeModel() to establish what actually works.
 */
export async function listModels(config) {
  const { body } = await request(config, "/v1/models");
  const models = Array.isArray(body?.data) ? body.data : [];
  return models.map((m) => ({
    id: m.id,
    ownedBy: m.owned_by ?? null,
    provider: String(m.id).includes("/") ? String(m.id).split("/")[0] : null,
  }));
}

/**
 * Probe one model with a minimal request.
 *
 * A 200 is not proof of usability: some providers return an empty completion
 * rather than an error. So we require actual content, and distinguish
 * "reachable but empty" from "unreachable".
 */
/**
 * @param {object} config
 * @param {string} modelId
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function probeModel(config, modelId, { timeoutMs } = {}) {
  const started = Date.now();
  try {
    const { body } = await request(
      config,
      "/v1/chat/completions",
      {
        method: "POST",
        json: true,
        timeoutMs,
        body: {
          model: modelId,
          messages: [{ role: "user", content: "Reply with exactly: PONG" }],
          max_tokens: 16,
        },
      }
    );

    const choice = body?.choices?.[0];
    const content = choice?.message?.content;
    const text = typeof content === "string" ? content.trim() : "";
    const elapsedMs = Date.now() - started;

    if (!text) {
      // Reachable transport, useless payload. Worth distinguishing: the
      // operator can fix a 401, but not this.
      return {
        model: modelId,
        status: "empty",
        reachable: true,
        elapsedMs,
        detail: "responded 200 with empty content",
      };
    }
    return { model: modelId, status: "ok", reachable: true, elapsedMs, sample: text.slice(0, 80) };
  } catch (err) {
    return {
      model: modelId,
      status: err.code === "timeout" ? "timeout" : "error",
      reachable: false,
      elapsedMs: Date.now() - started,
      detail: err.message,
      code: err.code ?? null,
    };
  }
}

/** Cheap reachability signal for the gateway itself. */
export async function ping(config) {
  const started = Date.now();
  try {
    await getVersion(config);
    return { ok: true, elapsedMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      elapsedMs: Date.now() - started,
      error: err.message,
      code: err.code ?? null,
      // Present only for an HTTP-level failure. A transport failure carries no
      // status at all, which is exactly how a caller tells "nothing is listening"
      // (an optional daemon that is simply switched off) apart from "listening
      // and broken" (a 5xx that is a real problem).
      status: err.status ?? null,
    };
  }
}

/**
 * Send a real chat completion and return the assistant text.
 *
 * Throws on transport or HTTP failure -- unlike probeModel, this is used for
 * work that matters, so a failure must not be flattened into a status object
 * the caller might ignore. Routing's failure classifier needs the error.
 *
 * An empty completion resolves with an empty string rather than throwing; the
 * router treats that as a distinct failure kind (a provider that answers 200
 * with nothing is a different problem from one that 500s).
 */
/**
 * @param {object} config
 * @param {string} modelId
 * @param {string} prompt
 * @param {{ timeoutMs?: number, system?: string|null, maxTokens?: number, temperature?: number|null }} [opts]
 */
export async function complete(config, modelId, prompt, { timeoutMs, system = null, maxTokens = 1024, temperature = null } = {}) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: String(prompt) });

  const body = {
    model: modelId,
    messages,
    max_tokens: maxTokens,
  };
  if (temperature != null) body.temperature = temperature;

  const { body: parsed } = await request(config, "/v1/chat/completions", {
    method: "POST",
    json: true,
    timeoutMs,
    body,
  });

  const choice = parsed?.choices?.[0];
  const content = choice?.message?.content;
  const text = typeof content === "string" ? content : content == null ? "" : String(content);

  return {
    model: modelId,
    text: text.trim(),
    raw: parsed,
    finishReason: choice?.finish_reason ?? null,
    usage: parsed?.usage ?? null,
  };
}

/**
 * Message role constants for the chat surface.
 *
 * Declared rather than sprinkled as literals so the wire shape is one decision
 * instead of twenty. OpenAI's contract is the target; these are the three roles
 * the chat loop actually sends.
 */
export const ROLE = Object.freeze({ SYSTEM: "system", USER: "user", ASSISTANT: "assistant" });

/** Coerce an arbitrary message list into OpenAI's `{role, content}` shape. */
function normaliseMessages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== "object") continue;
    const content = m.content;
    if (typeof content !== "string") continue;
    out.push({ role: typeof m.role === "string" ? m.role : ROLE.USER, content });
  }
  return out;
}

/**
 * Streaming chat completion.
 *
 * Same HTTP boundary as complete(), but reads the response body as Server-Sent
 * Events and hands each token to `onToken` as it arrives, so a caller can render
 * a response while it is still being produced. Returns the fully accumulated
 * text once the stream ends, so a caller that ignores `onToken` still gets the
 * whole answer.
 *
 * Three behaviours matter and each is deliberate:
 *
 *   - `[DONE]` and `finish_reason` both terminate the read. A provider that
 *     never sends `[DONE]` (some do not, and the in-repo gateway synthesises it,
 *     but a third party may not) must not leave the caller waiting forever, so
 *     the socket closing ends the loop too.
 *   - A non-SSE response is not an error. If the upstream ignored `stream:true`
 *     and answered with a plain JSON body, the content is emitted once and the
 *     call resolves as `{ streamed: false }`. The alternative -- treating a
 *     perfectly good answer as a failure because its content-type was wrong --
 *     would make the client stricter than the contract it speaks.
 *   - Cancellation is distinct from timeout and from refusal. Ctrl+C aborts the
 *     caller's signal; that surfaces as `code: "cancelled"` so the UI can print
 *     "[interrupted]" rather than an alarming transport error.
 *
 * @param {object} config
 * @param {string} modelId
 * @param {Array<{role?: string, content: string}>} messages
 * @param {{ signal?: AbortSignal|null, onToken?: ((chunk: string) => void)|null, timeoutMs?: number, system?: string|null, maxTokens?: number|null, temperature?: number|null }} [opts]
 */
export async function streamComplete(
  config,
  modelId,
  messages,
  { signal = null, onToken = null, timeoutMs, system = null, maxTokens = null, temperature = null } = {},
) {
  const url = `${String(config.baseUrl).replace(/\/+$/, "")}/v1/chat/completions`;
  const ms = timeoutMs ?? config.probeTimeoutMs ?? 60000;

  const wire = normaliseMessages(messages);
  if (system) wire.unshift({ role: ROLE.SYSTEM, content: String(system) });

  const body = { model: modelId, messages: wire, stream: true };
  if (maxTokens != null) body.max_tokens = maxTokens;
  if (temperature != null) body.temperature = temperature;

  // One controller carries both the caller's signal and the hard timeout, so the
  // fetch is torn down by whichever fires first and the finally block cleans up
  // the other.
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  let timedOut = false;
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("stream timeout"));
  }, ms);
  if (typeof timer.unref === "function") timer.unref();

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { ...buildHeaders({ apiKey: config.apiKey, json: true }), Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
    if (signal?.aborted) {
      const cancelled = new GatewayError("stream cancelled", { code: "cancelled" });
      cancelled.name = "AbortError";
      throw cancelled;
    }
    if (timedOut || err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new GatewayError(`gateway timed out after ${ms}ms (${url})`, { code: "timeout" });
    }
    throw new GatewayError(`cannot reach gateway at ${config.baseUrl}`, { code: "unreachable", detail: err?.message });
  }

  if (!res.ok) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
    const text = await res.text().catch(() => "");
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
    const e = parsed?.error || {};
    throw new GatewayError(e.message || `gateway returned ${res.status}`, {
      status: res.status,
      code: e.code || "http_error",
      detail: redactDeep(parsed),
    });
  }

  const contentType = res.headers.get("content-type") || "";
  const looksSse = contentType.includes("text/event-stream");

  try {
    // Non-streaming fallback: the upstream answered with a plain body. Emit the
    // whole completion once so the caller's rendering path is unchanged.
    if (!looksSse || !res.body) {
      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 500) };
      }
      const choice = parsed?.choices?.[0];
      const content = choice?.message?.content ?? choice?.text ?? (typeof parsed?.content === "string" ? parsed.content : "");
      const out = typeof content === "string" ? content : content == null ? "" : String(content);
      if (onToken && out) onToken(out);
      return {
        model: modelId,
        text: out.trim(),
        streamed: false,
        finishReason: choice?.finish_reason ?? null,
        usage: parsed?.usage ?? null,
        raw: parsed,
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let finishReason = null;
    let usage = null;
    let done = false;

    while (!done) {
      const { value, done: streamEnd } = await reader.read();
      if (streamEnd) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line === "" || !line.startsWith("data:")) continue;

        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          done = true;
          break;
        }
        let evt;
        try {
          evt = JSON.parse(data);
        } catch {
          continue; // a keep-alive or malformed line is skipped, not fatal
        }
        if (evt?.error) {
          throw new GatewayError(evt.error.message || "provider error mid-stream", {
            code: evt.error.code || "stream_error",
          });
        }
        const choice = evt?.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta) {
          full += delta;
          if (onToken) onToken(delta);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (evt?.usage) usage = evt.usage;
      }
    }

    return { model: modelId, text: full.trim(), streamed: true, finishReason, usage, raw: null };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

export default { GatewayError, ROLE, getVersion, listModels, probeModel, ping, complete, streamComplete };