import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { StyledText } from "./ansi";
import { ChangeView } from "./changeView";
import { Decorator } from "./decorations";
import { DescriptionEditor } from "./descriptionEditor";
import { discardLines, FileDiff } from "./diff";
import { HelpView } from "./helpView";
import {
  abandon,
  absorb,
  commit,
  description,
  edit,
  findRoot,
  newChange,
  rebase,
  redo,
  restore,
  restoreChanges,
  restoreRevision,
  SelectedChanges,
  snapshot,
  split,
  squash,
  undo,
  withSelection,
} from "./jj";
import { StatusView } from "./statusView";
import { SCHEME, View } from "./view";

/** Open views by URI. */
const views = new Map<string, View>();

let activeConfirmation: { prompt: string; answer: (input: string) => void } | undefined;

export interface MajjApi {
  /** Sends keyboard input to the open input prompt. Used by tests. */
  answerConfirmation(input: string): void;
  /** The text of the open input prompt, if any. Used by tests. */
  confirmPrompt(): string | undefined;
  /** The rendered status for a workspace root, if a status view for it is open. Used by tests. */
  getStatus(root: string): StyledText | undefined;
}

export function activate(context: vscode.ExtensionContext): MajjApi {
  const decorator = new Decorator();
  const descriptionEditor = new DescriptionEditor();
  const changed = new vscode.EventEmitter<vscode.Uri>();

  const editorsFor = (view: View) =>
    vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === view.uri.toString());

  const viewFor = (uri: vscode.Uri) => views.get(uri.toString());

  const getView = (uri: vscode.Uri) => {
    let view = viewFor(uri);
    if (!view) {
      const notify = (v: View) => changed.fire(v.uri);
      if (uri.path === ChangeView.path) {
        view = new ChangeView(uri, notify);
      } else if (uri.path === HelpView.path) {
        view = new HelpView(uri, notify, context);
      } else {
        view = new StatusView(uri, notify);
      }
      views.set(uri.toString(), view);
    }
    return view;
  };

  const provider: vscode.TextDocumentContentProvider = {
    onDidChange: changed.event,
    async provideTextDocumentContent(uri) {
      // Views are created lazily here so that status tabs restored on startup work too.
      const view = getView(uri);
      if (!view.loaded) {
        await view.refresh();
      }
      return view.content.lines.join("\n");
    },
  };

  const showView = async (uri: vscode.Uri, preview: boolean, viewColumn = otherColumn()) => {
    let doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== "majj") {
      doc = await vscode.languages.setTextDocumentLanguage(doc, "majj");
    }
    await vscode.window.showTextDocument(doc, { preview, viewColumn });
  };

  const showStatus = async () => {
    const root = await resolveRoot();
    if (!root) {
      return;
    }
    const uri = StatusView.uriFor(root);
    const existing = viewFor(uri);
    await showView(uri, false, columnOf(uri) ?? otherColumn());
    // Like magit, invoking status on an already open view refreshes it.
    if (existing?.loaded) {
      await existing.refresh();
    }
  };

  // Like magit's revision buffer, change views open as a preview so that
  // visiting another change replaces the tab rather than piling them up.
  const visit = async () => {
    const editor = vscode.window.activeTextEditor;
    const view = editor && viewFor(editor.document.uri);
    if (editor && view instanceof StatusView) {
      const line = editor.selection.active.line;
      const file = view.fileAt(line);
      const change = view.changeAt(line);
      if (file && !file.deleted) {
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(view.root, file.path)), {
          viewColumn: otherColumn(),
        });
      } else if (change) {
        await showView(ChangeView.uriFor(view.root, change), true);
      }
    }
  };

  const readWorkingCopyFile = async (root: string, relPath: string): Promise<string> => {
    try {
      return await fs.readFile(await workingCopyPath(root, relPath), "utf8");
    } catch (e) {
      if (isNotFound(e)) {
        return "";
      }
      throw e;
    }
  };

  const abandonChange = async () => {
    const editor = vscode.window.activeTextEditor;
    const view = editor && viewFor(editor.document.uri);
    if (!editor || !(view instanceof StatusView)) {
      return;
    }
    const change = view.changeAt(editor.selection.active.line);
    if (!change) {
      return;
    }
    try {
      await abandon(view.root, change);
      await view.refresh();
    } catch (e) {
      void vscode.window.showErrorMessage(`majj: ${e instanceof Error ? e.message : e}`);
    }
  };

  const absorbAtPoint = async () => {
    const editor = vscode.window.activeTextEditor;
    const view = editor && viewFor(editor.document.uri);
    if (!editor || !(view instanceof StatusView)) {
      return;
    }
    try {
      await absorb(view.root, view.changeAt(editor.selection.active.line) ?? "@");
      await view.refresh();
    } catch (e) {
      void vscode.window.showErrorMessage(`majj: ${e instanceof Error ? e.message : e}`);
    }
  };

  const commitWorkingCopy = async () => {
    const editor = vscode.window.activeTextEditor;
    const view = editor && viewFor(editor.document.uri);
    if (!editor || !(view instanceof StatusView)) {
      return;
    }
    try {
      const selection = await buildSelectedChanges(view);
      if ((await description(view.root, "@")).trim()) {
        await commit(view.root, selection);
      } else if (!(await withSelection(selection, (args) => descriptionEditor.run(view.root, ["commit", ...args])))) {
        vscode.window.setStatusBarMessage("Commit canceled.", 4000);
        return;
      }
      view.clearSelection();
      await view.refresh();
    } catch (e) {
      void vscode.window.showErrorMessage(`majj: ${e instanceof Error ? e.message : e}`);
    }
  };

  const describeAtPoint = async () => {
    const editor = vscode.window.activeTextEditor;
    const view = editor && viewFor(editor.document.uri);
    if (!editor || !(view instanceof StatusView)) {
      return;
    }
    const revision = view.changeAt(editor.selection.active.line) ?? "@";
    try {
      // Unlike for a commit, clearing a description on purpose is a reasonable edit.
      if (!(await descriptionEditor.run(view.root, ["describe", revision], { allowEmpty: true }))) {
        vscode.window.setStatusBarMessage("Describe canceled.", 4000);
        return;
      }
      await view.refresh();
    } catch (e) {
      void vscode.window.showErrorMessage(`majj: ${e instanceof Error ? e.message : e}`);
    }
  };

  // Discards working copy changes at point, or abandons the change at point.
  // jj undo can reverse either, so unlike with git there's no confirmation.
  const discard = async () => {
    const editor = vscode.window.activeTextEditor;
    const view = editor && viewFor(editor.document.uri);
    if (!editor || !(view instanceof StatusView)) {
      return;
    }
    const { start, end, active, isEmpty } = editor.selection;
    const file = isEmpty ? view.fileAt(active.line) : undefined;
    try {
      if (file) {
        await restore(view.root, file.restorePaths);
        await view.refresh();
        return;
      }
      const byFile = view.discardedLinesIn(start.line, end.line);
      if (byFile.size === 0) {
        if (isEmpty) {
          await abandonChange();
        }
        return;
      }
      // Snapshots on both sides make the edit its own jj operation, which jj undo can undo.
      await snapshot(view.root);
      for (const [fileDiff, chunks] of byFile) {
        if (fileDiff.symlink) {
          await restore(view.root, diffPaths(fileDiff));
          continue;
        }
        const fullPath = await workingCopyPath(view.root, fileDiff.path);
        const current = await readWorkingCopyFile(view.root, fileDiff.path);
        const updated = discardLines(current, fileDiff, chunks);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, updated);
      }
      await snapshot(view.root);
      await view.refresh();
    } catch (e) {
      void vscode.window.showErrorMessage(`majj: ${e instanceof Error ? e.message : e}`);
    }
  };

  const editChange = async () => {
    const editor = vscode.window.activeTextEditor;
    const view = editor && viewFor(editor.document.uri);
    if (!editor || !(view instanceof StatusView)) {
      return;
    }
    const change = view.changeAt(editor.selection.active.line);
    if (!change) {
      return;
    }
    try {
      await edit(view.root, change);
      await view.refresh();
    } catch (e) {
      void vscode.window.showErrorMessage(`majj: ${e instanceof Error ? e.message : e}`);
    }
  };

  const buildSelectedChanges = async (
    view: StatusView,
    mode: "keep" | "discard" = "keep",
  ): Promise<SelectedChanges | undefined> => {
    const items = view.selectedFiles();
    if (items.length === 0) {
      return undefined;
    }
    const paths: string[] = [];
    const partialFiles = new Map<string, string>();
    for (const { wcFile, fileDiff, selected, unselected } of items) {
      paths.push(...wcFile.restorePaths);
      const toDiscard = mode === "keep" ? unselected : selected;
      // A symlink's only "lines" are its target, so it goes in whole.
      if (fileDiff && toDiscard && !fileDiff.symlink) {
        const current = await readWorkingCopyFile(view.root, wcFile.path);
        partialFiles.set(wcFile.path, discardLines(current, fileDiff, toDiscard));
      }
    }
    return { paths, partialFiles };
  };

  const splitSelected = async () => {
    const editor = vscode.window.activeTextEditor;
    const view = editor && viewFor(editor.document.uri);
    if (!editor || !(view instanceof StatusView)) {
      return;
    }
    try {
      const selection = await buildSelectedChanges(view);
      if (!selection) {
        return;
      }
      await split(view.root, selection);
      view.clearSelection();
      await view.refresh();
    } catch (e) {
      void vscode.window.showErrorMessage(`majj: ${e instanceof Error ? e.message : e}`);
    }
  };

  const squashSelected = async () => {
    const editor = vscode.window.activeTextEditor;
    const view = editor && viewFor(editor.document.uri);
    if (!editor || !(view instanceof StatusView)) {
      return;
    }
    try {
      const selection = await buildSelectedChanges(view);
      await squash(view.root, selection);
      view.clearSelection();
      await view.refresh();
    } catch (e) {
      void vscode.window.showErrorMessage(`majj: ${e instanceof Error ? e.message : e}`);
    }
  };

  const newOnChange = async () => {
    const editor = vscode.window.activeTextEditor;
    const view = editor && viewFor(editor.document.uri);
    if (!editor || !(view instanceof StatusView)) {
      return;
    }
    try {
      await newChange(view.root, view.changeAt(editor.selection.active.line) ?? "@");
      await view.refresh();
    } catch (e) {
      void vscode.window.showErrorMessage(`majj: ${e instanceof Error ? e.message : e}`);
    }
  };

  const rebaseChange = async () => {
    const editor = vscode.window.activeTextEditor;
    const view = editor && viewFor(editor.document.uri);
    if (!editor || !(view instanceof StatusView)) {
      return;
    }
    const source = view.changeAt(editor.selection.active.line) ?? "@";
    const dest = await promptInput(`Rebase ${source} onto`);
    if (!dest) {
      return;
    }
    try {
      await rebase(view.root, source, dest);
      await view.refresh();
    } catch (e) {
      void vscode.window.showErrorMessage(`majj: ${e instanceof Error ? e.message : e}`);
    }
  };

  const restoreAtPoint = async () => {
    const editor = vscode.window.activeTextEditor;
    const view = editor && viewFor(editor.document.uri);
    if (!editor || !(view instanceof StatusView)) {
      return;
    }
    try {
      const selected = await buildSelectedChanges(view, "discard");
      if (selected) {
        await restoreChanges(view.root, selected);
        view.clearSelection();
        await view.refresh();
        return;
      }
      const { start, end, active, isEmpty } = editor.selection;
      const file = isEmpty ? view.fileAt(active.line) : undefined;
      if (file) {
        await restore(view.root, file.restorePaths);
        await view.refresh();
        return;
      }
      const byFile = view.discardedLinesIn(start.line, end.line);
      if (byFile.size > 0) {
        const paths: string[] = [];
        const partialFiles = new Map<string, string>();
        for (const [fileDiff, chunks] of byFile) {
          if (fileDiff.symlink) {
            paths.push(...diffPaths(fileDiff));
            continue;
          }
          paths.push(fileDiff.path);
          const current = await readWorkingCopyFile(view.root, fileDiff.path);
          partialFiles.set(fileDiff.path, discardLines(current, fileDiff, chunks));
        }
        await restoreChanges(view.root, { paths, partialFiles });
        await view.refresh();
        return;
      }
      await restoreRevision(view.root, view.changeAt(active.line) ?? "@");
      await view.refresh();
    } catch (e) {
      void vscode.window.showErrorMessage(`majj: ${e instanceof Error ? e.message : e}`);
    }
  };

  const showHelp = async () => {
    const active = vscode.window.activeTextEditor?.document.uri;
    const root = active?.scheme === SCHEME ? active.query : ((await resolveRoot()) ?? "");
    const uri = HelpView.uriFor(root);
    const existing = viewFor(uri);
    await showView(uri, true);
    if (existing?.loaded) {
      await existing.refresh();
    }
  };

  const refresh = async () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    await (uri && viewFor(uri))?.refresh();
  };

  const toggleFold = () => {
    const editor = vscode.window.activeTextEditor;
    const view = editor && viewFor(editor.document.uri);
    if (editor && view) {
      const line = editor.selection.active.line;
      const headerLine = view.toggleFold(line);
      if (headerLine !== undefined && line > headerLine) {
        editor.selection = new vscode.Selection(headerLine, 0, headerLine, 0);
      }
    }
  };

  const toggleSelect = () => {
    const editor = vscode.window.activeTextEditor;
    const view = editor && viewFor(editor.document.uri);
    if (editor && view instanceof StatusView) {
      view.toggleSelect(editor.selection.start.line, editor.selection.end.line);
    }
  };

  const runRedo = async () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const view = uri && viewFor(uri);
    if (!view?.root) {
      return;
    }
    try {
      await redo(view.root);
      await view.refresh();
    } catch (e) {
      void vscode.window.showErrorMessage(`majj: ${e instanceof Error ? e.message : e}`);
    }
  };

  const runUndo = async () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const view = uri && viewFor(uri);
    if (!view?.root) {
      return;
    }
    try {
      await undo(view.root);
      await view.refresh();
    } catch (e) {
      void vscode.window.showErrorMessage(`majj: ${e instanceof Error ? e.message : e}`);
    }
  };

  context.subscriptions.push(
    decorator,
    descriptionEditor,
    changed,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.commands.registerCommand("majj.abandon", abandonChange),
    vscode.commands.registerCommand("majj.absorb", absorbAtPoint),
    vscode.commands.registerCommand("majj.cancelEditing", () => descriptionEditor.cancel()),
    vscode.commands.registerCommand("majj.commit", commitWorkingCopy),
    vscode.commands.registerCommand("majj.describe", describeAtPoint),
    vscode.commands.registerCommand("majj.discard", discard),
    vscode.commands.registerCommand("majj.edit", editChange),
    vscode.commands.registerCommand("majj.finishEditing", () => descriptionEditor.finish()),
    vscode.commands.registerCommand("majj.help", showHelp),
    vscode.commands.registerCommand("majj.new", newOnChange),
    vscode.commands.registerCommand("majj.rebase", rebaseChange),
    vscode.commands.registerCommand("majj.redo", runRedo),
    vscode.commands.registerCommand("majj.refresh", refresh),
    vscode.commands.registerCommand("majj.restore", restoreAtPoint),
    vscode.commands.registerCommand("majj.split", splitSelected),
    vscode.commands.registerCommand("majj.squash", squashSelected),
    vscode.commands.registerCommand("majj.status", showStatus),
    vscode.commands.registerCommand("majj.toggleFold", toggleFold),
    vscode.commands.registerCommand("majj.toggleSelect", toggleSelect),
    vscode.commands.registerCommand("majj.undo", runUndo),
    vscode.commands.registerCommand("majj.visit", visit),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const view = viewFor(e.document.uri);
      if (view) {
        for (const editor of editorsFor(view)) {
          decorator.apply(editor, view.content);
        }
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        const view = viewFor(editor.document.uri);
        if (view) {
          decorator.apply(editor, view.content);
          view.onDidBecomeVisible();
        }
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      viewFor(doc.uri)?.dispose();
      views.delete(doc.uri.toString());
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("majj")) {
        for (const view of views.values()) {
          view.configure();
          view.requestRefresh();
        }
      }
    }),
    { dispose: () => views.forEach((view) => view.dispose()) },
  );

  return {
    answerConfirmation: (input) => activeConfirmation?.answer(input),
    confirmPrompt: () => activeConfirmation?.prompt,
    getStatus: (root) => viewFor(StatusView.uriFor(root))?.content,
  };
}

