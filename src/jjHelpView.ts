import * as vscode from "vscode";
import { StyledText, StyledTextBuilder } from "./ansi";
import { runJj } from "./jj";
import { appendError, SCHEME, View } from "./view";

/** jj's help for a command, shown as the virtual document `majj:jj-help.majj?<root>#<command>`. */
export class JjHelpView extends View {
  static readonly path = "jj-help.majj";

  static uriFor(root: string, command: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: SCHEME,
      path: JjHelpView.path,
      query: root,
      fragment: command,
    });
  }

  override configure() {
    // Help does not depend on repository changes.
  }

  protected async render(): Promise<StyledText> {
    const out = new StyledTextBuilder();
    try {
      out.appendAnsi(await runJj(this.root, ["help", ...this.uri.fragment.split(" ")], { color: true }));
    } catch (e) {
      appendError(out, e);
    }
    return out.build();
  }
}
