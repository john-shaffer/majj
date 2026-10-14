// Launches VS Code with the extension under development on a scratch jj repo
// and runs ./suite inside its extension host.
//
// MAJJ_TEST_VSCODE can point to a VS Code Electron binary (not the `code` CLI
// launcher, which detaches), as the flake's vscode-tests check does; otherwise
// @vscode/test-electron downloads VS Code.

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

function makeFixtureRepo(dir: string, env: NodeJS.ProcessEnv) {
  const jj = (...args: string[]) =>
    execFileSync("jj", args, { cwd: dir, env, stdio: "pipe" });
  fs.mkdirSync(dir, { recursive: true });
  jj("git", "init");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  jj("commit", "-m", "First change");
  jj("bookmark", "create", "feature", "-r", "@-");
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  jj("commit", "-m", "Second change");
  jj("new", "--no-edit", "root()", "-m", "Sibling change");
  jj("new", "--no-edit", "@", "-m", "Descendant change");
  fs.writeFileSync(path.join(dir, "c.txt"), "c\n");
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "majj-test-"));
  const repo = path.join(tmp, "repo");
  // Keep the user's jj config (templates, colors, revsets) out of the test.
  const jjConfig = path.join(tmp, "jj-config.toml");
  fs.writeFileSync(
    jjConfig,
    '[user]\nname = "Majj Test"\nemail = "majj-test@example.com"\n',
  );
  const env = { ...process.env, JJ_CONFIG: jjConfig };
  makeFixtureRepo(repo, env);

  try {
    await runTests({
      vscodeExecutablePath: process.env.MAJJ_TEST_VSCODE || undefined,
      extensionDevelopmentPath: path.resolve(__dirname, "../../.."),
      extensionTestsPath: path.resolve(__dirname, "suite"),
      extensionTestsEnv: { JJ_CONFIG: jjConfig, MAJJ_TEST_REPO: repo },
      launchArgs: [
        repo,
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        "--user-data-dir",
        path.join(tmp, "user-data"),
        "--extensions-dir",
        path.join(tmp, "extensions"),
      ],
    });
  } catch (e) {
    console.error("VS Code tests failed:", e);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

void main();
