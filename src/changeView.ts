import * as vscode from "vscode";
import { StyledText, StyledTextBuilder } from "./ansi";
import { appendShow, FileSpan } from "./diff";
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

  private rawShow?: string;
  private collapsedFiles = new Set<string>();
  private fileSpans = new Map<number, FileSpan>();

  override toggleFold(line: number): number | undefined {
    const span = this.fileSpans.get(line);
    if (!span || this.rawShow === undefined) {
      return undefined;
    }
    if (this.collapsedFiles.has(span.path)) {
      this.collapsedFiles.delete(span.path);
    } else {
      this.collapsedFiles.add(span.path);
    }
    this.update(this.renderShow(this.rawShow));
    return span.headerLine;
  }

  private renderShow(ansi: string): StyledText {
    const out = new StyledTextBuilder();
    this.fileSpans = appendShow(out, ansi, this.collapsedFiles);
    return out.build();
  }

  protected async render(): Promise<StyledText> {
    try {
      this.rawShow = await runJj(this.root, ["show", "--git", this.uri.fragment], {
        color: true,
      });
      return this.renderShow(this.rawShow);
    } catch (e) {
      this.rawShow = undefined;
      this.fileSpans.clear();
      const out = new StyledTextBuilder();
      appendError(out, e);
      return out.build();
    }
  }
}
