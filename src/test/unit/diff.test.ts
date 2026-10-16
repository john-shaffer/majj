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

x | 1 ${fg(2, "+")}
1 file changed, 1 insertion(+), 0 deletions(-)
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
    "x | 1 +",
    "1 file changed, 1 insertion(+), 0 deletions(-)",
    "",
    "Changes (1)",
    "modified   x",
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
  assert.deepEqual(text.lines.slice(text.lines.indexOf("Changes (4)")), [
    "Changes (4)",
    "modified   bin",
    "old mode 100644",
    "new mode 100755",
    "Binary files a/bin and b/bin differ",
    "deleted    gone",
    "@@ -1,1 +0,0 @@",
    "-x",
    "renamed    mv1 -> mv2",
    "new file   sp ace",
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
  assert.ok(text.lines.includes("modified   x"), text.lines.join("\n"));
});

test("an empty change has no Changes section", () => {
  const text = appendShowText(`Commit ID: abc

0 files changed, 0 insertions(+), 0 deletions(-)
`);
  assert.deepEqual(text.lines, ["Commit ID: abc", "", "0 files changed, 0 insertions(+), 0 deletions(-)"]);
});
