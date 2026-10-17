import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { StyledText } from "./ansi";
import { Keybinding, parseKeybindingsJson, renderHelp } from "./help";
import { SCHEME, View } from "./view";

/** The help buffer, shown as the virtual document `majj:help.majj?<root>`. */
export class HelpView extends View {
  static readonly path = "help.majj";

  static uriFor(root: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: SCHEME,
      path: HelpView.path,
      query: root,
    });
  }

  private readonly defaults: Keybinding[];
  private readonly keybindingsPath: string;

  constructor(uri: vscode.Uri, onDidUpdate: (view: View) => void, context: vscode.ExtensionContext) {
    super(uri, onDidUpdate);
    this.defaults = context.extension.packageJSON?.contributes?.keybindings ?? [];
    this.keybindingsPath = path.join(context.globalStorageUri.fsPath, "..", "..", "keybindings.json");
  }

  override configure() {
    // Help does not depend on repository changes.
  }

  protected async render(): Promise<StyledText> {
    let user: Keybinding[] = [];
    try {
      user = parseKeybindingsJson(await fs.readFile(this.keybindingsPath, "utf8"));
    } catch {
      // No user keybindings.json; render with defaults.
    }
    return renderHelp(this.defaults, user);
  }
}
