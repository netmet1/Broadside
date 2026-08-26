/**
 * Turning a saved template into the sessions a launch opens.
 *
 * A template holds references, and a reference is resolved **at launch**, not
 * when it was saved: a host renamed last week opens under its new name, and a
 * WSL distro uninstalled since is reported rather than silently skipped. The
 * three sources are read fresh every time for exactly that reason.
 *
 * What this does not do is open anything. It returns a plan, and the App layer
 * turns that into tabs through the same path the Hosts tab and the "+" launcher
 * already use. There is one way to open a session in this application and a
 * template is not a second one.
 */

import { listHosts, type Host } from "@/lib/tauri/hosts";
import { listLocalShells, type LocalShell } from "@/lib/tauri/local";
import { loadProfiles } from "@/lib/localShellProfiles";
import type { TemplateItem } from "@/lib/tauri/templates";
import { resolveItem } from "@/pages/templates/items";
import { loadShellColors } from "@/lib/terminalColors";
import type { LocalShellOpenOpts } from "@/pages/terminals/session";

export type LaunchSession =
  | { type: "ssh"; host: Host }
  | { type: "local"; shell: LocalShell; opts: LocalShellOpenOpts };

export type LaunchPlan = {
  /** What will open, in the template's own order. */
  sessions: LaunchSession[];
  /** One line per item that will not, saying why. Reported rather than thrown:
   * a template that names five things and can open four should open four and
   * say so, which is more use than refusing the lot. */
  skipped: string[];
};

export async function planTemplateLaunch(
  items: TemplateItem[],
): Promise<LaunchPlan> {
  const [hosts, shells] = await Promise.all([
    listHosts(),
    // Losing the shells must not cost the hosts: the SSH sessions in this
    // template can still open, and the local ones will say they could not.
    listLocalShells().catch(() => [] as LocalShell[]),
  ]);
  const sources = {
    hostsById: new Map(hosts.map((h) => [h.id, h] as const)),
    shellsById: new Map(shells.map((s) => [s.id, s] as const)),
    profilesById: new Map(loadProfiles().map((p) => [p.id, p] as const)),
    shellColors: loadShellColors() as Record<string, string | null | undefined>,
  };

  const sessions: LaunchSession[] = [];
  const skipped: string[] = [];
  for (const item of items) {
    const r = resolveItem(item, sources);
    if (r.missing) {
      skipped.push(r.missing);
      continue;
    }
    if (r.host) {
      sessions.push({ type: "ssh", host: r.host });
      continue;
    }
    if (r.shell) {
      sessions.push({
        type: "local",
        shell: r.shell,
        // A profile carries its folder, its startup command and its name; a
        // bare shell carries none of those and opens exactly as the "+"
        // launcher would open it.
        opts: r.profile
          ? {
              cwd: r.profile.cwd || undefined,
              startupCommand: r.profile.startupCommand || undefined,
              profileLabel: r.profile.label,
              profileColor: r.profile.color || undefined,
            }
          : {},
      });
    }
  }
  return { sessions, skipped };
}
