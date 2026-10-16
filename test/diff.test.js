// Diff engine and renderers (src/tui/diff.js) plus the viewer dialog
// (src/tui/diff-viewer-dialog.js): pure data in, ANSI text out.

import test from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";
process.env.TERM = "xterm";
delete process.env.FORCE_COLOR;

const d = await import("../src/tui/diff.js");
const dlg = await import("../src/tui/diff-viewer-dialog.js");
const ui = await import("../src/cli/ui.js");
ui.setColor(false);

const lines = (...l) => l.join("\n");

test("computeDiff marks a changed line as a removal plus an addition", () => {
  const diff = d.computeDiff(lines("a", "b", "c"), lines("a", "B", "c"));
  const types = diff.map((e) => e.type);
  assert.deepEqual(types, ["context", "remove", "add", "context"]);
  assert.equal(diff[1].content, "b");
  assert.equal(diff[2].content, "B");
});

test("computeDiff numbers old and new lines and keeps unchanged lines as context", () => {
  const diff = d.computeDiff(lines("a", "b", "c"), lines("a", "B", "c"));
  // context a -> old 1 / new 1; remove b -> old 2; add B -> new 2; context c -> 3/3.
  assert.deepEqual(
    diff.map((e) => [e.type, e.oldLine, e.newLine, e.line]),
    [
      ["context", 1, 1, 1],
      ["remove", 2, null, 2],
      ["add", null, 2, 2],
      ["context", 3, 3, 3],
    ],
  );
});

test("computeDiff reads an empty old text as a whole addition, and vice versa", () => {
  const added = d.computeDiff("", lines("x", "y"));
  assert.deepEqual(added.map((e) => e.type), ["add", "add"]);
  assert.deepEqual(d.diffStats(added), { additions: 2, deletions: 0 });

  const removed = d.computeDiff(lines("x", "y"), "");
  assert.deepEqual(removed.map((e) => e.type), ["remove", "remove"]);
  assert.deepEqual(d.diffStats(removed), { additions: 0, deletions: 2 });
});

test("computeDiff reports identical inputs as pure context", () => {
  const diff = d.computeDiff(lines("same", "text"), lines("same", "text"));
  assert.ok(diff.every((e) => e.type === "context"));
  assert.deepEqual(d.diffStats(diff), { additions: 0, deletions: 0 });
  assert.equal(d.groupHunks(diff).length, 0, "no changes means no hunks");
});

test("diffStats counts additions and deletions", () => {
  const diff = d.computeDiff(lines("a", "b", "c", "d"), lines("a", "x", "c", "e", "f"));
  const stats = d.diffStats(diff);
  assert.equal(stats.additions, 3); // x, e, f
  assert.equal(stats.deletions, 2); // b and the trailing d
});

test("groupHunks pads with context and merges changes that are close together", () => {
  const old = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const nw = old.slice();
  nw[2] = "CHANGED NEAR TOP";
  nw[4] = "CHANGED A FEW DOWN";
  const hunks = d.groupHunks(d.computeDiff(old.join("\n"), nw.join("\n")), 3);
  // Two changes only 2 lines apart, well within 2*context -> one merged hunk.
  assert.equal(hunks.length, 1);
  assert.match(hunks[0].header, /^@@ -\d+,\d+ \+\d+,\d+ @@$/);
  assert.equal(hunks[0].oldCount, hunks[0].newCount, "context keeps counts equal");
});

test("groupHunks separates changes that are far apart", () => {
  const old = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const nw = old.slice();
  nw[0] = "CHANGED FIRST";
  nw[35] = "CHANGED LAST";
  const hunks = d.groupHunks(d.computeDiff(old.join("\n"), nw.join("\n")), 3);
  assert.equal(hunks.length, 2, "distant changes become separate hunks");
  assert.notEqual(hunks[0].header, hunks[1].header);
});

