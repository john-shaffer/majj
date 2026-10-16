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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

test("watch mode picks up operations from the jj CLI", async () => {
  await setConfig("autoRefresh.mode", "watch");
  jj("describe", "-m", "Described from the CLI");
  await waitFor("the new description", () =>
    statusText().includes("Described from the CLI"),
  );
});

test("watch mode picks up file edits", async () => {
  fs.writeFileSync(path.join(repo, "watched.txt"), "x\n");
  await waitFor("the new file", () => statusText().includes("A watched.txt"));
});

test("off mode only refreshes on demand", async () => {
  await setConfig("autoRefresh.mode", "off");
  await sleep(500);
  fs.writeFileSync(path.join(repo, "unwatched.txt"), "x\n");
  await sleep(1500);
  assert.ok(
    !statusText().includes("unwatched.txt"),
    "refreshed although auto refresh is off",
  );
  await vscode.commands.executeCommand("majj.refresh");
  await waitFor("the refresh", () => statusText().includes("A unwatched.txt"));
});

test("poll mode refreshes periodically", async () => {
  await setConfig("autoRefresh.pollInterval", 1);
  await setConfig("autoRefresh.mode", "poll");
  await sleep(500);
  fs.writeFileSync(path.join(repo, "polled.txt"), "x\n");
  await waitFor(
    "the polled file",
    () => statusText().includes("A polled.txt"),
    5000,
  );
});

test("revset and limit settings apply to the change graph", async () => {
  await setConfig("autoRefresh.mode", "off");
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

test("recent changes are shown even when the log revset hides them", async () => {
  await setConfig("status.limit", undefined);
  jj("config", "set", "--repo", "revsets.log", "@");
  try {
    await vscode.commands.executeCommand("majj.refresh");
    await waitFor("the recent changes", () =>
      statusText().includes("First change"),
    );

    await setConfig("status.recentChanges", 0);
    await vscode.commands.executeCommand("majj.refresh");
    await waitFor(
      "the recent changes to go",
      () => !statusText().includes("First change"),
    );
  } finally {
    jj("config", "unset", "--repo", "revsets.log");
    await setConfig("status.recentChanges", undefined);
  }
});

test("a directory outside any jj repo gets an explanatory status view", async () => {
  const dir = fs.mkdtempSync(path.join(path.dirname(repo), "no-repo-"));
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.from({ scheme: "majj", path: "status.majj", query: dir }),
  );
  await vscode.window.showTextDocument(doc);
  await waitFor("the explanation", () =>
    doc.getText().startsWith(`No jj repository in ${dir}`),
  );
  assert.ok(doc.getText().includes("jj git init"), doc.getText());
  assert.ok(!doc.getText().includes("jj failed"), doc.getText());
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
});

test("visiting a change in the graph shows it", async () => {
  await vscode.commands.executeCommand("majj.status");
  await waitFor("the graph", () => statusText().includes("Second change"));
  const editor = vscode.window.activeTextEditor!;
  // The description line, below the line with the graph node.
  const lines = editor.document.getText().split("\n");
  const line = lines.findIndex(
    (l, i) => i > lines.indexOf("Changes:") && l.includes("Second change"),
  );
  editor.selection = new vscode.Selection(line, 0, line, 0);
  await vscode.commands.executeCommand("majj.visit");

  const doc = vscode.window.activeTextEditor!.document;
  assert.equal(doc.uri.path, "change.majj");
  assert.equal(doc.languageId, "majj");
  await waitFor("the change", () => doc.getText().includes("Second change"));
  assert.match(doc.getText(), /^Commit ID: /m);
  assert.match(doc.getText(), /^Changes \(1\)\nnew file   b\.txt\n@@ /m);
  assert.ok(!doc.getText().includes("diff --git"), doc.getText());
  assert.ok(!doc.getText().includes("\x1b"), "escape codes leaked");
});
