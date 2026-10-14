import * as vscode from "vscode";
import { Style, StyledText, StyledTextBuilder } from "./ansi";
import { getConfig } from "./config";
import { JjError, runJj } from "./jj";

const HEADER: Style = { bold: true };
const ERROR: Style = { bold: true, fg: { kind: "ansi", index: 1 } };

export async function renderStatus(root: string): Promise<StyledText> {
  const { revset, limit } = getConfig();
  const out = new StyledTextBuilder();
  try {
    // `jj status` snapshots the working copy, so the log can skip doing it again.
    const status = await runJj(root, ["status"], { color: true });
    const logArgs = ["log", "--ignore-working-copy"];
    if (revset) {
      logArgs.push("-r", revset);
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

/** The status buffer for one jj workspace, shown as the virtual document `majj:status.majj?<root>`. */
export class StatusView {
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
  private running?: Promise<void>;
  private rerun = false;

  constructor(
    readonly root: string,
    private readonly onDidUpdate: (view: StatusView) => void,
  ) {
    this.uri = StatusView.uriFor(root);
  }

  /** Re-runs jj. Requests made while a refresh is running are coalesced into one more run. */
  refresh(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
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
}
