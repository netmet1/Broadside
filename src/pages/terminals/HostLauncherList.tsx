import { PlusIcon, ServerIcon } from "lucide-react";

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
  /** Go and add a host: the Hosts tab, with its form open. */
  onNew: () => void;
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
  onNew,
}: Props) {
  const hint = useHint();
  const showsRows = open && !loading && !error && hosts.length > 0;
  return (
    // A flex item of the menu's column: it gives up height down to its header
    // and one row, and the list below is what shrinks (see TerminalsPage).
    <div
      className={cn(
        "mt-1 flex flex-col border-t border-border/60 pt-1",
        showsRows && "min-h-[5.25rem]",
      )}
    >
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
      >
        {/* Adding a host needs the full form, which lives on the Hosts tab:
            this goes there with the form already open rather than growing a
            second, smaller form in a menu. */}
        <button
          type="button"
          onClick={onNew}
          className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          {...hint("Add a host: goes to the Hosts tab with the new-host form open")}
        >
          <PlusIcon className="h-3.5 w-3.5" /> New
        </button>
      </LauncherSectionHeader>
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
        // above stays put so the twisty is always reachable. It takes what
        // room the menu has left rather than a fixed cap, so a taller window
        // shows more of it. `overscroll-contain` keeps a wheel that reaches the
        // end of this list from scrolling whatever is behind it.
        <div className="min-h-0 flex-auto overflow-y-auto overscroll-contain">
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