test("renderUnifiedDiff draws a file header, a @@ line, and +/- prefixes with no ANSI under NO_COLOR", () => {
  const diff = d.computeDiff(lines("a", "b", "c"), lines("a", "B", "c"));
  const out = d.renderUnifiedDiff("foo.js", diff);
  assert.ok(!out.includes("\u001b"), "colour is off, so no escapes");
  const body = out.split("\n");
  assert.equal(body[0], "foo.js");
  assert.match(body[1], /^@@ -1,3 \+1,3 @@$/);
  // The old/new number columns are blank on one side of a removal/addition, so
  // assert on the sign plus the text at the end of the line.
  assert.ok(
    body.some((l) => l.trim().endsWith("- b")),
    "the removed line carries a minus sign",
  );
  assert.ok(
    body.some((l) => l.trim().endsWith("+ B")),
    "the added line carries a plus sign",
  );
});

test("renderUnifiedDiff clips every line to the requested width", () => {
  const diff = d.computeDiff(
    lines("a short line", "another short line", "and one more"),
    lines("a short line", "another line", "and one more", "a very long added line that goes on and on"),
  );
  const out = d.renderUnifiedDiff("f.js", diff, { width: 30 });
  for (const line of out.split("\n")) {
    assert.ok(ui.width(line) <= 30, `line exceeds width: ${JSON.stringify(line)}`);
  }
});

test("renderUnifiedDiff says so when there is nothing to show", () => {
  const diff = d.computeDiff("same", "same");
  assert.match(d.renderUnifiedDiff("f.js", diff), /no changes/);
  assert.match(d.renderUnifiedDiff("", diff, { showHeader: false }), /no changes/);
});

test("parseGitDiff reads paths, hunk headers, and +/- content with line numbers", () => {
  const gd = lines(
    "diff --git a/x.js b/x.js",
    "index 111..222 100644",
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -1,3 +1,4 @@",
    " ctx",
    "-old",
    "+new",
    "+extra",
    " tail",
    "",
  );
  const files = d.parseGitDiff(gd);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "x.js");
  assert.equal(files[0].additions, 2);
  assert.equal(files[0].deletions, 1);
  const first = files[0].diff[0];
  assert.deepEqual([first.type, first.oldLine, first.newLine], ["context", 1, 1]);
  // The add after the removal lands on new line 2; the trailing context on 3/4.
  const tail = files[0].diff[files[0].diff.length - 1];
  assert.deepEqual([tail.type, tail.oldLine, tail.newLine], ["context", 3, 4]);
});

test("parseGitDiff treats +++/--- inside a hunk as content, not as a new file header", () => {
  const gd = lines(
    "diff --git a/f.txt b/f.txt",
    "index aa..bb 100644",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,2 +1,2 @@",
    "-old one",
    "+++ important note",
    "",
  );
  const files = d.parseGitDiff(gd);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "f.txt", "the path must not be rewritten by content");
  const add = files[0].diff.find((e) => e.type === "add");
  assert.equal(add.content, "++ important note", "the whole line after the sign is content");
});

test("parseGitDiff resolves a new file shown against /dev/null", () => {
  const gd = lines(
    "diff --git a/new.js b/new.js",
    "new file mode 100644",
    "index 0000000..abc",
    "--- /dev/null",
    "+++ b/new.js",
    "@@ -0,0 +1,2 @@",
    "+first",
    "+second",
    "",
  );
  const files = d.parseGitDiff(gd);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "new.js");
  assert.equal(files[0].additions, 2);
  assert.equal(files[0].deletions, 0);
  assert.ok(
    files[0].diff.every((e) => e.type === "add"),
    "metadata lines (mode/index) never become diff entries",
  );
});

test("parseGitDiff splits multi-file output into one record per file", () => {
  const gd = lines(
    "diff --git a/a.txt b/a.txt",
    "index aa..bb 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-one",
    "+two",
    "diff --git a/b.txt b/b.txt",
    "index cc..dd 100644",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1 +1,2 @@",
    "three",
    "+four",
    "",
  );
  const files = d.parseGitDiff(gd);
  assert.deepEqual(files.map((f) => f.path), ["a.txt", "b.txt"]);
  assert.deepEqual(files.map((f) => f.additions), [1, 1]);
});

