import * as vscode from "vscode";
import { stripAnsi, Style, StyledText, StyledTextBuilder } from "./ansi";
import { getConfig } from "./config";
import {
  appendFileDiff,
  changedLinesByChunk,
  DiffLine,
  FileDiff,
  fileSelectionState,
  FoldSpan,
  parseFiles,
  selectionPrefix,
} from "./diff";
import { configGet, ENTRY_ID, entryIds, JjError, runJj } from "./jj";
import { appendError, SCHEME, View } from "./view";
import { WorkingCopyFile, workingCopyFiles } from "./workingCopy";

const HEADER: Style = { bold: true };
const NO_REPO = /There is no jj repo in/;

// Each log entry starts with its change ID between \x1e and \x1f, so that
// lines can be mapped to changes whatever the user's log template looks like.
// A divergent change ID is ambiguous, so those entries use their commit ID.
const MARK = /\x1e([^\x1f]*)\x1f/;
const markedTemplate = (template: string) => `"\\x1e" ++ ${ENTRY_ID} ++ "\\x1f" ++ (${template})`;
// jj's line for an edge through changes the revset leaves out, under the node it comes from.
const ELIDED = /^[^~]*~\s+\(elided revisions\)\s*$/;

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
  /** Parsed file diffs for the working copy, keyed by workspace-relative path. */
  diffs: Map<string, FileDiff>;
  /** The change whose elided ancestors each `(elided revisions)` line stands for, by line index. */
  elisions: Map<number, string>;
  /** For each line of a change shown only because of an expanded elision, that elision's change. */
  revealed: Map<number, string>;
}

export interface SelectedFile {
  wcFile: WorkingCopyFile;
  fileDiff?: FileDiff;
  /** For a partially selected file (`[◐]`), the changed lines that WERE selected. */
  selected?: ReadonlyMap<number, ReadonlySet<number>>;
  /** For a partially selected file (`[◐]`), the changed lines that were NOT selected. */
  unselected?: Map<number, Set<number>>;
}

export interface StatusData {
  status: string;
  diff: string;
  log: string;
  revset: string;
  /** The expanded elision's change that each change in the graph is shown for, if any. */
  revealedBy: Map<string, string>;
}

function selectableByChunk(fileDiff?: FileDiff): Map<number, Set<number>> {
  const byChunk = changedLinesByChunk(fileDiff);
  if (byChunk.size === 0) {
    byChunk.set(-1, new Set([-1]));
  }
  return byChunk;
}

export function formatStatus(
  data: StatusData,
  expandedFiles: ReadonlySet<string> = new Set(),
  collapsedChunks: ReadonlySet<string> = new Set(),
  selected: ReadonlyMap<string, ReadonlyMap<number, ReadonlySet<number>>> = new Map(),
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
      const m = /^(?:Working copy\s+\(|Parent commit\b)[^:]*:\s+(\S+)\s+([0-9a-f]+)/.exec(stripAnsi(statusLines[i]));
      if (m) {
        changes.set(out.line, /^[k-z]+$/.test(m[1]) ? m[1] : m[2]);
      }
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
    if (wcFile) {
      const fileDiff = diffs.get(wcFile.path);
      const allByChunk = selectableByChunk(fileDiff);
      const selectedInFile = selected.get(wcFile.path) ?? new Map<number, ReadonlySet<number>>();
      out.append(selectionPrefix(fileSelectionState(allByChunk, selectedInFile)));
      out.appendAnsi(statusLines[i]).newline();
      files.set(headerLine, wcFile);
      foldSpans.set(headerLine, { kind: "file", key: wcFile.path, headerLine });
      if (expandedFiles.has(wcFile.path) && fileDiff) {
        appendFileDiff(out, fileDiff, headerLine, foldSpans, collapsedChunks, diffLines, selectedInFile);
      }
    } else {
      out.appendAnsi(statusLines[i]).newline();
    }
  }
  out.separate();
  out.append("Changes:", HEADER);
  if (data.revset) {
    out.append(` ${data.revset}`);
  }
  out.newline();
  let change: string | undefined;
  // The change of the last node drawn in each column of the graph.
  const nodeChanges = new Map<number, string>();
  const elisions = new Map<number, string>();
  const revealed = new Map<number, string>();
  for (const line of data.log.split("\n")) {
    const mark = MARK.exec(line);
    change = mark?.[1] ?? change;
    if (change) {
      changes.set(out.line, change);
      const by = data.revealedBy.get(change);
      if (by) {
        revealed.set(out.line, by);
      }
    }
    if (mark) {
      // The node is the last character of the graph before the entry.
      nodeChanges.set(stripAnsi(line.slice(0, mark.index)).trimEnd().length - 1, mark[1]);
    } else {
      const plain = stripAnsi(line);
      const elided = ELIDED.test(plain) && nodeChanges.get(plain.indexOf("~"));
      if (elided) {
        elisions.set(out.line, elided);
      }
    }
    out.appendAnsi(mark ? line.replace(mark[0], "") : line).newline();
  }
  return { text: out.build(), changes, files, foldSpans, diffLines, diffs, elisions, revealed };
}

