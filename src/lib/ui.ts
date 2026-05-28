// Tiny zero-dependency ANSI styling for a clean "cyberpunk" CLI.
// Honors NO_COLOR and non-TTY (pipes) by disabling color automatically.
const COLOR = (!!process.stdout.isTTY || process.env.CAIRN_COLOR === "1") && !process.env.NO_COLOR;
const TTY = !!process.stdout.isTTY || process.env.CAIRN_COLOR === "1";
const wrap = (code: string) => (s: string | number) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  cyan: wrap("38;5;51"),
  magenta: wrap("38;5;201"),
  green: wrap("38;5;47"),
  amber: wrap("38;5;214"),
  red: wrap("38;5;203"),
  gray: wrap("38;5;245"),
  dim: wrap("2"),
  bold: wrap("1"),
  white: wrap("97"),
};

const W = 64;
export function banner(): void {
  if (!TTY) return; // skip the box when piped/non-interactive
  const bar = "═".repeat(W);
  console.log(c.cyan(`╔${bar}╗`));
  console.log(
    c.cyan("║ ") +
      c.magenta(c.bold("▟▛ CAIRN ▜▙")) +
      c.gray("  ·  ") +
      c.cyan("paid-attention board") +
      c.gray("  ·  ") +
      c.green("compute substrate") +
      " ".repeat(Math.max(0, W - 50)) +
      c.cyan("║"),
  );
  console.log(c.cyan(`╚${bar}╝`));
}

export function rule(label = ""): void {
  if (label) console.log(c.gray("─".repeat(2)) + " " + c.cyan(c.bold(label)) + " " + c.gray("─".repeat(Math.max(0, W - label.length - 4))));
  else console.log(c.gray("─".repeat(W)));
}

export function badge(source: string): string {
  if (source === "chain") return c.green("⛓ on-chain");
  if (source === "demo") return c.amber("◆ demo");
  if (source === "draft") return c.gray("✎ draft");
  return c.gray(source);
}

// proportional bar using block fills
export function bar(value: number, max: number, width = 16): string {
  const frac = max > 0 ? Math.min(1, value / max) : 0;
  const fill = Math.round(frac * width);
  return c.cyan("█".repeat(fill)) + c.gray("░".repeat(Math.max(0, width - fill)));
}

export function csd(base: number): string {
  return c.cyan(`${(base / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 })}`) + c.gray(" CSD");
}

export function ok(s: string): string { return c.green("✓ ") + s; }
export function warn(s: string): string { return c.amber("⚠ ") + s; }
export function err(s: string): string { return c.red("✗ ") + s; }
export function key(k: string): string { return c.gray(k); }
export function pad(s: string, n: number): string {
  // pad accounting for the visible length (strip ANSI)
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return s + " ".repeat(Math.max(0, n - visible));
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const isTty = TTY;

// neon braille spinner for async/network ops. no-op when piped.
export function spinner(label: string): { stop: (final?: string) => void } {
  if (!TTY) return { stop: (final?: string) => { if (final) console.log(final); } };
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const t = setInterval(() => {
    process.stdout.write(`\r${c.magenta(frames[i++ % frames.length]!)} ${c.cyan(label)} ${c.gray("…")}  `);
  }, 80);
  return {
    stop: (final?: string) => {
      clearInterval(t);
      process.stdout.write("\r\x1b[K");
      if (final) console.log(final);
    },
  };
}

// "decode" reveal of the CAIRN wordmark — matrix-style scramble that resolves L→R.
export async function bannerAnimated(): Promise<void> {
  if (!TTY) { banner(); return; }
  const word = "CAIRN";
  const pool = "▖▗▘▙▚▛▜▝▞▟01#%&/\\<>=+*".split("");
  const rnd = () => pool[Math.floor(Math.random() * pool.length)]!;
  for (let step = 0; step <= word.length; step++) {
    let s = "";
    for (let i = 0; i < word.length; i++) s += i < step ? c.magenta(c.bold(word[i]!)) : c.cyan(rnd());
    process.stdout.write(`\r  ${c.cyan("▟▛")} ${s} ${c.cyan("▜▙")}  ${c.gray("· paid-attention board · compute substrate")}   `);
    await sleep(55);
  }
  process.stdout.write("\n");
  rule();
}

export function clearScreen(): void {
  if (TTY) process.stdout.write("\x1b[2J\x1b[H");
}
