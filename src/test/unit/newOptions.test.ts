import { strict as assert } from "node:assert";
import { test } from "node:test";
import { defaultNewOptions, newArgs, toggleParent } from "../../newOptions";

const point = { revset: "kmsumtwq", label: "kmsumtwq" };
const main = { revset: "main", label: "main" };
const other = { revset: "rlprsrnn", label: "rlprsrnn" };

test("the first parent picked replaces the default, and later picks toggle", () => {
  let options = toggleParent(defaultNewOptions(point), main);
  assert.deepEqual(options.parents, [main]);
  options = toggleParent(options, point);
  assert.deepEqual(options.parents, [main, point]);
  options = toggleParent(options, main);
  assert.deepEqual(options.parents, [point]);
});

test("newArgs passes parents after -- and leaves the default parent out with -A or -B", () => {
  const options = defaultNewOptions(point);
  assert.deepEqual(newArgs(options), ["new", "--", "kmsumtwq"]);
  assert.deepEqual(newArgs({ ...options, message: "-x", edit: false }), [
    "new",
    "-m",
    "-x",
    "--no-edit",
    "--",
    "kmsumtwq",
  ]);
  assert.deepEqual(newArgs({ ...options, after: [main], before: [other] }), ["new", "-A", "main", "-B", "rlprsrnn"]);
  assert.deepEqual(newArgs({ ...toggleParent(options, main), after: [other] }), [
    "new",
    "-A",
    "rlprsrnn",
    "--",
    "main",
  ]);
});
