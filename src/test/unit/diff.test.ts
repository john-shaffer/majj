import { strict as assert } from "node:assert";
import { test } from "node:test";
import { StyledTextBuilder } from "../../ansi";
import {
  appendFileDiff,
  appendShow,
  changedLinesByChunk,
  discardLines,
  fileSelectionState,
  parseFiles,
} from "../../diff";

const ESC = "\x1b";
const bold = (s: string) => `${ESC}[1m${s}${ESC}[0m`;
const fg = (n: number, s: string) => `${ESC}[38;5;${n}m${s}${ESC}[39m`;
const added = (s: string) => fg(2, `+${ESC}[4m${s}${ESC}[24m`);

const show = (diff: string) =>
  appendShowText(`Commit ID: ${fg(4, "abc")}

    Describe it

${diff}`);

function appendShowText(ansi: string) {
  const out = new StyledTextBuilder();
  appendShow(out, ansi);
  return out.build();
}

test("files are listed under a Changes section without git's headers", () => {
  const text = show(`${bold("diff --git a/x b/x")}
${bold("index 1..2 100644")}
${bold("--- a/x")}
${bold("+++ b/x")}
${fg(6, "@@ -1,1 +1,2 @@")}
 a
${added("b")}
`);
  assert.deepEqual(text.lines, [
    "Commit ID: abc",
    "",
    "    Describe it",
    "",
    "Changes    1 file, 1 insertion(+), 0 deletions(-)",
    "modified   x | 1 +",
    "@@ -1,1 +1,2 @@",
    " a",
    "+b",
  ]);
});

test("diff lines keep jj's colors but not its token underlines", () => {
  const text = show(`${bold("diff --git a/x b/x")}
${fg(6, "@@ -1,1 +1,2 @@")}
${added("b")}
`);
  const line = text.lines.indexOf("+b");
  const spans = text.spans.filter((s) => s.line === line);
  assert.deepEqual(
    spans.map((s) => s.style),
    [{ fg: { kind: "ansi", index: 2 } }, { fg: { kind: "ansi", index: 2 } }],
  );
});

test("each file is labeled with how it changed", () => {
  const text = show(`diff --git a/bin b/bin
old mode 100644
new mode 100755
index 1..2
Binary files a/bin and b/bin differ
diff --git a/gone b/gone
deleted file mode 100644
index 1..0
--- a/gone
+++ /dev/null
@@ -1,1 +0,0 @@
-x
diff --git a/mv1 b/mv2
rename from mv1
rename to mv2
diff --git a/sp ace b/sp ace
new file mode 100644
index 0..1
--- /dev/null
+++ b/sp ace
@@ -0,0 +1,1 @@
+x
\\ No newline at end of file
`);
  assert.deepEqual(text.lines.slice(text.lines.findIndex((l) => l.startsWith("Changes"))), [
    "Changes    4 files, 1 insertion(+), 1 deletion(-)",
    "modified   bin        | (binary)",
    "old mode 100644",
    "new mode 100755",
    "Binary files a/bin and b/bin differ",
    "deleted    gone       | 1 -",
    "@@ -1,1 +0,0 @@",
    "-x",
    "renamed    mv1 -> mv2 | 0",
    "new file   sp ace     | 1 +",
    "@@ -0,0 +1,1 @@",
    "+x",
    "\\ No newline at end of file",
  ]);
});

test("paths are read without the a/ and b/ prefixes when jj omits them", () => {
  const text = show(`diff --git x x
@@ -1,1 +1,1 @@
-a
+b
`);
  assert.ok(text.lines.includes("modified   x | 2 +-"), text.lines.join("\n"));
});

test("a description that quotes a diff is not mistaken for one", () => {
  const text = appendShowText(`Commit ID: abc

    Fix a parser
    diff --git a/x b/x
`);
  assert.deepEqual(text.lines, ["Commit ID: abc", "", "    Fix a parser", "    diff --git a/x b/x"]);
});

test("an empty change has no Changes section", () => {
  const text = appendShowText(`Commit ID: abc

    Describe it
`);
  assert.deepEqual(text.lines, ["Commit ID: abc", "", "    Describe it"]);
});

test("long bars are scaled down, keeping counts aligned", () => {
  const plus = (n: number) => Array.from({ length: n }, () => "+x\n").join("");
  const text = show(`diff --git a/big b/big
@@ -0,0 +1,80 @@
${plus(80)}diff --git a/small b/small
@@ -1,0 +1,2 @@
${plus(2)}`);
  const files = text.lines.filter((l) => / \| /.test(l));
  assert.deepEqual(files, [`modified   big   | 80 ${"+".repeat(40)}`, "modified   small |  2 +"]);
});

