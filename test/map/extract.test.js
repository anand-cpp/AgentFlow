// Unit tests for the symbol extractor: per-language declaration and import
// patterns, export flags, candidate-path generation, and totality on garbage.
import test from "node:test";
import assert from "node:assert/strict";

import {
  extractSource,
  detectLanguage,
  importCandidates,
} from "../../src/core/map/extract.js";

test("detectLanguage maps extensions to families", () => {
  assert.equal(detectLanguage("a/b.ts"), "ts");
  assert.equal(detectLanguage("server.mjs"), "js");
  assert.equal(detectLanguage("mod.py"), "python");
  assert.equal(detectLanguage("x.go"), "go");
  assert.equal(detectLanguage("y.rs"), "rust");
  assert.equal(detectLanguage("z.rb"), "generic");
  assert.equal(detectLanguage("README.md"), "unknown");
});

test("JS/TS: imports, exports, interfaces, methods", () => {
  const out = extractSource(
    "src/a.ts",
    [
      'import { x } from "./b";',
      'const { z } = require("../lib/c");',
      "export function hello(a) {}",
      "export default class Foo {}",
      "export const K = 1;",
      "export interface Baz { a: string }",
      "type T = { x: number };",
      "async function gen() {}",
      "  private innerMethod() {}",
    ].join("\n"),
  );
  assert.equal(out.language, "ts");
  assert.deepEqual(out.imports.map((i) => i.raw), ["./b", "../lib/c"]);
  const byName = new Map(out.symbols.map((s) => [s.name, s]));
  assert.equal(byName.get("hello").kind, "function");
  assert.equal(byName.get("hello").exported, true);
  assert.equal(byName.get("Foo").kind, "class");
  assert.equal(byName.get("Foo").exported, true);
  assert.equal(byName.get("K").kind, "const");
  assert.equal(byName.get("Baz").kind, "interface");
  assert.equal(byName.get("T").kind, "type");
  assert.equal(byName.get("T").exported, false);
  assert.equal(byName.get("gen").exported, false);
  assert.equal(byName.get("innerMethod").kind, "method");
});

test("CJS module.exports is captured as an exported const", () => {
  const out = extractSource(
    "lib/cjs.js",
    'const a = require("x");\nmodule.exports.handler = (req) => 1;\n',
  );
  const byName = new Map(out.symbols.map((s) => [s.name, s]));
  assert.equal(byName.get("handler").exported, true);
  assert.deepEqual(out.imports.map((i) => i.raw), ["x"]);
});

test("Python: def/class with underscore-private exports and dotted imports", () => {
  const out = extractSource(
    "pkg/mod.py",
    "import os\nfrom .helpers import thing\ndef _priv(): pass\ndef pub(): pass\nclass Big: pass\n",
  );
  assert.deepEqual(out.imports.map((i) => i.raw), ["os", ".helpers"]);
  const byName = new Map(out.symbols.map((s) => [s.name, s]));
  assert.equal(byName.get("_priv").exported, false);
  assert.equal(byName.get("pub").exported, true);
  assert.equal(byName.get("Big").kind, "class");
});

test("Go: package, import block, types, methods, export-by-case", () => {
  const out = extractSource(
    "svc/main.go",
    "package main\n\nimport (\n\t\"net/http\"\n)\n\nfunc main() {}\ntype Server struct {}\nfunc (s *Server) Handler() {}\nfunc private() {}\nfunc Public() {}\n",
  );
  assert.deepEqual(out.imports.map((i) => i.raw), ["net/http"]);
  const byName = new Map(out.symbols.map((s) => [s.name, s]));
  assert.equal(byName.get("main").kind, "module");
  assert.equal(byName.get("Server").kind, "type");
  assert.equal(byName.get("Handler").kind, "method");
  assert.equal(byName.get("Handler").exported, true);
  assert.equal(byName.get("private").exported, false);
  assert.equal(byName.get("Public").exported, true);
});

test("Rust: use, pub functions, structs/enums, traits, mods", () => {
  const out = extractSource(
    "crates/app.rs",
    "use crate::foo;\npub fn go() {}\nstruct S;\npub enum E {}\ntrait T {}\nmod internal {}\n",
  );
  assert.deepEqual(out.imports.map((i) => i.raw), ["crate::foo"]);
  const byName = new Map(out.symbols.map((s) => [s.name, s]));
  assert.equal(byName.get("go").exported, true);
  assert.equal(byName.get("S").exported, false);
  assert.equal(byName.get("E").exported, true);
  assert.equal(byName.get("T").kind, "interface");
  assert.equal(byName.get("internal").kind, "module");
});

test("generic languages still yield defs and includes", () => {
  const out = extractSource(
    "x/main.rb",
    "class Greeter\n  def hello\n    puts 'hi'\n  end\nend\n",
  );
  const names = out.symbols.map((s) => s.name);
  assert.ok(names.includes("Greeter"), "class is found by the generic extractor");
});

test("comments and block-comment lines do not become symbols", () => {
  const out = extractSource(
    "src/comments.js",
    "// function fake() {}\n/* class AlsoFake {} */\n * function docFake() {}\nexport function real() {}\n",
  );
  const names = out.symbols.map((s) => s.name);
  assert.deepEqual(names, ["real"]);
});

test("symbol cap keeps the first N, deterministic", () => {
  const lines = [];
  for (let i = 0; i < 50; i += 1) lines.push(`function fn${i}() {}`);
  const out = extractSource("big.js", lines.join("\n"), { maxSymbols: 5 });
  assert.equal(out.symbols.length, 5);
  assert.equal(out.symbols[0].name, "fn0");
});

test("totality: garbage, binary junk and empty input never throw", () => {
  for (const text of ["", "\n\n\n", "}}}random(((garbage", "a".repeat(5000)]) {
    const out = extractSource("x.js", text);
    assert.equal(out.file, "x.js");
    assert.ok(Array.isArray(out.symbols));
    assert.ok(Array.isArray(out.imports));
  }
});

test("duplicate symbol names are recorded once, first line wins", () => {
  const out = extractSource("dup.js", "function x() {}\nfunction x() {}\n");
  assert.equal(out.symbols.filter((s) => s.name === "x").length, 1);
  assert.equal(out.symbols.find((s) => s.name === "x").line, 1);
});

test("importCandidates: relative, bare packages refusal, dotted py paths", () => {
  // Relative paths resolve against the importing file.
  const rel = importCandidates("./b.ts", "src/a.ts");
  assert.equal(rel[0], "src/b.ts");
  const up = importCandidates("../lib/c", "src/deep/a.js");
  assert.ok(up.includes("src/lib/c.ts"));
  assert.ok(up.includes("src/lib/c/index.js"));
  // npm packages, urls and protocols are never workspace-relative files, but
  // a bare name still yields flat candidates the resolver can confirm.
  assert.deepEqual(importCandidates("node:path", "a.js"), []);
  const bare = importCandidates("lodash", "a.js");
  assert.ok(bare.includes("lodash"));
  assert.ok(bare.includes("lodash.ts"));
  assert.ok(bare.includes("lodash/index.js"));
  // Python dotted modules map to slashed candidates.
  const dotted = importCandidates("pkg.mod", "m/a.py");
  assert.ok(dotted.includes("pkg/mod.py"));
  assert.deepEqual(importCandidates(null, "a.js"), []);
});
