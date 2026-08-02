/**
 * Markdown → view model.
 *
 * Parsing is delegated to marked's lexer (CommonMark/GFM tolerant —
 * an unclosed fence simply runs to end of input, which is exactly what
 * streaming needs). The view model is plain data so it can be unit
 * tested without a renderer; markdown-text.tsx turns it into Ink
 * elements.
 */

import { lexer, type Token, type Tokens } from "marked";

export interface MdSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Inline code, # / ## headings — theme accent color */
  accent?: boolean;
  /** Quote body, code language label — theme muted color */
  muted?: boolean;
  /** Prefixes │ ┌, underlines, hr, link urls — theme faint color */
  faint?: boolean;
}

export interface MdLine {
  indent: number;
  spans: MdSpan[];
}

const HR_LINE = "─".repeat(40);
const H2_UNDERLINE = "────";

export function buildViewModel(source: string): MdLine[] {
  let tokens: Token[];
  try {
    tokens = lexer(source);
  } catch {
    return source.split("\n").map((text) => ({ indent: 0, spans: [{ text }] }));
  }
  const lines: MdLine[] = [];
  emitBlockTokens(tokens, 0, lines);
  return lines;
}

function emitBlockTokens(tokens: Token[], indent: number, out: MdLine[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const heading = token as Tokens.Heading;
        const spans = parseInline(heading.tokens).map((s) => ({
          ...s,
          bold: true,
          accent: heading.depth <= 2 ? true : s.accent,
        }));
        out.push({ indent, spans });
        if (heading.depth === 2) {
          out.push({ indent, spans: [{ text: H2_UNDERLINE, faint: true }] });
        }
        break;
      }
      case "paragraph": {
        pushWrapped(out, indent, parseInline((token as Tokens.Paragraph).tokens));
        break;
      }
      case "list": {
        emitList(token as Tokens.List, indent, out);
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        const label: MdSpan[] = code.lang ? [{ text: code.lang, muted: true }] : [];
        out.push({ indent, spans: [{ text: "┌ ", faint: true }, ...label] });
        for (const text of code.text.split("\n")) {
          out.push({ indent, spans: [{ text: "│ ", faint: true }, { text }] });
        }
        break;
      }
      case "blockquote": {
        const inner: MdLine[] = [];
        emitBlockTokens((token as Tokens.Blockquote).tokens, 0, inner);
        for (const line of inner) {
          out.push({
            indent,
            spans: [
              { text: "│ ", faint: true },
              ...line.spans.map((s) => ({ ...s, muted: true })),
            ],
          });
        }
        break;
      }
      case "hr": {
        out.push({ indent, spans: [{ text: HR_LINE, faint: true }] });
        break;
      }
      case "space": {
        out.push({ indent, spans: [] });
        break;
      }
      default: {
        // Tables, html, and anything else: pass the raw source through.
        const raw = (token as { raw?: string }).raw ?? "";
        for (const text of raw.replace(/\n$/, "").split("\n")) {
          if (text) out.push({ indent, spans: [{ text }] });
        }
      }
    }
  }
}

function emitList(list: Tokens.List, indent: number, out: MdLine[]): void {
  const start = typeof list.start === "number" ? list.start : 1;
  list.items.forEach((item, i) => {
    const marker = list.ordered ? `${start + i}. ` : "• ";
    let markerUsed = false;
    for (const sub of item.tokens) {
      if (sub.type === "list") {
        emitBlockTokens([sub], indent + 2, out);
      } else if (sub.type === "text" || sub.type === "paragraph") {
        const spans = parseInline((sub as Tokens.Text).tokens ?? []);
        pushWrapped(out, indent + 2, markerUsed ? spans : [{ text: marker }, ...spans]);
        markerUsed = true;
      } else {
        emitBlockTokens([sub], indent + 2, out);
      }
    }
    if (!markerUsed) out.push({ indent: indent + 2, spans: [{ text: marker }] });
  });
}

function parseInline(tokens: Token[] | undefined): MdSpan[] {
  if (!tokens) return [];
  const spans: MdSpan[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "text":
        spans.push({ text: (t as Tokens.Text).text });
        break;
      case "strong":
        spans.push(...parseInline((t as Tokens.Strong).tokens).map((s) => ({ ...s, bold: true })));
        break;
      case "em":
        spans.push(...parseInline((t as Tokens.Em).tokens).map((s) => ({ ...s, italic: true })));
        break;
      case "codespan":
        spans.push({ text: (t as Tokens.Codespan).text, accent: true });
        break;
      case "link": {
        const link = t as Tokens.Link;
        spans.push({ text: link.text }, { text: ` ${link.href}`, faint: true });
        break;
      }
      case "br":
        spans.push({ text: "\n" });
        break;
      default: {
        const text = (t as { text?: string }).text;
        if (typeof text === "string") spans.push({ text });
      }
    }
  }
  return spans;
}

/** Push spans as one line, splitting into multiple lines at embedded \n. */
function pushWrapped(out: MdLine[], indent: number, spans: MdSpan[]): void {
  let current: MdSpan[] = [];
  const flush = () => {
    out.push({ indent, spans: current });
    current = [];
  };
  for (const span of spans) {
    span.text.split("\n").forEach((part, i) => {
      if (i > 0) flush();
      if (part) current.push({ ...span, text: part });
    });
  }
  flush();
}
