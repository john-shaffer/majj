import * as vscode from "vscode";
import { StyledText, StyledTextBuilder } from "./ansi";
import { appendShow, DiffLine, FileDiff, FoldSpan, newLineNumber } from "./diff";
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
  private collapsedChunks = new Set<string>();
  private foldSpans = new Map<number, FoldSpan>();
  private diffLines = new Map<number, DiffLine>();
  private fileLines = new Map<number, FileDiff>();

  /** The file, relative to the root, and 1-based line of it that a line of the view shows. */
  locationAt(line: number): { path: string; line: number } | undefined {
    const diffLine = this.diffLines.get(line);
    if (diffLine) {
      return {
        path: diffLine.file.path,
        line: newLineNumber(diffLine.file, diffLine.chunkIndex, diffLine.lineIndex),
      };
    }
    const file = this.fileLines.get(line);
    return file && { path: file.path, line: 1 };
  }

  override toggleFold(line: number): number | undefined {
    const span = this.foldSpans.get(line);
    if (!span || this.rawShow === undefined) {
      return undefined;
    }
    const set = span.kind === "file" ? this.collapsedFiles : this.collapsedChunks;
    if (set.has(span.key)) {
      set.delete(span.key);
    } else {
      set.add(span.key);
    }
    this.update(this.renderShow(this.rawShow));
    return span.headerLine;
  }

  private renderShow(ansi: string): StyledText {
    const out = new StyledTextBuilder();
    this.diffLines = new Map();
    this.fileLines = new Map();
    this.foldSpans = appendShow(out, ansi, this.collapsedFiles, this.collapsedChunks, this.diffLines, this.fileLines);
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
      this.foldSpans.clear();
      this.diffLines.clear();
      this.fileLines.clear();
      const out = new StyledTextBuilder();
      appendError(out, e);
      return out.build();
    }
  }
}
