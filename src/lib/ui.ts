// Cairn CLI theme — matches the website + wallet: black-and-white terminal with a
// single phosphor-green accent, sharp edges, a blinking cursor and a fast decode
// "boot" reveal. Zero deps.
//
// clig.dev compliance:
//   • color off when stdout/stderr isn't a TTY, NO_COLOR is set, TERM=dumb, or
//     --no-color is passed (CAIRN_COLOR=1 forces it on for demos)
//   • no animation unless interactive + color (CAIRN_NO_ANIM / --no-anim opt out)
//   • the spinner (transient progress) goes to STDERR so stdout stays pipeable
const argv = process.argv;
const TTY = !!process.stdout.isTTY || process.env.CAIRN_COLOR === "1";
const NO_COLOR = (!!process.env.NO_COLOR && process.env.NO_COLOR !== "") || process.env.TERM === "dumb"
  || process.env.CAIRN_NO_COLOR === "1" || argv.includes("--no-color");
const COLOR = (TTY || process.env.CAIRN_COLOR === "1") && !NO_COLOR;
const TRUE = COLOR && /^(truecolor|24bit)$/.test(process.env.COLORTERM ?? "");
const ANIM = COLOR && !!process.stdout.isTTY && !process.env.CAIRN_NO_ANIM && !argv.includes("--no-anim");

// truecolor with a 256-color fallback, so the exact wallet/site palette renders when
// the terminal supports it and degrades gracefully when it doesn't.
const fg = (rgb: string, c256: string) => (s: string | number) => (COLOR ? `\x1b[${TRUE ? rgb : c256}m${s}\x1b[0m` : String(s));
const sgr = (code: string) => (s: string | number) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));

// palette — phosphor green #6ee7a0 accent, off-white text, dim grays, soft red #ff6b6b
const GREEN = fg("38;2;110;231;160", "38;5;114");
const WHITE = fg("38;2;230;230;230", "97");
const GRAY = fg("38;2;125;125;125", "38;5;245");
const FAINT = fg("38;2;90;90;90", "38;5;240");
const RED = fg("38;2;255;107;107", "38;5;203");

export const c = {
  green: GREEN, white: WHITE, gray: GRAY, faint: FAINT, red: RED,
  dim: sgr("2"), bold: sgr("1"),
  // legacy role names remapped to the monochrome+green theme so call sites stay put:
  cyan: GREEN,     // accents · ids · bars  → phosphor green
  magenta: WHITE,  // emphasis · rank · wordmark → bright white
  amber: GRAY,     // demo / muted → gray
};

const W = 64;
const TAG = "paid-attention board · compute substrate";

export function banner(): void {
  if (!TTY) return; // chrome is for humans; piped output skips it
  console.log(`  ${c.white(c.bold("▓▒░ CAIRN"))} ${c.green("▮")}  ${c.gray(TAG)}`);
  rule();
}

export function rule(label = ""): void {
  if (label) {
    const tail = Math.max(0, W - label.length - 5);
    console.log(`${c.green("──")} ${c.white(c.bold(label))} ${c.faint("─".repeat(tail))}`);
  } else console.log(c.faint("─".repeat(W)));
}

export function badge(source: string): string {
  if (source === "chain") return c.green("⛓ on-chain");
  if (source === "demo") return c.gray("◆ demo");
  if (source === "draft") return c.gray("✎ draft");
  return c.gray(source);
}

// proportional bar — green fill, faint track (matches the site's support bars)
export function bar(value: number, max: number, width = 16): string {
  const frac = max > 0 ? Math.min(1, value / max) : 0;
  const fill = Math.round(frac * width);
  return c.green("█".repeat(fill)) + c.faint("░".repeat(Math.max(0, width - fill)));
}

export function csd(base: number): string {
  return c.green(`${(base / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 })}`) + c.gray(" CSD");
}

// Strip dangerous characters from UNTRUSTED strings before printing them to a TTY, so a
// hostile server/chain field (title, body, message, ERROR string, txid/id, handle, bio,
// domain…) can't (a) inject ANSI/OSC escapes to spoof output — cursor-up + repaint to
// overwrite a "✗ MISMATCH" with "✓ VERIFIED", rewrite the window title, OSC-8 link spoof,
// OSC-52 clipboard write — or (b) use Unicode bidi-overrides / zero-width chars to spoof
// a displayed address/name/amount (CLI-9). Display-only: NEVER apply to bytes that get
// hashed/verified (it would change the hash).
//   • C0/C1 control + DEL (incl. ESC 0x1b — the ANSI/OSC lead-in)
//   • bidi controls: LRM/RLM U+200E/F, ALM U+061C, LRE..RLO U+202A-E, LRI..PDI U+2066-9
//   • zero-width / joiners / BOM: ZWSP/ZWNJ/ZWJ U+200B-D, WJ U+2060, BOM U+FEFF
const CTRL = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2060\\u2066-\\u2069\\u202a-\\u202e\\ufeff]",
  "g",
);
export function san(s: unknown): string { return String(s ?? "").replace(CTRL, ""); }

