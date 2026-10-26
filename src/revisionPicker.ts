import * as vscode from "vscode";
import { getConfig } from "./config";
import { ENTRY_ID, runJj } from "./jj";
import { Revision } from "./newOptions";
import { openPrompt } from "./prompt";
import { graphRevset } from "./statusView";

/** One line of JSON per change: [entry ID, change ID, commit ID, bookmarks, description, author, age]. */
const CHANGE_TEMPLATE = `"[" ++ ${[
  `${ENTRY_ID}.escape_json()`,
  "stringify(change_id.shortest(8)).escape_json()",
  "stringify(commit_id.shortest(8)).escape_json()",
  'stringify(bookmarks.map(|b| b.name()).join(" ")).escape_json()',
  "description.first_line().escape_json()",
  "stringify(author.email()).escape_json()",
  "stringify(committer.timestamp().ago()).escape_json()",
].join(' ++ "," ++ ')} ++ "]\\n"`;

interface ChangeInfo {
  id: string;
  changeId: string;
  commitId: string;
  bookmarks: string;
  description: string;
  author: string;
  age: string;
}

async function logChanges(root: string, revset: string | undefined, limit: number): Promise<ChangeInfo[]> {
  const args = ["log", "--no-graph", "--ignore-working-copy", "-T", CHANGE_TEMPLATE];
  if (revset) {
    args.push("-r", revset);
  }
  if (limit > 0) {
    args.push("--limit", String(limit));
  }
  const out = await runJj(root, args);
  return out
    .split("\n")
    .filter((line) => line)
    .map((line) => {
      const [id, changeId, commitId, bookmarks, description, author, age] = JSON.parse(line) as string[];
      return { id, changeId, commitId, bookmarks, description, author, age };
    });
}

interface RevisionItem extends vscode.QuickPickItem {
  revision?: Revision;
}

const CHECK = "$(check) ";

function changeItem(change: ChangeInfo, selected: ReadonlySet<string>, alwaysShow = false): RevisionItem {
  const description = change.description || "(no description set)";
  return {
    label: `${selected.has(change.id) ? CHECK : ""}${change.changeId}`,
    description: change.bookmarks ? `${change.bookmarks}  ${description}` : description,
    detail: `${change.author}  ${change.age}  ${change.commitId}`,
    alwaysShow,
    revision: { revset: change.id, label: change.bookmarks.split(" ")[0] || change.changeId },
  };
}

function separator(label: string): RevisionItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}

/**
 * Lets the user pick a change from the change graph, matching on its IDs,
 * bookmarks, description, and author, or type a revset, whose changes are
 * shown as it's typed. Changes in `selected` are marked with a check.
 */
export function pickRevision(root: string, title: string, selected: Revision[]): Promise<Revision | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const selectedRevsets = new Set(selected.map((r) => r.revset));
    const quickPick = vscode.window.createQuickPick<RevisionItem>();
    quickPick.title = title;
    quickPick.placeholder = "Type to match changes, or a revset";
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.busy = true;

    let graphItems: RevisionItem[] = [];
    let revsetItems: RevisionItem[] = [];
    // Selected revsets that aren't changes in the graph, such as typed ones.
    const otherSelected = (): RevisionItem[] => {
      const shown = new Set(graphItems.map((i) => i.revision?.revset));
      const others = selected.filter((r) => !shown.has(r.revset));
      return others.length === 0
        ? []
        : [separator("Selected"), ...others.map((revision) => ({ label: CHECK + revision.label, revision }))];
    };
    const render = () => {
      const revsetIds = new Set(revsetItems.map((i) => i.revision?.revset));
      quickPick.items = [
        ...revsetItems,
        ...otherSelected(),
        ...(revsetItems.length > 0 ? [separator("Changes")] : []),
        ...graphItems.filter((i) => !revsetIds.has(i.revision?.revset)),
      ];
    };

    const { limit, recentChanges, revset } = getConfig();
    const loaded = (async () => {
      try {
        const graph = await logChanges(root, revset || (await graphRevset(root, recentChanges)), limit);
        graphItems = graph.map((c) => changeItem(c, selectedRevsets));
      } catch (e) {
        void vscode.window.showErrorMessage(`majj: ${e instanceof Error ? e.message : e}`);
      }
      quickPick.busy = false;
      render();
    })();

    // The latest evaluation of the typed text as a revset.
    let evaluated: Promise<void> = Promise.resolve();
    let generation = 0;
    const evaluate = (text: string) => {
      const current = ++generation;
      evaluated = (async () => {
        let items: RevisionItem[] = [];
        if (text) {
          try {
            const changes = await logChanges(root, text, 50);
            if (changes.length > 1) {
              items.push({
                label: text,
                description: `all ${changes.length}${changes.length === 50 ? "+" : ""} changes in the revset`,
                alwaysShow: true,
                revision: { revset: text, label: text },
              });
            }
            items.push(...changes.map((c) => changeItem(c, selectedRevsets, true)));
            items = [separator(`Revset ${text}`), ...items];
          } catch {
            // Not a valid revset (yet), so just match the changes in the graph.
          }
        }
        await loaded;
        if (current === generation) {
          revsetItems = items;
          render();
        }
      })();
    };

    const finish = (revision: Revision | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      close();
      quickPick.hide();
      resolve(revision);
    };

    // Takes the highlighted change, or else the text as a revset.
    const accept = () => {
      const text = quickPick.value.trim();
      finish(quickPick.activeItems[0]?.revision ?? (text ? { revset: text, label: text } : undefined));
    };

    const close = openPrompt({
      title,
      // Types `input`, then takes what the typed revset matches, without
      // depending on which item VS Code highlights.
      answer: (input) => {
        quickPick.value = input;
        evaluate(input.trim());
        void evaluated.then(() =>
          finish(revsetItems.find((i) => i.revision)?.revision ?? { revset: input.trim(), label: input.trim() }),
        );
      },
    });

    let timer: NodeJS.Timeout | undefined;
    const subscriptions = [
      quickPick.onDidChangeValue((value) => {
        clearTimeout(timer);
        timer = setTimeout(() => evaluate(value.trim()), 150);
      }),
      quickPick.onDidAccept(() => void evaluated.then(accept)),
      quickPick.onDidHide(() => {
        clearTimeout(timer);
        subscriptions.forEach((s) => s.dispose());
        quickPick.dispose();
        finish(undefined);
      }),
    ];
    quickPick.show();
  });
}
