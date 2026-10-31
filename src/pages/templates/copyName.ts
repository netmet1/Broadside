/**
 * The name a copy of a template gets: the first of "Name 02", "Name 03", ...
 * that no saved template uses, or the name itself if nothing does.
 *
 * The same rule the database applies on save (`unique_name` in
 * db/templates.rs): a trailing number is replaced rather than added to, so a
 * copy of "Name 02" is "Name 03" and not "Name 02 02", and names are compared
 * without regard to case. Worked out here so the editor can show the name a
 * duplicate will be saved under before it is saved. The save still checks, so
 * a name taken in the meantime is numbered on, not refused.
 */
export function copyName(desired: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(desired.toLowerCase())) return desired;
  const cut = desired.lastIndexOf(" ");
  const head = cut === -1 ? "" : desired.slice(0, cut);
  const tail = cut === -1 ? "" : desired.slice(cut + 1);
  const stem =
    head.trim() !== "" && /^[0-9]+$/.test(tail) ? head.trimEnd() : desired;
  for (let n = 2; n <= 999; n++) {
    const candidate = `${stem} ${String(n).padStart(2, "0")}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return desired;
}