export function ok(s: string): string { return c.green("✓ ") + s; }
export function warn(s: string): string { return c.gray("⚠ ") + s; }
export function err(s: string): string { return c.red("✗ ") + s; }
export function key(k: string): string { return c.gray(k); }
export function pad(s: string, n: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return s + " ".repeat(Math.max(0, n - visible));
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const isTty = TTY;
export const anim = ANIM;

// Phosphor braille spinner for network/async work. Writes to STDERR (clig.dev: keep
// stdout clean for piping) and is a no-op when output isn't an interactive terminal.
// After ~1.5s it shows an elapsed counter so a slow node read doesn't look hung;
// stop() prints a clean ✓ (or a caller-supplied final line) on stdout.
export function spinner(label: string): { stop: (final?: string) => void; update: (l: string) => void } {
  if (!ANIM) return { stop: (final?: string) => { if (final) console.log(final); }, update: () => {} };
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0, lbl = label;
  const t0 = Date.now();
  const paint = () => {
    const el = (Date.now() - t0) / 1000;
    const tail = el >= 1.5 ? c.faint(` ${el.toFixed(0)}s`) : "";
    process.stderr.write(`\r\x1b[K${c.green(frames[i++ % frames.length]!)} ${c.gray(lbl)}${tail} `);
  };
  const t = setInterval(paint, 80); paint();
  return {
    update: (l: string) => { lbl = l; },
    stop: (final?: string) => {
      clearInterval(t);
      process.stderr.write("\r\x1b[K");
      if (final) console.log(final);
    },
  };
}

// Type a line out character-by-character to stdout — the site's boot typewriter, in the
// terminal. Falls back to an instant write when animation is off. ~`cps` chars/sec.
export async function typeOut(text: string, cps = 220): Promise<void> {
  if (!ANIM) { process.stdout.write(text + "\n"); return; }
  const step = Math.max(4, Math.round(1000 / cps));
  for (let i = 1; i <= text.length; i++) {
    process.stdout.write(`\r\x1b[K${text.slice(0, i)}${c.green("▋")}`);
    await sleep(step);
  }
  process.stdout.write(`\r\x1b[K${text}\n`);
}

// Decode-reveal of the CAIRN wordmark: each glyph scrambles a few times then locks to a
// bright-white letter, resolving left→right behind a green cursor — the site's "boot"
// feel. ~420ms cap, interactive TTY only (static banner otherwise, so `help` piped to a
// file isn't escape-code garbage). Followed by a typed strap-line + rule.
export async function bannerAnimated(): Promise<void> {
  if (!ANIM) { banner(); return; }
  const word = "CAIRN";
  const pool = "▖▗▘▙▚▛▜▝▞▟01#%/\\<>=$".split("");
  const rnd = () => pool[Math.floor(Math.random() * pool.length)]!;
  const HOLD = 3; // scramble frames each not-yet-locked glyph shows before the head passes it
  for (let step = 0; step <= word.length; step++) {
    for (let f = 0; f < (step < word.length ? HOLD : 1); f++) {
      let s = "";
      for (let i = 0; i < word.length; i++) {
        if (i < step) s += c.white(c.bold(word[i]!));
        else if (i === step) s += c.green(c.bold(rnd())); // the glyph currently resolving
        else s += c.faint(rnd());
      }
      process.stdout.write(`\r\x1b[K  ${c.gray("▓▒░")} ${s} ${c.green("▋")}  ${c.faint("· " + TAG)}`);
      await sleep(26);
    }
  }
  process.stdout.write(`\r\x1b[K  ${c.gray("▓▒░")} ${c.white(c.bold(word))} ${c.green("▮")}  ${c.gray("· " + TAG)}\n`);
  rule();
}

export function clearScreen(): void {
  if (TTY) process.stdout.write("\x1b[2J\x1b[H");
}
// Move the cursor home and clear from there to the end of screen — repaints in place
// without the full-screen black flash `clearScreen` causes. Used by `watch`.
export function cursorHome(): void {
  if (TTY) process.stdout.write("\x1b[H\x1b[0J");
}