test("renderSplitDiff puts removals on the left and additions on the right", () => {
  const diff = d.computeDiff(lines("a", "b", "c"), lines("a", "B", "c"));
  const out = d.renderSplitDiff("f.js", diff, { width: 60 });
  const rows = out.split("\n").filter((l) => l.includes("\u2502"));
  assert.ok(rows.length >= 3, "each line of the file becomes a row");
  const changeRow = rows.find((l) => l.includes("- b"));
  assert.ok(changeRow, "the removed line is on a row");
  assert.match(changeRow, /\+ B/, "and its replacement sits across the bar, to the right");
});

test("renderSplitDiff aligns a replacement block row by row", () => {
  const diff = d.computeDiff(lines("keep", "old1", "old2", "keep2"), lines("keep", "new1", "new2", "keep2"));
  const out = d.renderSplitDiff("f.js", diff, { width: 60 });
  const all = out.split("\n");
  const row1 = all.find((l) => l.includes("- old1"));
  const row2 = all.find((l) => l.includes("- old2"));
  assert.ok(row1, "old1 is rendered");
  assert.match(row1, /\+ new1/, "new1 lines up opposite old1");
  assert.ok(row2, "old2 is rendered");
  assert.match(row2, /\+ new2/, "new2 lines up opposite old2");
});

test("renderDiffViewer adds a file sidebar only when there is more than one file", () => {
  const diff = d.computeDiff("a", "b");
  const one = d.renderDiffViewer([{ path: "f.js", diff }], { width: 60, height: 8 });
  assert.ok(!one.includes("\u2502"), "a single file needs no tree");

  const many = d.renderDiffViewer(
    [{ path: "f.js", diff }, { path: "g.js", diff }],
    { width: 60, height: 8 },
  );
  assert.ok(many.includes("\u2502"), "two files get a sidebar");
  assert.match(many, /f\.js/, "the tree lists the files");
});

test("renderDiffViewer windows the body to the requested height", () => {
  const old = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
  const nw = old.map((l, i) => (i % 7 === 0 ? `CHANGED ${l}` : l));
  const diff = d.computeDiff(old.join("\n"), nw.join("\n"));
  const out = d.renderDiffViewer([{ path: "big.js", diff }], { width: 70, height: 10 });
  assert.equal(out.split("\n").length, 10, "header plus body fills exactly the height");
  assert.match(out.split("\n")[0], /big\.js/, "the header names the file");
});

test("renderDiffViewer selects split mode automatically on a wide terminal", () => {
  const diff = d.computeDiff(lines("a", "b"), lines("a", "B"));
  const wide = d.renderDiffViewer([{ path: "f.js", diff }], { width: 110, height: 10, mode: "auto" });
  assert.match(wide.split("\n")[0], /^split\b/, "auto picks split at >= 100 columns");
  const narrow = d.renderDiffViewer([{ path: "f.js", diff }], { width: 60, height: 10, mode: "auto" });
  assert.match(narrow.split("\n")[0], /^unified\b/, "auto picks unified below 100 columns");
});

test("diff viewer dialog renders a header, body, and key hints", () => {
  const diff = d.computeDiff(lines("a", "b"), lines("a", "B"));
  const dialog = dlg.diffViewerDialog([{ path: "f.js", diff }], { width: 60, height: 8 });
  const out = dialog.render();
  assert.match(out, /f\.js/);
  assert.match(out, /\[.*q\]close/, "the footer advertises the controls");
  assert.equal(dialog.type, "diff");
});

test("diff viewer dialog scrolls with the arrow keys and clamps at the end", () => {
  const old = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
  const nw = old.map((l, i) => (i % 5 === 0 ? `CHANGED ${l}` : l));
  const diff = d.computeDiff(old.join("\n"), nw.join("\n"));
  const dialog = dlg.diffViewerDialog([{ path: "big.js", diff }], { width: 60, height: 6 });
  assert.equal(dialog.state.scroll, 0);

  assert.deepEqual(dialog.handleKey("", { name: "down" }), { done: false });
  assert.equal(dialog.state.scroll, 1);

  dialog.handleKey("", { name: "up" });
  assert.equal(dialog.state.scroll, 0, "scrolling up cannot go negative");

  // Drive past the end; it must stop at the maximum, never wrap.
  for (let i = 0; i < 500; i += 1) dialog.handleKey("", { name: "down" });
  const atEnd = dialog.state.scroll;
  dialog.handleKey("", { name: "down" });
  assert.equal(dialog.state.scroll, atEnd, "the scroll clamps at the bottom");
  assert.ok(atEnd > 0, "there was something to scroll to");

  dialog.handleKey("", { name: "end" });
  assert.equal(dialog.state.scroll, atEnd, "End jumps to the same bottom");
  dialog.handleKey("", { name: "home" });
  assert.equal(dialog.state.scroll, 0, "Home returns to the top");
});

