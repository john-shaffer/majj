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

export interface FileDiff {
  label: string;
  path: string;
  from?: string;
  binary: boolean;
  insertions: number;
  deletions: number;
  /** The lines after git's headers, with their colors. */
  lines: string[];
}

export interface FileSpan {
  path: string;
  headerLine: number;
}

const displayPath = (file: FileDiff) => (file.from ? `${file.from} -> ${file.path}` : file.path);

export function appendShow(
  out: StyledTextBuilder,
  ansi: string,
  collapsedFiles: ReadonlySet<string> = new Set(),
): Map<number, FileSpan> {
  const fileSpans = new Map<number, FileSpan>();
  const lines = ansi.split("\n");
  let diffStart = lines.findIndex((l) => DIFF_GIT.test(stripAnsi(l)));
  if (diffStart < 0) {
    diffStart = lines.length;
  }
  out.appendAnsi(lines.slice(0, diffStart).join("\n"));
  const files = parseFiles(lines.slice(diffStart));
  if (files.length === 0) {
    return fileSpans;
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
    if (!collapsedFiles.has(file.path)) {
      appendFileDiff(out, file);
    }
    for (let l = headerLine; l < out.line; l++) {
      fileSpans.set(l, { path: file.path, headerLine });
    }
  }
  return fileSpans;
}

export function appendFileDiff(out: StyledTextBuilder, file: FileDiff) {
  for (const line of file.lines) {
    // jj underlines the changed tokens, which on a wholly added or removed
    // line is the whole line.
    out.appendAnsi(line, ({ underline, ...style }) => style).newline();
  }
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Scaled like git's stat: any change gets at least one character. */
const barLength = (n: number, scale: number) => (n > 0 ? Math.max(1, Math.round(n * scale)) : 0);

export function parseFiles(lines: string[]): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let from: string | undefined;
  let inHunks = false;
  for (const line of lines) {
    const plain = stripAnsi(line);
    if (DIFF_GIT.test(plain)) {
      file = {
        label: "modified",
        path: gitHeaderPath(plain.slice("diff --git ".length)),
        binary: false,
        insertions: 0,
        deletions: 0,
        lines: [],
      };
      files.push(file);
      from = undefined;
      inHunks = false;
    } else if (!file) {
      continue;
    } else if (inHunks || plain.startsWith("@@")) {
      inHunks = true;
      file.lines.push(line);
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
      file.lines.push(line);
    }
  }
  // The diff ends with a newline, which is not a line of the last file.
  if (file?.lines.at(-1) === "") {
    file.lines.pop();
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
