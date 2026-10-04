// Bounded output for tool results.
//
// A tool result goes straight into the model's context, and a model that reads
// a 4MB log has not failed -- it has simply been handed more tokens than the
// window holds, and the useful part is now somewhere past the cut.
//
// So every tool bounds its output, and -- the part that matters -- says so. A
// silent cut is worse than no bound: the model reasons over a prefix and
// concludes the file ended there. `truncated: true` with the original size lets
// it know it is looking at a prefix and decide to narrow the request.

import { TOOL_ERROR, ToolInvocationError } from "./tool-errors.js";

/** Bytes, not characters. A model's limit is bytes, and a multi-byte character
 *  makes character counts disagree with the real cost by up to 4x. */
export const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * Cut `text` to `maxBytes`, and report exactly what happened.
 *
 * Never splits a multi-byte character: a truncated result ending in half a
 * character is corrupt text that will fail to encode or decode, which turns a
 * size problem into a confusing one. The cut is pulled back to the last complete
 * character boundary.
 *
 * Returns `{ text, truncated, originalSize, returnedSize, limit }`. Sizes are
 * byte counts of the UTF-8 encoding, which is what the numbers mean to a caller
 * sizing a context window.
 *
 * `originalSize` overrides the measured size. It exists for a caller that already
 * dropped bytes before this point -- a process that printed 17KB through a 1KB
 * capture cap hands over exactly 1KB, which is *at* the limit and would otherwise
 * be reported as complete. A caller that knows the real size must be able to say
 * so, or the bound silently under-reports the one case that matters.
 */
export function boundText(text, maxBytes = DEFAULT_MAX_BYTES, { label = "output", originalSize } = {}) {
  const original = Number.isFinite(originalSize) ? originalSize : Buffer.byteLength(text, "utf8");
  if (original <= maxBytes) {
    return { text, truncated: false, originalSize: original, returnedSize: original, limit: maxBytes };
  }

  const buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
  // Walk back from the true maximum to the last byte boundary that decodes. A
  // partial sequence at the cut would otherwise produce text that fails to decode
  // -- a size problem turning into a confusing one.
  //
  // Starting at `length - 1` rather than `length - 3` matters: jumping straight to
  // the worst case throws away up to three bytes that would have fit, which for a
  // 2-byte character like "e-acute" silently discards a whole extra character.
  // Three is the longest a UTF-8 sequence, so at most three steps are needed.
  let end = buf.length;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      decoder.decode(buf.subarray(0, end));
      break;
    } catch {
      end -= 1;
    }
  }

  const boundedText = buf.subarray(0, end).toString("utf8");
  return {
    text: boundedText,
    truncated: true,
    originalSize: original,
    returnedSize: Buffer.byteLength(boundedText, "utf8"),
    limit: maxBytes,
    label,
  };
}

/** Room held back from the text so the truncation notice fits inside maxBytes.
 *  A notice is ~150 bytes; 256 leaves headroom for large byte counts. */
const NOTICE_RESERVE = 256;

/**
 * Bound a string for a tool result, appending a notice the model cannot miss.
 *
 * The notice is part of the returned text on purpose. Structured metadata is
 * right for a program reading the result, but the thing that has to notice the
 * truncation is a language model reading it as prose.
 *
 * The text bound is therefore `maxBytes - NOTICE_RESERVE` when a cut is known, so
 * the *whole* payload still honours the caller's limit. Appending a notice to a
 * full-budget payload would return more bytes than were asked for, which makes
 * `maxBytes` a lie the caller has to discover and correct for. Below the reserve
 * the text gets nothing and the notice is kept: saying what was dropped matters
 * more than the last few bytes before it.
 */
export function boundOutput(text, maxBytes = DEFAULT_MAX_BYTES, { label = "output", redaction, originalSize } = {}) {
  const measured = Number.isFinite(originalSize) ? originalSize : Buffer.byteLength(text, "utf8");
  const willTruncate = measured > maxBytes;
  const textLimit = willTruncate ? Math.max(0, maxBytes - NOTICE_RESERVE) : maxBytes;

  const bounded = boundText(text, textLimit, { label, originalSize: measured });
  const redacted = redaction ? redaction(bounded.text) : bounded.text;
  const wasRedacted = redacted !== bounded.text;
  bounded.text = redacted;
  bounded.redacted = wasRedacted;
  if (!bounded.truncated) return { ...bounded, notice: null };

  const omitted = bounded.originalSize - bounded.returnedSize;
  const notice = `\n\n[truncated: ${label} was ${bounded.originalSize} bytes, showing the first ${bounded.returnedSize}; ${omitted} bytes omitted. Narrow the request to see the rest.]`;
  bounded.text = bounded.text + notice;
  bounded.notice = notice;
  // Reported honestly: the notice is bytes the caller receives, so a window sized on
  // returnedSize accounts for it. `limit` stays maxBytes, and returnedSize <= limit
  // for every cap above NOTICE_RESERVE.
  bounded.returnedSize = Buffer.byteLength(bounded.text, "utf8");
  bounded.limit = maxBytes;
  return bounded;
}

/**
 * Bound an array of already-rendered items.
 *
 * Arrays are truncated by *count* rather than by bytes, because the failure mode
 * is different: a grep returning 4000 near-identical lines is a context problem
 * even when every line is short. Both bounds apply, and the caller is told which
 * one fired.
 */
export function boundList(items, { maxItems, maxBytes = DEFAULT_MAX_BYTES, label = "results", render = (x) => String(x) } = {}) {
  const kept = [];
  let bytes = 0;
  let truncated = false;

  for (const item of items) {
    if (maxItems != null && kept.length >= maxItems) {
      truncated = true;
      break;
    }
    const line = render(item);
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + size > maxBytes) {
      truncated = true;
      break;
    }
    kept.push(item);
    bytes += size;
  }

  return {
    items: kept,
    truncated,
    returnedCount: kept.length,
    totalCount: items.length,
    returnedSize: bytes,
    limit: maxItems ?? maxBytes,
    label,
  };
}

/**
 * A guard for a limit the caller insists on.
 *
 * Used where truncation is not an acceptable answer -- a file over the hard read
 * cap is refused with OUTPUT_LIMIT rather than returned as a prefix, because
 * silently handing back the first 256KB of a 400MB file invites the model to
 * conclude it read the whole thing.
 */
export function enforceByteLimit(actual, maxBytes, { label = "output" } = {}) {
  if (actual <= maxBytes) return;
  throw new ToolInvocationError(
    TOOL_ERROR.OUTPUT_LIMIT,
    `${label} is ${actual} bytes, over the ${maxBytes} byte limit; narrow the request`,
    { originalSize: actual, limit: maxBytes, label },
  );
}