// Renders help.majj from package.json's default keybindings and any user
// overrides in keybindings.json.

import { Style, StyledText, StyledTextBuilder } from "./ansi";

const HEADER: Style = { bold: true };
const KEY: Style = { fg: { kind: "ansi", index: 4 } };

export interface Keybinding {
  command: string;
  key?: string;
  when?: string;
}

interface HelpEntry {
  command: string;
  description: string;
}

const ESSENTIAL: HelpEntry[] = [
  { command: "majj.refresh", description: "refresh current buffer" },
  { command: "majj.toggleFold", description: "toggle section at point" },
  { command: "majj.toggleSelect", description: "toggle selection at point" },
  { command: "majj.visit", description: "visit thing at point" },
  { command: "majj.abandon", description: "abandon change at point" },
  { command: "majj.commit", description: "commit working copy" },
  { command: "majj.edit", description: "edit change at point" },
  { command: "majj.discard", description: "discard at point" },
  { command: "majj.rebase", description: "rebase change at point" },
  { command: "majj.split", description: "split selected changes" },
  { command: "majj.squash", description: "squash changes" },
  { command: "majj.restore", description: "restore changes" },
  { command: "majj.undo", description: "undo last operation" },
  { command: "majj.redo", description: "redo last undone operation" },
  { command: "workbench.action.closeActiveEditor", description: "exit / close majj view" },
];

export function displayKey(key: string): string {
  if (/^shift[+-][a-zA-Z]$/.test(key)) {
    return key.slice(6).toUpperCase();
  }
  if (key === "enter") {
    return "RET";
  }
  if (key === "space") {
    return "SPC";
  }
  if (key === "tab") {
    return "TAB";
  }
  if (key === "shift+/" || key === "shift+-") {
    return "?";
  }
  return key;
}

/**
 * Parses a JSON with Comments (`keybindings.json`) array of keybindings.
 * Malformed files return an empty list so that help still renders with defaults.
 */
export function parseKeybindingsJson(jsonc: string): Keybinding[] {
  const stripped = jsonc
    .replace(/"(?:\\.|[^"\\])*"|\/\/.*$|\/\*[\s\S]*?\*\//gm, (m) => (m.startsWith('"') ? m : ""))
    .replace(/,\s*([\]}])/g, "$1");
  try {
    const parsed: unknown = JSON.parse(stripped);
    return Array.isArray(parsed) ? (parsed as Keybinding[]) : [];
  } catch {
    return [];
  }
}

export function resolveBindings(defaults: Keybinding[], user: Keybinding[] = []): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const bind of defaults) {
    if (bind?.command && bind.key) {
      bindings.set(bind.command, displayKey(bind.key));
    }
  }
  for (const bind of user) {
    if (!bind || typeof bind.command !== "string") {
      continue;
    }
    if (bind.command.startsWith("-")) {
      continue;
    }
    if (typeof bind.key === "string" && bind.key) {
      // For non-majj commands (such as workbench.action.closeActiveEditor),
      // only pick up bindings scoped to majj views.
      if (bind.command.startsWith("majj.") || bind.when?.includes("majj")) {
        bindings.set(bind.command, displayKey(bind.key));
      }
    }
  }
  return bindings;
}

export function renderHelp(defaults: Keybinding[], user: Keybinding[] = []): StyledText {
  const bindings = resolveBindings(defaults, user);
  const out = new StyledTextBuilder();
  out.append("Essential commands", HEADER).newline();
  const rows = ESSENTIAL.filter((e) => bindings.has(e.command));
  const width = Math.max(9, ...rows.map((e) => bindings.get(e.command)!.length + 2));
  for (const entry of rows) {
    const key = bindings.get(entry.command)!;
    out
      .append("  ")
      .append(key, KEY)
      .append(" ".repeat(width - key.length))
      .append(entry.description)
      .newline();
  }
  return out.build();
}
