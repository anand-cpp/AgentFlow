// Output modes: human-readable vs --json.
//
// Every command returns a plain data object. The renderer decides whether to
// print it as JSON or as formatted text. This keeps commands free of
// presentation concerns and makes every command machine-readable for free.

const OUT = process.stdout;
const ERR = process.stderr;

export class Output {
  constructor({ json = false, quiet = false, verbose = false } = {}) {
    this.json = json;
    this.quiet = quiet;
    this.verbose = verbose;
  }

  async init(result, renderText) {
    if (this.json) {
      // Structured output is the whole point of --json: emit only the payload,
      // never decoration, so it can be piped into jq without filtering.
      OUT.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const text = renderText(result);
      if (text && text.trim()) OUT.write(`${text}\n`);
    }
  }

  /** Human-only message. Suppressed by --json and by --quiet. */
  info(msg) {
    if (this.json || this.quiet) return;
    ERR.write(`${msg}\n`);
  }

  /** Progress/status line. Suppressed by --json. */
  status(msg) {
    if (this.json) return;
    ERR.write(`${msg}\n`);
  }

  /** Detail, shown only with --verbose. */
  detail(msg) {
    if (this.json || !this.verbose) return;
    ERR.write(`${msg}\n`);
  }

  warn(msg) {
    if (this.json) return;
    ERR.write(`${msg}\n`);
  }

  error(msg) {
    // Errors always go to stderr, even under --json, so a piped payload on
    // stdout stays parseable.
    ERR.write(`${msg}\n`);
  }
}

export default { Output };