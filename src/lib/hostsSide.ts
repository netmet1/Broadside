/** Which of the Library tab's lists you were last looking at.
 *
 * A view preference about this machine, so localStorage alongside the column
 * widths and the grid settings, and its own module because two screens ask
 * about it. The Library page reads it on mount; App writes it before showing
 * the page (the Terminals "+" menu's New host), because the page is built fresh
 * on every visit, so the preference it reads on the way in is the whole
 * mechanism.
 *
 * `profiles` joined the switch in build 69. `templates` was a side until
 * prompts135 moved that list to the Templates tab; Library's Templates button
 * now goes there instead. */
export type HostsSide = "hosts" | "profiles";

const SIDE_KEY = "hosts-side";

/** Anything unrecognised means hosts: a value written by a build that had a
 * side this one does not (`templates`, before prompts135) must not leave the
 * page showing nothing. */
export function loadHostsSide(): HostsSide {
  const saved = localStorage.getItem(SIDE_KEY);
  return saved === "profiles" ? saved : "hosts";
}

export function rememberHostsSide(side: HostsSide): void {
  localStorage.setItem(SIDE_KEY, side);
}