test("collapsed files keep their summary line but hide their diff lines", () => {
  const ansi = `Commit ID: abc

    Describe it

diff --git a/first b/first
@@ -1,1 +1,2 @@
 a
+b
diff --git a/second b/second
@@ -1,1 +1,2 @@
 c
+d
`;
  const out = new StyledTextBuilder();
  const fileLines = appendShow(out, ansi, new Set(["first"]));
  assert.deepEqual(out.build().lines, [
    "Commit ID: abc",
    "",
    "    Describe it",
    "",
    "Changes    2 files, 2 insertions(+), 0 deletions(-)",
    "modified   first  | 1 +",
    "modified   second | 1 +",
    "@@ -1,1 +1,2 @@",
    " c",
    "+d",
  ]);
  assert.deepEqual(fileLines.get(5), { kind: "file", key: "first", headerLine: 5 });
  assert.deepEqual(fileLines.get(6), { kind: "file", key: "second", headerLine: 6 });
  assert.deepEqual(fileLines.get(7), { kind: "chunk", key: "second\n0", headerLine: 7 });
  assert.deepEqual(fileLines.get(9), { kind: "chunk", key: "second\n0", headerLine: 7 });
});

test("collapsed chunks keep their @@ header line but hide their body lines", () => {
  const ansi = `Commit ID: abc

    Describe it

diff --git a/x b/x
@@ -1,2 +1,3 @@
 a
+b
 c
@@ -10,2 +11,3 @@
 d
+e
 f
`;
  const out = new StyledTextBuilder();
  const spans = appendShow(out, ansi, new Set(), new Set(["x\n0"]));
  assert.deepEqual(out.build().lines, [
    "Commit ID: abc",
    "",
    "    Describe it",
    "",
    "Changes    1 file, 2 insertions(+), 0 deletions(-)",
    "modified   x | 2 ++",
    "@@ -1,2 +1,3 @@",
    "@@ -10,2 +11,3 @@",
    " d",
    "+e",
    " f",
  ]);
  assert.deepEqual(spans.get(5), { kind: "file", key: "x", headerLine: 5 });
  assert.deepEqual(spans.get(6), { kind: "chunk", key: "x\n0", headerLine: 6 });
  assert.deepEqual(spans.get(7), { kind: "chunk", key: "x\n1", headerLine: 7 });
  assert.deepEqual(spans.get(10), { kind: "chunk", key: "x\n1", headerLine: 7 });
});

test("symlinks are recognized by their git file mode", () => {
  const files = parseFiles(
    `diff --git a/new-link b/new-link
new file mode 120000
index 0000000000..48980ad58d
--- /dev/null
+++ b/new-link
@@ -0,0 +1,1 @@
+/etc/hostname
\\ No newline at end of file
diff --git a/changed-link b/changed-link
index 1111111111..2222222222 120000
--- a/changed-link
+++ b/changed-link
@@ -1,1 +1,1 @@
-a
\\ No newline at end of file
+b
\\ No newline at end of file
diff --git a/file b/file
index 1111111111..2222222222 100644
--- a/file
+++ b/file
@@ -1,1 +1,1 @@
-a
+b
`.split("\n"),
  );
  assert.deepEqual(
    files.map((f) => [f.path, f.symlink]),
    [
      ["new-link", true],
      ["changed-link", true],
      ["file", false],
    ],
  );
});

test("discardLines discards individual added or removed lines and selections of changed lines", () => {
  const [file] = parseFiles(
    `diff --git a/x b/x
@@ -1,5 +1,5 @@
 line 1
-old A
+new A
 line 2
-old B
+new B
 line 3
`.split("\n"),
  );
  const current = "line 1\nnew A\nline 2\nnew B\nline 3\n";

  // Discard only "+new A" (line index 2 in chunk 0).
  assert.equal(discardLines(current, file, new Map([[0, new Set([2])]])), "line 1\nline 2\nnew B\nline 3\n");

  // Discard only "-old A" (line index 1 in chunk 0), restoring "old A" before "new A".
  assert.equal(
    discardLines(current, file, new Map([[0, new Set([1])]])),
    "line 1\nold A\nnew A\nline 2\nnew B\nline 3\n",
  );

  // Discard selection covering "-old A", "+new A", " line 2", and "-old B" (indices 1, 2, 4).
  assert.equal(
    discardLines(current, file, new Map([[0, new Set([1, 2, 4])]])),
    "line 1\nold A\nline 2\nold B\nnew B\nline 3\n",
  );
});

test("appendFileDiff renders selection markers [ ], [◐], and [●] for chunks and changed lines", () => {
  const [file] = parseFiles(
    `diff --git a/x b/x
@@ -1,2 +1,3 @@
 a
-b
+b1
@@ -10,1 +11,2 @@
 c
+d
`.split("\n"),
  );
  const allByChunk = changedLinesByChunk(file);
  const selected = new Map<number, Set<number>>([[0, new Set([1])]]);
  assert.equal(fileSelectionState(allByChunk, new Map()), "none");
  assert.equal(fileSelectionState(allByChunk, selected), "some");
  assert.equal(
    fileSelectionState(
      allByChunk,
      new Map([
        [0, new Set([1, 2])],
        [1, new Set([1])],
      ]),
    ),
    "all",
  );

  const out = new StyledTextBuilder();
  appendFileDiff(out, file, 0, new Map(), new Set(), undefined, selected);
  assert.deepEqual(out.build().lines, [
    "[◐] @@ -1,2 +1,3 @@",
    "     a",
    "[●] -b",
    "[ ] +b1",
    "[ ] @@ -10,1 +11,2 @@",
    "     c",
    "[ ] +d",
  ]);
});
