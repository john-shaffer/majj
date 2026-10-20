// Renders `jj show --git` like magit's revision buffer: git's per-file
// headers become one "modified   path | 3 ++-" line under a "Changes"
// section, and the hunks keep jj's colors.

import { stripAnsi, Style, StyledTextBuilder } from "./ansi";

const HEADER: Style = { bold: true };
const FILE: Style = { fg: { kind: "ansi", index: 3 } };
const ADDED: Style = { fg: { kind: "ansi", index: 2 } };
const REMOVED: Style = { fg: { kind: "ansi", index: 1 } };

/** The width of the labels, "new file   " and so on, as in magit. */
const LABEL_WIDTH = 11;
/** The most +'s and -'s in a file's bar. Longer bars are scaled down to fit. */
const MAX_BAR = 40;

// jj indents the description, so a line starting with this begins the diff.
const DIFF_GIT = /^diff --git /;
// Extended header lines that the file's label or path stands in for.
const HIDDEN = /^(index |--- |\+\+\+ |(new|deleted) file mode |(rename|copy) (from|to) |(dis)?similarity index )/;

export interface ChunkDiff {
  /** The `@@ ... @@` line, with its colors. */
  header: string;
  /** The lines of the chunk after its `@@ ... @@` header, with their colors. */
  lines: string[];
}

export interface FileDiff {
  label: string;
  path: string;
  from?: string;
  binary: boolean;
  /** Whether either side is a symlink, whose "content" is its target path. */
  symlink: boolean;
  insertions: number;
  deletions: number;
  /** Non-hunk lines after git's headers (e.g. mode changes or binary notice), with their colors. */
  headers: string[];
  chunks: ChunkDiff[];
}

export interface FoldSpan {
  kind: "file" | "chunk";
  key: string;
  headerLine: number;
}

export interface DiffLine {
  file: FileDiff;
  chunkIndex: number;
  /** Index within `chunk.lines`, or `undefined` on the `@@ ... @@` chunk header line. */
  lineIndex?: number;
  /** True when this line is an added (`+`) or removed (`-`) line. */
  changed: boolean;
}

// Git's mode for symlinks, in "new file mode", "old mode", "index" and similar header lines.
const SYMLINK_MODE = /^(new file mode|deleted file mode|old mode|new mode|index \S+) 120000$/;

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

const displayPath = (file: FileDiff) => (file.from ? `${file.from} -> ${file.path}` : file.path);

/**
 * Appends `jj show --git` output to `out`. Returns the fold spans, and fills
 * in `diffLines` and `fileLines` with the diff line and file on each line.
 */
export function appendShow(
  out: StyledTextBuilder,
  ansi: string,
  collapsedFiles: ReadonlySet<string> = new Set(),
  collapsedChunks: ReadonlySet<string> = new Set(),
  diffLines?: Map<number, DiffLine>,
  fileLines?: Map<number, FileDiff>,
): Map<number, FoldSpan> {
  const foldSpans = new Map<number, FoldSpan>();
  const lines = ansi.split("\n");
  let diffStart = lines.findIndex((l) => DIFF_GIT.test(stripAnsi(l)));
  if (diffStart < 0) {
    diffStart = lines.length;
  }
  out.appendAnsi(lines.slice(0, diffStart).join("\n"));
  const files = parseFiles(lines.slice(diffStart));
  if (files.length === 0) {
    return foldSpans;
  }
  const sum = (f: (file: FileDiff) => number) => files.reduce((n, file) => n + f(file), 0);
  out
    .separate()
    .append(
      [
        `${"Changes".padEnd(LABEL_WIDTH)}${plural(files.length, "file")}`,
        plural(
          sum((f) => f.insertions),
          "insertion",
        ) + "(+)",
        plural(
          sum((f) => f.deletions),
          "deletion",
        ) + "(-)",
      ].join(", "),
      HEADER,
    )
    .newline();
  const pathWidth = Math.max(...files.map((f) => displayPath(f).length));
  const countWidth = Math.max(...files.map((f) => String(f.insertions + f.deletions).length));
  const scale = Math.min(1, MAX_BAR / Math.max(...files.map((f) => f.insertions + f.deletions)));
  for (const file of files) {
    const headerLine = out.line;
    out.append(`${file.label.padEnd(LABEL_WIDTH)}${displayPath(file).padEnd(pathWidth)}`, FILE).append(" | ");
    if (file.binary) {
      out.append("(binary)");
    } else {
      out
        .append(String(file.insertions + file.deletions).padStart(countWidth))
        .append(file.insertions + file.deletions > 0 ? " " : "")
        .append("+".repeat(barLength(file.insertions, scale)), ADDED)
        .append("-".repeat(barLength(file.deletions, scale)), REMOVED);
    }
    out.newline();
    foldSpans.set(headerLine, { kind: "file", key: file.path, headerLine });
    fileLines?.set(headerLine, file);
    if (!collapsedFiles.has(file.path)) {
      appendFileDiff(out, file, headerLine, foldSpans, collapsedChunks, diffLines);
    }
  }
  return foldSpans;
}

