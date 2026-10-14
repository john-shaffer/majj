import * as vscode from "vscode";

export interface MajjConfig {
  jjPath: string;
  limit: number;
  revset: string;
}

export function getConfig(): MajjConfig {
  const config = vscode.workspace.getConfiguration("majj");
  return {
    jjPath: config.get<string>("jjPath") || "jj",
    limit: config.get<number>("status.limit", 50),
    revset: config.get<string>("status.revset", "").trim(),
  };
}
