import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { stripAnsi } from "./ansi";
import { getConfig } from "./config";

export class JjError extends Error {
  /** The error output as jj printed it, possibly with color escapes. */
  constructor(readonly output: string) {
    super(stripAnsi(output));
  }
}

export function runJj(cwd: string, args: string[], { color = false } = {}): Promise<string> {
  const fullArgs = ["--no-pager", "--color", color ? "always" : "never", ...args];
  return new Promise((resolve, reject) => {
    execFile(getConfig().jjPath, fullArgs, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
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

/** The root of the jj workspace containing `dir`. */
export async function findRoot(dir: string): Promise<string> {
  return (await runJj(dir, ["root"])).trim();
}

/** A `root-file:` fileset pattern for an exact workspace-relative path. */
function fileset(file: string): string {
  return `root-file:"${file.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Makes `revision` the working copy change (`jj edit`). */
export async function edit(cwd: string, revision: string): Promise<void> {
  await runJj(cwd, ["edit", revision]);
}

/** Restores the given workspace-relative paths in the working copy from its parent(s). */
export async function restore(cwd: string, paths: string[]): Promise<void> {
  await runJj(cwd, ["restore", "--", ...paths.map(fileset)]);
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
