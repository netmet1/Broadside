import { ServerIcon } from "lucide-react";

import type { Host } from "@/lib/tauri/hosts";
import { useHint } from "@/lib/status";
import { isTintable } from "@/lib/terminalColors";
import { cn } from "@/lib/utils";
import { LauncherSectionHeader } from "@/pages/terminals/LauncherSection";

type Props = {
  hosts: Host[];
  /** True until the first read lands: the list shows nothing rather than "None
   * yet", which would flash at somebody who has thirty. */
  loading: boolean;
  /** Why the list is empty, when it is empty because something went wrong. */
  error: string | null;
  /** Hosts that already have a tab, so a row can say so. */
  openHostIds: Set<number>;
  /** How many tabs one click will open, for the row's hint. */
  count: number;
  open: boolean;
  onToggle: () => void;
  onOpen: (host: Host) => void;
};

/**
 * The Hosts section of the Terminals "+" launcher: every saved host, in the
 * Hosts tab's own order, one click from a terminal.
 *
 * It is here because the "+" is where you go when you want another session, and
 * until this build it could only make you a local one: a host meant leaving the
 * page, finding the row, coming back. The list is read when the menu opens, so
 * a host added on the other tab a moment ago is in it.
 *
 * **A host already open is not blocked, and asks nothing.** The Hosts tab does
 * ask, because a row there is the one obvious thing to click and clicking it
 * twice is easy. This menu is a deliberate trip through a count and a section,
 * and it exists to open sessions; the row says "already open" and opens another
 * one if that is what you meant. Serial is the only thing here that refuses a
 * second tab, because a COM port genuinely cannot have one.
 */
export function HostLauncherList({
  hosts,
  loading,
  error,
  openHostIds,
  count,
  open,
  onToggle,
  onOpen,
}: Props) {
  const hint = useHint();
  return (
    <div className="mt-1 border-t border-border/60 pt-1">
      <LauncherSectionHeader
        title="Hosts"
        count={loading ? null : hosts.length}
        open={open}
        onToggle={onToggle}
        hintText={
          open
            ? "Roll the host list away. It stays rolled up until you open it again, restarts included"
            : "Show the saved hosts, to open one from here"
        }
      />
      {!open ? null : loading ? null : error ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          Couldn't read the host list. The Hosts tab will say why.
        </p>
      ) : hosts.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          No hosts yet. Add one on the Hosts tab.
        </p>
      ) : (
        // Its own scroller, like the profiles below it: thirty hosts must not
        // push the serial section off the bottom of the window, and the header
        // above stays put so the twisty is always reachable.
        // `overscroll-contain` keeps a wheel that reaches the end of this list
        // from scrolling whatever is behind it.
        <div className="max-h-[40vh] overflow-y-auto overscroll-contain">
          {hosts.map((h) => {
            const already = openHostIds.has(h.id);
            const where = `${h.username}@${h.hostname}:${h.port}`;
            return (
              <button
                key={h.id}
                type="button"
                onClick={() => onOpen(h)}
                title={where}
                {...hint(
                  count > 1
                    ? `Open ${count} terminals on ${h.label} (${where})`
                    : `Open a terminal on ${h.label} (${where})`,
                )}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <ServerIcon
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    !isTintable(h.color) && "text-muted-foreground",
                  )}
                  style={isTintable(h.color) ? { color: h.color } : undefined}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {h.label}
                    {already && (
                      <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                        already open
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {where}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