async function fetchStatusData(root: string, expandedElisions: ReadonlySet<string> = new Set()): Promise<StatusData> {
  const { limit, recentChanges, revset } = getConfig();
  // `jj status` snapshots the working copy, so diff and log can skip doing it again.
  const [status, baseRevset, logTemplate] = await Promise.all([
    runJj(root, ["status"], { color: true }),
    revset || graphRevset(root, recentChanges),
    configGet(root, "templates.log"),
  ]);
  const { revset: logRevset, revealedBy } = await withElisions(root, baseRevset, expandedElisions);
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
  return { status, diff, log, revset, revealedBy };
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
    diffs: new Map(),
    elisions: new Map(),
    revealed: new Map(),
  };
}

/**
 * `revset` plus, for each change in `expanded`, the changes between it and
 * its ancestors in `revset`, which the graph would otherwise elide. Also
 * returns which expanded change each of those is shown for.
 */
async function withElisions(
  root: string,
  revset: string | undefined,
  expanded: ReadonlySet<string>,
): Promise<{ revset: string | undefined; revealedBy: Map<string, string> }> {
  const revealedBy = new Map<string, string>();
  if (expanded.size === 0) {
    return { revset, revealedBy };
  }
  const base = `(${revset ?? (await configGet(root, "revsets.log"))})`;
  // present() keeps a change abandoned since from breaking the whole revset.
  const elided = (c: string) => `((${base} & ::present(${c}))::present(${c}))`;
  await Promise.all(
    [...expanded].map(async (c) => {
      for (const id of await entryIds(root, `${elided(c)} ~ ${base}`)) {
        revealedBy.set(id, c);
      }
    }),
  );
  return { revset: [base, ...[...expanded].map(elided)].join(" | "), revealedBy };
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
  private selected = new Map<string, Map<number, Set<number>>>();
  private changes = new Map<number, string>();
  private files = new Map<number, WorkingCopyFile>();
  private foldSpans = new Map<number, FoldSpan>();
  private diffLines = new Map<number, DiffLine>();
  private diffs = new Map<string, FileDiff>();
  private elisions = new Map<number, string>();
  private revealed = new Map<number, string>();
  /** Changes whose elided ancestors tab has expanded. */
  private expandedElisions = new Set<string>();

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
    const elided = this.elisions.get(line);
    const revealedBy = this.revealed.get(line);
    if (elided || revealedBy) {
      if (elided) {
        this.expandedElisions.add(elided);
      } else {
        this.expandedElisions.delete(revealedBy!);
      }
      void this.refresh();
      return undefined;
    }
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
    this.update(this.applyStatus(formatStatus(this.raw, this.expandedFiles, this.collapsedChunks, this.selected)));
    return span.headerLine;
  }

  toggleSelect(startLine: number, endLine: number): void {
    if (!this.raw) {
      return;
    }
    const targets: { path: string; chunkIndex: number; lineIndex: number }[] = [];
    const addFileTargets = (path: string) => {
      for (const [c, lines] of selectableByChunk(this.diffs.get(path))) {
        for (const j of lines) {
          targets.push({ path, chunkIndex: c, lineIndex: j });
        }
      }
    };
    if (startLine === endLine) {
      const wcFile = this.files.get(startLine);
      const dl = this.diffLines.get(startLine);
      if (wcFile) {
        addFileTargets(wcFile.path);
      } else if (dl && dl.lineIndex === undefined) {
        const lines = selectableByChunk(dl.file).get(dl.chunkIndex);
        for (const j of lines ?? []) {
          targets.push({ path: dl.file.path, chunkIndex: dl.chunkIndex, lineIndex: j });
        }
      } else if (dl?.changed && dl.lineIndex !== undefined) {
        targets.push({ path: dl.file.path, chunkIndex: dl.chunkIndex, lineIndex: dl.lineIndex });
      }
    } else {
      for (let l = startLine; l <= endLine; l++) {
        const dl = this.diffLines.get(l);
        if (dl?.changed && dl.lineIndex !== undefined) {
          targets.push({ path: dl.file.path, chunkIndex: dl.chunkIndex, lineIndex: dl.lineIndex });
        }
      }
      if (targets.length === 0) {
        for (let l = startLine; l <= endLine; l++) {
          const wcFile = this.files.get(l);
          if (wcFile) {
            addFileTargets(wcFile.path);
          }
        }
      }
    }
    if (targets.length === 0) {
      return;
    }
    const allSelected = targets.every((t) => this.selected.get(t.path)?.get(t.chunkIndex)?.has(t.lineIndex));
    for (const t of targets) {
      if (allSelected) {
        const byChunk = this.selected.get(t.path);
        const lines = byChunk?.get(t.chunkIndex);
        lines?.delete(t.lineIndex);
        if (lines?.size === 0) {
          byChunk?.delete(t.chunkIndex);
        }
        if (byChunk?.size === 0) {
          this.selected.delete(t.path);
        }
      } else {
        let byChunk = this.selected.get(t.path);
        if (!byChunk) {
          this.selected.set(t.path, (byChunk = new Map()));
        }
        let lines = byChunk.get(t.chunkIndex);
        if (!lines) {
          byChunk.set(t.chunkIndex, (lines = new Set()));
        }
        lines.add(t.lineIndex);
      }
    }
    this.update(this.applyStatus(formatStatus(this.raw, this.expandedFiles, this.collapsedChunks, this.selected)));
  }

  selectedFiles(): SelectedFile[] {
    const result: SelectedFile[] = [];
    for (const wcFile of this.files.values()) {
      const fileDiff = this.diffs.get(wcFile.path);
      const allByChunk = selectableByChunk(fileDiff);
      const selByChunk = this.selected.get(wcFile.path);
      const state = fileSelectionState(allByChunk, selByChunk);
      if (state === "all") {
        result.push({ wcFile });
      } else if (state === "some" && fileDiff) {
        const unselected = new Map<number, Set<number>>();
        for (const [c, lines] of allByChunk) {
          const sel = selByChunk?.get(c);
          for (const j of lines) {
            if (!sel?.has(j)) {
              let set = unselected.get(c);
              if (!set) {
                unselected.set(c, (set = new Set()));
              }
              set.add(j);
            }
          }
        }
        result.push({ wcFile, fileDiff, selected: selByChunk, unselected });
      }
    }
    return result;
  }

  clearSelection(): void {
    this.selected.clear();
  }

  private pruneSelection(raw: StatusData): void {
    const validPaths = new Set([...workingCopyFiles(stripAnsi(raw.status)).values()].map((f) => f.path));
    for (const filePath of this.expandedFiles) {
      if (!validPaths.has(filePath)) {
        this.expandedFiles.delete(filePath);
      }
    }
    for (const chunkKey of this.collapsedChunks) {
      if (!validPaths.has(chunkKey.split("\n")[0])) {
        this.collapsedChunks.delete(chunkKey);
      }
    }
    const diffs = new Map(parseFiles(raw.diff.split("\n")).map((f) => [f.path, f]));
    for (const [filePath, selByChunk] of this.selected) {
      if (!validPaths.has(filePath)) {
        this.selected.delete(filePath);
        continue;
      }
      const allByChunk = selectableByChunk(diffs.get(filePath));
      for (const [c, selLines] of selByChunk) {
        const validLines = allByChunk.get(c);
        for (const j of selLines) {
          if (!validLines?.has(j)) {
            selLines.delete(j);
          }
        }
        if (selLines.size === 0) {
          selByChunk.delete(c);
        }
      }
      if (selByChunk.size === 0) {
        this.selected.delete(filePath);
      }
    }
  }

  private applyStatus({ text, changes, files, foldSpans, diffLines, diffs, elisions, revealed }: Status): StyledText {
    this.changes = changes;
    this.elisions = elisions;
    this.revealed = revealed;
    this.files = files;
    this.foldSpans = foldSpans;
    this.diffLines = diffLines;
    this.diffs = diffs;
    return text;
  }

  protected async render(): Promise<StyledText> {
    try {
      this.raw = await fetchStatusData(this.root, this.expandedElisions);
      this.pruneSelection(this.raw);
      return this.applyStatus(formatStatus(this.raw, this.expandedFiles, this.collapsedChunks, this.selected));
    } catch (e) {
      this.raw = undefined;
      return this.applyStatus(errorStatus(this.root, e));
    }
  }
}
