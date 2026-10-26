// The arguments the jj new menu builds up before running `jj new`.

/** A revset chosen in the menu, with a short label to show for it. */
export interface Revision {
  revset: string;
  label: string;
}

export interface NewOptions {
  /** Revisions to insert the new change after (`-A`). */
  after: Revision[];
  /** Revisions to insert the new change before (`-B`). */
  before: Revision[];
  /** Whether to edit the new change; false passes `--no-edit`. */
  edit: boolean;
  message?: string;
  parents: Revision[];
  /** The parents are still the starting point, which the first pick replaces. */
  parentsAreDefault: boolean;
}

export function defaultNewOptions(parent: Revision): NewOptions {
  return { after: [], before: [], edit: true, parents: [parent], parentsAreDefault: true };
}

/** `revisions` without `revision` if it has it, or else with it added. */
export function toggleRevision(revisions: Revision[], revision: Revision): Revision[] {
  return revisions.some((r) => r.revset === revision.revset)
    ? revisions.filter((r) => r.revset !== revision.revset)
    : [...revisions, revision];
}

/** Toggles `revision` as a parent, except that it replaces the default parent. */
export function toggleParent(options: NewOptions, revision: Revision): NewOptions {
  return {
    ...options,
    parents: options.parentsAreDefault ? [revision] : toggleRevision(options.parents, revision),
    parentsAreDefault: false,
  };
}

/**
 * Whether the parents are left out of the command: jj new doesn't take them
 * along with `-A` or `-B`, so the default parent gives way to those.
 */
export function parentsUnused(options: NewOptions): boolean {
  return options.parentsAreDefault && (options.after.length > 0 || options.before.length > 0);
}

export function newArgs(options: NewOptions): string[] {
  const args = ["new"];
  if (options.message !== undefined) {
    args.push("-m", options.message);
  }
  if (!options.edit) {
    args.push("--no-edit");
  }
  for (const { revset } of options.after) {
    args.push("-A", revset);
  }
  for (const { revset } of options.before) {
    args.push("-B", revset);
  }
  if (!parentsUnused(options)) {
    args.push("--", ...options.parents.map((p) => p.revset));
  }
  return args;
}
