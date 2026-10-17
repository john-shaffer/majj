import * as vscode from "vscode";
import { stripAnsi, Style, StyledText, StyledTextBuilder } from "./ansi";
import { getConfig } from "./config";
import { appendFileDiff, FileSpan, parseFiles } from "./diff";
import { configGet, JjError, runJj } from "./jj";
import { appendError, SCHEME, View } from "./view";
import { WorkingCopyFile, workingCopyFiles } from "./workingCopy";

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
  /** The working copy file shown on each filename line of jj's status, relative to the root. */
  files: Map<number, WorkingCopyFile>;
  /** The foldable working copy file section on each line (filename and expanded diff), by line index. */
  fileSpans: Map<number, FileSpan>;
}

interface StatusData {
  status: string;
  diff: string;
  log: string;
  revset: string;
}

export function formatStatus(data: StatusData, expandedFiles: ReadonlySet<string> = new Set()): Status {
  const out = new StyledTextBuilder();
  const changes = new Map<number, string>();
  const files = new Map<number, WorkingCopyFile>();
  const fileSpans = new Map<number, FileSpan>();
  const rawFiles = workingCopyFiles(stripAnsi(data.status));
  const diffs = new Map(parseFiles(data.diff.split("\n")).map((f) => [f.path, f]));

  const statusLines = data.status.trimEnd().split("\n");
  for (let i = 0; i < statusLines.length; i++) {
    const wcFile = rawFiles.get(i);
    const headerLine = out.line;
    out.appendAnsi(statusLines[i]).newline();
    if (wcFile) {
      files.set(headerLine, wcFile);
      const fileDiff = diffs.get(wcFile.path);
      if (expandedFiles.has(wcFile.path) && fileDiff) {
        appendFileDiff(out, fileDiff);
      }
      for (let l = headerLine; l < out.line; l++) {
        fileSpans.set(l, { path: wcFile.path, headerLine });
      }
    }
  }
  out.separate();
  out.append("Changes:", HEADER);
  if (data.revset) {
    out.append(` ${data.revset}`);
  }
  out.newline();
  let change: string | undefined;
  for (const line of data.log.split("\n")) {
    const mark = MARK.exec(line);
    change = mark?.[1] ?? change;
    if (change) {
      changes.set(out.line, change);
    }
    out.appendAnsi(mark ? line.replace(mark[0], "") : line).newline();
  }
  return { text: out.build(), changes, files, fileSpans };
}

async function fetchStatusData(root: string): Promise<StatusData> {
  const { limit, recentChanges, revset } = getConfig();
  // `jj status` snapshots the working copy, so diff and log can skip doing it again.
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
  const hasFiles = workingCopyFiles(stripAnsi(status)).size > 0;
  const [log, diff] = await Promise.all([
    runJj(root, logArgs, { color: true }),
    hasFiles ? runJj(root, ["diff", "--git", "--ignore-working-copy"], { color: true }) : Promise.resolve(""),
  ]);
  return { status, diff, log, revset };
}

export async function renderStatus(root: string, expandedFiles: ReadonlySet<string> = new Set()): Promise<Status> {
  try {
    return formatStatus(await fetchStatusData(root), expandedFiles);
  } catch (e) {
    return errorStatus(root, e);
  }
}

function errorStatus(root: string, e: unknown): Status {
  const out = new StyledTextBuilder();
  if (e instanceof JjError && NO_REPO.test(e.message)) {
    out.append(`No jj repository in ${root}`, HEADER).separate();
    out.appendAnsi(e.output).separate();
    out.append("Create one with `jj git init`, then press g to refresh.");
  } else {
    appendError(out, e);
  }
  return {
    text: out.build(),
    changes: new Map(),
    files: new Map(),
    fileSpans: new Map(),
  };
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

  private raw?: StatusData;
  private expandedFiles = new Set<string>();
  private changes = new Map<number, string>();
  private files = new Map<number, WorkingCopyFile>();
  private fileSpans = new Map<number, FileSpan>();

  /** The ID of the change shown on a line of the change graph. */
  changeAt(line: number): string | undefined {
    return this.changes.get(line);
  }

  /** The working copy file shown on a line, relative to the root. */
  fileAt(line: number): WorkingCopyFile | undefined {
    return this.files.get(line);
  }

  override toggleFold(line: number): number | undefined {
    const span = this.fileSpans.get(line);
    if (!span || !this.raw) {
      return undefined;
    }
    if (this.expandedFiles.has(span.path)) {
      this.expandedFiles.delete(span.path);
    } else {
      this.expandedFiles.add(span.path);
    }
    this.update(this.applyStatus(formatStatus(this.raw, this.expandedFiles)));
    return span.headerLine;
  }

  private applyStatus({ text, changes, files, fileSpans }: Status): StyledText {
    this.changes = changes;
    this.files = files;
    this.fileSpans = fileSpans;
    return text;
  }

  protected async render(): Promise<StyledText> {
    try {
      this.raw = await fetchStatusData(this.root);
      return this.applyStatus(formatStatus(this.raw, this.expandedFiles));
    } catch (e) {
      this.raw = undefined;
      return this.applyStatus(errorStatus(this.root, e));
    }
  }
}
