import * as vscode from "vscode";
import { Color, Style, StyledText, styleKey } from "./ansi";

const ANSI_NAMES = [
  "Black",
  "Red",
  "Green",
  "Yellow",
  "Blue",
  "Magenta",
  "Cyan",
  "White",
];

function toCssColor(color: Color): string | vscode.ThemeColor {
  if (color.kind === "rgb") {
    return `rgb(${color.r}, ${color.g}, ${color.b})`;
  }
  const name = ANSI_NAMES[color.index % 8];
  return new vscode.ThemeColor(
    color.index < 8 ? `terminal.ansi${name}` : `terminal.ansiBright${name}`,
  );
}

function toDecorationOptions(style: Style): vscode.DecorationRenderOptions {
  return {
    color: style.fg && toCssColor(style.fg),
    backgroundColor: style.bg && toCssColor(style.bg),
    fontWeight: style.bold ? "bold" : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration: style.underline ? "underline" : undefined,
    opacity: style.dim ? "0.6" : undefined,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  };
}

/** Paints StyledText spans onto editors, sharing one decoration type per distinct style. */
export class Decorator implements vscode.Disposable {
  private types = new Map<string, vscode.TextEditorDecorationType>();

  apply(editor: vscode.TextEditor, text: StyledText) {
    const ranges = new Map<string, vscode.Range[]>();
    for (const span of text.spans) {
      const key = styleKey(span.style);
      if (!this.types.has(key)) {
        this.types.set(
          key,
          vscode.window.createTextEditorDecorationType(
            toDecorationOptions(span.style),
          ),
        );
      }
      let list = ranges.get(key);
      if (!list) {
        ranges.set(key, (list = []));
      }
      list.push(new vscode.Range(span.line, span.start, span.line, span.end));
    }
    // Styles from a previous render that no longer occur must be cleared too.
    for (const [key, type] of this.types) {
      editor.setDecorations(type, ranges.get(key) ?? []);
    }
  }

  dispose() {
    for (const type of this.types.values()) {
      type.dispose();
    }
    this.types.clear();
  }
}
