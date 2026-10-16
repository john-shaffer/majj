// Finds the files in `jj status`'s "Working copy changes" section, so that
// visiting one of its lines can open the file.

const SECTION = "Working copy changes:";
const FILE = /^([ACDMR]) (.*)$/;
// jj abbreviates a rename or copy as `prefix{from => to}suffix`.
const RENAME = /\{([^{}]*) => ([^{}]*)\}/;

/** The path, relative to the workspace root, of each file line by line index. */
export function workingCopyFiles(status: string): Map<number, string> {
  const files = new Map<number, string>();
  const lines = status.split("\n");
  const start = lines.indexOf(SECTION);
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    const match = FILE.exec(lines[i]);
    if (!match) {
      break;
    }
    // Deleted files have nothing to open.
    if (match[1] !== "D") {
      files.set(i, match[2].replace(RENAME, "$2"));
    }
  }
  return files;
}
