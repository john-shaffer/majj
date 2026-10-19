import { strict as assert } from "node:assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { MajjApi } from "../../../extension";
import { test } from "./index";

const repo = fs.realpathSync(process.env.MAJJ_TEST_REPO!);

const jj = (...args: string[]) => execFileSync("jj", ["--no-pager", ...args], { cwd: repo, encoding: "utf8" });

const statusText = () =>
  vscode.workspace.textDocuments.find((d) => d.uri.scheme === "majj" && d.uri.query === repo)?.getText() ?? "";

/** The lines of the status view's change graph, starting with its header. */
function changesSection(): string[] | undefined {
  const lines = statusText().split("\n");
  const start = lines.findIndex((line) => line.startsWith("Changes:"));
  return start < 0 ? undefined : lines.slice(start);
}

async function waitFor(what: string, condition: () => boolean, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}. Status view:\n${statusText()}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setConfig(key: string, value: unknown) {
  await vscode.workspace.getConfiguration("majj").update(key, value, vscode.ConfigurationTarget.Global);
}

test("status command opens the status view", async () => {
  await vscode.commands.executeCommand("majj.status");
  const editor = vscode.window.activeTextEditor;
  assert.equal(editor?.document.uri.scheme, "majj");
  assert.equal(editor.document.uri.path, "status.majj");
  assert.equal(editor.document.languageId, "majj");
  await waitFor("status to load", () => statusText().includes("Changes:"));

  const text = statusText();
  const workingCopy = jj("log", "--no-graph", "-r", "@", "-T", "change_id.shortest(8)");
  assert.match(
    text,
    new RegExp(
      `^Working copy\\s+\\(@\\)\\s*: ${workingCopy}[\\s\\S]*\\nParent commit \\(@-\\): .*\\n\\nWorking copy changes:\\n\\[ \\] A c\\.txt\\n\\nChanges:`,
    ),
  );
  assert.match(text, new RegExp(`^@  ${workingCopy} `, "m"));
  for (const description of ["First change", "Second change", "Sibling change", "Descendant change"]) {
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
  await waitFor("the new description", () => statusText().includes("Described from the CLI"));
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
  assert.ok(!statusText().includes("unwatched.txt"), "refreshed although auto refresh is off");
  await vscode.commands.executeCommand("majj.refresh");
  await waitFor("the refresh", () => statusText().includes("A unwatched.txt"));
});

test("poll mode refreshes periodically", async () => {
  await setConfig("autoRefresh.pollInterval", 1);
  await setConfig("autoRefresh.mode", "poll");
  await sleep(500);
  fs.writeFileSync(path.join(repo, "polled.txt"), "x\n");
  await waitFor("the polled file", () => statusText().includes("A polled.txt"), 5000);
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
    await waitFor("the recent changes", () => statusText().includes("First change"));

    await setConfig("status.recentChanges", 0);
    await vscode.commands.executeCommand("majj.refresh");
    await waitFor("the recent changes to go", () => !statusText().includes("First change"));
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
  await waitFor("the explanation", () => doc.getText().startsWith(`No jj repository in ${dir}`));
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
  const line = lines.findIndex((l, i) => i > lines.indexOf("Changes:") && l.includes("Second change"));
  editor.selection = new vscode.Selection(line, 0, line, 0);
  await vscode.commands.executeCommand("majj.visit");

  const doc = vscode.window.activeTextEditor!.document;
  assert.equal(doc.uri.path, "change.majj");
  assert.equal(doc.languageId, "majj");
  await waitFor("the change", () => doc.getText().includes("Second change"));
  assert.match(doc.getText(), /^Commit ID: /m);
  assert.match(
    doc.getText(),
    /^Changes {4}1 file, 1 insertion\(\+\), 0 deletions\(-\)\nnew file   b\.txt \| 1 \+\n@@ /m,
  );
  assert.ok(!doc.getText().includes("diff --git"), doc.getText());
  assert.doesNotMatch(doc.getText(), /files? changed/);
  assert.ok(!doc.getText().includes("\x1b"), "escape codes leaked");
});

test("visiting a working copy change opens the file", async () => {
  await vscode.commands.executeCommand("majj.status");
  await waitFor("the working copy changes", () => statusText().includes("A c.txt"));
  const editor = vscode.window.activeTextEditor!;
  const line = editor.document.getText().split("\n").indexOf("[ ] A c.txt");
  editor.selection = new vscode.Selection(line, 0, line, 0);
  await vscode.commands.executeCommand("majj.visit");

  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, path.join(repo, "c.txt"));
});

test("poll mode refreshes the change view", async () => {
  const workingCopy = jj("log", "--no-graph", "-r", "@", "-T", "change_id");
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.from({ scheme: "majj", path: "change.majj", query: repo, fragment: workingCopy }),
  );
  await vscode.window.showTextDocument(doc);
  await waitFor("the change", () => doc.getText().includes("c.txt"));
  await setConfig("autoRefresh.pollInterval", 1);
  await setConfig("autoRefresh.mode", "poll");
  await sleep(500);
  fs.writeFileSync(path.join(repo, "polled-change.txt"), "x\n");
  await waitFor("the polled file", () => doc.getText().includes("polled-change.txt"), 5000);
});

