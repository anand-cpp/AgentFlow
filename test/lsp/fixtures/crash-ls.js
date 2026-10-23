// A language server that always crashes immediately.
//
// Used to exercise the supervisor's restart path and its bounded backoff
// without depending on a real server misbehaving.

process.stdout.write("");
process.exit(1);
