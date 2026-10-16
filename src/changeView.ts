import * as vscode from "vscode";
import { StyledText, StyledTextBuilder } from "./ansi";
import { appendShow } from "./diff";
import { runJj } from "./jj";
import { appendError, SCHEME, View } from "./view";

/** `jj show` for one change, shown as the virtual document `majj:change.majj?<root>#<change ID>`. */
export class ChangeView extends View {
  static readonly path = "change.majj";

  static uriFor(root: string, change: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: SCHEME,
      path: ChangeView.path,
      query: root,
      fragment: change,
    });
  }

  protected async render(): Promise<StyledText> {
    const out = new StyledTextBuilder();
    try {
      appendShow(
        out,
        await runJj(this.root, ["show", "--stat", "--git", this.uri.fragment], {
          color: true,
        }),
      );
    } catch (e) {
      appendError(out, e);
    }
    return out.build();
  }
}
