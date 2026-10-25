/**
 * The grid on the Terminals tab, read back as a template: what the Save as
 * template button would hand the Templates tab, and whether a saved template
 * already says exactly that.
 *
 * A template is an ordered list of references and nothing else (see
 * lib/tauri/templates), so "the layout matches a template" means the same
 * sessions in the same order: the tiles left to right, top to bottom, which is
 * the tab strip's order. Grid sizes are not part of it because a template does
 * not store any.
 */

import type { TemplateItem } from "@/lib/tauri/templates";
import type { TermSession } from "@/pages/terminals/session";

/** The template item that would open this tab again, or null for one a
 * template cannot hold. A serial console is the one: it names a port on this
 * machine at a line speed, and the Templates editor has nothing to offer it
 * from. */
export function sessionTemplateItem(s: TermSession): TemplateItem | null {
  if (s.type === "ssh") {
    return {
      kind: "host",
      hostId: s.host.id,
      ref: {
        label: s.host.label,
        hostname: s.host.hostname,
        port: s.host.port,
        username: s.host.username,
      },
    };
  }
  if (s.shell.kind === "serial") return null;
  if (s.profileId) {
    return {
      kind: "profile",
      profileId: s.profileId,
      label: s.profileLabel ?? "",
    };
  }
  return { kind: "shell", shellId: s.shell.id, label: s.shell.label };
}

/** What makes two items the same session. A host by its row when it has one,
 * by its endpoint when it is a placeholder (which no open tab can be). Labels
 * are left out: a renamed host is still the same host. */
function itemKey(item: TemplateItem): string {
  switch (item.kind) {
    case "host":
      return item.hostId != null
        ? `h:${item.hostId}`
        : `r:${item.ref.username}@${item.ref.hostname}:${item.ref.port}`;
    case "shell":
      return `s:${item.shellId}`;
    case "profile":
      return `p:${item.profileId}`;
  }
}

/** Whether some saved template is exactly these items, in this order. */
export function matchesATemplate(
  items: TemplateItem[],
  templates: { items: TemplateItem[] }[],
): boolean {
  const key = items.map(itemKey).join("|");
  return templates.some((t) => t.items.map(itemKey).join("|") === key);
}
