// Renders `jj show --stat --git` like magit's revision buffer: git's
// per-file headers become one "modified   path" line under a "Changes (N)"
// section, and the hunks keep jj's colors.

import { stripAnsi, Style, StyledTextBuilder } from "./ansi";

const HEADER: Style = { bold: true };
const FILE: Style = { fg: { kind: "ansi", index: 3 } };

const STAT_SUMMARY = /^\d+ files? changed/;
const DIFF_GIT = /^diff --git /;
// Extended header lines that the file's label or path stands in for.
const HIDDEN = /^(index |--- |\+\+\+ |(new|deleted) file mode |(rename|copy) (from|to) |(dis)?similarity index )/;

interface FileDiff {
  label: string;
  path: string;
  /** The lines after git's headers, with their colors. */
  lines: string[];
}

export function appendShow(out: StyledTextBuilder, ansi: string) {
  const lines = ansi.split("\n");
  const diffStart = findDiffStart(lines);
  out.appendAnsi(lines.slice(0, diffStart).join("\n"));
  const files = parseFiles(lines.slice(diffStart));
  if (files.length === 0) {
    return;
  }
  out.separate().append(`Changes (${files.length})`, HEADER).newline();
  for (const file of files) {
    out.append(`${file.label.padEnd(11)}${file.path}`, FILE).newline();
    for (const line of file.lines) {
      // jj underlines the changed tokens, which on a wholly added or removed
      // line is the whole line.
      out.appendAnsi(line, ({ underline, ...style }) => style).newline();
    }
  }
}

/**
 * The first line of the diff, which comes after the stat's summary line. Paths
 * in the stat, or the description, could themselves look like a diff header.
 */
function findDiffStart(lines: string[]): number {
  const summary = lines.findIndex((l) => STAT_SUMMARY.test(stripAnsi(l)));
  const start = lines.findIndex((l, i) => i > summary && DIFF_GIT.test(stripAnsi(l)));
  return summary < 0 || start < 0 ? lines.length : start;
}

function parseFiles(lines: string[]): FileDiff[] {
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
    } else if (plain.startsWith("new file mode ")) {
      file.label = "new file";
    } else if (plain.startsWith("deleted file mode ")) {
      file.label = "deleted";
    } else if (/^(rename|copy) from /.test(plain)) {
      from = plain.replace(/^\w+ from /, "");
    } else if (/^(rename|copy) to /.test(plain)) {
      file.label = plain.startsWith("rename") ? "renamed" : "copied";
      file.path = `${from} -> ${plain.replace(/^\w+ to /, "")}`;
    } else if (!HIDDEN.test(plain)) {
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
