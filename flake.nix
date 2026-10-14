{
  description = "majj: a Magit-style interface for Jujutsu (jj) in VS Code";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      forAllSystems =
        f:
        lib.genAttrs [ "aarch64-darwin" "aarch64-linux" "x86_64-darwin" "x86_64-linux" ] (
          system: f nixpkgs.legacyPackages.${system}
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
                npmDepsHash = "sha256-Bzm19EXNse2MFDQWs9xRbokIAq/PFvhbNeB+uR58KCs=";
                npmBuildScript = "compile";
              }
              // args
            );
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
          };

          checks = { };

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
      packages = lib.mapAttrs (_: o: o.packages) perSystem;
    };
}
