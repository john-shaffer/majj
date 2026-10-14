# List recipes
default:
    @just --list

# Build the extension into ./result
build:
    nix build .#majj

# Run every flake check
check:
    nix flake check

# Compile TypeScript into ./out, e.g. before launching the extension with F5
compile:
    nix develop -c npm run compile

# Format source files with sand
format:
    sand format $(jj file list | grep -E '\.(json|nix|ts)$|(^|/)justfile$' | grep -vE '(^|/)package-lock\.json$')
