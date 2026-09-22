/** Which sections of the Terminals "+" launcher are rolled up.
 *
 * The menu grew a section at a time: the shells it can spawn, then saved
 * profiles, then serial ports, and now the hosts, and on a machine with a dozen
 * of each it is a long menu to move through when you only ever open one kind of
 * thing. Rolling a section away is a per-machine view preference, so
 * localStorage, alongside the Hosts-tab side and the grid settings.
 *
 * Collapsed is the exception and expanded is the default: a section missing
 * from the stored list is open, so a build that adds another one shows it the
 * first time rather than hiding it behind a preference nobody set.
 *
 * "Serial console" is deliberately not in here. It is the one section that is
 * short on every machine (a COM port or two, usually none), and it carries the
 * explanation of what to do when there are none. */
export type LauncherSection = "shells" | "hosts" | "profiles";

const COLLAPSED_KEY = "launcher-collapsed";

const KNOWN: LauncherSection[] = ["shells", "hosts", "profiles"];

/** The sections rolled up last time. Anything unrecognised in the stored value
 * is dropped rather than kept, so a name this build has never heard of cannot
 * sit in the list forever. */
export function loadCollapsedSections(): Set<LauncherSection> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((s): s is LauncherSection =>
        KNOWN.includes(s as LauncherSection),
      ),
    );
  } catch {
    // A disabled or corrupt store costs the memory of the preference, never the
    // menu: every section opens.
    return new Set();
  }
}

export function rememberCollapsedSections(
  collapsed: Set<LauncherSection>,
): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Same bargain as above.
  }
}
