# majj

A [Magit](https://magit.vc/)-style interface for [Jujutsu (jj)](https://github.com/jj-vcs/jj) in VS Code,
in the spirit of [edamagit](https://github.com/kahole/edamagit).

Early days: for now there is only a status view.

## Status view

Run **Majj: Status** (`alt+x j`) to open `status.majj` for the jj workspace of the
active file (or the first workspace folder in a jj repo). It shows `jj status`
followed by the change graph from `jj log`, with jj's own colors:

```
Working copy changes:
A c.txt
Working copy  (@) : kmsumtwq ffd642af (no description set)
Parent commit (@-): rlprsrnn 36f55765 master | Retry requests rejected for an expired signature

Changes:
@  kmsumtwq jdsha@pm.me 2026-10-14 12:29:28 ffd642af
│  (no description set)
○  rlprsrnn jdsha@pm.me 2026-10-14 11:01:18 master 36f55765
│  Retry requests rejected for an expired signature
```

Press `g` in the view to refresh it.

## Keybindings

| Command        | Default  | When                 |
| -------------- | -------- | -------------------- |
| `majj.refresh` | `g`      | in the status view   |
| `majj.status`  | `alt+x j` | anywhere            |

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
| `majj.jjPath`                   | `jj`    | jj executable. |
| `majj.status.limit`             | `50`    | Maximum changes in the graph (0 = no limit). |
| `majj.status.revset`            | `""`    | Revset for the change graph; empty uses jj's `revsets.log`. |

jj has no way to subscribe to repository changes (its watchman integration only
speeds up snapshots), so `watch` mode watches jj's operation heads
(`.jj/repo/op_heads`), which change after every jj operation, plus the files in
the workspace. `poll` mode re-runs jj on a timer instead, which helps where file
watching is unreliable (e.g. network file systems). Either way, refreshes only run
while the view is visible; a hidden view catches up when it is shown again.

Note that refreshing runs `jj status`, which snapshots the working copy, just as
running jj in a terminal does.

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
