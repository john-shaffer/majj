import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as path from "path";
import { test } from "node:test";
import { displayKey, Keybinding, parseKeybindingsJson, renderHelp } from "../../help";

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as {
  contributes: { keybindings: Keybinding[] };
};
const defaults = pkg.contributes.keybindings;

test("default keybindings render the essential commands section", () => {
  const text = renderHelp(defaults);
  assert.deepEqual(text.lines, [
    "Essential commands",
    "  g        refresh current buffer",
    "  TAB      toggle section at point",
    "  SPC      toggle selection at point",
    "  RET      visit thing at point",
    "  a        absorb change at point",
    "  c        commit working copy",
    "  d        describe change at point",
    "  e        edit change at point",
    "  k        discard or abandon at point",
    "  n        new change on change at point",
    "  r        rebase change at point",
    "  s        split selected changes",
    "  S        squash changes",
    "  X        restore changes",
    "  ctrl+z   undo last operation",
    "  ctrl+y   redo last undone operation",
    "  q        exit / close majj view",
  ]);
  assert.deepEqual(text.spans, [
    { line: 0, start: 0, end: 18, style: { bold: true } },
    { line: 1, start: 2, end: 3, style: { fg: { kind: "ansi", index: 4 } } },
    { line: 2, start: 2, end: 5, style: { fg: { kind: "ansi", index: 4 } } },
    { line: 3, start: 2, end: 5, style: { fg: { kind: "ansi", index: 4 } } },
    { line: 4, start: 2, end: 5, style: { fg: { kind: "ansi", index: 4 } } },
    { line: 5, start: 2, end: 3, style: { fg: { kind: "ansi", index: 4 } } },
    { line: 6, start: 2, end: 3, style: { fg: { kind: "ansi", index: 4 } } },
    { line: 7, start: 2, end: 3, style: { fg: { kind: "ansi", index: 4 } } },
    { line: 8, start: 2, end: 3, style: { fg: { kind: "ansi", index: 4 } } },
    { line: 9, start: 2, end: 3, style: { fg: { kind: "ansi", index: 4 } } },
    { line: 10, start: 2, end: 3, style: { fg: { kind: "ansi", index: 4 } } },
    { line: 11, start: 2, end: 3, style: { fg: { kind: "ansi", index: 4 } } },
    { line: 12, start: 2, end: 3, style: { fg: { kind: "ansi", index: 4 } } },
    { line: 13, start: 2, end: 3, style: { fg: { kind: "ansi", index: 4 } } },
    { line: 14, start: 2, end: 3, style: { fg: { kind: "ansi", index: 4 } } },
    { line: 15, start: 2, end: 8, style: { fg: { kind: "ansi", index: 4 } } },
    { line: 16, start: 2, end: 8, style: { fg: { kind: "ansi", index: 4 } } },
    { line: 17, start: 2, end: 3, style: { fg: { kind: "ansi", index: 4 } } },
  ]);
});

test("user keybindings override defaults and widen the key column when needed", () => {
  const user = parseKeybindingsJson(`// User overrides
[
  /* remap refresh */
  { "key": "shift+r", "command": "majj.refresh" },
  { "key": "ctrl+enter", "command": "majj.visit" },
  { "key": "g", "command": "-majj.refresh" },
  // Non-majj close bindings are ignored unless scoped to majj.
  { "key": "ctrl+w", "command": "workbench.action.closeActiveEditor" },
]`);
  const text = renderHelp(defaults, user);
  assert.deepEqual(text.lines, [
    "Essential commands",
    "  R           refresh current buffer",
    "  TAB         toggle section at point",
    "  SPC         toggle selection at point",
    "  ctrl+enter  visit thing at point",
    "  a           absorb change at point",
    "  c           commit working copy",
    "  d           describe change at point",
    "  e           edit change at point",
    "  k           discard or abandon at point",
    "  n           new change on change at point",
    "  r           rebase change at point",
    "  s           split selected changes",
    "  S           squash changes",
    "  X           restore changes",
    "  ctrl+z      undo last operation",
    "  ctrl+y      redo last undone operation",
    "  q           exit / close majj view",
  ]);
});

test("displayKey formats special keys like magit", () => {
  assert.equal(displayKey("enter"), "RET");
  assert.equal(displayKey("space"), "SPC");
  assert.equal(displayKey("tab"), "TAB");
  assert.equal(displayKey("shift+a"), "A");
  assert.equal(displayKey("shift-x"), "X");
  assert.equal(displayKey("shift+4"), "shift+4");
  assert.equal(displayKey("shift+/"), "?");
});
