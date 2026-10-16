import * as vscode from "vscode";

export type AutoRefreshMode = "off" | "poll" | "watch";

export interface MajjConfig {
  autoRefreshMode: AutoRefreshMode;
  jjPath: string;
  limit: number;
  pollIntervalSeconds: number;
  recentChanges: number;
  revset: string;
}

export function getConfig(): MajjConfig {
  const config = vscode.workspace.getConfiguration("majj");
  return {
    autoRefreshMode: config.get<AutoRefreshMode>("autoRefresh.mode", "watch"),
    jjPath: config.get<string>("jjPath") || "jj",
    limit: config.get<number>("status.limit", 50),
    pollIntervalSeconds: Math.max(1, config.get<number>("autoRefresh.pollInterval", 5)),
    recentChanges: config.get<number>("status.recentChanges", 10),
    revset: config.get<string>("status.revset", "").trim(),
  };
}
