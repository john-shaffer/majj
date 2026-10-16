import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applySgr, color256, stripAnsi, StyledTextBuilder } from "../../ansi";

const ESC = "\x1b";

test("plain text has no spans", () => {
  const text = new StyledTextBuilder().appendAnsi("hello\nworld\n").build();
  assert.deepEqual(text, { lines: ["hello", "world"], spans: [] });
});

test("colors from jj log output become spans", () => {
  // Shaped like `jj log --color always`: bold magenta shortest prefix, dim rest, then a plain separator.
  const line = `@  ${ESC}[1m${ESC}[38;5;13mk${ESC}[38;5;8mmsumtwq${ESC}[39m ${ESC}[38;5;3mjdsha@pm.me${ESC}[39m${ESC}[0m`;
  const text = new StyledTextBuilder().appendAnsi(`${line}\n│  ${ESC}[1m${ESC}[38;5;10m(empty)${ESC}[0m\n`).build();

  assert.deepEqual(text.lines, ["@  kmsumtwq jdsha@pm.me", "│  (empty)"]);
  assert.deepEqual(text.spans, [
    {
      line: 0,
      start: 3,
      end: 4,
      style: { bold: true, fg: { kind: "ansi", index: 13 } },
    },
    {
      line: 0,
      start: 4,
      end: 11,
      style: { bold: true, fg: { kind: "ansi", index: 8 } },
    },
    { line: 0, start: 11, end: 12, style: { bold: true } },
    {
      line: 0,
      start: 12,
      end: 23,
      style: { bold: true, fg: { kind: "ansi", index: 3 } },
    },
    {
      line: 1,
      start: 3,
      end: 10,
      style: { bold: true, fg: { kind: "ansi", index: 10 } },
    },
  ]);
});

test("styles carry across newlines", () => {
  const text = new StyledTextBuilder().appendAnsi(`${ESC}[31mab\ncd${ESC}[0m e`).build();
  assert.deepEqual(text.lines, ["ab", "cd e"]);
  assert.deepEqual(
    text.spans.map((s) => [s.line, s.start, s.end]),
    [
      [0, 0, 2],
      [1, 0, 2],
    ],
  );
});

test("SGR codes", () => {
  assert.deepEqual(applySgr({}, "1;2;3;4"), {
    bold: true,
    dim: true,
    italic: true,
    underline: true,
  });
  assert.deepEqual(applySgr({ bold: true, dim: true, italic: true }, "22"), {
    italic: true,
  });
  assert.deepEqual(applySgr({ bold: true }, ""), {});
  assert.deepEqual(applySgr({}, "94;41"), {
    fg: { kind: "ansi", index: 12 },
    bg: { kind: "ansi", index: 1 },
  });
  assert.deepEqual(applySgr({}, "38;2;1;2;3"), {
    fg: { kind: "rgb", r: 1, g: 2, b: 3 },
  });
  assert.deepEqual(applySgr({}, "38:5:196"), {
    fg: { kind: "rgb", r: 255, g: 0, b: 0 },
  });
  assert.deepEqual(applySgr({ fg: { kind: "ansi", index: 1 } }, "39"), {});
});

test("256-color palette", () => {
  assert.deepEqual(color256(4), { kind: "ansi", index: 4 });
  assert.deepEqual(color256(16), { kind: "rgb", r: 0, g: 0, b: 0 });
  assert.deepEqual(color256(231), { kind: "rgb", r: 255, g: 255, b: 255 });
  assert.deepEqual(color256(232), { kind: "rgb", r: 8, g: 8, b: 8 });
});

test("non-color escapes are dropped", () => {
  const link = `${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`;
  assert.equal(stripAnsi(`${ESC}[2K${link}${ESC}[?25h`), "link");
  assert.deepEqual(new StyledTextBuilder().appendAnsi(link).build().spans, []);
});

test("separate leaves exactly one blank line", () => {
  const text = new StyledTextBuilder().append("a\n\n\n").separate().append("b").build();
  assert.deepEqual(text.lines, ["a", "", "b"]);
});
