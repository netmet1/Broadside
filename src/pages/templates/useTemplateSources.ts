import { useEffect, useMemo, useState } from "react";

import { errorMessage, listHosts, type Host } from "@/lib/tauri/hosts";
import { listLocalShells, type LocalShell } from "@/lib/tauri/local";
import { loadDisabledShells } from "@/lib/localShellPrefs";
import { useShellProfiles } from "@/lib/useShellProfiles";
import { sortForRail } from "@/lib/railSort";
import { useShellColors } from "@/lib/useShellColors";
import type { ItemSources } from "@/pages/templates/items";

/**
 * Everything the Templates rail can offer, in four groups, and everything a
 * stored item is resolved against.
 *
 * **The sort applies inside each group and never across them.** That is the
 * whole reason this is a hook rather than one flat list: a rail that re-sorted
 * by name would put a WSL distro between two hosts, and the groups are how you
 * find anything in a list of forty. Hosts take the full sort set, because they
 * are the only rows with a tag, an address and a connection to sort on. Shells
 * and custom terminals keep the order the launcher gives them, which is the
 * order they are detected in and the order the operator already knows. Profiles
 * take name order only, since a profile has nothing else to be sorted by.
 *
 * The three sources are read at different times for different reasons, and all
 * three are re-read whenever the page is shown: hosts because the Hosts tab is
 * one click away, shells because a custom terminal added in Settings should
 * appear without a restart, and the hide list because that is a Settings toggle
 * too. The page stays mounted, so nothing else would notice any of them.
 */
export function useTemplateSources({
  visible,
  sort,
  connectedHostIds,
}: {
  visible: boolean;
  sort: string;
  connectedHostIds: Set<number>;
}) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [hostsError, setHostsError] = useState<string | null>(null);
  const [shells, setShells] = useState<LocalShell[]>([]);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  // Profiles are a database read since build 69, re-read on every show like
  // the hosts. Empty until the first read lands.
  const { profiles: loadedProfiles } = useShellProfiles(visible);
  const profiles = useMemo(() => loadedProfiles ?? [], [loadedProfiles]);
  const shellColors = useShellColors();

  // The hide list is read during render rather than in the effect below, for
  // the reason TerminalsPage records at length: reading storage is synchronous,
  // so an effect only delays showing the truth by a frame, and the rail would
  // paint the previous visit's list first.
  const [wasVisible, setWasVisible] = useState(visible);
  if (wasVisible !== visible) {
    setWasVisible(visible);
    if (visible) setDisabled(loadDisabledShells());
  }

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    listHosts()
      .then((hs) => {
        if (!alive) return;
        setHosts(hs);
        setHostsError(null);
      })
      .catch((e) => {
        if (alive) setHostsError(errorMessage(e));
      });
    listLocalShells()
      .then((s) => {
        if (alive) setShells(s);
      })
      .catch(() => {
        // The shells being unlistable costs two groups of the rail, never the
        // hosts or the template being edited.
      });
    return () => {
      alive = false;
    };
  }, [visible]);

  // A custom terminal is a shell with a `custom:` id (see lib/tauri/local,
  // which merges the two for the launcher). They are split back apart here
  // because they are a group of their own in this rail: the detected shells are
  // what Windows has, and these are what the operator added.
  const detectedShells = useMemo(
    () => shells.filter((s) => !s.id.startsWith("custom:")),
    [shells],
  );
  const customTerminals = useMemo(
    () => shells.filter((s) => s.id.startsWith("custom:")),
    [shells],
  );

  // The hide list from Settings, Appearance applies to the detected shells, the
  // same list it hides from the "+" launcher. Custom terminals are not in it,
  // and profiles deliberately ignore it: a profile may launch a shell that is
  // hidden from the plain list, which is exactly what the launcher does too.
  const enabledShells = useMemo(
    () => detectedShells.filter((s) => !disabled.has(s.id)),
    [detectedShells, disabled],
  );

  const sortedHosts = useMemo(
    () =>
      sortForRail(hosts, (h) => h, sort, (h) =>
        connectedHostIds.has(h.id) ? 1 : 0,
      ),
    [hosts, sort, connectedHostIds],
  );

  // Name order only, and only when the sort says so. Anything else (tag, IP,
  // online) is a question about a host, and answering it by reshuffling the
  // profiles would be inventing an order out of nothing.
  const sortedProfiles = useMemo(() => {
    if (sort !== "az" && sort !== "za") return profiles;
    const arr = [...profiles].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
    return sort === "za" ? arr.reverse() : arr;
  }, [profiles, sort]);

  const sources: ItemSources = useMemo(
    () => ({
      hostsById: new Map(hosts.map((h) => [h.id, h] as const)),
      shellsById: new Map(shells.map((s) => [s.id, s] as const)),
      profilesById: new Map(profiles.map((p) => [p.id, p] as const)),
      shellColors,
    }),
    [hosts, shells, profiles, shellColors],
  );

  return {
    hosts,
    hostsError,
    sortedHosts,
    enabledShells,
    customTerminals,
    sortedProfiles,
    shellColors,
    sources,
  };
}