test("views open in the editor group that isn't active", async () => {
  await setConfig("autoRefresh.mode", "off");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  const file = await vscode.workspace.openTextDocument(path.join(repo, "c.txt"));
  await vscode.window.showTextDocument(file, vscode.ViewColumn.One);

  // With one group, the editor splits.
  await vscode.commands.executeCommand("majj.status");
  assert.equal(vscode.window.activeTextEditor?.viewColumn, vscode.ViewColumn.Two);
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

  await vscode.window.showTextDocument(file, vscode.ViewColumn.Two);

  await vscode.commands.executeCommand("majj.status");
  assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, "majj");
  assert.equal(vscode.window.activeTextEditor?.viewColumn, vscode.ViewColumn.One);

  await waitFor("the graph", () => statusText().includes("Second change"));
  const editor = vscode.window.activeTextEditor!;
  const line = editor.document.getText().split("\n").indexOf("[ ] A c.txt");
  editor.selection = new vscode.Selection(line, 0, line, 0);
  await vscode.commands.executeCommand("majj.visit");
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, path.join(repo, "c.txt"));
  assert.equal(vscode.window.activeTextEditor?.viewColumn, vscode.ViewColumn.Two);

  // An open status view is revealed where it is rather than opened again.
  await vscode.commands.executeCommand("majj.status");
  assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, "majj");
  assert.equal(vscode.window.activeTextEditor?.viewColumn, vscode.ViewColumn.One);
});

test("discarding a working copy file restores it without asking, and jj undo brings it back", async () => {
  await setConfig("autoRefresh.mode", "off");
  const api = vscode.extensions.getExtension<MajjApi>("jdsha.majj")!.exports;
  const filePath = path.join(repo, "discard-me.txt");
  fs.writeFileSync(filePath, "temp\n");
  await vscode.commands.executeCommand("majj.status");
  await waitFor("the new file", () => statusText().includes("A discard-me.txt"));

  const editor = vscode.window.activeTextEditor!;
  const discardFile = async () => {
    const line = editor.document.getText().split("\n").indexOf("[ ] A discard-me.txt");
    editor.selection = new vscode.Selection(line, 0, line, 0);
    await vscode.commands.executeCommand("majj.discard");
    assert.equal(api.confirmPrompt(), undefined);
    await waitFor("the file to be discarded", () => !statusText().includes("discard-me.txt"));
    assert.ok(!fs.existsSync(filePath));
  };
  await discardFile();

  await vscode.commands.executeCommand("majj.undo");
  assert.equal(fs.readFileSync(filePath, "utf8"), "temp\n");
  await waitFor("the file to come back", () => statusText().includes("[ ] A discard-me.txt"));
  // Redoing the same restore within the second would recreate the undone
  // commit exactly, which jj rejects as "Newly-created commit already exists".
  await sleep(1100);
  await discardFile();
});

test("discarding individual changed lines and selections of changed lines reverts only those lines", async () => {
  await setConfig("autoRefresh.mode", "off");
  const filePath = path.join(repo, "b.txt");
  fs.writeFileSync(filePath, "b1\nb2\nb3\n");
  try {
    await vscode.commands.executeCommand("majj.status");
    await waitFor("M b.txt to appear", () => statusText().includes("M b.txt"));

    const editor = vscode.window.activeTextEditor!;
    const fileLine = editor.document.getText().split("\n").indexOf("[ ] M b.txt");
    editor.selection = new vscode.Selection(fileLine, 0, fileLine, 0);
    await vscode.commands.executeCommand("majj.toggleFold");
    await waitFor("b.txt diff to expand", () => statusText().includes("[ ] +b1\n[ ] +b2\n[ ] +b3"));

    // Discard a single changed line (+b2).
    const b2Line = editor.document.getText().split("\n").indexOf("[ ] +b2");
    editor.selection = new vscode.Selection(b2Line, 0, b2Line, 0);
    await vscode.commands.executeCommand("majj.discard");
    await waitFor("b2 to be removed", () => !statusText().includes("+b2") && statusText().includes("+b1"));
    assert.equal(fs.readFileSync(filePath, "utf8"), "b1\nb3\n");

    // jj undo brings the discarded line back, and jj redo discards it again.
    await vscode.commands.executeCommand("majj.undo");
    assert.equal(fs.readFileSync(filePath, "utf8"), "b1\nb2\nb3\n");
    await vscode.commands.executeCommand("majj.redo");
    assert.equal(fs.readFileSync(filePath, "utf8"), "b1\nb3\n");
    await waitFor("b2 to be removed again", () => !statusText().includes("+b2") && statusText().includes("+b1"));

    // Discard a selection spanning -b and +b1, restoring b and removing b1 while keeping b3.
    const lines = editor.document.getText().split("\n");
    const minusB = lines.indexOf("[ ] -b");
    const plusB1 = lines.indexOf("[ ] +b1");
    editor.selection = new vscode.Selection(minusB, 0, plusB1, 0);
    await vscode.commands.executeCommand("majj.discard");
    await waitFor("b restored and b1 removed", () => !statusText().includes("+b1") && statusText().includes("+b3"));
    assert.equal(fs.readFileSync(filePath, "utf8"), "b\nb3\n");
  } finally {
    jj("restore", "b.txt");
    await vscode.commands.executeCommand("majj.refresh");
    await waitFor("b.txt restored", () => !statusText().includes("b.txt"));
  }
});

