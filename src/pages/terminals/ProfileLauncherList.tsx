import {
  CopyIcon,
  DownloadIcon,
  GripVerticalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";

import {
  matchingCustomShell,
  UNMATCHED_CUSTOM,
  type ShellProfile,
} from "@/lib/localShellProfiles";
import type { LocalShell } from "@/lib/tauri/local";
import { useHint } from "@/lib/status";
import { isTintable } from "@/lib/terminalColors";
import { useRowDrag } from "@/lib/useRowDrag";
import { useShellColors } from "@/lib/useShellColors";
import { cn } from "@/lib/utils";
import { LauncherSectionHeader } from "@/pages/terminals/LauncherSection";
import { LocalShellIcon } from "@/pages/terminals/LocalShellIcon";

type Props = {
  profiles: ShellProfile[];
  /** True until the first read lands: the list shows nothing rather than "None
   * yet", which would flash at somebody who has twelve. */
  loading: boolean;
  /** Every shell that can launch here; a profile naming another is struck
   * through. */
  shells: LocalShell[];
  onNew: () => void;
  onImport: () => void;
  onExport: () => void;
  onOpen: (profile: ShellProfile) => void;
  onEdit: (profile: ShellProfile) => void;
  onDuplicate: (profile: ShellProfile) => void;
  /** A lone click on the bin, which deletes nothing and explains the gesture. */
  onDeleteClick: () => void;
  /** The double-click that asks to delete. */
  onDeleteRequest: (profile: ShellProfile) => void;
  /** The whole order after a drag, as ids. */
  onReorder: (ids: string[]) => void;
  /** Whether the section is rolled down. Remembered by the page, because the
   * three sections share one stored preference. */
  open: boolean;
  onToggle: () => void;
};

/**
 * The Profiles section of the Terminals "+" launcher: a header with New,
 * Import and Export, then one row per saved profile.
 *
 * Dragging is by the grip only, shared with the Profiles table on the Hosts
 * tab (lib/useRowDrag, which says why).
 */
export function ProfileLauncherList({
  profiles,
  loading,
  shells,
  onNew,
  onImport,
  onExport,
  onOpen,
  onEdit,
  onDuplicate,
  onDeleteClick,
  onDeleteRequest,
  onReorder,
  open,
  onToggle,
}: Props) {
  const hint = useHint();
  const shellColors = useShellColors();
  const drag = useRowDrag(
    profiles.map((p) => p.id),
    onReorder,
  );

  const headerButton =
    "flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
  const rowButton =
    "shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent group-hover:opacity-100";

  const showsRows = open && !loading && profiles.length > 0;
  return (
    // A flex item of the menu's column: it gives up height down to its header
    // and one row, and the list below is what shrinks (see TerminalsPage).
    <div
      className={cn(
        "mt-1 flex flex-col border-t border-border/60 pt-1",
        showsRows && "min-h-[4.75rem]",
      )}
    >
      <LauncherSectionHeader
        title="Profiles"
        count={loading ? null : profiles.length}
        open={open}
        onToggle={onToggle}
        hintText={
          open
            ? "Roll the profile list away. It stays rolled up until you open it again, restarts included"
            : "Show the saved launch profiles"
        }
      >
          <button
            type="button"
            onClick={onImport}
            aria-label="Import profiles"
            title="Import"
            className={headerButton}
            {...hint(
              "Import profiles from a file. You see every profile, startup command included, before anything is saved",
            )}
          >
            <UploadIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onExport}
            disabled={profiles.length === 0}
            aria-label="Export profiles"
            title="Export"
            className={headerButton}
            {...hint("Export every profile, in this order, to a file")}
          >
            <DownloadIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onNew}
            className={headerButton}
            {...hint("Create a saved shell profile")}
          >
            <PlusIcon className="h-3.5 w-3.5" /> New
          </button>
      </LauncherSectionHeader>
      {!open ? null : loading ? null : profiles.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          None yet. A profile opens a shell in a chosen folder and can run a
          command on start.
        </p>
      ) : (
        // Enough profiles and the list is taller than the window. It scrolls
        // here rather than pushing the menu off the bottom of the app: the
        // header above stays put, so New, Import and Export are always reachable
        // and the rest of the menu never moves. It takes what room the menu has
        // left rather than a fixed cap. `overscroll-contain` keeps a wheel that
        // reaches the end of this list from scrolling whatever is behind it.
        <div className="min-h-0 flex-auto overflow-y-auto overscroll-contain">
          {profiles.map((p) => {
            // A profile can outlive a removed WSL distro; flag one whose shell
            // isn't currently available.
            const shell = shells.find((s) => s.id === p.shellId);
            // A profile a restore (or an import) left pointing at nothing says
            // which custom shell it wanted, so the tooltip can name it rather
            // than only saying something is missing.
            const wanted =
              !shell && p.shellId === UNMATCHED_CUSTOM ? p.wantedShell : "";
            const wantedIsBack = !!matchingCustomShell(shells, wanted);
            // The colour the tab will come out, so the launcher shows the same
            // thing the tab strip will: the profile's own if it set one,
            // otherwise its shell's.
            const profileColor =
              p.color || shellColors[shell?.kind ?? ""] || null;
            const side = drag.dropSide(p.id);
            return (
              <div
                key={p.id}
                {...drag.rowProps(p.id)}
                className={cn(
                  "group relative flex items-center gap-1 rounded-sm py-1.5 pl-0.5 pr-2 text-sm hover:bg-accent hover:text-accent-foreground",
                  drag.isDragging(p.id) && "opacity-40",
                )}
              >
                {side && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary",
                      side === "before" ? "-top-px" : "-bottom-px",
                    )}
                  />
                )}
                <span
                  aria-hidden="true"
                  {...drag.gripProps(p.id)}
                  className="shrink-0 cursor-grab rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 active:cursor-grabbing"
                  {...hint("Drag to change this profile's place in the list")}
                >
                  <GripVerticalIcon className="h-3.5 w-3.5" />
                </span>
                <button
                  type="button"
                  onClick={() => onOpen(p)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title={
                    shell
                      ? `${p.shellId}${p.cwd ? `: ${p.cwd}` : ""}`
                      : wanted
                        ? wantedIsBack
                          ? `This profile opened "${wanted}", which is on this machine again: open Edit and pick it`
                          : `This profile opened the custom local shell "${wanted}", which isn't on this machine. Add it under Settings > Local shells`
                        : "This profile's shell isn't available on this machine"
                  }
                >
                  <LocalShellIcon
                    kind={shell?.kind ?? "cmd"}
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      !isTintable(profileColor) && "text-muted-foreground",
                    )}
                    style={
                      isTintable(profileColor)
                        ? { color: profileColor }
                        : undefined
                    }
                  />
                  <span
                    className={cn(
                      "truncate",
                      !shell && "text-muted-foreground line-through",
                    )}
                  >
                    {p.label}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onEdit(p)}
                  aria-label={`Edit ${p.label}`}
                  title="Edit profile"
                  className={cn(rowButton, "hover:text-foreground")}
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                </button>
                {/* The menu stays open: duplicating is what you do when you want
                    two or three of something, and closing the list after each one
                    would make you reopen it to do the next. */}
                <button
                  type="button"
                  onClick={() => onDuplicate(p)}
                  aria-label={`Duplicate ${p.label}`}
                  title="Duplicate profile"
                  className={cn(rowButton, "hover:text-foreground")}
                >
                  <CopyIcon className="h-3.5 w-3.5" />
                </button>
                {/* A double-click, and then the dialog. A profile is saved work
                    with no undo behind it, and this button sits a few pixels from
                    Edit in a menu people move through quickly. A lone click
                    deletes nothing and says why. */}
                <button
                  type="button"
                  onClick={(e) => {
                    // The second click of a double-click arrives here too,
                    // carrying detail 2. Only a click that is on its own needs
                    // explaining.
                    if (e.detail > 1) return;
                    onDeleteClick();
                  }}
                  onDoubleClick={() => onDeleteRequest(p)}
                  aria-label={`Delete ${p.label}`}
                  title="Double-click to delete"
                  className={cn(rowButton, "hover:text-red-500")}
                >
                  <Trash2Icon className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
