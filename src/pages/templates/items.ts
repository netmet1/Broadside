/**
 * Turning a stored template item into something to draw, and back again.
 *
 * A template holds references, and a reference is only half an answer: the
 * label a host had when it was dropped in, or the id of a WSL distro that may
 * since have been uninstalled. Everything on screen (the box on the canvas, the
 * row in the Hosts table, the tab a launch opens) needs the *current* answer,
 * and needs to be told when there isn't one.
 *
 * `missing` is the whole reason this file exists. A template that names three
 * machines and one shell this laptop does not have should say so, in the box,
 * before the operator presses Open and gets two terminals and a shrug.
 */

import type { Host } from "@/lib/tauri/hosts";
import type { LocalShell } from "@/lib/tauri/local";
import type { TemplateItem } from "@/lib/tauri/templates";
import {
  UNMATCHED_CUSTOM,
  type ShellProfile,
} from "@/lib/localShellProfiles";
import { isTintable } from "@/lib/terminalColors";

/** Everything on this machine a template item can be resolved against. */
export type ItemSources = {
  hostsById: Map<number, Host>;
  shellsById: Map<string, LocalShell>;
  profilesById: Map<string, ShellProfile>;
  shellColors: Record<string, string | null | undefined>;
};

export type ResolvedItem = {
  /** What to put in the box. Always something, even when nothing resolved: a
   * placeholder with no name would be a box you cannot repair. */
  label: string;
  /** The tint, `#rrggbb`, or null for the theme's own. A host wears its own
   * colour; a shell wears its kind's; a profile overrides both, because a
   * profile is a purpose rather than a language (see lib/terminalColors). */
  color: string | null;
  /** `LocalShell.kind` for the icon, or null when this is a host and takes the
   * coloured dot instead. */
  shellKind: string | null;
  /** Why this will not open on this machine, or null when it will. */
  missing: string | null;
  /** The host, when the item is one and it resolved. What a launch opens. */
  host: Host | null;
  /** The shell and (optional) profile, when the item is a local one and it
   * resolved. */
  shell: LocalShell | null;
  profile: ShellProfile | null;
};

export function resolveItem(
  item: TemplateItem,
  src: ItemSources,
): ResolvedItem {
  const base: ResolvedItem = {
    label: "",
    color: null,
    shellKind: null,
    missing: null,
    host: null,
    shell: null,
    profile: null,
  };
  switch (item.kind) {
    case "host": {
      const host =
        item.hostId != null ? (src.hostsById.get(item.hostId) ?? null) : null;
      return {
        ...base,
        // The live label when the host is here, the stored one when it is not.
        // A renamed host shows its new name; a deleted one keeps the only name
        // anybody ever gave it.
        label: host?.label || item.ref.label || item.ref.hostname,
        color: host ? tintOrNull(host.color) : null,
        host,
        missing: host
          ? null
          : `No host here matches ${item.ref.username}@${item.ref.hostname}:${item.ref.port}. Point this box at one.`,
      };
    }
    case "shell": {
      const shell = src.shellsById.get(item.shellId) ?? null;
      return {
        ...base,
        label: shell?.label || item.label || item.shellId,
        shellKind: shell?.kind ?? "cmd",
        color: shell ? tintOrNull(src.shellColors[shell.kind]) : null,
        shell,
        missing: shell
          ? null
          : `${item.label || item.shellId} isn't available on this machine.`,
      };
    }
    case "profile": {
      const profile = src.profilesById.get(item.profileId) ?? null;
      const shell = profile
        ? (src.shellsById.get(profile.shellId) ?? null)
        : null;
      return {
        ...base,
        label: profile?.label || item.label || "Profile",
        shellKind: shell?.kind ?? "cmd",
        color: profile
          ? tintOrNull(profile.color || src.shellColors[shell?.kind ?? ""])
          : null,
        profile,
        shell,
        missing: !profile
          ? `The profile "${item.label}" isn't saved on this machine.`
          : shell
            ? null
            : profile.shellId === UNMATCHED_CUSTOM && profile.wantedShell
              ? `"${profile.label}" opened the custom local shell "${profile.wantedShell}", which isn't on this machine.`
              : `"${profile.label}" uses a shell that isn't available on this machine.`,
      };
    }
  }
}

function tintOrNull(color: string | null | undefined): string | null {
  return isTintable(color) ? color : null;
}

/** The item a rail row becomes when it is dropped on the canvas. */
export function hostItem(host: Host): TemplateItem {
  return {
    kind: "host",
    hostId: host.id,
    ref: {
      label: host.label,
      hostname: host.hostname,
      port: host.port,
      username: host.username,
    },
  };
}

export function shellItem(shell: LocalShell): TemplateItem {
  return { kind: "shell", shellId: shell.id, label: shell.label };
}

export function profileItem(profile: ShellProfile): TemplateItem {
  return { kind: "profile", profileId: profile.id, label: profile.label };
}

/** A stable React key for an item at a position.
 *
 * The position is part of it on purpose: a template may hold the same host
 * twice, which is an ordinary way to work, and two boxes keyed only by host id
 * would be two boxes React thinks are one.
 */
export function itemKey(item: TemplateItem, index: number): string {
  switch (item.kind) {
    case "host":
      return `${index}:host:${item.hostId ?? item.ref.hostname}`;
    case "shell":
      return `${index}:shell:${item.shellId}`;
    case "profile":
      return `${index}:profile:${item.profileId}`;
  }
}

/** Moves the item at `from` so it lands at `to`, keeping every other item's
 * relative order. The same move the terminal tab strip makes. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0) return items;
  if (from >= items.length || to >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
