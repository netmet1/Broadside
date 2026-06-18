/** Which detected local shells the user has hidden from the Terminals "+"
 * launcher (Settings -> Appearance). A UI pref in localStorage, mirroring
 * hostColumns. We store the DISABLED ids (not the enabled ones) so any newly
 * detected shell defaults to ON. The set is pruned to currently-detected ids,
 * so a shell that disappears and later returns is treated as new (enabled). */

const KEY = "local-shells-disabled";

export function loadDisabledShells(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (Array.isArray(raw)) {
      return new Set(raw.filter((x) => typeof x === "string"));
    }
  } catch {
    // Fall through to an empty set (all shells visible).
  }
  return new Set();
}

export function saveDisabledShells(ids: Set<string>): void {
  localStorage.setItem(KEY, JSON.stringify([...ids]));
}

/** Drop any stored disabled ids that are no longer detected, so a shell that
 * vanished and came back follows the new-found protocol (enabled). Persists the
 * pruned set if it changed and returns it. */
export function reconcileDisabledShells(detectedIds: string[]): Set<string> {
  const detected = new Set(detectedIds);
  const stored = loadDisabledShells();
  let changed = false;
  for (const id of stored) {
    if (!detected.has(id)) {
      stored.delete(id);
      changed = true;
    }
  }
  if (changed) saveDisabledShells(stored);
  return stored;
}
