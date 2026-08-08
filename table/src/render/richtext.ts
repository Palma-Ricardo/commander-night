// Rich rules-text for the on-canvas ability/trigger panels (design §9, T4). PIXI
// `Text` is one string in one style — it can't put a coloured mana pip mid-line,
// won't fill in a spell's chosen X, and only word-wraps (it never shrinks to fit).
// This lays out a decoded rules string as a run of `Text` words interleaved with
// drawn mana pips, wraps them to a box, and scales the font down until the whole
// thing fits — the four things the stack-effect and trigger-order plates need.
//
// The wrap/tokenize core is pure (injected measurement) so it's unit-tested; the
// PIXI glue below measures with `CanvasTextMetrics` and needs a canvas, like the
// rest of the render layer (exercised by `npm run shoot`, not the node tests).

import { CanvasTextMetrics, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { symbolColor } from '@night/core/state/mana';
import { decodeEntities } from '../text';

/** One drawable piece of a word: a run of plain text, or a single `{…}` mana pip
 *  (the brace content, e.g. "G", "2", "W/U", "T"). `w` is its measured width. */
export interface Part {
  kind: 'text' | 'pip';
  value: string;
  w: number;
}
/** A word never split across a line break — a whitespace-delimited run, which may
 *  mix text and pips (`{T}:` → a pip then ":"). `w` is the sum of its parts. */
export interface Word {
  parts: Part[];
  w: number;
}

const PIP_RE = /\{([^{}]+)\}/g;

/** Split one paragraph (no newlines) into words of raw parts — pure, no widths.
 *  A `{…}` token becomes its own pip part; the text around it stays text. */
export function tokenize(paragraph: string): { kind: 'text' | 'pip'; value: string }[][] {
  const words: { kind: 'text' | 'pip'; value: string }[][] = [];
  for (const chunk of paragraph.split(/\s+/)) {
    if (chunk === '') continue;
    const parts: { kind: 'text' | 'pip'; value: string }[] = [];
    let last = 0;
    PIP_RE.lastIndex = 0;
    for (let m = PIP_RE.exec(chunk); m !== null; m = PIP_RE.exec(chunk)) {
      if (m.index > last) parts.push({ kind: 'text', value: chunk.slice(last, m.index) });
      parts.push({ kind: 'pip', value: m[1]! });
      last = m.index + m[0].length;
    }
    if (last < chunk.length) parts.push({ kind: 'text', value: chunk.slice(last) });
    words.push(parts);
  }
  return words;
}

/** Greedy word-wrap: pack words onto lines up to `maxW`, breaking before a word
 *  that would overflow (a word wider than the box still gets its own line rather
 *  than looping). Pure — `spaceW` is the inter-word gap. */
export function wrapLines(words: Word[], maxW: number, spaceW: number): Word[][] {
  const lines: Word[][] = [];
  let line: Word[] = [];
  let x = 0;
  for (const word of words) {
    const next = line.length === 0 ? word.w : x + spaceW + word.w;
    if (line.length > 0 && next > maxW) {
      lines.push(line);
      line = [word];
      x = word.w;
    } else {
      line.push(word);
      x = next;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

// Mana-pip disc fills, matched to the DOM pips (styles.css `.mana-*`) so the two
// clients read identically: WUBRG hues, colourless/generic/X a neutral grey.
function pipFill(sym: string): number {
  switch (symbolColor(sym)) {
    case 'W': return 0xfffbd5;
    case 'U': return 0xaae0fa;
    case 'B': return 0xb9b2af;
    case 'R': return 0xf9aa8f;
    case 'G': return 0x9bd3ae;
    default: return 0xccc2c0;   // C, generic, X, {T}, {S}, hybrids
  }
}

/** A mana pip drawn as a filled disc/stadium with its symbol centred — origin at
 *  the pip's centre. Widens to a pill for a multi-character symbol (a hybrid). */
function pipNode(sym: string, size: number, family: string, resolution: number): { node: Container; w: number } {
  const h = size * 1.12;
  const label = new Text({
    text: sym, resolution,
    style: new TextStyle({ fontFamily: family, fontSize: Math.max(6, Math.round(size * 0.72)), fill: 0x1a1a1a, fontWeight: '700' }),
  });
  const w = Math.max(h, label.width + h * 0.5);
  const node = new Container();
  const g = new Graphics()
    .roundRect(-w / 2, -h / 2, w, h, h / 2).fill(pipFill(sym))
    .roundRect(-w / 2 + 0.6, -h / 2 + 0.6, w - 1.2, h - 1.2, h / 2)
    .stroke({ width: Math.max(1, h * 0.05), color: 0x000000, alpha: 0.4 });
  label.anchor.set(0.5);
  node.addChild(g, label);
  return { node, w };
}

export interface RichStyle {
  fontFamily: string;
  fontSize: number;         // starting size; shrinks toward minFontSize to fit
  minFontSize?: number;
  fill: number;
  lineHeightMul: number;    // line height as a multiple of the font size
  maxW: number;             // wrap width and the box the text is fitted into
  maxH: number;
  align: 'left' | 'center';
  resolution: number;
}

/** Build a rules-text block that fits a `maxW × maxH` box: mana `{…}` tokens drawn
 *  as pips, HTML entities decoded (`&mdash;` → "—"), font scaled down until it
 *  fits, and — only if it still overflows at the minimum size — trailing lines
 *  dropped with an ellipsis. Container origin is the box's top-left. */
export function richText(raw: string, style: RichStyle): Container {
  const paragraphs = decodeEntities(raw).split('\n');
  const min = style.minFontSize ?? Math.max(7, Math.round(style.fontSize * 0.6));

  const measureAt = (size: number): { lines: Word[][]; lineH: number } => {
    const bodyStyle = new TextStyle({ fontFamily: style.fontFamily, fontSize: size, fill: style.fill });
    const labelStyle = new TextStyle({ fontFamily: style.fontFamily, fontSize: Math.max(6, Math.round(size * 0.72)), fontWeight: '700' });
    const pipH = size * 1.12;
    const spaceW = Math.max(CanvasTextMetrics.measureText(' ', bodyStyle).width, size * 0.24);
    const measure = (p: { kind: 'text' | 'pip'; value: string }): Part => {
      if (p.kind === 'pip') {
        const lw = CanvasTextMetrics.measureText(p.value, labelStyle).width;
        return { kind: 'pip', value: p.value, w: Math.max(pipH, lw + pipH * 0.5) };
      }
      return { kind: 'text', value: p.value, w: CanvasTextMetrics.measureText(p.value, bodyStyle).width };
    };
    const lines: Word[][] = [];
    for (const para of paragraphs) {
      const words: Word[] = tokenize(para).map(parts => {
        const measured = parts.map(measure);
        return { parts: measured, w: measured.reduce((s, p) => s + p.w, 0) };
      });
      if (words.length === 0) lines.push([]);                 // blank line ⇒ a gap
      else for (const l of wrapLines(words, style.maxW, spaceW)) lines.push(l);
    }
    return { lines, lineH: size * style.lineHeightMul };
  };

  // Shrink the font until the block fits the box height, down to the floor.
  let size = Math.round(style.fontSize);
  let laid = measureAt(size);
  while (laid.lines.length * laid.lineH > style.maxH && size > min) {
    size = Math.max(min, size - 1);
    laid = measureAt(size);
  }

  // Still too tall at the floor (a wall of text): keep the lines that fit and mark
  // the truncation, so the plate never spills off the card (Issues.txt #28).
  let { lines } = laid;
  const maxLines = Math.max(1, Math.floor(style.maxH / laid.lineH));
  let truncated = false;
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    truncated = true;
  }

  const bodyStyle = new TextStyle({ fontFamily: style.fontFamily, fontSize: size, fill: style.fill });
  const spaceW = Math.max(CanvasTextMetrics.measureText(' ', bodyStyle).width, size * 0.24);
  const container = new Container();
  lines.forEach((line, i) => {
    const lineW = line.reduce((s, w) => s + w.w, 0) + Math.max(0, line.length - 1) * spaceW;
    let x = style.align === 'center' ? (style.maxW - lineW) / 2 : 0;
    const cy = i * laid.lineH + laid.lineH / 2;
    const lastLine = truncated && i === lines.length - 1;
    line.forEach((word, wi) => {
      word.parts.forEach(part => {
        if (part.kind === 'pip') {
          const { node } = pipNode(part.value, size, style.fontFamily, style.resolution);
          node.position.set(x + part.w / 2, cy);
          container.addChild(node);
        } else {
          const t = new Text({
            text: part.value, resolution: style.resolution, style: bodyStyle,
          });
          t.anchor.set(0, 0.5);
          t.position.set(x, cy);
          container.addChild(t);
        }
        x += part.w;
      });
      if (lastLine && wi === line.length - 1) {
        const ell = new Text({ text: '…', resolution: style.resolution, style: bodyStyle });
        ell.anchor.set(0, 0.5);
        ell.position.set(x, cy);
        container.addChild(ell);
      }
      x += spaceW;
    });
  });
  return container;
}
