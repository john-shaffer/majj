# majj

A [Magit](https://magit.vc/)-style interface for [Jujutsu (jj)](https://github.com/jj-vcs/jj) in VS Code,
in the spirit of [edamagit](https://github.com/kahole/edamagit).

Early days: for now there is a status view, a change view, and a help view.

## Status view

Run **Majj: Status** (`alt+x j`) to open `status.majj` for the jj workspace of the
active file (or the first workspace folder in a jj repo). Outside of any jj repo,
the view says so and how to create one. It shows `jj status`
followed by the change graph from `jj log`, with jj's own colors:

```
Working copy  (@) : kmsumtwq ffd642af (no description set)
Parent commit (@-): rlprsrnn 36f55765 master | Retry requests rejected for an expired signature

Working copy changes:
[ ] A c.txt

Changes:
@  kmsumtwq jdsha@pm.me 2026-10-14 12:29:28 ffd642af
│  (no description set)
○  rlprsrnn jdsha@pm.me 2026-10-14 11:01:18 master 36f55765
│  Retry requests rejected for an expired signature
```

Press `g` in the view to refresh it, `?` to open `help.majj`, `q` to close a
view, `ctrl+z` / `ctrl+y` to run `jj undo` / `jj redo`, `enter` on a change in
the graph to open `change.majj` with its `jj show` output, `a` on a change or
commit to run `jj abandon` on it, `e` to run `jj edit` on it, or `r` to run
`jj rebase` on it. Like magit's revision buffer, `change.majj` and `help.majj`
open as preview tabs, which the next one you open replaces. Press `enter` on a
file under "Working copy changes" to open the file, `tab` on a file or diff
chunk to show or hide it (also in `change.majj`), `space` on a file, chunk, or
changed line to toggle its selection (`[ ]` / `[◐]` / `[●]`), `c` to commit the
selected changes, or the whole working copy if none are selected (`jj commit`),
opening the description for editing if it has none, `s` to split the selected
changes (`jj split`), `S` to squash changes (`jj squash`), `X` to restore
changes (`jj restore`), or `k` to discard a file, chunk, or changed lines after
a `y`/`n` confirmation.

When jj needs a description, majj opens jj's draft in an editor tab, with the
change's diff below a `JJ: ignore-rest` line, which jj ignores along with
everything after it. Press `ctrl+c ctrl+c` to save it and finish, or
`ctrl+c ctrl+k` to cancel. Closing the tab finishes with what was last saved,
and a description with nothing but `JJ:` lines cancels. jj runs majj's own
helper as its editor, so this doesn't depend on the `code` command.

majj opens these in an editor group other than the active one: the first group,
or the second if the first is active, splitting the editor if there's only one. An open status view is shown in the group it's already in.

## Keybindings

| Command                              | Default         | When                       |
| ------------------------------------ | --------------- | -------------------------- |
| `majj.abandon`                       | `a`             | in the status view         |
| `majj.cancelEditing`                 | `ctrl+c ctrl+k` | in a description editor    |
| `majj.commit`                        | `c`             | in the status view         |
| `majj.discard`                       | `k`             | in the status view         |
| `majj.edit`                          | `e`             | in the status view         |
| `majj.finishEditing`                 | `ctrl+c ctrl+c` | in a description editor    |
| `majj.help`                          | `?`             | in majj views              |
| `majj.rebase`                        | `r`             | in the status view         |
| `majj.redo`                          | `ctrl+y`        | in majj views              |
| `majj.refresh`                       | `g`             | in majj views              |
| `majj.restore`                       | `X`             | in the status view         |
| `majj.split`                         | `s`             | in the status view         |
| `majj.squash`                        | `S`             | in the status view         |
| `majj.status`                        | `alt+x j`       | anywhere                   |
| `majj.toggleFold`                    | `tab`           | in status and change views |
| `majj.toggleSelect`                  | `space`         | in the status view         |
| `majj.undo`                          | `ctrl+z`        | in majj views              |
| `majj.visit`                         | `enter`         | in the status view         |
| `workbench.action.closeActiveEditor` | `q`             | in majj views              |

Change them in **Preferences: Open Keyboard Shortcuts** (search for "majj"), or in
`keybindings.json`:

```json
{ "key": "ctrl+c j", "command": "majj.status" },
{ "key": "alt+x j", "command": "-majj.status" }
```

## Settings

| Setting                         | Default | Description |
| ------------------------------- | ------- | ----------- |
| `majj.autoRefresh.mode`         | `watch` | `off`, `poll`, or `watch`. |
| `majj.autoRefresh.pollInterval` | `5`     | Seconds between refreshes in `poll` mode. |
| `majj.jjPath`                   | `jj`    | jj executable. Only settable in user (not workspace) settings, so a repo can't choose what majj runs. |
| `majj.status.limit`             | `50`    | Maximum changes in the graph (0 = no limit). |
| `majj.status.recentChanges`     | `10`    | Ancestors of `@` always shown in the graph when `status.revset` is empty. |
| `majj.status.revset`            | `""`    | Revset for the change graph; empty uses jj's `revsets.log`. |

jj has no way to subscribe to repository changes (its watchman integration only
speeds up snapshots), so `watch` mode watches jj's operation heads
(`.jj/repo/op_heads`), which change after every jj operation, plus the files in
the workspace. `poll` mode re-runs jj on a timer instead, which helps where file
watching is unreliable (e.g. network file systems). Both apply to the status and
change views. Either way, refreshes only run while a view is visible; a hidden
view catches up when it is shown again.

Note that refreshing runs `jj status` or `jj show`, which snapshot the working
copy, just as running jj in a terminal does.

## Development

Recipes are in the [justfile](justfile) (`just` lists them):

```sh
just build        # the extension, into ./result
just check        # every flake check: unit tests, and VS Code integration tests on Linux
just format       # format sources with sand
just test-unit
just test-vscode
```

The integration tests run a real VS Code under Xvfb inside the Nix sandbox.
For interactive development, `nix develop`, then `npm install` and press F5 in
VS Code to launch an Extension Development Host.

`just build` produces the extension under `result/share/vscode/extensions/jdsha.majj`,
usable with `vscode-with-extensions` or home-manager's `programs.vscode`.

## License

[MIT](LICENSE)
