{
  description = "majj: a Magit-style interface for Jujutsu (jj) in VS Code";

  # Latest stable nixpkgs
  inputs.nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      forAllSystems =
        f:
        lib.genAttrs [ "aarch64-darwin" "aarch64-linux" "x86_64-darwin" "x86_64-linux" ] (
          system:
          f (
            import nixpkgs {
              inherit system;
              # VS Code is only used to run the integration tests.
              config.allowUnfreePredicate = pkg: lib.getName pkg == "vscode";
            }
          )
        );
      manifest = lib.importJSON ./package.json;

      outputsFor =
        pkgs:
        let
          inherit (pkgs) stdenv;

          npmProject =
            args:
            pkgs.buildNpmPackage (
              {
                inherit (manifest) version;
                src = lib.fileset.toSource {
                  root = ./.;
                  fileset = lib.fileset.unions [
                    ./LICENSE
                    ./README.md
                    ./package-lock.json
                    ./package.json
                    ./src
                    ./tsconfig.json
                  ];
                };
                npmDepsHash = "sha256-MNt4i11JxjOanff66Qizov1IvZh7YMiFOKmnGMKnTc0=";
                npmBuildScript = "compile";
              }
              // args
            );

          # Compiled sources, tests included, with node_modules.
          build = npmProject {
            pname = "majj-build";
            installPhase = ''
              cp -r . $out
            '';
          };

          # Runs a test command against the build. It succeeds even when the
          # tests fail, so that Nix caches the result, and records the log and
          # exit status for the matching check to judge.
          testReport =
            name: nativeBuildInputs: command:
            pkgs.runCommand "majj-${name}-report" { inherit nativeBuildInputs; } ''
              cp -r ${build} majj
              chmod -R u+w majj
              cd majj
              export HOME=$TMPDIR
              mkdir $out
              set +e
              {
                ${command}
              } > $out/log 2>&1
              echo $? > $out/status
            '';

          checkReport =
            name: report:
            pkgs.runCommand "majj-${name}" { } ''
              if [ "$(cat ${report}/status)" != 0 ]; then
                cat ${report}/log >&2
                exit 1
              fi
              touch $out
            '';

          reports = {
            unit-tests = testReport "unit-tests" [ pkgs.nodejs ] "npm run test:unit";
          }
          // lib.optionalAttrs stdenv.hostPlatform.isLinux {
            vscode-tests =
              # MAJJ_TEST_VSCODE is the Electron binary: bin/code is the CLI
              # launcher, which detaches.
              testReport "vscode-tests"
                [
                  pkgs.jujutsu
                  pkgs.nodejs
                  pkgs.xvfb-run
                ]
                ''
                  MAJJ_TEST_VSCODE=${pkgs.vscode}/lib/vscode/code \
                    xvfb-run -a node out/test/integration/runTest.js
                '';
          };
        in
        {
          packages = {
            # An unpacked VS Code extension, usable with vscode-with-extensions
            # or home-manager's programs.vscode.extensions.
            default = self.packages.${stdenv.hostPlatform.system}.majj;
            majj = npmProject rec {
              pname = "vscode-extension-${manifest.publisher}-${manifest.name}";
              installPhase = ''
                runHook preInstall
                dir=$out/share/vscode/extensions/${passthru.vscodeExtUniqueId}
                mkdir -p $dir
                cp -r LICENSE README.md out package.json $dir/
                rm -rf $dir/out/test
                runHook postInstall
              '';
              passthru = {
                vscodeExtName = manifest.name;
                vscodeExtPublisher = manifest.publisher;
                vscodeExtUniqueId = "${manifest.publisher}.${manifest.name}";
              };
              meta = {
                inherit (manifest) description;
                license = lib.licenses.mit;
              };
            };
          }
          // lib.mapAttrs' (name: lib.nameValuePair "${name}-report") reports;

          checks = lib.mapAttrs checkReport reports;

          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.jujutsu
              pkgs.just
              pkgs.nodejs
            ];
          };
        };

      perSystem = forAllSystems outputsFor;
    in
    {
      checks = lib.mapAttrs (_: o: o.checks) perSystem;
      devShells = lib.mapAttrs (_: o: o.devShells) perSystem;
      # Adds the extension to pkgs.vscode-extensions.<publisher>.<name>,
      # alongside the extensions nixpkgs packages.
      overlays.default = final: prev: {
        vscode-extensions = prev.vscode-extensions // {
          ${manifest.publisher} = prev.vscode-extensions.${manifest.publisher} or { } // {
            ${manifest.name} = (outputsFor final).packages.majj;
          };
        };
      };
      packages = lib.mapAttrs (_: o: o.packages) perSystem;
    };
}
