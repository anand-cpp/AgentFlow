// Language-server registry: extension mapping and non-throwing detection.

import test from "node:test";
import assert from "node:assert/strict";

import { LANGUAGE_SERVERS, extensionOf, getServerForFile, getServerById, detectInstalledServers } from "../../src/core/lsp/registry.js";

test("every registry entry is well-formed", () => {
  for (const s of LANGUAGE_SERVERS) {
    assert.ok(s.id && typeof s.id === "string", "id");
    assert.ok(s.command && typeof s.command === "string", `command for ${s.id}`);
    assert.ok(Array.isArray(s.extensions) && s.extensions.length, `extensions for ${s.id}`);
    assert.ok(s.extensions.every((e) => e.startsWith(".") && e === e.toLowerCase()), `lowercased dot-extensions for ${s.id}`);
    assert.ok(Array.isArray(s.args), `args for ${s.id}`);
    assert.ok(s.install, `install hint for ${s.id}`);
  }
});

test("no two servers claim the same extension", () => {
  const seen = new Map();
  for (const s of LANGUAGE_SERVERS) {
    for (const ext of s.extensions) {
      assert.equal(seen.get(ext), undefined, `extension ${ext} claimed by both ${seen.get(ext)} and ${s.id}`);
      seen.set(ext, s.id);
    }
  }
});

test("extensionOf lowercases and keeps the dot", () => {
  assert.equal(extensionOf("A.TSX"), ".tsx");
  assert.equal(extensionOf("src/app.MJS"), ".mjs");
  assert.equal(extensionOf("Makefile"), "");
  assert.equal(extensionOf(""), "");
});

test("getServerForFile routes common extensions to the right server", () => {
  assert.equal(getServerForFile("a.ts")?.id, "typescript");
  assert.equal(getServerForFile("a.tsx")?.id, "typescript");
  assert.equal(getServerForFile("lib.rs")?.id, "rust");
  assert.equal(getServerForFile("main.go")?.id, "go");
  assert.equal(getServerForFile("util.cpp")?.id, "clangd");
  assert.equal(getServerForFile("script.py")?.id, "python");
  assert.equal(getServerForFile("index.html")?.id, "html");
  assert.equal(getServerForFile("style.scss")?.id, "css");
  assert.equal(getServerForFile("data.jsonc")?.id, "json");
});

test("getServerForFile returns null for an unknown extension", () => {
  assert.equal(getServerForFile("notes.txt"), null);
  assert.equal(getServerForFile("noext"), null);
});

test("getServerById looks up the entry", () => {
  assert.equal(getServerById("go")?.command, "gopls");
  assert.equal(getServerById("nope"), null);
});

test("detectInstalledServers reports found and missing without throwing", async () => {
  const probe = async (command) =>
    command === "gopls" ? { ok: true, path: "C:/bin/gopls.exe", error: null } : { ok: false, path: null, error: "not found" };
  const servers = await detectInstalledServers({ probe });
  assert.equal(servers.length, LANGUAGE_SERVERS.length);
  const go = servers.find((s) => s.id === "go");
  assert.equal(go.installed, true);
  assert.equal(go.path, "C:/bin/gopls.exe");
  assert.ok(go.args.length === 0 && go.command === "gopls");
  const rust = servers.find((s) => s.id === "rust");
  assert.equal(rust.installed, false);
  assert.equal(rust.path, null);
  assert.ok(rust.install, "a missing server still carries its install hint");
});