export type SelectionState = "none" | "some" | "all";

export const selectionPrefix = (state: SelectionState) =>
  state === "all" ? "[●] " : state === "some" ? "[◐] " : "[ ] ";

/** The indices of added (`+`) and removed (`-`) lines in each chunk of `file`. */
export function changedLinesByChunk(file?: FileDiff): Map<number, Set<number>> {
  const byChunk = new Map<number, Set<number>>();
  file?.chunks.forEach((chunk, i) => {
    const indices = new Set<number>();
    chunk.lines.forEach((line, j) => {
      const plain = stripAnsi(line);
      if (plain.startsWith("+") || plain.startsWith("-")) {
        indices.add(j);
      }
    });
    if (indices.size > 0) {
      byChunk.set(i, indices);
    }
  });
  return byChunk;
}

export function chunkSelectionState(
  allInChunk: ReadonlySet<number> | undefined,
  selectedInChunk: ReadonlySet<number> | undefined,
): SelectionState {
  if (!allInChunk || allInChunk.size === 0 || !selectedInChunk || selectedInChunk.size === 0) {
    return "none";
  }
  let count = 0;
  for (const j of allInChunk) {
    if (selectedInChunk.has(j)) {
      count++;
    }
  }
  return count === 0 ? "none" : count === allInChunk.size ? "all" : "some";
}

export function fileSelectionState(
  allByChunk: ReadonlyMap<number, ReadonlySet<number>>,
  selectedByChunk: ReadonlyMap<number, ReadonlySet<number>> | undefined,
): SelectionState {
  let total = 0;
  let selected = 0;
  for (const [c, lines] of allByChunk) {
    const sel = selectedByChunk?.get(c);
    for (const j of lines) {
      total++;
      if (sel?.has(j)) {
        selected++;
      }
    }
  }
  return total === 0 || selected === 0 ? "none" : selected === total ? "all" : "some";
}

export function appendFileDiff(
  out: StyledTextBuilder,
  file: FileDiff,
  fileHeaderLine: number,
  foldSpans: Map<number, FoldSpan>,
  collapsedChunks: ReadonlySet<string> = new Set(),
  diffLines?: Map<number, DiffLine>,
  selectedInFile?: ReadonlyMap<number, ReadonlySet<number>>,
) {
  const byChunk = selectedInFile ? changedLinesByChunk(file) : undefined;
  for (const line of file.headers) {
    foldSpans.set(out.line, { kind: "file", key: file.path, headerLine: fileHeaderLine });
    if (selectedInFile) {
      out.append("    ");
    }
    appendDiffLine(out, line);
  }
  for (let i = 0; i < file.chunks.length; i++) {
    const chunk = file.chunks[i];
    const key = `${file.path}\n${i}`;
    const chunkHeaderLine = out.line;
    diffLines?.set(chunkHeaderLine, { file, chunkIndex: i, changed: false });
    if (selectedInFile) {
      out.append(selectionPrefix(chunkSelectionState(byChunk?.get(i), selectedInFile.get(i))));
    }
    appendDiffLine(out, chunk.header);
    if (!collapsedChunks.has(key)) {
      const selChunk = selectedInFile?.get(i);
      for (let j = 0; j < chunk.lines.length; j++) {
        const plain = stripAnsi(chunk.lines[j]);
        const changed = plain.startsWith("+") || plain.startsWith("-");
        diffLines?.set(out.line, { file, chunkIndex: i, lineIndex: j, changed });
        if (selectedInFile) {
          out.append(changed ? selectionPrefix(selChunk?.has(j) ? "all" : "none") : "    ");
        }
        appendDiffLine(out, chunk.lines[j]);
      }
    }
    for (let l = chunkHeaderLine; l < out.line; l++) {
      foldSpans.set(l, { kind: "chunk", key, headerLine: chunkHeaderLine });
    }
  }
}

/**
 * The 1-based line of the new file that line `lineIndex` of chunk
 * `chunkIndex` in `file` shows, or for the chunk's `@@` header, its first
 * line. A removed line maps to where it was removed from.
 */
export function newLineNumber(file: FileDiff, chunkIndex: number, lineIndex = 0): number {
  const chunk = file.chunks[chunkIndex];
  const match = chunk && HUNK_HEADER.exec(stripAnsi(chunk.header));
  if (!match) {
    return 1;
  }
  const start = Number(match[1]);
  // A chunk that only removes lines starts at the line before the removal.
  if (match[2] !== undefined && Number(match[2]) === 0) {
    return Math.max(1, start);
  }
  let line = start;
  for (let j = 0; j < lineIndex; j++) {
    const plain = stripAnsi(chunk.lines[j]);
    if (plain.startsWith(" ") || plain.startsWith("+")) {
      line++;
    }
  }
  return line;
}