test("discarding or restoring changed lines of a symlink restores the link without touching its target", async () => {
  await setConfig("autoRefresh.mode", "off");
  const target = path.join(repo, "..", "outside.txt");
  const link = path.join(repo, "link");
  fs.writeFileSync(target, "outside\n");
  const discardLinkLine = async (command: string) => {
    fs.symlinkSync(target, link);
    await vscode.commands.executeCommand("majj.status");
    await waitFor("A link to appear", () => statusText().includes("[ ] A link"));
    const editor = vscode.window.activeTextEditor!;
    const fileLine = editor.document.getText().split("\n").indexOf("[ ] A link");
    editor.selection = new vscode.Selection(fileLine, 0, fileLine, 0);
    await vscode.commands.executeCommand("majj.toggleFold");
    await waitFor("link diff to expand", () => statusText().includes(`[ ] +${target}`));
    const targetLine = editor.document.getText().split("\n").indexOf(`[ ] +${target}`);
    editor.selection = new vscode.Selection(targetLine, 0, targetLine, 0);
    await vscode.commands.executeCommand(command);
    await waitFor("link to be restored", () => !statusText().includes("A link"));
    assert.ok(!fs.existsSync(link));
    assert.equal(fs.readFileSync(target, "utf8"), "outside\n");
  };
  try {
    await discardLinkLine("majj.discard");
    await discardLinkLine("majj.restore");
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(target, { force: true });
    await vscode.commands.executeCommand("majj.refresh");
    await waitFor("link removed", () => !statusText().includes("link"));
  }
});

test("tab shows and hides changed files and chunks in the working copy and in change.majj", async () => {
  await setConfig("autoRefresh.mode", "off");
  await vscode.commands.executeCommand("majj.status");
  await waitFor("the working copy file", () => statusText().includes("A c.txt"));
  assert.ok(!statusText().includes("@@ -0,0 +1,1 @@"));

  // Expand c.txt in status.majj.
  const statusEditor = vscode.window.activeTextEditor!;
  const fileLine = statusEditor.document.getText().split("\n").indexOf("[ ] A c.txt");
  statusEditor.selection = new vscode.Selection(fileLine, 0, fileLine, 0);
  await vscode.commands.executeCommand("majj.toggleFold");
  await waitFor("c.txt diff to show", () => statusText().includes("[ ] A c.txt\n[ ] @@ -0,0 +1,1 @@\n[ ] +c"));

  // Collapse the chunk from inside its body; @@ stays visible and the cursor returns to the @@ line.
  statusEditor.selection = new vscode.Selection(fileLine + 2, 0, fileLine + 2, 0);
  await vscode.commands.executeCommand("majj.toggleFold");
  await waitFor("c.txt chunk body to hide", () => !statusText().includes("+c"));
  assert.ok(statusText().includes("[ ] A c.txt\n[ ] @@ -0,0 +1,1 @@"));
  assert.equal(statusEditor.selection.active.line, fileLine + 1);

  // Expand the chunk again, then collapse the whole file from its file line.
  await vscode.commands.executeCommand("majj.toggleFold");
  await waitFor("c.txt chunk body to show again", () => statusText().includes("+c"));
  statusEditor.selection = new vscode.Selection(fileLine, 0, fileLine, 0);
  await vscode.commands.executeCommand("majj.toggleFold");
  await waitFor("c.txt diff to hide", () => !statusText().includes("@@ -0,0 +1,1 @@"));

  // Visit a change in the graph and toggle its chunk and file diff in change.majj.
  const lines = statusEditor.document.getText().split("\n");
  const changeLine = lines.findIndex((l, i) => i > lines.indexOf("Changes:") && l.includes("Second change"));
  statusEditor.selection = new vscode.Selection(changeLine, 0, changeLine, 0);
  await vscode.commands.executeCommand("majj.visit");

  const changeEditor = vscode.window.activeTextEditor!;
  const changeDoc = changeEditor.document;
  assert.equal(changeDoc.uri.path, "change.majj");
  await waitFor("change diff to load", () => changeDoc.getText().includes("+b"));

  // Toggle chunk in change.majj.
  const chunkLine = changeDoc
    .getText()
    .split("\n")
    .findIndex((l) => l.startsWith("@@ "));
  changeEditor.selection = new vscode.Selection(chunkLine, 0, chunkLine, 0);
  await vscode.commands.executeCommand("majj.toggleFold");
  await waitFor("b.txt chunk body to hide", () => !changeDoc.getText().includes("+b"));
  assert.ok(changeDoc.getText().includes("@@ "));

  await vscode.commands.executeCommand("majj.toggleFold");
  await waitFor("b.txt chunk body to show again", () => changeDoc.getText().includes("+b"));

  // Toggle whole file in change.majj.
  const bLine = changeDoc
    .getText()
    .split("\n")
    .findIndex((l) => l.startsWith("new file   b.txt"));
  changeEditor.selection = new vscode.Selection(bLine, 0, bLine, 0);
  await vscode.commands.executeCommand("majj.toggleFold");
  await waitFor("b.txt diff to hide", () => !changeDoc.getText().includes("@@ "));
  assert.ok(changeDoc.getText().includes("new file   b.txt | 1 +"));

  await vscode.commands.executeCommand("majj.toggleFold");
  await waitFor("b.txt diff to show again", () => changeDoc.getText().includes("+b"));
});

