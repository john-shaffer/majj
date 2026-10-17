import * as vscode from "vscode";
import { stripAnsi, Style, StyledText, StyledTextBuilder } from "./ansi";
import { getConfig } from "./config";
import { appendFileDiff, DiffLine, FileDiff, FoldSpan, parseFiles } from "./diff";
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
  /** The foldable file or chunk section on each line of the working copy changes, by line index. */
  foldSpans: Map<number, FoldSpan>;
  /** The rendered diff chunk or line at each expanded working copy diff line, by line index. */
  diffLines: Map<number, DiffLine>;
}

interface StatusData {
  status: string;
  diff: string;
  log: string;
  revset: string;
}

export function formatStatus(
  data: StatusData,
  expandedFiles: ReadonlySet<string> = new Set(),
  collapsedChunks: ReadonlySet<string> = new Set(),
): Status {
  const out = new StyledTextBuilder();
  const changes = new Map<number, string>();
  const files = new Map<number, WorkingCopyFile>();
  const foldSpans = new Map<number, FoldSpan>();
  const diffLines = new Map<number, DiffLine>();
  const rawFiles = workingCopyFiles(stripAnsi(data.status));
  const diffs = new Map(parseFiles(data.diff.split("\n")).map((f) => [f.path, f]));

  const statusLines = data.status.trimEnd().split("\n");
  const isCommitLine = (i: number) => /^(Working copy\s+\(|Parent commit\b)/.test(stripAnsi(statusLines[i]));
  for (let i = 0; i < statusLines.length; i++) {
    if (isCommitLine(i)) {
      out.appendAnsi(statusLines[i]).newline();
    }
  }
  out.separate();
  for (let i = 0; i < statusLines.length; i++) {
    if (isCommitLine(i)) {
      continue;
    }
    const wcFile = rawFiles.get(i);
    const headerLine = out.line;
    out.appendAnsi(statusLines[i]).newline();
    if (wcFile) {
      files.set(headerLine, wcFile);
      foldSpans.set(headerLine, { kind: "file", key: wcFile.path, headerLine });
      const fileDiff = diffs.get(wcFile.path);
      if (expandedFiles.has(wcFile.path) && fileDiff) {
        appendFileDiff(out, fileDiff, headerLine, foldSpans, collapsedChunks, diffLines);
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
  return { text: out.build(), changes, files, foldSpans, diffLines };
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

export async function renderStatus(
  root: string,
  expandedFiles: ReadonlySet<string> = new Set(),
  collapsedChunks: ReadonlySet<string> = new Set(),
): Promise<Status> {
  try {
    return formatStatus(await fetchStatusData(root), expandedFiles, collapsedChunks);
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
    foldSpans: new Map(),
    diffLines: new Map(),
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
  private collapsedChunks = new Set<string>();
  private changes = new Map<number, string>();
  private files = new Map<number, WorkingCopyFile>();
  private foldSpans = new Map<number, FoldSpan>();
  private diffLines = new Map<number, DiffLine>();

  /** The ID of the change shown on a line of the change graph. */
  changeAt(line: number): string | undefined {
    return this.changes.get(line);
  }

  /** The working copy file shown on a line, relative to the root. */
  fileAt(line: number): WorkingCopyFile | undefined {
    return this.files.get(line);
  }

  /**
   * The changed diff lines (`+` or `-`) within `[startLine, endLine]`, grouped
   * by file and chunk index. A single cursor on a `@@ ... @@` chunk header
   * selects all changed lines in that chunk.
   */
  discardedLinesIn(startLine: number, endLine: number): Map<FileDiff, Map<number, Set<number>>> {
    const result = new Map<FileDiff, Map<number, Set<number>>>();
    const add = (file: FileDiff, chunkIndex: number, lineIndex: number) => {
      let chunks = result.get(file);
      if (!chunks) {
        result.set(file, (chunks = new Map()));
      }
      let lines = chunks.get(chunkIndex);
      if (!lines) {
        chunks.set(chunkIndex, (lines = new Set()));
      }
      lines.add(lineIndex);
    };
    if (startLine === endLine) {
      const dl = this.diffLines.get(startLine);
      if (dl && dl.lineIndex === undefined) {
        const chunk = dl.file.chunks[dl.chunkIndex];
        chunk?.lines.forEach((line, j) => {
          const plain = stripAnsi(line);
          if (plain.startsWith("+") || plain.startsWith("-")) {
            add(dl.file, dl.chunkIndex, j);
          }
        });
        return result;
      }
    }
    for (let l = startLine; l <= endLine; l++) {
      const dl = this.diffLines.get(l);
      if (dl?.changed && dl.lineIndex !== undefined) {
        add(dl.file, dl.chunkIndex, dl.lineIndex);
      }
    }
    return result;
  }

  override toggleFold(line: number): number | undefined {
    const span = this.foldSpans.get(line);
    if (!span || !this.raw) {
      return undefined;
    }
    const set = span.kind === "file" ? this.expandedFiles : this.collapsedChunks;
    if (set.has(span.key)) {
      set.delete(span.key);
    } else {
      set.add(span.key);
    }
    this.update(this.applyStatus(formatStatus(this.raw, this.expandedFiles, this.collapsedChunks)));
    return span.headerLine;
  }

  private applyStatus({ text, changes, files, foldSpans, diffLines }: Status): StyledText {
    this.changes = changes;
    this.files = files;
    this.foldSpans = foldSpans;
    this.diffLines = diffLines;
    return text;
  }

  protected async render(): Promise<StyledText> {
    try {
      this.raw = await fetchStatusData(this.root);
      return this.applyStatus(formatStatus(this.raw, this.expandedFiles, this.collapsedChunks));
    } catch (e) {
      this.raw = undefined;
      return this.applyStatus(errorStatus(this.root, e));
    }
  }
}