/**
 * Returns `content` with the selected changed lines (`+` or `-`) in `file`
 * reverted: discarded `+` lines are removed and discarded `-` lines are restored.
 */
export function discardLines(
  content: string,
  file: FileDiff,
  discarded: ReadonlyMap<number, ReadonlySet<number>>,
): string {
  const fileLines = content.match(/[^\n]*\n|[^\n]+/g) ?? [];
  const chunkIndices = [...discarded.keys()].sort((a, b) => b - a);
  for (const chunkIndex of chunkIndices) {
    const chunk = file.chunks[chunkIndex];
    const selected = discarded.get(chunkIndex);
    const match = chunk && HUNK_HEADER.exec(stripAnsi(chunk.header));
    if (!chunk || !selected || !match) {
      continue;
    }
    const newStart = Number(match[1]);
    const newCount = match[2] !== undefined ? Number(match[2]) : 1;
    const startIndex = newCount === 0 ? newStart : newStart - 1;
    const replacement: string[] = [];
    for (let j = 0; j < chunk.lines.length; j++) {
      const plain = stripAnsi(chunk.lines[j]);
      if (plain.startsWith("\\")) {
        continue;
      }
      const noNewline = j + 1 < chunk.lines.length && stripAnsi(chunk.lines[j + 1]).startsWith("\\");
      const text = plain.slice(1) + (noNewline ? "" : "\n");
      if (plain.startsWith(" ")) {
        replacement.push(text);
      } else if (plain.startsWith("+") && !selected.has(j)) {
        replacement.push(text);
      } else if (plain.startsWith("-") && selected.has(j)) {
        replacement.push(text);
      }
    }
    fileLines.splice(startIndex, newCount, ...replacement);
  }
  return fileLines.join("");
}

function appendDiffLine(out: StyledTextBuilder, line: string) {
  // jj underlines the changed tokens, which on a wholly added or removed
  // line is the whole line.
  out.appendAnsi(line, ({ underline, ...style }) => style).newline();
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Scaled like git's stat: any change gets at least one character. */
const barLength = (n: number, scale: number) => (n > 0 ? Math.max(1, Math.round(n * scale)) : 0);

export function parseFiles(lines: string[]): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let chunk: ChunkDiff | undefined;
  let from: string | undefined;
  for (const line of lines) {
    const plain = stripAnsi(line);
    if (file && !chunk && SYMLINK_MODE.test(plain)) {
      file.symlink = true;
    }
    if (DIFF_GIT.test(plain)) {
      file = {
        label: "modified",
        path: gitHeaderPath(plain.slice("diff --git ".length)),
        binary: false,
        symlink: false,
        insertions: 0,
        deletions: 0,
        headers: [],
        chunks: [],
      };
      files.push(file);
      chunk = undefined;
      from = undefined;
    } else if (!file) {
      continue;
    } else if (plain.startsWith("@@")) {
      chunk = { header: line, lines: [] };
      file.chunks.push(chunk);
    } else if (chunk) {
      chunk.lines.push(line);
      if (plain.startsWith("+")) {
        file.insertions++;
      } else if (plain.startsWith("-")) {
        file.deletions++;
      }
    } else if (plain.startsWith("new file mode ")) {
      file.label = "new file";
    } else if (plain.startsWith("deleted file mode ")) {
      file.label = "deleted";
    } else if (/^(rename|copy) from /.test(plain)) {
      from = plain.replace(/^\w+ from /, "");
    } else if (/^(rename|copy) to /.test(plain)) {
      file.label = plain.startsWith("rename") ? "renamed" : "copied";
      file.from = from;
      file.path = plain.replace(/^\w+ to /, "");
    } else if (!HIDDEN.test(plain)) {
      file.binary ||= plain.startsWith("Binary files ");
      file.headers.push(line);
    }
  }
  // The diff ends with a newline, which is not a line of the last file.
  const lastLines = chunk ? chunk.lines : file?.headers;
  if (lastLines?.at(-1) === "") {
    lastLines.pop();
  }
  return files;
}

/**
 * The path in `a/<path> b/<path>`, or `<path> <path>` when jj's
 * diff.git.show-path-prefix is off. Renames and copies, the only diffs whose
 * two paths differ, get theirs from the rename and copy lines instead.
 */
function gitHeaderPath(paths: string): string {
  const half = (paths.length - 1) / 2;
  const path = Number.isInteger(half) ? paths.slice(0, half) : paths;
  return path.startsWith("a/") && paths.slice(half + 1).startsWith("b/") ? path.slice(2) : path;
}