test("editing a change or commit in status.majj runs jj edit on it", async () => {
  await setConfig("autoRefresh.mode", "off");
  const original = jj("log", "--no-graph", "-r", "@", "-T", "change_id").trim();
  try {
    await vscode.commands.executeCommand("majj.status");
    await waitFor("Second change in graph", () => statusText().includes("Second change"));

    const editor = vscode.window.activeTextEditor!;
    const lines = editor.document.getText().split("\n");
    const secondLine = lines.findIndex((l, i) => i > lines.indexOf("Changes:") && l.includes("Second change"));
    editor.selection = new vscode.Selection(secondLine, 0, secondLine, 0);
    await vscode.commands.executeCommand("majj.edit");
    await waitFor("working copy to become Second change", () =>
      /^Working copy\s+\(@\)\s*: .*Second change/m.test(statusText()),
    );
    assert.equal(jj("log", "--no-graph", "-r", "@", "-T", "description").trim(), "Second change");

    // Edit the parent commit directly from the Parent commit (@-) line at the top of status.majj.
    const parentLine = editor.document
      .getText()
      .split("\n")
      .findIndex((l) => l.startsWith("Parent commit (@-):"));
    editor.selection = new vscode.Selection(parentLine, 0, parentLine, 0);
    await vscode.commands.executeCommand("majj.edit");
    await waitFor("working copy to become First change", () =>
      /^Working copy\s+\(@\)\s*: .*First change/m.test(statusText()),
    );
    assert.equal(jj("log", "--no-graph", "-r", "@", "-T", "description").trim(), "First change");
  } finally {
    jj("edit", original);
    await vscode.commands.executeCommand("majj.refresh");
    await waitFor("working copy restored", () => statusText().includes("A c.txt"));
  }
});

test("selecting working copy changes with space then splitting with s and squashing with S", async () => {
  await setConfig("autoRefresh.mode", "off");
  const savedOp = jj("op", "log", "--no-graph", "-n", "1", "-T", "id").trim();
  const filePath = path.join(repo, "b.txt");
  fs.writeFileSync(filePath, "b1\nb2\nb3\n");
  try {
    await vscode.commands.executeCommand("majj.status");
    await waitFor("M b.txt to appear", () => statusText().includes("[ ] M b.txt"));

    const editor = vscode.window.activeTextEditor!;
    let fileLine = editor.document.getText().split("\n").indexOf("[ ] M b.txt");
    editor.selection = new vscode.Selection(fileLine, 0, fileLine, 0);
    await vscode.commands.executeCommand("majj.toggleFold");
    await waitFor("b.txt diff to expand", () => statusText().includes("[ ] +b1\n[ ] +b2\n[ ] +b3"));

    // Select a single line (+b2) with space: file and chunk become [◐], line becomes [●].
    const b2Line = editor.document.getText().split("\n").indexOf("[ ] +b2");
    editor.selection = new vscode.Selection(b2Line, 0, b2Line, 0);
    await vscode.commands.executeCommand("majj.toggleSelect");
    await waitFor("partial selection markers", () =>
      statusText().includes("[◐] M b.txt\n[◐] @@ -1,1 +1,3 @@\n[ ] -b\n[ ] +b1\n[●] +b2\n[ ] +b3"),
    );

    // Toggle chunk header with space: selects all lines in the chunk ([●]), then deselects all ([ ]).
    const chunkLine = editor.document.getText().split("\n").indexOf("[◐] @@ -1,1 +1,3 @@");
    editor.selection = new vscode.Selection(chunkLine, 0, chunkLine, 0);
    await vscode.commands.executeCommand("majj.toggleSelect");
    await waitFor("full selection markers", () =>
      statusText().includes("[●] M b.txt\n[●] @@ -1,1 +1,3 @@\n[●] -b\n[●] +b1\n[●] +b2\n[●] +b3"),
    );
    await vscode.commands.executeCommand("majj.toggleSelect");
    await waitFor("cleared selection markers", () => statusText().includes("[ ] M b.txt\n[ ] @@ -1,1 +1,3 @@"));

    // Select -b and +b1 and split them into @- with s (majj.split).
    const lines = editor.document.getText().split("\n");
    const minusB = lines.indexOf("[ ] -b");
    const plusB1 = lines.indexOf("[ ] +b1");
    editor.selection = new vscode.Selection(minusB, 0, plusB1, 0);
    await vscode.commands.executeCommand("majj.toggleSelect");
    await waitFor("-b and +b1 selected", () => statusText().includes("[●] -b\n[●] +b1\n[ ] +b2"));
    await vscode.commands.executeCommand("majj.split");
    await waitFor("split to leave only +b2 and +b3 in @", () =>
      statusText().includes("[ ] @@ -1,1 +1,3 @@\n     b1\n[ ] +b2\n[ ] +b3"),
    );
    assert.equal(jj("file", "show", "-r", "@-", "b.txt"), "b1\n");

    // Select +b2 and squash it into @- with S (majj.squash).
    const newB2Line = editor.document.getText().split("\n").indexOf("[ ] +b2");
    editor.selection = new vscode.Selection(newB2Line, 0, newB2Line, 0);
    await vscode.commands.executeCommand("majj.toggleSelect");
    await waitFor("+b2 selected", () => statusText().includes("[●] +b2"));
    await vscode.commands.executeCommand("majj.squash");
    await waitFor("squash to leave only +b3 in @", () => !statusText().includes("+b2") && statusText().includes("+b3"));
    assert.equal(jj("file", "show", "-r", "@-", "b.txt"), "b1\nb2\n");
    assert.equal(fs.readFileSync(filePath, "utf8"), "b1\nb2\nb3\n");
    // Fold state of M b.txt is preserved; collapse it before finishing.
    fileLine = editor.document.getText().split("\n").indexOf("[ ] M b.txt");
    editor.selection = new vscode.Selection(fileLine, 0, fileLine, 0);
    await vscode.commands.executeCommand("majj.toggleFold");
  } finally {
    jj("op", "restore", savedOp);
    await vscode.commands.executeCommand("majj.refresh");
    await waitFor("repo restored", () => !statusText().includes("b.txt") && statusText().includes("[ ] A c.txt"));
  }
});

