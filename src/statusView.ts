import * as vscode from "vscode";
import { Style, StyledText, StyledTextBuilder } from "./ansi";
import { AutoRefresh } from "./autoRefresh";
import { getConfig } from "./config";
import { JjError, runJj } from "./jj";

const HEADER: Style = { bold: true };
const ERROR: Style = { bold: true, fg: { kind: "ansi", index: 1 } };

export async function renderStatus(root: string): Promise<StyledText> {
  const { limit, recentChanges, revset } = getConfig();
  const out = new StyledTextBuilder();
  try {
    // `jj status` snapshots the working copy, so the log can skip doing it again.
    const [status, logRevset] = await Promise.all([
      runJj(root, ["status"], { color: true }),
      revset || graphRevset(root, recentChanges),
    ]);
    const logArgs = ["log", "--ignore-working-copy"];
    if (logRevset) {
      logArgs.push("-r", logRevset);
    }
    if (limit > 0) {
      logArgs.push("--limit", String(limit));
    }
    const log = await runJj(root, logArgs, { color: true });

    out.appendAnsi(status).separate();
    out.append("Changes:", HEADER);
    if (revset) {
      out.append(` ${revset}`);
    }
    out.newline().appendAnsi(log);
  } catch (e) {
    out.append("jj failed:", ERROR).newline();
    if (e instanceof JjError) {
      out.appendAnsi(e.output);
    } else {
      out.append(String(e));
    }
  }
  return out.build();
}

/**
 * jj's default log revset, plus the working copy's last `recentChanges`
 * ancestors. Like magit's recent commits, they give the graph some context
 * when everything is pushed and the default revset shows little else.
 */
async function graphRevset(
  root: string,
  recentChanges: number,
): Promise<string | undefined> {
  if (recentChanges <= 0) {
    return undefined;
  }
  const logRevset = (
    await runJj(root, ["config", "get", "revsets.log"])
  ).trim();
  return `(${logRevset}) | ancestors(@, ${recentChanges + 1})`;
}

/** The status buffer for one jj workspace, shown as the virtual document `majj:status.majj?<root>`. */
export class StatusView implements vscode.Disposable {
  static readonly scheme = "majj";

  static uriFor(root: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: StatusView.scheme,
      path: "status.majj",
      query: root,
    });
  }

  readonly uri: vscode.Uri;
  content: StyledText = { lines: ["Loading…"], spans: [] };
  loaded = false;
  /** An auto refresh was skipped while the view was hidden. */
  private stale = false;
  private running?: Promise<void>;
  private rerun = false;
  private autoRefresh: AutoRefresh;

  constructor(
    readonly root: string,
    private readonly onDidUpdate: (view: StatusView) => void,
  ) {
    this.uri = StatusView.uriFor(root);
    this.autoRefresh = new AutoRefresh(root, () => this.requestRefresh());
    this.configure();
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
        this.content = await renderStatus(this.root);
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

  dispose() {
    this.autoRefresh.dispose();
  }
}
