/**
 * What travels between the Templates rail and its canvas during a drag.
 *
 * A short string in `text/plain` rather than a module-level variable holding the
 * dragged object, which is the other common way to do this. The string is the
 * only payload the browser actually carries, so a drop can be trusted to be
 * about the thing that was picked up even if the rail has re-rendered, re-sorted
 * or been filtered in between. It is also the same channel the terminal tab
 * strip already reorders itself through.
 *
 * Two vocabularies, told apart by their prefix:
 *
 *   `tpl-rail:host:12`      a rail row, so this drop adds a session
 *   `tpl-box:3`             a box already on the canvas, so this drop moves it
 */

import type { Host } from "@/lib/tauri/hosts";
import type { LocalShell } from "@/lib/tauri/local";
import type { ShellProfile } from "@/lib/localShellProfiles";
import type { TemplateItem } from "@/lib/tauri/templates";
import { hostItem, profileItem, shellItem } from "@/pages/templates/items";

export const DRAG_RAIL_PREFIX = "tpl-rail:";
export const DRAG_BOX_PREFIX = "tpl-box:";

export type DragPayload =
  | { kind: "rail"; item: TemplateItem }
  | { kind: "box"; index: number };

/** Reads a drop back into something the canvas can act on, or null when the
 * drag came from somewhere else entirely (a file, a link, another program).
 * Resolving against the live lists here means a rail row that has since been
 * deleted simply does nothing, rather than adding a reference to it. */
export function parseDrag(
  raw: string,
  sources: {
    hostsById: Map<number, Host>;
    shellsById: Map<string, LocalShell>;
    profilesById: Map<string, ShellProfile>;
  },
): DragPayload | null {
  if (raw.startsWith(DRAG_BOX_PREFIX)) {
    const index = Number.parseInt(raw.slice(DRAG_BOX_PREFIX.length), 10);
    return Number.isInteger(index) && index >= 0 ? { kind: "box", index } : null;
  }
  if (!raw.startsWith(DRAG_RAIL_PREFIX)) return null;
  const rest = raw.slice(DRAG_RAIL_PREFIX.length);
  const at = rest.indexOf(":");
  if (at === -1) return null;
  const what = rest.slice(0, at);
  const id = rest.slice(at + 1);
  if (what === "host") {
    const host = sources.hostsById.get(Number.parseInt(id, 10));
    return host ? { kind: "rail", item: hostItem(host) } : null;
  }
  if (what === "shell") {
    const shell = sources.shellsById.get(id);
    return shell ? { kind: "rail", item: shellItem(shell) } : null;
  }
  if (what === "profile") {
    const profile = sources.profilesById.get(id);
    return profile ? { kind: "rail", item: profileItem(profile) } : null;
  }
  return null;
}
