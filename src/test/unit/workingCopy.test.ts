import { strict as assert } from "node:assert";
import { test } from "node:test";
import { workingCopyFiles } from "../../workingCopy";

test("working copy change lines map to the files' paths", () => {
  const files = workingCopyFiles(`Working copy changes:
M src/a.ts
A sp ace.txt
D gone
R src/{old.txt => new.txt}
R {top.txt => src/top.txt}
C {a => b}/c
Working copy  (@) : yoqxwvmw 61433bf3 (no description set)
Parent commit (@-): nyuonnkm e9ca4c97 M not/a/file`);
  assert.deepEqual(
    [...files],
    [
      [1, "src/a.ts"],
      [2, "sp ace.txt"],
      [4, "src/new.txt"],
      [5, "src/top.txt"],
      [6, "b/c"],
    ],
  );
});

test("a clean working copy has no files", () => {
  assert.equal(workingCopyFiles("The working copy has no changes.\nWorking copy  (@) : x").size, 0);
});
