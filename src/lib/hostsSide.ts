/** Which of the Hosts tab's three lists you were last looking at.
 *
 * A view preference about this machine, so localStorage alongside the column
 * widths and the grid settings, and its own module because two screens ask
 * about it. The Hosts page reads it on mount; the Templates splash writes it,
 * because "Show all templates" is a request to land on the Templates side and
 * the Hosts page is built fresh on every visit, so the preference it reads on
 * the way in is the whole mechanism.
 *
 * `profiles` joined the switch in build 69: saved launch profiles are a third
 * list of ways to open a session, and they were managed only from a dropdown
 * menu on another tab. */
export type HostsSide = "hosts" | "templates" | "profiles";

const SIDE_KEY = "hosts-side";

/** Anything unrecognised means hosts: a value written by a build that had a
 * side this one does not must not leave the page showing nothing. */
export function loadHostsSide(): HostsSide {
  const saved = localStorage.getItem(SIDE_KEY);
  return saved === "templates" || saved === "profiles" ? saved : "hosts";
}

export function rememberHostsSide(side: HostsSide): void {
  localStorage.setItem(SIDE_KEY, side);
}
