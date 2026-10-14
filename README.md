# majj

A [Magit](https://magit.vc/)-style interface for [Jujutsu (jj)](https://github.com/jj-vcs/jj) in VS Code,
in the spirit of [edamagit](https://github.com/kahole/edamagit).

## Development

Recipes are in the [justfile](justfile) (`just` lists them):

```sh
just build        # the extension, into ./result
just check        # every flake check
just format       # format sources with sand
```

For interactive development, `nix develop`, then `npm install` and press F5 in
VS Code to launch an Extension Development Host.

`just build` produces the extension under `result/share/vscode/extensions/jdsha.majj`,
usable with `vscode-with-extensions` or home-manager's `programs.vscode`.

## License

[MIT](LICENSE)