test("rebasing a change in status.majj prompts for destination and runs jj rebase", async () => {
  await setConfig("autoRefresh.mode", "off");
  const api = vscode.extensions.getExtension<MajjApi>("jdsha.majj")!.exports;
  const savedOp = jj("op", "log", "--no-graph", "-n", "1", "-T", "id").trim();
  try {
    await vscode.commands.executeCommand("majj.status");
    await waitFor("Sibling change in graph", () => statusText().includes("Sibling change"));

    const siblingId = jj(
      "log",
      "--no-graph",
      "-r",
      'description(substring:"Sibling change")',
      "-T",
      "change_id",
    ).trim();
    const editor = vscode.window.activeTextEditor!;
    const lines = editor.document.getText().split("\n");
    const siblingLine = lines.findIndex((l, i) => i > lines.indexOf("Changes:") && l.includes("Sibling change"));
    editor.selection = new vscode.Selection(siblingLine, 0, siblingLine, 0);

    const rebasing = vscode.commands.executeCommand("majj.rebase");
    await waitFor("rebase prompt", () => api.confirmPrompt() !== undefined);
    assert.equal(api.confirmPrompt(), `Rebase ${siblingId} onto`);
    api.answerConfirmation("feature");
    await rebasing;

    assert.equal(
      jj("log", "--no-graph", "-r", 'description(substring:"Sibling change")-', "-T", "description").trim(),
      "First change",
    );

    // Flag-style input fills in the source revision when omitted.
    const newSiblingLine = editor.document
      .getText()
      .split("\n")
      .findIndex((l, i, arr) => i > arr.indexOf("Changes:") && l.includes("Sibling change"));
    editor.selection = new vscode.Selection(newSiblingLine, 0, newSiblingLine, 0);
    const rebasingFlags = vscode.commands.executeCommand("majj.rebase");
    await waitFor("rebase prompt", () => api.confirmPrompt() !== undefined);
    api.answerConfirmation("-r -d root()");
    await rebasingFlags;

    assert.equal(
      jj("log", "--no-graph", "-r", 'description(substring:"Sibling change")-', "-T", "description").trim(),
      "",
    );
  } finally {
    jj("op", "restore", savedOp);
    await vscode.commands.executeCommand("majj.refresh");
  }
});

test("restoring selected working copy changes or a change at point with X runs jj restore", async () => {
  await setConfig("autoRefresh.mode", "off");
  const savedOp = jj("op", "log", "--no-graph", "-n", "1", "-T", "id").trim();
  const filePath = path.join(repo, "b.txt");
  fs.writeFileSync(filePath, "b1\nb2\nb3\n");
  try {
    await vscode.commands.executeCommand("majj.status");
    await waitFor("M b.txt to appear", () => statusText().includes("[ ] M b.txt"));

    const editor = vscode.window.activeTextEditor!;
    let fileLine = editor.document.getText().split("\n").indexOf("[ ] M b.txt");
    editor.selection = new vscode.Selection(fileLine, 0, fileLine, 0);
    await vscode.commands.executeCommand("majj.toggleFold");
    await waitFor("b.txt diff to expand", () => statusText().includes("[ ] +b1\n[ ] +b2\n[ ] +b3"));

    // Select +b2 with space and restore it with X (majj.restore).
    const b2Line = editor.document.getText().split("\n").indexOf("[ ] +b2");
    editor.selection = new vscode.Selection(b2Line, 0, b2Line, 0);
    await vscode.commands.executeCommand("majj.toggleSelect");
    await waitFor("+b2 selected", () => statusText().includes("[●] +b2"));
    await vscode.commands.executeCommand("majj.restore");
    await waitFor("+b2 restored", () => !statusText().includes("+b2") && statusText().includes("[ ] +b1\n[ ] +b3"));
    assert.equal(fs.readFileSync(filePath, "utf8"), "b1\nb3\n");

    // Collapse M b.txt before restoring a change in the graph.
    fileLine = editor.document.getText().split("\n").indexOf("[ ] M b.txt");
    editor.selection = new vscode.Selection(fileLine, 0, fileLine, 0);
    await vscode.commands.executeCommand("majj.toggleFold");
    await waitFor("b.txt diff to collapse", () => !statusText().includes("+b1"));

    // Restore a change in the graph (Second change) with X (`jj restore -c`).
    const lines = editor.document.getText().split("\n");
    const secondLine = lines.findIndex((l, i) => i > lines.indexOf("Changes:") && l.includes("Second change"));
    editor.selection = new vscode.Selection(secondLine, 0, secondLine, 0);
    await vscode.commands.executeCommand("majj.restore");
    await waitFor("Second change to become empty", () => statusText().includes("(empty) Second change"));

    // Undo and redo with ctrl+z (majj.undo) and ctrl+y (majj.redo).
    await vscode.commands.executeCommand("majj.undo");
    await waitFor("undo to restore Second change", () => !statusText().includes("(empty) Second change"));
    await vscode.commands.executeCommand("majj.redo");
    await waitFor("redo to empty Second change again", () => statusText().includes("(empty) Second change"));
  } finally {
    jj("op", "restore", savedOp);
    await vscode.commands.executeCommand("majj.refresh");
    await waitFor("repo restored", () => !statusText().includes("b.txt") && !statusText().includes("(empty) Second"));
  }
});

