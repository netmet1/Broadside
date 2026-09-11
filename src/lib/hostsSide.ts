/** Which of the Hosts tab's two lists you were last looking at.
 *
 * A view preference about this machine, so localStorage alongside the column
 * widths and the grid settings, and its own module because two screens ask
 * about it. The Hosts page reads it on mount; the Templates splash writes it,
 * because "Show all templates" is a request to land on the Templates side and
 * the Hosts page is built fresh on every visit, so the preference it reads on
 * the way in is the whole mechanism. */
export type HostsSide = "hosts" | "templates";

const SIDE_KEY = "hosts-side";

export function loadHostsSide(): HostsSide {
  return localStorage.getItem(SIDE_KEY) === "templates" ? "templates" : "hosts";
}

export function rememberHostsSide(side: HostsSide): void {
  localStorage.setItem(SIDE_KEY, side);
}
