// Minimal ANSI/SGR parser for the composer terminal view. tmux `capture-pane -e`
// emits the rendered screen with SGR color attributes (no cursor motion), so a
// small SGR parser is enough — we drop any other escape sequences. Palette is a
// Tokyo-Night-ish 16-color set that fits the app's dark + blue/purple theme.

export interface AnsiSegment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const FG = ['#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6'];
const FG_BRIGHT = ['#565f89', '#ff7a93', '#b9f27c', '#ff9e64', '#9bb5ff', '#c7a9ff', '#a4daff', '#c0caf5'];

interface State {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** Map an xterm-256 color index to a hex/rgb string. */
function xterm256(n: number): string {
  if (n < 8) return FG[n];
  if (n < 16) return FG_BRIGHT[n - 8];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const ch = (x: number) => (x === 0 ? 0 : x * 40 + 55);
  return `rgb(${ch(r)},${ch(g)},${ch(b)})`;
}

function applyCodes(state: State, codes: number[]): void {
  for (let i = 0; i < codes.length; i += 1) {
    const c = codes[i];
    if (c === 0) {
      state.fg = undefined;
      state.bg = undefined;
      state.bold = false;
      state.dim = false;
      state.italic = false;
      state.underline = false;
    } else if (c === 1) state.bold = true;
    else if (c === 2) state.dim = true;
    else if (c === 3) state.italic = true;
    else if (c === 4) state.underline = true;
    else if (c === 22) {
      state.bold = false;
      state.dim = false;
    } else if (c === 23) state.italic = false;
    else if (c === 24) state.underline = false;
    else if (c >= 30 && c <= 37) state.fg = FG[c - 30];
    else if (c === 39) state.fg = undefined;
    else if (c >= 90 && c <= 97) state.fg = FG_BRIGHT[c - 90];
    else if (c >= 40 && c <= 47) state.bg = FG[c - 40];
    else if (c === 49) state.bg = undefined;
    else if (c >= 100 && c <= 107) state.bg = FG_BRIGHT[c - 100];
    else if (c === 38 || c === 48) {
      const key = c === 38 ? 'fg' : 'bg';
      if (codes[i + 1] === 5) {
        state[key] = xterm256(codes[i + 2] ?? 0);
        i += 2;
      } else if (codes[i + 1] === 2) {
        state[key] = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
        i += 4;
      }
    }
  }
}

const SGR = /\x1b\[([0-9;]*)m/g;
// Drop non-SGR escape sequences (cursor moves, OSC, charset) so they don't show.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OTHER_ESC = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

function clean(text: string): string {
  return text.replace(OTHER_ESC, '');
}

/** Parse a string with ANSI SGR codes into styled segments. Pure. */
export function parseAnsi(input: string): AnsiSegment[] {
  const src = String(input).replace(OSC, '');
  const segs: AnsiSegment[] = [];
  const state: State = {};
  let last = 0;
  let m: RegExpExecArray | null;
  SGR.lastIndex = 0;
  const push = (raw: string) => {
    const text = clean(raw);
    if (text) segs.push({ text, ...state });
  };
  while ((m = SGR.exec(src)) !== null) {
    if (m.index > last) push(src.slice(last, m.index));
    const codes = (m[1] === '' ? '0' : m[1]).split(';').map((x) => Number(x) || 0);
    applyCodes(state, codes);
    last = SGR.lastIndex;
  }
  if (last < src.length) push(src.slice(last));
  return segs;
}

export interface UrlPart {
  text: string;
  href?: string;
}

const URL_RE = /(https?:\/\/[^\s'"`<>()\][]+)/g;

/** Split text into plain runs and URL runs (trailing punctuation trimmed). Pure. */
export function splitUrls(text: string): UrlPart[] {
  const parts: UrlPart[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    let url = m[0];
    let trail = '';
    const tm = url.match(/[.,;:!?]+$/);
    if (tm) {
      trail = tm[0];
      url = url.slice(0, -trail.length);
    }
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: url, href: url });
    if (trail) parts.push({ text: trail });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts.length ? parts : [{ text }];
}
