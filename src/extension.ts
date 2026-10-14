import * as path from "path";
import * as vscode from "vscode";
import { StyledText } from "./ansi";
import { Decorator } from "./decorations";
import { findRoot } from "./jj";
import { StatusView } from "./statusView";

/** Status views by workspace root. */
const views = new Map<string, StatusView>();

export interface MajjApi {
  /** The rendered status for a workspace root, if a status view for it is open. Used by tests. */
  getStatus(root: string): StyledText | undefined;
}

export function activate(context: vscode.ExtensionContext): MajjApi {
  const decorator = new Decorator();
  const changed = new vscode.EventEmitter<vscode.Uri>();

  const editorsFor = (view: StatusView) =>
    vscode.window.visibleTextEditors.filter(
      (e) => e.document.uri.toString() === view.uri.toString(),
    );

  const viewFor = (uri: vscode.Uri) =>
    uri.scheme === StatusView.scheme ? views.get(uri.query) : undefined;

  const getView = (root: string) => {
    let view = views.get(root);
    if (!view) {
      view = new StatusView(root, (v) => changed.fire(v.uri));
      views.set(root, view);
    }
    return view;
  };

  const provider: vscode.TextDocumentContentProvider = {
    onDidChange: changed.event,
    async provideTextDocumentContent(uri) {
      // Views are created lazily here so that status tabs restored on startup work too.
      const view = getView(uri.query);
      if (!view.loaded) {
        await view.refresh();
      }
      return view.content.lines.join("\n");
    },
  };

  const showStatus = async () => {
    const root = await resolveRoot();
    if (!root) {
      return;
    }
    const existing = views.get(root);
    let doc = await vscode.workspace.openTextDocument(StatusView.uriFor(root));
    if (doc.languageId !== "majj") {
      doc = await vscode.languages.setTextDocumentLanguage(doc, "majj");
    }
    await vscode.window.showTextDocument(doc, { preview: false });
    // Like magit, invoking status on an already open view refreshes it.
    if (existing?.loaded) {
      await existing.refresh();
    }
  };

  const refresh = async () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    await (uri && viewFor(uri))?.refresh();
  };

  context.subscriptions.push(
    decorator,
    changed,
    vscode.workspace.registerTextDocumentContentProvider(
      StatusView.scheme,
      provider,
    ),
    vscode.commands.registerCommand("majj.status", showStatus),
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
      if (doc.uri.scheme === StatusView.scheme) {
        views.get(doc.uri.query)?.dispose();
        views.delete(doc.uri.query);
      }
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

  return { getStatus: (root) => views.get(root)?.content };
}

/** The jj workspace of the active editor, or else of the first workspace folder that is in one. */
async function resolveRoot(): Promise<string | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === StatusView.scheme) {
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
  let lastError: unknown;
  for (const dir of candidates) {
    try {
      return await findRoot(dir);
    } catch (e) {
      lastError = e;
    }
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  void vscode.window.showErrorMessage(
    `majj: no jj repository found for the active file or workspace${detail}`,
  );
  return undefined;
}

export function deactivate() {}
