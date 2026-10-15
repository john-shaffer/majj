import * as vscode from "vscode";
import { Style, StyledText, StyledTextBuilder } from "./ansi";
import { getConfig } from "./config";
import { JjError, runJj } from "./jj";
import { SCHEME, View } from "./view";

const HEADER: Style = { bold: true };
const ERROR: Style = { bold: true, fg: { kind: "ansi", index: 1 } };
const NO_REPO = /There is no jj repo in/;

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
    if (e instanceof JjError && NO_REPO.test(e.message)) {
      out.append(`No jj repository in ${root}`, HEADER).separate();
      out.appendAnsi(e.output).separate();
      out.append("Create one with `jj git init`, then press g to refresh.");
      return out.build();
    }
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
export class StatusView extends View {
  static readonly path = "status.majj";

  static uriFor(root: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: SCHEME,
      path: StatusView.path,
      query: root,
    });
  }

  constructor(root: string, onDidUpdate: (view: View) => void) {
    super(StatusView.uriFor(root), onDidUpdate);
  }

  protected render(): Promise<StyledText> {
    return renderStatus(this.root);
  }
}
