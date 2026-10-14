import { execFile } from "child_process";
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
  { color = false } = {},
): Promise<string> {
  const fullArgs = [
    "--no-pager",
    "--color",
    color ? "always" : "never",
    ...args,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      getConfig().jjPath,
      fullArgs,
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new JjError(stderr.trim() || error.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/** The root of the jj workspace containing `dir`. */
export async function findRoot(dir: string): Promise<string> {
  return (await runJj(dir, ["root"])).trim();
}