test("diff viewer dialog moves between files with n and p", () => {
  const diff = d.computeDiff("a", "b");
  const dialog = dlg.diffViewerDialog(
    [{ path: "a.js", diff }, { path: "b.js", diff }],
    { width: 60, height: 8 },
  );
  assert.equal(dialog.state.fileIndex, 0);
  dialog.handleKey("n", { name: "n" });
  assert.equal(dialog.state.fileIndex, 1);
  dialog.handleKey("n", { name: "n" });
  assert.equal(dialog.state.fileIndex, 0, "n wraps back around to the first file");
  dialog.handleKey("p", { name: "p" });
  assert.equal(dialog.state.fileIndex, 1, "p wraps backwards");
});

test("diff viewer dialog jumps between hunks with ] and [", () => {
  const old = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const nw = old.slice();
  nw[0] = "CHANGED FIRST";
  nw[35] = "CHANGED LAST";
  const dialog = dlg.diffViewerDialog(
    [{ path: "f.js", diff: d.computeDiff(old.join("\n"), nw.join("\n")) }],
    { width: 60, height: 8 },
  );
  assert.equal(dialog.state.scroll, 0, "starts at the first hunk");
  dialog.handleKey("]", { name: "]" });
  assert.ok(dialog.state.scroll > 0, "] advances to the second hunk");
  dialog.handleKey("[", { name: "[" });
  assert.equal(dialog.state.scroll, 0, "[ returns to the first hunk");
});

test("diff viewer dialog toggles mode with Tab and the tree with b", () => {
  const diff = d.computeDiff("a", "b");
  const dialog = dlg.diffViewerDialog(
    [{ path: "a.js", diff }, { path: "b.js", diff }],
    { width: 60, height: 8 },
  );
  assert.equal(dialog.state.mode, "unified");
  assert.equal(dialog.state.showTree, true);
  dialog.handleKey("", { name: "tab" });
  assert.equal(dialog.state.mode, "split");
  dialog.handleKey("", { name: "tab" });
  assert.equal(dialog.state.mode, "unified");
  dialog.handleKey("b", { name: "b" });
  assert.equal(dialog.state.showTree, false);
  dialog.handleKey("b", { name: "b" });
  assert.equal(dialog.state.showTree, true);
});

test("diff viewer dialog closes on q and on Escape, yielding null", () => {
  const diff = d.computeDiff("a", "b");
  const dialog = dlg.diffViewerDialog([{ path: "f.js", diff }], { width: 60, height: 8 });
  assert.deepEqual(dialog.handleKey("q", { name: "q" }), { done: true, value: null });

  const second = dlg.diffViewerDialog([{ path: "f.js", diff }], { width: 60, height: 8 });
  assert.deepEqual(second.handleKey("", { name: "escape" }), { done: true, value: null });

  const third = dlg.diffViewerDialog([{ path: "f.js", diff }], { width: 60, height: 8 });
  assert.deepEqual(third.handleKey("", { ctrl: true, name: "c" }), { done: true, value: null });
});

test("diff viewer dialog ignores unrelated keys without closing", () => {
  const diff = d.computeDiff("a", "b");
  const dialog = dlg.diffViewerDialog([{ path: "f.js", diff }], { width: 60, height: 8 });
  assert.deepEqual(dialog.handleKey("z", { name: "z" }), { done: false });
  assert.equal(dialog.state.scroll, 0);
  assert.equal(dialog.state.fileIndex, 0);
});
