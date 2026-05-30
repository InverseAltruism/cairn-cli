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

// Phosphor braille spinner for network/async work. Writes to STDERR (clig.dev: keep
// stdout clean for piping) and is a no-op when output isn't an interactive terminal.
export function spinner(label: string): { stop: (final?: string) => void } {
  if (!ANIM) return { stop: (final?: string) => { if (final) console.log(final); } };
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const t = setInterval(() => process.stderr.write(`\r${c.green(frames[i++ % frames.length]!)} ${c.gray(label)} `), 80);
  return {
    stop: (final?: string) => {
      clearInterval(t);
      process.stderr.write("\r\x1b[K");
      if (final) console.log(final);
    },
  };
}

// Fast decode-reveal of the CAIRN wordmark: scramble glyphs resolve L→R into white
// letters with a green cursor — the site's "boot" feel. ~360ms, and only on an
// interactive TTY (static banner otherwise, so help piped to a file isn't garbage).
export async function bannerAnimated(): Promise<void> {
  if (!ANIM) { banner(); return; }
  const word = "CAIRN";
  const pool = "▖▗▘▙▚▛▜▝▞▟01#%/\\<>=".split("");
  const rnd = () => pool[Math.floor(Math.random() * pool.length)]!;
  for (let step = 0; step <= word.length; step++) {
    let s = "";
    for (let i = 0; i < word.length; i++) s += i < step ? c.white(c.bold(word[i]!)) : c.green(rnd());
    process.stdout.write(`\r  ${c.gray("▓▒░")} ${s} ${c.green("▋")}  ${c.gray("· " + TAG)}   `);
    await sleep(60);
  }
  process.stdout.write(`\r  ${c.gray("▓▒░")} ${c.white(c.bold(word))} ${c.green("▮")}  ${c.gray("· " + TAG)}\n`);
  rule();
}

export function clearScreen(): void {
  if (TTY) process.stdout.write("\x1b[2J\x1b[H");
}
