import * as vscode from "vscode";
import { Style, StyledText, StyledTextBuilder } from "./ansi";
import { AutoRefresh } from "./autoRefresh";
import { getConfig } from "./config";
import { JjError } from "./jj";

/** The URI scheme of majj's virtual documents. Their query is the workspace root. */
export const SCHEME = "majj";

const ERROR: Style = { bold: true, fg: { kind: "ansi", index: 1 } };

export function appendError(out: StyledTextBuilder, e: unknown) {
  out.append("jj failed:", ERROR).newline();
  if (e instanceof JjError) {
    out.appendAnsi(e.output);
  } else {
    out.append(String(e));
  }
}

/** A virtual document rendered from jj output, kept up to date while it is visible. */
export abstract class View implements vscode.Disposable {
  content: StyledText = { lines: ["Loading…"], spans: [] };
  loaded = false;
  /** An auto refresh was skipped while the view was hidden. */
  private stale = false;
  private running?: Promise<void>;
  private rerun = false;
  private autoRefresh: AutoRefresh;

  constructor(
    readonly uri: vscode.Uri,
    private readonly onDidUpdate: (view: View) => void,
  ) {
    this.autoRefresh = new AutoRefresh(this.root, () => this.requestRefresh());
    this.configure();
  }

  get root(): string {
    return this.uri.query;
  }

  configure() {
    const { autoRefreshMode, pollIntervalSeconds } = getConfig();
    this.autoRefresh.start(autoRefreshMode, pollIntervalSeconds);
  }

  /** Re-runs jj. Requests made while a refresh is running are coalesced into one more run. */
  refresh(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.stale = false;
    this.running = (async () => {
      do {
        this.rerun = false;
        this.content = await this.render();
      } while (this.rerun);
    })().finally(() => {
      this.running = undefined;
      this.loaded = true;
      this.onDidUpdate(this);
    });
    return this.running;
  }

  /** Refreshes now if the view is on screen, otherwise when it next becomes visible. */
  requestRefresh() {
    if (this.isVisible()) {
      void this.refresh();
    } else {
      this.stale = true;
    }
  }

  onDidBecomeVisible() {
    if (this.stale) {
      void this.refresh();
    }
  }

  private isVisible(): boolean {
    return vscode.window.visibleTextEditors.some(
      (e) => e.document.uri.toString() === this.uri.toString(),
    );
  }

  protected abstract render(): Promise<StyledText>;

  dispose() {
    this.autoRefresh.dispose();
  }
}
