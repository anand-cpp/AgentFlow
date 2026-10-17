// LSP base-protocol framing over a stdio byte stream.
//
// The language server protocol multiplexes JSON-RPC messages on stdout with a
// single, blunt rule: `Content-Length: <bytes>\r\n\r\n<json>`. Everything here
// exists because that rule is byte-oriented -- the length counts UTF-8 bytes,
// not characters -- and because a socket/pipe hands you arbitrary chunk
// boundaries. A decoder that assumed one `data` event per message works on the
// author's laptop and dies on a server that flushes a 4KB boundary mid-header.
//
// The decoder is a buffer accumulator, not a stream: no `node:stream` dependency,
// no async, just `push(chunk) -> messages[]`. That keeps it trivially testable
// and usable from both a child_process pipe and an in-memory test transport.

const HEADER_SEPARATOR = "\r\n\r\n";

/** Default cap on a single message body. Guards against a malformed header
 * claiming a multi-gigabyte body and driving `Buffer.alloc` to OOM. */
const DEFAULT_MAX_CONTENT_LENGTH = 32 * 1024 * 1024;

export class LspFramingError extends Error {
  /** @param {string} message @param {{ code?: string }} [opts] */
  constructor(message, { code = "lsp_framing_error" } = {}) {
    super(message);
    this.name = "LspFramingError";
    this.code = code;
  }
}

/**
 * Pull the Content-Length out of a header block.
 *
 * Headers are case-insensitive and there may be more than one (`Content-Type`
 * is commonly sent alongside). Returns null when the header is present but not
 * a non-negative integer, so the caller can fail loudly rather than guess.
 *
 * @param {string} header
 * @returns {number|null}
 */
function parseContentLength(header) {
  for (const line of header.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (name !== "content-length") continue;
    const value = line.slice(idx + 1).trim();
    if (!/^\d+$/.test(value)) return null;
    return Number(value);
  }
  return null;
}

export class LspFrameDecoder {
  /** @param {{ maxContentLength?: number }} [options] */
  constructor({ maxContentLength = DEFAULT_MAX_CONTENT_LENGTH } = {}) {
    this.maxContentLength = maxContentLength;
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Feed a chunk of bytes and get back every complete message it unlocked.
   *
   * A single chunk may complete zero, one, or many messages; a message may also
   * span several chunks. The return value is always the messages that are now
   * fully available -- callers loop nothing, they just forward each.
   *
   * @param {Buffer|Uint8Array|string} chunk
   * @returns {any[]}
   */
  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes]);

    const messages = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR, 0, "latin1");
      if (headerEnd === -1) break;

      const header = this.buffer.toString("latin1", 0, headerEnd);
      const length = parseContentLength(header);
      if (length === null) {
        throw new LspFramingError(`missing or malformed Content-Length header: ${JSON.stringify(header)}`, {
          code: "lsp_bad_header",
        });
      }
      if (length > this.maxContentLength) {
        throw new LspFramingError(
          `message body of ${length} bytes exceeds the ${this.maxContentLength}-byte limit`,
          { code: "lsp_message_too_large" },
        );
      }

      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      if (this.buffer.length - bodyStart < length) break; // wait for the rest

      const body = this.buffer.toString("utf8", bodyStart, bodyStart + length);
      this.buffer = this.buffer.subarray(bodyStart + length);

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        throw new LspFramingError(`invalid JSON in message body: ${err.message}`, {
          code: "lsp_bad_json",
        });
      }
      messages.push(parsed);
    }
    return messages;
  }

  /** Bytes currently held waiting for the rest of a message. */
  get pending() {
    return this.buffer.length;
  }

  /** Drop any partial message. Used when a server is restarted mid-frame. */
  reset() {
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * Encode one message into an LSP frame.
 *
 * The length header is computed from the UTF-8 **byte** length of the JSON. A
 * naive `json.length` is wrong the moment a message carries a non-ASCII
 * character (a file path, a doc-comment), and the server then misreads every
 * subsequent frame -- the classic "works until someone types an accent" bug.
 *
 * @param {any} message
 * @returns {Buffer}
 */
export function encodeLspMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "latin1"), body]);
}

export default { LspFrameDecoder, encodeLspMessage, LspFramingError };
