import { showMenu } from "./menu";
import {
  defaultNewOptions,
  newArgs,
  NewOptions,
  parentsUnused,
  Revision,
  toggleParent,
  toggleRevision,
} from "./newOptions";
import { promptInput } from "./prompt";
import { pickRevision } from "./revisionPicker";

const list = (revisions: Revision[]) => revisions.map((r) => r.label).join(", ");

/**
 * Shows the jj new menu with `parent` as the starting parent until it's
 * closed, returning the `jj new` arguments to run, if any. `showHelp` shows
 * jj's help for the command.
 */
export async function newMenu(
  root: string,
  parent: Revision,
  showHelp: () => Promise<void>,
): Promise<string[] | undefined> {
  let options: NewOptions = defaultNewOptions(parent);
  for (;;) {
    const key = await showMenu("jj new", [
      {
        title: "Arguments",
        entries: [
          {
            keys: ["o", "r"],
            description: "Parents",
            value: parentsUnused(options) ? "(not used with -A or -B)" : list(options.parents),
          },
          { keys: ["m"], description: "Message", value: options.message ?? "" },
          { keys: ["e"], description: "Edit the new change", value: options.edit ? "on" : "off (--no-edit)" },
          { keys: ["A"], description: "Insert after", value: list(options.after) },
          { keys: ["B"], description: "Insert before", value: list(options.before) },
        ],
      },
      {
        title: "Actions",
        entries: [
          { keys: ["n"], description: "Create the new change" },
          { keys: ["h", "?"], description: "Show help for jj new" },
        ],
      },
    ]);
    switch (key) {
      case undefined:
        return undefined;
      case "n":
        return newArgs(options);
      case "o": {
        const revision = await pickRevision(root, "Parents", options.parents);
        if (revision) {
          options = toggleParent(options, revision);
        }
        break;
      }
      case "m": {
        const message = await promptInput("Message", { value: options.message });
        if (message !== undefined) {
          options = { ...options, message: message || undefined };
        }
        break;
      }
      case "e":
        options = { ...options, edit: !options.edit };
        break;
      case "A":
      case "B": {
        const field = key === "A" ? "after" : "before";
        const title = key === "A" ? "Insert after" : "Insert before";
        const revision = await pickRevision(root, title, options[field]);
        if (revision) {
          options = { ...options, [field]: toggleRevision(options[field], revision) };
        }
        break;
      }
      case "h":
        await showHelp();
        break;
    }
  }
}
