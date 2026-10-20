import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { stripAnsi } from "./ansi";
import { getConfig } from "./config";

export class JjError extends Error {
  /** The error output as jj printed it, possibly with color escapes. */
  constructor(readonly output: string) {
    super(stripAnsi(output));
  }
}

export function runJj(
  cwd: string,
  args: string[],
  { color = false, env = {} }: { color?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const fullArgs = ["--no-pager", "--color", color ? "always" : "never", ...args];
  const options = { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 };
  return new Promise((resolve, reject) => {
    execFile(getConfig().jjPath, fullArgs, options, (error, stdout, stderr) => {
      if (error) {
        reject(new JjError(stderr.trim() || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function configGet(cwd: string, name: string): Promise<string> {
  return (await runJj(cwd, ["config", "get", name])).trim();
}

/**
 * A template for the ID majj uses for a commit: its change ID, or for a
 * divergent change, which that ID doesn't identify, its commit ID.
 */
export const ENTRY_ID = "stringify(if(divergent, commit_id, change_id))";

/** The IDs (see `ENTRY_ID`) of the commits in `revset`. */
export async function entryIds(cwd: string, revset: string): Promise<string[]> {
  const out = await runJj(cwd, [
    "log",
    "--no-graph",
    "--ignore-working-copy",
    "-r",
    revset,
    "-T",
    `${ENTRY_ID} ++ "\\n"`,
  ]);
  return out.split("\n").filter((id) => id);
}

/** The root of the jj workspace containing `dir`. */
export async function findRoot(dir: string): Promise<string> {
  return (await runJj(dir, ["root"])).trim();
}

/** A `root-file:` fileset pattern for an exact workspace-relative path. */
function fileset(file: string): string {
  return `root-file:"${file.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Moves changes in `revision` into the ancestors that last changed those lines (`jj absorb`). */
export async function absorb(cwd: string, revision: string): Promise<void> {
  await runJj(cwd, ["absorb", "--from", revision]);
}

/** Abandons `revision` (`jj abandon`). */
export async function abandon(cwd: string, revision: string): Promise<void> {
  await runJj(cwd, ["abandon", revision]);
}

/**
 * Commits the selected working copy changes (or all working copy changes if
 * none are selected) with the working copy's existing description (`jj commit`).
 */
export async function commit(cwd: string, selection?: SelectedChanges): Promise<void> {
  await runWithSelection(cwd, ["commit", "--config", 'ui.editor="true"'], selection);
}

/** The description of `revision`. */
export async function description(cwd: string, revision: string): Promise<string> {
  return runJj(cwd, ["log", "--no-graph", "-r", revision, "-T", "description"]);
}

/** Makes `revision` the working copy change (`jj edit`). */
export async function edit(cwd: string, revision: string): Promise<void> {
  await runJj(cwd, ["edit", revision]);
}

/** Starts a new, empty change on top of `revision` (`jj new`). */
export async function newChange(cwd: string, revision: string): Promise<void> {
  await runJj(cwd, ["new", revision]);
}

/** Moves the working copy to the child of `@-` (`jj next`). */
export async function next(cwd: string): Promise<void> {
  await runJj(cwd, ["next"]);
}

/** Moves the working copy to the parent of `@-` (`jj prev`). */
export async function prev(cwd: string): Promise<void> {
  await runJj(cwd, ["prev"]);
}

const REBASE_SOURCE_FLAGS = new Set(["-b", "--branch", "-r", "--revision", "-s", "--source"]);

/**
 * Builds `jj rebase` arguments for rebasing `source` according to `input`.
 * Plain revset input defaults to `-s <source> -d <input>`; flag input such as
 * `-r -d main`, `-A main`, or `-r x -d y` inserts `source` when no source
 * revision was given.
 */
export function rebaseArgs(source: string, input: string): string[] {
  const trimmed = input.trim();
  const tokens = (trimmed.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g) ?? []).map((t) =>
    (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t,
  );
  if (tokens.length === 0) {
    return [];
  }
  if (!tokens.some((t) => t.startsWith("-"))) {
    return ["rebase", "-s", source, "-d", trimmed];
  }
  const out = ["rebase"];
  let hasSource = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    out.push(tok);
    if (REBASE_SOURCE_FLAGS.has(tok)) {
      hasSource = true;
      const next = tokens[i + 1];
      if (!next || next.startsWith("-")) {
        out.push(source);
      }
    }
  }
  if (!hasSource) {
    out.splice(1, 0, "-s", source);
  }
  return out;
}

/** Rebases `source` according to `input` (`jj rebase`). */
export async function rebase(cwd: string, source: string, input: string): Promise<void> {
  const args = rebaseArgs(source, input);
  if (args.length > 0) {
    await runJj(cwd, args);
  }
}

/** Redoes the most recently undone operation (`jj redo`). */
export async function redo(cwd: string): Promise<void> {
  await runJj(cwd, ["redo"]);
}

/** Restores the given workspace-relative paths in the working copy from its parent(s). */
export async function restore(cwd: string, paths: string[]): Promise<void> {
  await runJj(cwd, ["restore", "--", ...paths.map(fileset)]);
}

/** Restores the selected working copy changes from `@-` (`jj restore`). */
export async function restoreChanges(cwd: string, selection: SelectedChanges): Promise<void> {
  await runWithSelection(cwd, ["restore"], selection);
}

/** Restores all changes in `revision` as compared to its parents (`jj restore -c`). */
export async function restoreRevision(cwd: string, revision: string): Promise<void> {
  await runJj(cwd, ["restore", "-c", revision]);
}

export interface SelectedChanges {
  /** Workspace-relative paths (including both sides of renames) to include in the operation. */
  paths: string[];
  /** Workspace-relative file path -> target file content for `$right` in partially selected files. */
  partialFiles: Map<string, string>;
}

async function runWithSelection(cwd: string, baseArgs: string[], selection?: SelectedChanges): Promise<void> {
  await withSelection(selection, (args) => runJj(cwd, [...baseArgs, ...args]));
}

/**
 * Calls `run` with the arguments that limit a jj command to `selection`: its
 * paths, plus a diff editor that writes partially selected files' content.
 * No selection means no arguments, so the command applies to everything.
 */
export async function withSelection<T>(
  selection: SelectedChanges | undefined,
  run: (args: string[]) => Promise<T>,
): Promise<T> {
  if (!selection) {
    return run([]);
  }
  const filesets = selection.paths.map(fileset);
  if (selection.partialFiles.size === 0) {
    return run(["--", ...filesets]);
  }
  const stagedDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "majj-select-"));
  try {
    for (const [relPath, content] of selection.partialFiles) {
      const target = path.join(stagedDir, relPath);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content);
    }
    const editArgs = JSON.stringify(["-rf", `${stagedDir}/.`, "$right/"]);
    return await run([
      "--tool",
      "majj",
      "--config",
      'merge-tools.majj.program="cp"',
      "--config",
      `merge-tools.majj.edit-args=${editArgs}`,
      "--",
      ...filesets,
    ]);
  } finally {
    await fs.promises.rm(stagedDir, { recursive: true, force: true });
  }
}

/** Records the working copy's files in a jj operation (`jj util snapshot`). */
export async function snapshot(cwd: string): Promise<void> {
  await runJj(cwd, ["util", "snapshot"]);
}

/** Splits the selected working copy changes into a parent commit (`jj split`). */
export async function split(cwd: string, selection: SelectedChanges): Promise<void> {
  await runWithSelection(cwd, ["split", "-m", ""], selection);
}

/**
 * Squashes the selected working copy changes (or all working copy changes if
 * none are selected) into `into`, or else `@-` (`jj squash`).
 */
export async function squash(cwd: string, selection?: SelectedChanges, into?: string): Promise<void> {
  const args = ["squash", "--config", 'ui.editor="true"', ...(into ? ["--into", into] : [])];
  await runWithSelection(cwd, args, selection);
}

/** Undoes the last operation (`jj undo`). */
export async function undo(cwd: string): Promise<void> {
  await runJj(cwd, ["undo"]);
}

/**
 * The repo directory shared by all workspaces of the repository. In the main
 * workspace `.jj/repo` is that directory; in secondary workspaces it is a file
 * containing the path to it.
 */
export function repoDir(root: string): string {
  const jjDir = path.join(root, ".jj");
  const repo = path.join(jjDir, "repo");
  if (fs.statSync(repo).isFile()) {
    return path.resolve(jjDir, fs.readFileSync(repo, "utf8").trim());
  }
  return repo;
}
