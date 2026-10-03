// Gateway client: the HTTP boundary between the CLI and a running gateway.
//
// AgentFlow is a client. It does not embed a server; it talks to a 9Router-
// derived gateway over its OpenAI-compatible API. Keeping that behind one
// module means every command shares auth, timeout, and error handling.

import { redactDeep } from "../core/redact.js";

export class GatewayError extends Error {
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
    return { ok: false, elapsedMs: Date.now() - started, error: err.message, code: err.code ?? null };
  }
}

export default { GatewayError, getVersion, listModels, probeModel, ping };