function promptInput(prompt: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const inputBox = vscode.window.createInputBox();
    inputBox.prompt = prompt;

    const finish = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      activeConfirmation = undefined;
      inputBox.hide();
      resolve(value?.trim() || undefined);
    };

    activeConfirmation = { prompt, answer: finish };
    const acceptSub = inputBox.onDidAccept(() => finish(inputBox.value));
    const hideSub = inputBox.onDidHide(() => {
      acceptSub.dispose();
      hideSub.dispose();
      inputBox.dispose();
      finish(undefined);
    });

    inputBox.show();
  });
}

/** Both paths of a renamed or copied file, or else its one path. */
function diffPaths(fileDiff: FileDiff): string[] {
  return fileDiff.from ? [fileDiff.from, fileDiff.path] : [fileDiff.path];
}

function isNotFound(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The full path of a working copy file to read or write its lines. Refuses
 * a path that is or goes through a symlink, which could point outside the
 * workspace.
 */
async function workingCopyPath(root: string, relPath: string): Promise<string> {
  const fullPath = path.join(root, relPath);
  let current = root;
  for (const part of relPath.split(/[\\/]/)) {
    current = path.join(current, part);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch (e) {
      if (isNotFound(e)) {
        break;
      }
      throw e;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${relPath} is a symlink or inside one`);
    }
  }
  return fullPath;
}

/**
 * Open views and files in an editor group other than the active one: the first
 * group, or the second if the first is active. With only one group, this splits
 * the editor.
 */
function otherColumn(): vscode.ViewColumn {
  const active = vscode.window.tabGroups.activeTabGroup.viewColumn;
  return active > vscode.ViewColumn.One ? vscode.ViewColumn.One : vscode.ViewColumn.Two;
}

/** The editor group with a tab for uri, if any. */
function columnOf(uri: vscode.Uri): vscode.ViewColumn | undefined {
  return vscode.window.tabGroups.all.find((group) =>
    group.tabs.some((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()),
  )?.viewColumn;
}

/**
 * The jj workspace of the active editor, or else of the first workspace folder
 * that is in one. If there is none, the directory to explain that for: the
 * workspace folder of the active file, the file's directory, or else the first
 * workspace folder.
 */
async function resolveRoot(): Promise<string | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === SCHEME) {
    return active.query;
  }
  const candidates: string[] = [];
  if (active?.scheme === "file") {
    candidates.push(path.dirname(active.fsPath));
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === "file") {
      candidates.push(folder.uri.fsPath);
    }
  }
  for (const dir of candidates) {
    try {
      return await findRoot(dir);
    } catch {
      // Try the next candidate.
    }
  }
  const activeFolder = active && vscode.workspace.getWorkspaceFolder(active);
  if (activeFolder?.uri.scheme === "file") {
    return activeFolder.uri.fsPath;
  }
  if (candidates.length === 0) {
    void vscode.window.showErrorMessage("majj: open a file or folder to show its jj status");
  }
  return candidates[0];
}

export function deactivate() {}
