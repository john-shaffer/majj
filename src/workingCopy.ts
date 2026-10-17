// Finds the files in `jj status`'s "Working copy changes" section, so that
// commands on one of its lines can open or restore the file.

const SECTION = "Working copy changes:";
const FILE = /^([ACDMR]) (.*)$/;
// jj abbreviates a rename or copy as `prefix{from => to}suffix`.
const RENAME = /\{([^{}]*) => ([^{}]*)\}/;

export interface WorkingCopyFile {
  path: string;
  deleted: boolean;
  /** The paths to pass to `jj restore` to undo the change to this file. */
  restorePaths: string[];
}

/** The working copy file on each line of the "Working copy changes" section, by line index. */
export function workingCopyFiles(status: string): Map<number, WorkingCopyFile> {
  const files = new Map<number, WorkingCopyFile>();
  const lines = status.split("\n");
  const start = lines.indexOf(SECTION);
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    const match = FILE.exec(lines[i]);
    if (!match) {
      break;
    }
    const [, statusChar, rawPath] = match;
    const filePath = rawPath.replace(RENAME, "$2");
    const restorePaths = statusChar === "R" ? [rawPath.replace(RENAME, "$1"), filePath] : [filePath];
    files.set(i, {
      path: filePath,
      deleted: statusChar === "D",
      restorePaths,
    });
  }
  return files;
}
