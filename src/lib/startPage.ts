/** Which tab Broadside opens on (Settings > Startup).
 *
 * A view preference about this machine, so localStorage beside the Hosts tab's
 * remembered side (lib/hostsSide), and read once, by App, to seed the page it
 * starts on. Hosts until someone chooses otherwise, and after a Reset, which
 * clears localStorage.
 *
 * A template set to open at startup outranks it: that launch lands on Terminals
 * once it has resolved, whatever this says, which is why Settings greys the
 * choice while one is set. */
import type { Page } from "@/components/AppShell";
import { PAGES } from "@/lib/pages";

const START_PAGE_KEY = "start-page";

export const DEFAULT_START_PAGE: Page = "hosts";

/** The stored tab, or Hosts for anything missing or not a real page, so a value
 * from an older build or a hand edit can never open Broadside on nothing. */
export function loadStartPage(): Page {
  const stored = localStorage.getItem(START_PAGE_KEY);
  return PAGES.find((p) => p.page === stored)?.page ?? DEFAULT_START_PAGE;
}

export function saveStartPage(page: Page): void {
  localStorage.setItem(START_PAGE_KEY, page);
}
