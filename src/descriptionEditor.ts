import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { runJj } from "./jj";

/**
 * Edits descriptions for jj in VS Code tabs. jj's editor is set to
 * editorHelper.js, run by this extension host's own executable, so it works
 * the same whatever the editor's binary is called and needs no CLI.
 */
export class DescriptionEditor implements vscode.Disposable {
  /** Open descriptions by URI, resolved with whether to let jj use them. */
  private readonly sessions = new Map<string, (finished: boolean) => void>();
  private readonly tabListener = vscode.window.tabGroups.onDidChangeTabs((e) => {
    // Like closing the editor jj waits on, closing the tab finishes with what was saved.
    for (const tab of e.closed) {
      if (tab.input instanceof vscode.TabInputText) {
        this.sessions.get(tab.input.uri.toString())?.(true);
      }
    }
  });

  /**
   * Runs jj with `args`, editing any description jj asks for in a tab.
   * Resolves to false if the edit was cancelled.
   */
  async run(cwd: string, args: string[]): Promise<boolean> {
    let socketDir: string | undefined;
    let socketPath: string;
    if (process.platform === "win32") {
      socketPath = `\\\\.\\pipe\\majj-editor-${randomUUID()}`;
    } else {
      socketDir = await fs.mkdtemp(path.join(os.tmpdir(), "majj-editor-"));
      socketPath = path.join(socketDir, "socket");
    }
    let cancelled = false;
    const server = net.createServer((connection) => {
      let request = "";
      connection.setEncoding("utf8");
      const onData = async (data: string) => {
        request += data;
        const end = request.indexOf("\n");
        if (end < 0) {
          return;
        }
        connection.off("data", onData);
        let finished = false;
        try {
          finished = await this.edit(vscode.Uri.file(request.slice(0, end)));
        } catch (e) {
          // Reply anyway, or jj would wait forever.
          void vscode.window.showErrorMessage(`majj: ${e instanceof Error ? e.message : e}`);
        }
        cancelled ||= !finished;
        connection.end(finished ? "finish\n" : "cancel\n");
      };
      connection.on("data", onData);
    });
    try {
      await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
      const editor = JSON.stringify([process.execPath, path.join(__dirname, "editorHelper.js")]);
      await runJj(cwd, ["--config", `ui.editor=${editor}`, ...args], {
        env: { ELECTRON_RUN_AS_NODE: "1", MAJJ_EDITOR_SOCKET: socketPath },
      });
      return true;
    } catch (e) {
      if (cancelled) {
        return false;
      }
      throw e;
    } finally {
      server.close();
      if (socketDir) {
        await fs.rm(socketDir, { recursive: true, force: true });
      }
    }
  }

  /** Saves and closes the active description, letting jj use it. */
  async finish(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await editor.document.save();
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
  }

  /** Closes the active description without saving it, making jj abort. */
  async cancel(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri) {
      this.sessions.get(uri.toString())?.(false);
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    }
  }

  private async edit(uri: vscode.Uri): Promise<boolean> {
    const hint = vscode.window.setStatusBarMessage("Type C-c C-c to finish, or C-c C-k to cancel");
    try {
      const done = new Promise<boolean>((resolve) => this.sessions.set(uri.toString(), resolve));
      const editor = await vscode.window.showTextDocument(uri, { preview: false });
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      if (!(await done)) {
        return false;
      }
      // jj would otherwise go ahead with an empty description.
      const saved = await fs.readFile(uri.fsPath, "utf8");
      return saved.split("\n").some((line) => !line.startsWith("JJ:") && line.trim() !== "");
    } finally {
      hint.dispose();
      this.sessions.delete(uri.toString());
    }
  }

  dispose() {
    this.tabListener.dispose();
    for (const resolve of this.sessions.values()) {
      resolve(false);
    }
  }
}
