import { strict as assert } from "node:assert";
import { test } from "node:test";
import { workingCopyFiles } from "../../workingCopy";

test("workingCopyFiles maps each line to its path, deleted flag, and restore paths", () => {
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
      [1, { path: "src/a.ts", deleted: false, restorePaths: ["src/a.ts"] }],
      [2, { path: "sp ace.txt", deleted: false, restorePaths: ["sp ace.txt"] }],
      [3, { path: "gone", deleted: true, restorePaths: ["gone"] }],
      [4, { path: "src/new.txt", deleted: false, restorePaths: ["src/old.txt", "src/new.txt"] }],
      [5, { path: "src/top.txt", deleted: false, restorePaths: ["top.txt", "src/top.txt"] }],
      [6, { path: "b/c", deleted: false, restorePaths: ["b/c"] }],
    ],
  );
});

test("a clean working copy has no files", () => {
  assert.equal(workingCopyFiles("The working copy has no changes.\nWorking copy  (@) : x").size, 0);
});
