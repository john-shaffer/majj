import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { AutoRefreshMode } from "./config";
import { repoDir } from "./jj";

const DEBOUNCE_MS = 200;

/**
 * jj has no command to subscribe to repository changes (its fsmonitor/watchman
 * support only speeds up snapshotting), so "watch" mode watches the files jj
 * itself uses instead:
 *  - `.jj/repo/op_heads/heads` changes whenever any jj operation completes,
 *    whether it came from majj, the CLI, or another tool.
 *  - working copy files: jj only notices edits when it snapshots, which the
 *    status refresh does, so file changes trigger a refresh as well.
 * A refresh that snapshots new edits creates an operation, which triggers one
 * more refresh; that one finds nothing new, so it settles.
 */
export class AutoRefresh implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly root: string,
    private readonly trigger: () => void,
  ) {}

  start(mode: AutoRefreshMode, pollIntervalSeconds: number) {
    this.dispose();
    if (mode === "poll") {
      const timer = setInterval(this.trigger, pollIntervalSeconds * 1000);
      this.disposables.push({ dispose: () => clearInterval(timer) });
    } else if (mode === "watch") {
      this.watch();
    }
  }

  private watch() {
    let timer: NodeJS.Timeout | undefined;
    const debounced = () => {
      clearTimeout(timer);
      timer = setTimeout(this.trigger, DEBOUNCE_MS);
    };
    this.disposables.push({ dispose: () => clearTimeout(timer) });

    try {
      const opHeads = fs.watch(
        path.join(repoDir(this.root), "op_heads", "heads"),
        debounced,
      );
      opHeads.on("error", () => opHeads.close());
      this.disposables.push({ dispose: () => opHeads.close() });
    } catch (e) {
      console.warn(`majj: cannot watch jj operations in ${this.root}:`, e);
    }

    const files = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(this.root), "**/*"),
    );
    const onFile = (uri: vscode.Uri) => {
      // jj's own bookkeeping (and git's, in colocated repos) changes on every refresh.
      const first = path.relative(this.root, uri.fsPath).split(path.sep)[0];
      if (first !== ".jj" && first !== ".git") {
        debounced();
      }
    };
    this.disposables.push(
      files,
      files.onDidCreate(onFile),
      files.onDidChange(onFile),
      files.onDidDelete(onFile),
    );
  }

  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
