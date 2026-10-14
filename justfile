# List recipes
default:
    @just --list

# Build the extension into ./result
build: _snapshot
    nix build .#majj

# Run every flake check, printing the test log of any that fail
check: _snapshot
    #!/usr/bin/env bash
    set -euo pipefail
    system=$(nix eval --impure --raw --expr builtins.currentSystem)
    for name in $(nix eval --raw ".#checks.$system" --apply 'c: toString (builtins.attrNames c)'); do
        just _check "$name"
    done

# Compile TypeScript into ./out, e.g. before launching the extension with F5
compile:
    nix develop -c npm run compile

# Format source files with sand
format:
    sand format $(jj file list | grep -E '\.(json|nix|ts)$|(^|/)justfile$' | grep -vE '(^|/)package-lock\.json$')

# Run the unit tests
test-unit: (_check "unit-tests")

# Build a test report and fail with its log if the tests failed
_check name: _snapshot
    #!/usr/bin/env bash
    set -euo pipefail
    report=$(nix build --no-link --print-out-paths ".#{{ name }}-report")
    status=$(cat "$report/status")
    if [[ $status != 0 ]]; then
        cat "$report/log"
        echo "{{ name }} failed with exit status $status" >&2
        exit 1
    fi
    echo "{{ name }}: passed"

# Nix reads the git index, which jj only updates when it snapshots the working copy
_snapshot:
    @jj util snapshot
