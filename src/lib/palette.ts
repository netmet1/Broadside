export const PALETTE = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308",
  "#84cc16", "#22c55e", "#14b8a6", "#06b6d4",
  "#3b82f6", "#6366f1", "#a855f7", "#ec4899",
];

function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) =>
    ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/** Random hue in the palette's vibrance range (D-051 exhaustion fallback). */
function randomVibrantColor(): string {
  const h = Math.floor(Math.random() * 360);
  const s = 60 + Math.floor(Math.random() * 21); // 60–80
  const l = 45 + Math.floor(Math.random() * 21); // 45–65
  return hslToHex(h, s, l);
}

/**
 * Color for an auto-assignment: first unused palette hue, or — once every
 * palette hue is in use — a random vibrant color not already taken. Auto
 * never duplicates an in-use color; explicit user picks may (D-051).
 */
export function nextColor(usedColors: string[]): string {
  const used = new Set(usedColors.map((c) => c.toLowerCase()));
  const free = PALETTE.find((c) => !used.has(c.toLowerCase()));
  if (free) return free;
  for (;;) {
    const candidate = randomVibrantColor();
    if (!used.has(candidate)) return candidate;
  }
}
