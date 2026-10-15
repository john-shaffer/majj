import * as path from "path";
import * as vscode from "vscode";
import { StyledText } from "./ansi";
import { ChangeView } from "./changeView";
import { Decorator } from "./decorations";
import { findRoot } from "./jj";
import { StatusView } from "./statusView";
import { SCHEME, View } from "./view";

/** Open views by URI. */
const views = new Map<string, View>();

export interface MajjApi {
  /** The rendered status for a workspace root, if a status view for it is open. Used by tests. */
  getStatus(root: string): StyledText | undefined;
}

export function activate(context: vscode.ExtensionContext): MajjApi {
  const decorator = new Decorator();
  const changed = new vscode.EventEmitter<vscode.Uri>();

  const editorsFor = (view: View) =>
    vscode.window.visibleTextEditors.filter(
      (e) => e.document.uri.toString() === view.uri.toString(),
    );

  const viewFor = (uri: vscode.Uri) => views.get(uri.toString());

  const getView = (uri: vscode.Uri) => {
    let view = viewFor(uri);
    if (!view) {
      const ViewClass = uri.path === ChangeView.path ? ChangeView : StatusView;
      view = new ViewClass(uri, (v) => changed.fire(v.uri));
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

  const showView = async (uri: vscode.Uri, preview: boolean) => {
    let doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== "majj") {
      doc = await vscode.languages.setTextDocumentLanguage(doc, "majj");
    }
    await vscode.window.showTextDocument(doc, { preview });
  };

  const showStatus = async () => {
    const root = await resolveRoot();
    if (!root) {
      return;
    }
    const uri = StatusView.uriFor(root);
    const existing = viewFor(uri);
    await showView(uri, false);
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
      const change = view.changeAt(editor.selection.active.line);
      if (change) {
        await showView(ChangeView.uriFor(view.root, change), true);
      }
    }
  };

  const refresh = async () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    await (uri && viewFor(uri))?.refresh();
  };

  context.subscriptions.push(
    decorator,
    changed,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.commands.registerCommand("majj.status", showStatus),
    vscode.commands.registerCommand("majj.visit", visit),
    vscode.commands.registerCommand("majj.refresh", refresh),
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

  return { getStatus: (root) => viewFor(StatusView.uriFor(root))?.content };
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
    void vscode.window.showErrorMessage(
      "majj: open a file or folder to show its jj status",
    );
  }
  return candidates[0];
}

export function deactivate() {}
