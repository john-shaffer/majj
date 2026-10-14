import { strict as assert } from "node:assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { MajjApi } from "../../../extension";
import { test } from "./index";

const repo = fs.realpathSync(process.env.MAJJ_TEST_REPO!);

const jj = (...args: string[]) =>
  execFileSync("jj", ["--no-pager", ...args], { cwd: repo, encoding: "utf8" });

const statusText = () =>
  vscode.workspace.textDocuments
    .find((d) => d.uri.scheme === "majj" && d.uri.query === repo)
    ?.getText() ?? "";

/** The lines of the status view's change graph, starting with its header. */
function changesSection(): string[] | undefined {
  const lines = statusText().split("\n");
  const start = lines.findIndex((line) => line.startsWith("Changes:"));
  return start < 0 ? undefined : lines.slice(start);
}

async function waitFor(
  what: string,
  condition: () => boolean,
  timeoutMs = 10000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(
        `timed out waiting for ${what}. Status view:\n${statusText()}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function setConfig(key: string, value: unknown) {
  await vscode.workspace
    .getConfiguration("majj")
    .update(key, value, vscode.ConfigurationTarget.Global);
}

test("status command opens the status view", async () => {
  await vscode.commands.executeCommand("majj.status");
  const editor = vscode.window.activeTextEditor;
  assert.equal(editor?.document.uri.scheme, "majj");
  assert.equal(editor.document.uri.path, "status.majj");
  assert.equal(editor.document.languageId, "majj");
  await waitFor("status to load", () => statusText().includes("Changes:"));

  const text = statusText();
  const workingCopy = jj(
    "log",
    "--no-graph",
    "-r",
    "@",
    "-T",
    "change_id.shortest(8)",
  );
  assert.match(text, /Working copy changes:\nA c\.txt/);
  assert.match(text, new RegExp(`Working copy\\s+\\(@\\)\\s*: ${workingCopy}`));
  assert.match(text, new RegExp(`^@  ${workingCopy} `, "m"));
  for (const description of [
    "First change",
    "Second change",
    "Sibling change",
    "Descendant change",
  ]) {
    assert.ok(text.includes(description), `missing "${description}"`);
  }
  assert.ok(text.includes("feature"), "missing bookmark");
  assert.ok(!text.includes("\x1b"), "escape codes leaked into the text");
});

test("jj colors are kept as styled spans", async () => {
  const api = vscode.extensions.getExtension<MajjApi>("jdsha.majj")!.exports;
  const status = api.getStatus(repo)!;
  const atLine = status.lines.findIndex((l) => l.startsWith("@  "));
  assert.ok(
    status.spans.some((s) => s.line === atLine && s.style.fg),
    "working copy line has no colors",
  );
});

test("revset and limit settings apply to the change graph", async () => {
  await setConfig("status.revset", "@ | @-");
  await vscode.commands.executeCommand("majj.refresh");
  await waitFor("the revset", () => statusText().includes("Changes: @ | @-"));
  assert.ok(statusText().includes("Second change"));
  assert.ok(!statusText().includes("Sibling change"));

  await setConfig("status.revset", "");
  await setConfig("status.limit", 1);
  await vscode.commands.executeCommand("majj.refresh");
  // Each setting change refreshes, so wait for the one with both applied:
  // the header, then a single change's two lines.
  await waitFor("the limit", () => {
    const changes = changesSection();
    return changes?.[0] === "Changes:" && changes.length === 3;
  });
});
