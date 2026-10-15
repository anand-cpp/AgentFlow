// Workspace root resolution: the blast radius for every real tool.
//
// The security property is "the root is chosen once and cannot move". These
// tests pin the precedence (explicit > project > cwd), the refusal to guess
// when the choice is unusable, and the immutability that makes the property
// true rather than merely intended.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveWorkspaceRoot,
  tryResolveWorkspace,
  WorkspaceError,
  ROOT_SOURCE,
} from "../src/core/agents/workspace.js";
import { TOOL_ERROR } from "../src/core/agents/tool-errors.js";

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-workspace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("an explicit root wins over the project root and cwd", (t) => {
  const root = tmpdir(t);
  const project = path.join(root, "project");
  const explicit = path.join(root, "explicit");
  fs.mkdirSync(project);
  fs.mkdirSync(explicit);

  const ws = resolveWorkspaceRoot({ explicit, projectRoot: project, cwd: root });
  assert.equal(ws.root, fs.realpathSync.native(explicit));
  assert.equal(ws.source, ROOT_SOURCE.EXPLICIT);
});

test("the project root is used when no explicit root is named", (t) => {
  const root = tmpdir(t);
  const project = path.join(root, "project");
  fs.mkdirSync(project);

  const ws = resolveWorkspaceRoot({ projectRoot: project, cwd: root });
  assert.equal(ws.root, fs.realpathSync.native(project));
  assert.equal(ws.source, ROOT_SOURCE.PROJECT);
});

test("cwd is the last resort, and a blank explicit falls through", (t) => {
  const root = tmpdir(t);
  const ws = resolveWorkspaceRoot({ explicit: "   ", projectRoot: null, cwd: root });
  assert.equal(ws.root, fs.realpathSync.native(root));
  assert.equal(ws.source, ROOT_SOURCE.CWD);
});

test("an unusable root is refused rather than guessed", (t) => {
  const root = tmpdir(t);

  assert.throws(
    () => resolveWorkspaceRoot({ explicit: path.join(root, "does-not-exist"), cwd: root }),
    (err) => {
      const e = /** @type {any} */ (err);
      assert.ok(e instanceof WorkspaceError);
      assert.equal(e.code, TOOL_ERROR.INVALID_INPUT);
      assert.match(e.message, /does not exist/);
      return true;
    },
  );

  const file = path.join(root, "a-file");
  fs.writeFileSync(file, "x");
  assert.throws(
    () => resolveWorkspaceRoot({ explicit: file, cwd: root }),
    (err) => {
      const e = /** @type {any} */ (err);
      assert.equal(e.code, TOOL_ERROR.INVALID_INPUT);
      assert.match(e.message, /not a directory/);
      return true;
    },
  );
});

test("with nothing to resolve, it throws instead of defaulting to something", () => {
  assert.throws(
    () => resolveWorkspaceRoot({ explicit: null, projectRoot: null, cwd: "   " }),
    /no workspace root/,
  );
});

test("the root is frozen and cannot be re-pointed by a lifecycle hook", (t) => {
  const root = tmpdir(t);
  const ws = resolveWorkspaceRoot({ explicit: root });

  assert.ok(Object.isFrozen(ws), "the holder is frozen");
  assert.throws(() => {
    ws.root = "/etc";
  }, TypeError, "root has no setter");
  assert.throws(() => {
    ws._resolved = /** @type {any} */ ({ root: "/etc" });
  }, TypeError, "the resolved descriptor is non-writable");

  assert.equal(ws.root, fs.realpathSync.native(root), "still points where it started");
});

test("describe() and toolContext() expose the receipt without the holder", (t) => {
  const root = tmpdir(t);
  const ws = resolveWorkspaceRoot({ explicit: root });

  const desc = ws.describe();
  assert.equal(desc.root, fs.realpathSync.native(root));
  assert.equal(desc.requested, path.resolve(root));
  assert.equal(desc.source, ROOT_SOURCE.EXPLICIT);
  assert.equal(desc.linked, false);

  const ctx = /** @type {any} */ (ws.toolContext({ extra: 1 }));
  assert.equal(ctx.workspaceRoot, ws.root);
  assert.equal(ctx.extra, 1);
  ctx.workspaceRoot = "/etc";
  assert.equal(ws.root, fs.realpathSync.native(root), "a scribbled context cannot reach the run root");
});

test("tryResolveWorkspace returns null instead of throwing for read-only commands", (t) => {
  const root = tmpdir(t);
  assert.equal(tryResolveWorkspace({ explicit: path.join(root, "nope"), cwd: root }), null);
  assert.ok(tryResolveWorkspace({ explicit: root }));
});

test("a symlinked root is recorded as linked and resolved to its target", (t) => {
  const root = tmpdir(t);
  const real = path.join(root, "real");
  const link = path.join(root, "link");
  fs.mkdirSync(real);
  try {
    fs.symlinkSync(real, link, "junction");
  } catch {
    t.skip("symlinks not permitted on this platform");
    return;
  }

  const ws = resolveWorkspaceRoot({ explicit: link });
  assert.equal(ws.root, fs.realpathSync.native(real));
  assert.equal(ws.describe().linked, true, "the redirect is recorded, not hidden");
  assert.equal(ws.describe().requested, path.resolve(link), "the requested path is kept for the receipt");
});
