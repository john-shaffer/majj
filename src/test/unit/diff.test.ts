import { strict as assert } from "node:assert";
import { test } from "node:test";
import { StyledTextBuilder } from "../../ansi";
import { appendShow } from "../../diff";

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
