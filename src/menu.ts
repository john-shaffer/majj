import * as vscode from "vscode";
import { openPrompt } from "./prompt";

export interface MenuEntry {
  /** Keys that choose the entry. The first one is what showMenu returns. */
  keys: string[];
  description: string;
  /** The current value of an option, shown after the description. */
  value?: string;
}

export interface MenuSection {
  title: string;
  entries: MenuEntry[];
}

interface MenuItem extends vscode.QuickPickItem {
  entry?: MenuEntry;
}

/**
 * Shows a menu where typing an entry's key, or enter on it, chooses it.
 * Resolves with the entry's first key, or undefined if the menu is closed
 * with escape or `q`.
 */
export function showMenu(title: string, sections: MenuSection[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const quickPick = vscode.window.createQuickPick<MenuItem>();
    quickPick.title = title;
    quickPick.placeholder = "Type a key";
    quickPick.items = sections.flatMap((section): MenuItem[] => [
      { label: section.title, kind: vscode.QuickPickItemKind.Separator },
      ...section.entries.map((entry) => ({
        label: entry.keys.join(" "),
        description: entry.value === undefined ? entry.description : `${entry.description}  ${entry.value}`,
        entry,
      })),
    ]);
    const entries = sections.flatMap((s) => s.entries);

    const finish = (key: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      close();
      quickPick.hide();
      resolve(key);
    };

    const choose = (input: string) => {
      const entry = entries.find((e) => e.keys.includes(input));
      if (entry) {
        finish(entry.keys[0]);
      } else if (input === "q") {
        finish(undefined);
      }
    };

    const close = openPrompt({ title, answer: choose });
    const subscriptions = [
      quickPick.onDidChangeValue((value) => {
        if (value) {
          quickPick.value = "";
          choose(value);
        }
      }),
      quickPick.onDidAccept(() => {
        const entry = quickPick.activeItems[0]?.entry;
        if (entry) {
          finish(entry.keys[0]);
        }
      }),
      quickPick.onDidHide(() => {
        subscriptions.forEach((s) => s.dispose());
        quickPick.dispose();
        finish(undefined);
      }),
    ];
    quickPick.show();
  });
}