test("k on a change in status.majj abandons it with jj abandon", async () => {
  await setConfig("autoRefresh.mode", "off");
  const savedOp = jj("op", "log", "--no-graph", "-n", "1", "-T", "id").trim();
  try {
    await vscode.commands.executeCommand("majj.status");
    await waitFor("Sibling change in graph", () => statusText().includes("Sibling change"));

    const editor = vscode.window.activeTextEditor!;
    const lines = editor.document.getText().split("\n");
    const siblingLine = lines.findIndex((l, i) => i > lines.indexOf("Changes:") && l.includes("Sibling change"));
    editor.selection = new vscode.Selection(siblingLine, 0, siblingLine, 0);
    await vscode.commands.executeCommand("majj.discard");
    await waitFor("Sibling change to be abandoned", () => !statusText().includes("Sibling change"));
  } finally {
    jj("op", "restore", savedOp);
    await vscode.commands.executeCommand("majj.refresh");
    await waitFor("Sibling change restored", () => statusText().includes("Sibling change"));
  }
});

test("a absorbs the change at point, or the working copy, into the ancestors that last changed those lines", async () => {
  await setConfig("autoRefresh.mode", "off");
  const savedOp = jj("op", "log", "--no-graph", "-n", "1", "-T", "id").trim();
  const secondB = () => jj("file", "show", "-r", 'description(exact:"Second change\n")', "b.txt");
  const lineOf = (text: string) => {
    const lines = statusText().split("\n");
    return lines.findIndex((l, i) => i > lines.indexOf("Changes:") && l.includes(text));
  };
  const absorbAt = async (line: number) => {
    const editor = vscode.window.activeTextEditor!;
    editor.selection = new vscode.Selection(line, 0, line, 0);
    await vscode.commands.executeCommand("majj.absorb");
  };
  try {
    // From the working copy, with the cursor on its changes.
    fs.writeFileSync(path.join(repo, "b.txt"), "from working copy\n");
    await vscode.commands.executeCommand("majj.status");
    await waitFor("M b.txt to appear", () => statusText().includes("[ ] M b.txt"));
    await absorbAt(statusText().split("\n").indexOf("[ ] M b.txt"));
    assert.equal(secondB(), "from working copy\n");
    await waitFor("b.txt to leave the working copy", () => !statusText().includes("M b.txt"));

    // From a change in the graph.
    fs.writeFileSync(path.join(repo, "b.txt"), "from a change\n");
    jj("commit", "-m", "Absorb me");
    await vscode.commands.executeCommand("majj.status");
    await waitFor("Absorb me in graph", () => lineOf("Absorb me") >= 0);
    await absorbAt(lineOf("Absorb me"));
    assert.equal(secondB(), "from a change\n");
    const absorbed = jj("diff", "--name-only", "-r", 'description(exact:"Absorb me\n")').split("\n");
    assert.ok(!absorbed.includes("b.txt"), absorbed.join("\n"));
  } finally {
    jj("op", "restore", savedOp);
    await vscode.commands.executeCommand("majj.status");
    await waitFor("repo restored", () => !statusText().includes("b.txt") && !statusText().includes("Absorb me"));
  }
});

test("d edits the description of the change at point, or of the working copy, in the description editor", async () => {
  await setConfig("autoRefresh.mode", "off");
  const savedOp = jj("op", "log", "--no-graph", "-n", "1", "-T", "id").trim();
  const activeLanguage = () => vscode.window.activeTextEditor?.document.languageId;
  const describeAt = async (line: (lines: string[]) => number, edit: (doc: vscode.TextDocument) => vscode.TextEdit) => {
    await vscode.commands.executeCommand("majj.status");
    await waitFor("the graph", () => statusText().includes("Changes:"));
    const status = vscode.window.activeTextEditor!;
    const at = line(statusText().split("\n"));
    status.selection = new vscode.Selection(at, 0, at, 0);
    const describing = vscode.commands.executeCommand("majj.describe");
    await waitFor("the description editor", () => activeLanguage() === "jjdescription");
    const editor = vscode.window.activeTextEditor!;
    const { range, newText } = edit(editor.document);
    await editor.edit((b) => b.replace(range, newText));
    await vscode.commands.executeCommand("majj.finishEditing");
    await describing;
  };
  try {
    // A change in the graph: its description is there to edit, with its diff below.
    await describeAt(
      (lines) => lines.findIndex((l, i) => i > lines.indexOf("Changes:") && l.includes("Second change")),
      (doc) => {
        assert.match(doc.getText(), /^Second change\n[\s\S]*JJ: ignore-rest\n[\s\S]*\+b\n/);
        return vscode.TextEdit.replace(doc.lineAt(0).range, "Renamed second change");
      },
    );
    assert.equal(jj("log", "--no-graph", "-r", "@-", "-T", "description"), "Renamed second change\n");

    // The working copy, from one of its files. Clearing the description is allowed here.
    jj("describe", "-m", "To be cleared");
    await describeAt(
      (lines) => lines.indexOf("[ ] A c.txt"),
      (doc) => vscode.TextEdit.replace(doc.lineAt(0).range, ""),
    );
    assert.equal(jj("log", "--no-graph", "-r", "@", "-T", "description"), "");
  } finally {
    jj("op", "restore", savedOp);
    await vscode.commands.executeCommand("majj.status");
    await waitFor("repo restored", () => statusText().includes("Second change"));
  }
});

