import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { test } from "./index";

/** The scopes of each line's tokens, from the TextMate libraries VS Code itself ships. */
async function tokenize(lines: string[]): Promise<{ text: string; scopes: string[] }[][]> {
  const modules = path.join(vscode.env.appRoot, "node_modules");
  const textmate = require(path.join(modules, "vscode-textmate"));
  const oniguruma = require(path.join(modules, "vscode-oniguruma"));
  await oniguruma.loadWASM(fs.readFileSync(path.join(modules, "vscode-oniguruma", "release", "onig.wasm")).buffer);
  const grammars: Record<string, string> = {
    "source.diff": path.join(vscode.env.appRoot, "extensions", "diff", "syntaxes", "diff.tmLanguage.json"),
    "text.jjdescription": path.join(
      vscode.extensions.getExtension("jdsha.majj")!.extensionPath,
      "syntaxes",
      "jjdescription.tmLanguage.json",
    ),
  };
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
      createOnigString: (s: string) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scope: string) =>
      grammars[scope] && textmate.parseRawGrammar(fs.readFileSync(grammars[scope], "utf8"), grammars[scope]),
  });
  const grammar = await registry.loadGrammar("text.jjdescription");
  let state = textmate.INITIAL;
  return lines.map((line) => {
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    return result.tokens.map((t: { startIndex: number; endIndex: number; scopes: string[] }) => ({
      text: line.slice(t.startIndex, t.endIndex),
      scopes: t.scopes,
    }));
  });
}

test("description editors highlight JJ: lines, long subjects, and the diff below ignore-rest", async () => {
  const long = "x".repeat(50) + "y".repeat(22) + "z";
  const lines = [
    long,
    "",
    "JJ: This commit contains the following changes:",
    "JJ:     A added.txt",
    "JJ:     M modified.txt",
    "JJ:     D deleted.txt",
    "JJ: ignore-rest",
    "JJ: Everything below it will be ignored.",
    "diff --git a/added.txt b/added.txt",
    "@@ -0,0 +1,1 @@",
    "+added",
    'JJ: Lines starting with "JJ:" (like this one) will be removed.',
  ];
  const tokens = await tokenize(lines);
  const scopesOf = (line: number, text: string) => {
    const token = tokens[line].find((t) => t.text.includes(text));
    assert.ok(token, `no token with ${JSON.stringify(text)} in ${JSON.stringify(tokens[line])}`);
    return token.scopes;
  };
  assert.ok(scopesOf(0, "yyy").includes("invalid.deprecated.line-too-long.jjdescription"));
  assert.ok(scopesOf(0, "z").includes("invalid.illegal.line-too-long.jjdescription"));
  assert.ok(!scopesOf(0, "xxx").some((s) => s.startsWith("invalid")));
  assert.ok(scopesOf(2, "JJ:").includes("comment.line.jjdescription"));
  assert.ok(scopesOf(3, "A added.txt").includes("markup.inserted.jjdescription"));
  assert.ok(scopesOf(4, "M modified.txt").includes("markup.changed.jjdescription"));
  assert.ok(scopesOf(5, "D deleted.txt").includes("markup.deleted.jjdescription"));
  for (const line of [6, 7, 11]) {
    assert.ok(scopesOf(line, "JJ:").includes("comment.line.jjdescription"), lines[line]);
  }
  assert.ok(scopesOf(9, "@@").some((s) => s.startsWith("meta.diff.range")));
  assert.ok(scopesOf(10, "added").some((s) => s.startsWith("markup.inserted.diff")));
});
