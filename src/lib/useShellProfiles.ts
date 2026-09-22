import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { readLegacyProfiles, type ShellProfile } from "@/lib/localShellProfiles";
import { errorMessage } from "@/lib/tauri/hosts";
import {
  importLegacyShellProfiles,
  listShellProfiles,
} from "@/lib/tauri/shellProfiles";

/** The one-time copy out of localStorage, shared by every reader in this app
 * run so the Terminals launcher, the Templates rail and a template launch
 * cannot race each other into it. Forgotten on failure, so the next read tries
 * again rather than the whole run going without. */
let migration: Promise<void> | null = null;

export function migrateLegacyProfiles(): Promise<void> {
  migration ??= (async () => {
    const legacy = readLegacyProfiles();
    if (legacy.length === 0) return;
    // The backend does nothing if it has already run on this database or the
    // table has rows, so a reload or a second call is harmless.
    const { skipped } = await importLegacyShellProfiles(legacy);
    if (skipped > 0) {
      toast.warning(
        `${skipped} saved profile${skipped === 1 ? "" : "s"} could not be moved to the new store and ${
          skipped === 1 ? "is" : "are"
        } not in the launcher.`,
      );
    }
  })().catch((e: unknown) => {
    migration = null;
    throw e;
  });
  return migration;
}

/** Every saved profile, in launcher order, after making sure the profiles an
 * older build left in localStorage have been copied in. */
export async function loadShellProfiles(): Promise<ShellProfile[]> {
  await migrateLegacyProfiles();
  return listShellProfiles();
}

/**
 * The saved profiles for a page, re-read whenever the page is shown, so a
 * change made on another tab is there when you come back.
 *
 * `profiles` is null until the first read lands. A launcher shows nothing
 * rather than an empty list for that moment, so "None yet" never flashes at
 * somebody who has twelve.
 */
export function useShellProfiles(visible: boolean) {
  const [profiles, setProfiles] = useState<ShellProfile[] | null>(null);
  // Reads can overlap (shown, then a save refreshes); only the latest one may
  // land, or an older answer could overwrite a newer one.
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++latest.current;
    try {
      const next = await loadShellProfiles();
      if (seq === latest.current) setProfiles(next);
    } catch (e) {
      toast.error(errorMessage(e));
      if (seq === latest.current) setProfiles((prev) => prev ?? []);
    }
  }, []);
  // The same read as `refresh`, spelled as a promise chain so the state is
  // plainly set in a callback when the answer arrives, not in the effect.
  useEffect(() => {
    if (!visible) return;
    const seq = ++latest.current;
    loadShellProfiles()
      .then((next) => {
        if (seq === latest.current) setProfiles(next);
      })
      .catch((e: unknown) => {
        toast.error(errorMessage(e));
        if (seq === latest.current) setProfiles((prev) => prev ?? []);
      });
  }, [visible]);
  return { profiles, setProfiles, refresh };
}