test("n starts a new change on the change at point, or on the working copy", async () => {
  await setConfig("autoRefresh.mode", "off");
  const savedOp = jj("op", "log", "--no-graph", "-n", "1", "-T", "id").trim();
  const log = (rev: string, template: string) => jj("log", "--no-graph", "-r", rev, "-T", template).trim();
  const newAt = async (line: (lines: string[]) => number) => {
    await vscode.commands.executeCommand("majj.status");
    await waitFor("the graph", () => statusText().includes("Changes:"));
    const at = line(statusText().split("\n"));
    vscode.window.activeTextEditor!.selection = new vscode.Selection(at, 0, at, 0);
    await vscode.commands.executeCommand("majj.new");
  };
  try {
    const workingCopy = log("@", "change_id");
    await newAt((lines) => lines.indexOf("[ ] A c.txt"));
    assert.equal(log("@-", "change_id"), workingCopy);
    assert.equal(log("@", 'empty ++ "|" ++ description'), "true|");

    await newAt((lines) => lines.findIndex((l, i) => i > lines.indexOf("Changes:") && l.includes("Second change")));
    assert.equal(log("@-", "description"), "Second change");
    assert.equal(log("@", 'empty ++ "|" ++ description'), "true|");
  } finally {
    jj("op", "restore", savedOp);
    await vscode.commands.executeCommand("majj.status");
    await waitFor("repo restored", () => statusText().includes("[ ] A c.txt"));
  }
});

test("] and [ move the working copy to the next and previous change", async () => {
  await setConfig("autoRefresh.mode", "off");
  const savedOp = jj("op", "log", "--no-graph", "-n", "1", "-T", "id").trim();
  const parent = () => jj("log", "--no-graph", "-r", "@-", "-T", "change_id").trim();
  const original = jj("log", "--no-graph", "-r", "@", "-T", "change_id").trim();
  try {
    // prev and next move relative to @-, as from an empty change on top of the work.
    jj("new");
    await vscode.commands.executeCommand("majj.status");
    await waitFor("the graph", () => statusText().includes("Changes:"));
    await vscode.commands.executeCommand("majj.next");
    assert.equal(jj("log", "--no-graph", "-r", "@-", "-T", "description").trim(), "Descendant change");
    await waitFor("the view to refresh", () => /^Parent commit \(@-\): .*Descendant change/m.test(statusText()));
    await vscode.commands.executeCommand("majj.prev");
    assert.equal(parent(), original);
  } finally {
    jj("op", "restore", savedOp);
    await vscode.commands.executeCommand("majj.status");
    await waitFor("repo restored", () => statusText().includes("[ ] A c.txt"));
  }
});

test("committing with c opens a description editor only when the working copy has no description", async () => {
  await setConfig("autoRefresh.mode", "off");
  const savedOp = jj("op", "log", "--no-graph", "-n", "1", "-T", "id").trim();
  const description = (rev: string) => jj("log", "--no-graph", "-r", rev, "-T", "description").trim();
  const isEmpty = (rev: string) => jj("log", "--no-graph", "-r", rev, "-T", "empty").trim() === "true";
  const activeLanguage = () => vscode.window.activeTextEditor?.document.languageId;
  // Returns the commit command's promise wrapped, since awaiting it waits until editing finishes.
  const startCommit = async () => {
    await vscode.commands.executeCommand("majj.status");
    const committing = vscode.commands.executeCommand("majj.commit");
    await waitFor("the description editor", () => activeLanguage() === "jjdescription");
    return { committing };
  };
  try {
    jj("describe", "-m", "");
    await vscode.commands.executeCommand("majj.status");
    await waitFor("A c.txt to appear", () => statusText().includes("[ ] A c.txt"));

    // ctrl+c ctrl+k cancels, even after editing.
    let { committing } = await startCommit();
    const draft = vscode.window.activeTextEditor!.document.getText();
    assert.match(draft, /^JJ: This commit contains the following changes:\nJJ: {5}A c\.txt$/m);
    assert.match(
      draft,
      /\nJJ: ignore-rest\nJJ: Do not modify or remove the line above\.\nJJ: Everything below it will be ignored\.\ndiff --git a\/c\.txt b\/c\.txt\n(.*\n)*?@@ -0,0 \+1,1 @@\n\+c\n/,
    );
    await vscode.window.activeTextEditor!.edit((b) => b.insert(new vscode.Position(0, 0), "Cancelled message"));
    await vscode.commands.executeCommand("majj.cancelEditing");
    await committing;
    assert.ok(!isEmpty("@"));
    assert.equal(description("@"), "");

    // Finishing without writing a description cancels too.
    ({ committing } = await startCommit());
    await vscode.commands.executeCommand("majj.finishEditing");
    await committing;
    assert.ok(!isEmpty("@"));

    // ctrl+c ctrl+c commits with the edited description.
    ({ committing } = await startCommit());
    await vscode.window.activeTextEditor!.edit((b) => b.insert(new vscode.Position(0, 0), "Committed from majj"));
    await vscode.commands.executeCommand("majj.finishEditing");
    await committing;
    assert.equal(description("@-"), "Committed from majj");
    assert.equal(description("@"), "");
    await waitFor("c.txt to leave the working copy", () => !statusText().includes("A c.txt"));
    assert.ok(!vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label.endsWith(".jjdescription"))));

    // An existing description is kept without opening the editor.
    fs.writeFileSync(path.join(repo, "described.txt"), "x\n");
    jj("describe", "-m", "Already described");
    await vscode.commands.executeCommand("majj.status");
    await vscode.commands.executeCommand("majj.commit");
    assert.notEqual(activeLanguage(), "jjdescription");
    assert.equal(description("@-"), "Already described");
    assert.ok(!isEmpty("@-"));
    assert.equal(description("@"), "");
  } finally {
    jj("op", "restore", savedOp);
    await vscode.commands.executeCommand("majj.refresh");
    await waitFor("repo restored", () => statusText().includes("[ ] A c.txt"));
  }
});

