// jj renders its own colors (honoring the user's color config), so instead of
// re-implementing jj's templates we ask for `--color always` and turn the ANSI
// escapes into plain text plus style spans that the editor can decorate.
// This module has no vscode dependency so it can be unit tested with node.

export type Color =
  | { kind: "ansi"; index: number } // 0-15, resolved against the theme's terminal colors
  | { kind: "rgb"; r: number; g: number; b: number };

export interface Style {
  fg?: Color;
  bg?: Color;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface StyledSpan {
  line: number;
  start: number;
  end: number;
  style: Style;
}

export interface StyledText {
  lines: string[];
  spans: StyledSpan[];
}

// CSI sequences (SGR when the final byte is "m"), OSC sequences (e.g. hyperlinks) and other two-byte escapes.
const ESCAPE =
  /\x1b(?:\[([0-9;:?]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ESCAPE, "");
}

export function styleKey(style: Style): string {
  return JSON.stringify([
    style.fg,
    style.bg,
    !!style.bold,
    !!style.dim,
    !!style.italic,
    !!style.underline,
  ]);
}

function isPlain(style: Style): boolean {
  return (
    !style.fg &&
    !style.bg &&
    !style.bold &&
    !style.dim &&
    !style.italic &&
    !style.underline
  );
}

const ansi = (index: number): Color => ({ kind: "ansi", index });

export function color256(n: number): Color {
  if (n < 16) {
    return ansi(n);
  }
  if (n < 232) {
    const levels = [0, 95, 135, 175, 215, 255];
    const i = n - 16;
    return {
      kind: "rgb",
      r: levels[Math.floor(i / 36)],
      g: levels[Math.floor(i / 6) % 6],
      b: levels[i % 6],
    };
  }
  const gray = 8 + 10 * (n - 232);
  return { kind: "rgb", r: gray, g: gray, b: gray };
}

export function applySgr(current: Style, params: string): Style {
  const codes =
    params === ""
      ? [0]
      : params.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
  let style: Style = { ...current };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) {
      style = {};
    } else if (c === 1) {
      style.bold = true;
    } else if (c === 2) {
      style.dim = true;
    } else if (c === 3) {
      style.italic = true;
    } else if (c === 4) {
      style.underline = true;
    } else if (c === 22) {
      delete style.bold;
      delete style.dim;
    } else if (c === 23) {
      delete style.italic;
    } else if (c === 24) {
      delete style.underline;
    } else if (c >= 30 && c <= 37) {
      style.fg = ansi(c - 30);
    } else if (c >= 90 && c <= 97) {
      style.fg = ansi(c - 90 + 8);
    } else if (c === 39) {
      delete style.fg;
    } else if (c >= 40 && c <= 47) {
      style.bg = ansi(c - 40);
    } else if (c >= 100 && c <= 107) {
      style.bg = ansi(c - 100 + 8);
    } else if (c === 49) {
      delete style.bg;
    } else if (c === 38 || c === 48) {
      const key = c === 38 ? "fg" : "bg";
      if (codes[i + 1] === 5 && i + 2 < codes.length) {
        style[key] = color256(codes[i + 2]);
        i += 2;
      } else if (codes[i + 1] === 2 && i + 4 < codes.length) {
        style[key] = {
          kind: "rgb",
          r: codes[i + 2],
          g: codes[i + 3],
          b: codes[i + 4],
        };
        i += 4;
      }
    }
  }
  return style;
}

export class StyledTextBuilder {
  private lines: string[] = [""];
  private spans: StyledSpan[] = [];

  append(text: string, style: Style = {}): this {
    text
      .replace(/\r/g, "")
      .split("\n")
      .forEach((part, i) => {
        if (i > 0) {
          this.lines.push("");
        }
        if (!part) {
          return;
        }
        const line = this.lines.length - 1;
        const start = this.lines[line].length;
        this.lines[line] += part;
        if (!isPlain(style)) {
          this.spans.push({
            line,
            start,
            end: start + part.length,
            style: { ...style },
          });
        }
      });
    return this;
  }

  appendAnsi(text: string): this {
    let style: Style = {};
    let last = 0;
    for (const m of text.matchAll(ESCAPE)) {
      this.append(text.slice(last, m.index), style);
      last = m.index! + m[0].length;
      if (m[2] === "m") {
        style = applySgr(style, m[1]);
      }
    }
    this.append(text.slice(last), style);
    return this;
  }

  /** The index of the line that text is appended to. */
  get line(): number {
    return this.lines.length - 1;
  }

  newline(): this {
    this.lines.push("");
    return this;
  }

  /** Ends the current block with exactly one blank line before whatever is appended next. */
  separate(): this {
    this.trimEnd();
    this.lines.push("", "");
    return this;
  }

  build(): StyledText {
    this.trimEnd();
    return { lines: [...this.lines], spans: [...this.spans] };
  }

  private trimEnd() {
    while (this.lines.length > 1 && this.lines[this.lines.length - 1] === "") {
      this.lines.pop();
    }
  }
}
