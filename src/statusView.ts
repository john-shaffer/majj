import * as vscode from "vscode";
import { stripAnsi, Style, StyledText, StyledTextBuilder } from "./ansi";
import { getConfig } from "./config";
import { configGet, JjError, runJj } from "./jj";
import { appendError, SCHEME, View } from "./view";
import { workingCopyFiles } from "./workingCopy";

const HEADER: Style = { bold: true };
const NO_REPO = /There is no jj repo in/;

// Each log entry starts with its change ID between \x1e and \x1f, so that
// lines can be mapped to changes whatever the user's log template looks like.
// A divergent change ID is ambiguous, so those entries use their commit ID.
const MARK = /\x1e([^\x1f]*)\x1f/;
const markedTemplate = (template: string) =>
  `"\\x1e" ++ stringify(if(divergent, commit_id, change_id)) ++ "\\x1f" ++ (${template})`;

export interface Status {
  text: StyledText;
  /** The change shown on each line of the change graph, by line index. */
  changes: Map<number, string>;
  /** The working copy file shown on each line of jj's status, relative to the root. */
  files: Map<number, string>;
}

export async function renderStatus(root: string): Promise<Status> {
  const { limit, recentChanges, revset } = getConfig();
  const out = new StyledTextBuilder();
  const changes = new Map<number, string>();
  let files = new Map<number, string>();
  try {
    // `jj status` snapshots the working copy, so the log can skip doing it again.
    const [status, logRevset, logTemplate] = await Promise.all([
      runJj(root, ["status"], { color: true }),
      revset || graphRevset(root, recentChanges),
      configGet(root, "templates.log"),
    ]);
    const logArgs = ["log", "--ignore-working-copy", "-T", markedTemplate(logTemplate)];
    if (logRevset) {
      logArgs.push("-r", logRevset);
    }
    if (limit > 0) {
      logArgs.push("--limit", String(limit));
    }
    const log = await runJj(root, logArgs, { color: true });

    // The status starts the view, so its line indexes are the view's.
    files = workingCopyFiles(stripAnsi(status));
    out.appendAnsi(status).separate();
    out.append("Changes:", HEADER);
    if (revset) {
      out.append(` ${revset}`);
    }
    out.newline();
    let change: string | undefined;
    for (const line of log.split("\n")) {
      const mark = MARK.exec(line);
      change = mark?.[1] ?? change;
      if (change) {
        changes.set(out.line, change);
      }
      out.appendAnsi(mark ? line.replace(mark[0], "") : line).newline();
    }
  } catch (e) {
    if (e instanceof JjError && NO_REPO.test(e.message)) {
      out.append(`No jj repository in ${root}`, HEADER).separate();
      out.appendAnsi(e.output).separate();
      out.append("Create one with `jj git init`, then press g to refresh.");
    } else {
      appendError(out, e);
    }
  }
  return { text: out.build(), changes, files };
}

/**
 * jj's default log revset, plus the working copy's last `recentChanges`
 * ancestors. Like magit's recent commits, they give the graph some context
 * when everything is pushed and the default revset shows little else.
 */
async function graphRevset(root: string, recentChanges: number): Promise<string | undefined> {
  if (recentChanges <= 0) {
    return undefined;
  }
  const logRevset = await configGet(root, "revsets.log");
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

  private changes = new Map<number, string>();
  private files = new Map<number, string>();

  /** The ID of the change shown on a line of the change graph. */
  changeAt(line: number): string | undefined {
    return this.changes.get(line);
  }

  /** The working copy file shown on a line, relative to the root. */
  fileAt(line: number): string | undefined {
    return this.files.get(line);
  }

  protected async render(): Promise<StyledText> {
    const { text, changes, files } = await renderStatus(this.root);
    this.changes = changes;
    this.files = files;
    return text;
  }
}
