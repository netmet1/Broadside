export const PALETTE = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308",
  "#84cc16", "#22c55e", "#14b8a6", "#06b6d4",
  "#3b82f6", "#6366f1", "#a855f7", "#ec4899",
];

export function nextColor(usedColors: string[]): string {
  const used = new Set(usedColors.map((c) => c.toLowerCase()));
  return PALETTE.find((c) => !used.has(c.toLowerCase())) ?? PALETTE[0];
}