test("committing with c commits only the selected changes when there are any", async () => {
  await setConfig("autoRefresh.mode", "off");
  const savedOp = jj("op", "log", "--no-graph", "-n", "1", "-T", "id").trim();
  const changedFiles = (rev: string) => jj("diff", "-r", rev, "--name-only").trim().split("\n").sort();
  const activeLanguage = () => vscode.window.activeTextEditor?.document.languageId;
  fs.writeFileSync(path.join(repo, "b.txt"), "b1\nb2\nb3\n");
  try {
    jj("describe", "-m", "");
    await vscode.commands.executeCommand("majj.status");
    await waitFor("M b.txt to appear", () => statusText().includes("[ ] M b.txt"));
    // The editor tab replaces the status view's TextEditor, so look it up each time.
    const lineOf = (text: string) => statusText().split("\n").indexOf(text);
    const runAt = async (line: number, command: string) => {
      vscode.window.activeTextEditor!.selection = new vscode.Selection(line, 0, line, 0);
      await vscode.commands.executeCommand(command);
    };
    const select = (line: number) => runAt(line, "majj.toggleSelect");
    await runAt(lineOf("[ ] M b.txt"), "majj.toggleFold");
    await waitFor("b.txt diff to expand", () => statusText().includes("[ ] +b2"));
    await select(lineOf("[ ] +b2"));
    await waitFor("+b2 to be selected", () => statusText().includes("[●] +b2"));

    // The editor shows only the selected changes.
    const committing = vscode.commands.executeCommand("majj.commit");
    await waitFor("the description editor", () => activeLanguage() === "jjdescription");
    const diff = vscode.window.activeTextEditor!.document.getText().split("JJ: ignore-rest")[1];
    assert.ok(diff.includes("+b2") && !diff.includes("+b1") && !diff.includes("c.txt"), diff);
    await vscode.window.activeTextEditor!.edit((b) => b.insert(new vscode.Position(0, 0), "Selected line"));
    await vscode.commands.executeCommand("majj.finishEditing");
    await committing;
    assert.equal(jj("log", "--no-graph", "-r", "@-", "-T", "description").trim(), "Selected line");
    assert.equal(jj("file", "show", "-r", "@-", "b.txt"), "b\nb2\n");
    assert.ok(changedFiles("@").includes("c.txt"));
    assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "b1\nb2\nb3\n");

    // With a description already, a selected file is committed without the editor.
    jj("describe", "-m", "Selected file");
    await vscode.commands.executeCommand("majj.status");
    await waitFor("selection cleared", () => statusText().includes("[ ] A c.txt") && !statusText().includes("[●]"));
    await select(lineOf("[ ] A c.txt"));
    await waitFor("c.txt to be selected", () => statusText().includes("[●] A c.txt"));
    await vscode.commands.executeCommand("majj.commit");
    assert.equal(jj("log", "--no-graph", "-r", "@-", "-T", "description").trim(), "Selected file");
    assert.deepEqual(changedFiles("@-"), ["c.txt"]);
    assert.ok(changedFiles("@").includes("b.txt"));
  } finally {
    jj("op", "restore", savedOp);
    jj("restore", "b.txt");
    await vscode.commands.executeCommand("majj.status");
    await waitFor("repo restored", () => statusText().includes("[ ] A c.txt") && !statusText().includes("b.txt"));
  }
});

test("help command opens help.majj with the essential commands", async () => {
  await vscode.commands.executeCommand("majj.status");
  await vscode.commands.executeCommand("majj.help");
  const doc = vscode.window.activeTextEditor!.document;
  assert.equal(doc.uri.scheme, "majj");
  assert.equal(doc.uri.path, "help.majj");
  assert.equal(doc.languageId, "majj");
  await waitFor("help to load", () => doc.getText().includes("Essential commands"));
  assert.equal(
    doc.getText(),
    [
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
      "  [        move to previous change",
      "  ]        move to next change",
      "  ctrl+z   undo last operation",
      "  ctrl+y   redo last undone operation",
      "  q        exit / close majj view",
    ].join("\n"),
  );
});
