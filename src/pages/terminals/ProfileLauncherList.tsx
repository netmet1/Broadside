import { useState } from "react";
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
import { useShellColors } from "@/lib/useShellColors";
import { cn } from "@/lib/utils";
import { LocalShellIcon } from "@/pages/terminals/LocalShellIcon";

type DropSide = "before" | "after";

/** `ids` with `from` moved to just before or just after `to`. Pure. */
function moveProfileId(
  ids: string[],
  from: string,
  to: string,
  side: DropSide,
): string[] {
  if (from === to) return ids;
  const rest = ids.filter((id) => id !== from);
  const at = rest.indexOf(to);
  if (at === -1) return ids;
  rest.splice(side === "before" ? at : at + 1, 0, from);
  return rest;
}

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
};

/**
 * The Profiles section of the Terminals "+" launcher: a header with New,
 * Import and Export, then one row per saved profile.
 *
 * **Dragging is by the grip only.** The row is a launch button with three
 * hover buttons on it, so a whole-row drag would turn a slightly moving click
 * into a drag and a slightly short drag into a launch. Pressing the grip arms
 * that one row as draggable, and letting go disarms it. The pattern is the tab
 * strip's (native drag events, no library), with the drop line drawn above or
 * below the row under the pointer, so a profile can go to the very end.
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
}: Props) {
  const hint = useHint();
  const shellColors = useShellColors();
  const [armedId, setArmedId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; side: DropSide } | null>(null);

  const endDrag = () => {
    setArmedId(null);
    setDragId(null);
    setOver(null);
  };

  const headerButton =
    "flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
  const rowButton =
    "shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent group-hover:opacity-100";

  return (
    <div className="mt-1 border-t border-border/60 pt-1">
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Profiles
        </span>
        <div className="flex items-center gap-0.5">
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
        </div>
      </div>
      {loading ? null : profiles.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          None yet. A profile opens a shell in a chosen folder and can run a
          command on start.
        </p>
      ) : (
        // Enough profiles and the list is taller than the window. It scrolls
        // here rather than pushing the menu off the bottom of the app: the
        // header above stays put, so New, Import and Export are always reachable
        // and the rest of the menu never moves. `overscroll-contain` keeps a
        // wheel that reaches the end of this list from scrolling whatever is
        // behind it.
        <div className="max-h-[40vh] overflow-y-auto overscroll-contain">
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
            return (
              <div
                key={p.id}
                draggable={armedId === p.id}
                onDragStart={(e) => {
                  setDragId(p.id);
                  e.dataTransfer.effectAllowed = "move";
                  // Some webviews need drag data set or the drag is rejected.
                  e.dataTransfer.setData("text/plain", p.id);
                }}
                onDragOver={(e) => {
                  if (!dragId || dragId === p.id) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const box = e.currentTarget.getBoundingClientRect();
                  const side: DropSide =
                    e.clientY < box.top + box.height / 2 ? "before" : "after";
                  if (over?.id !== p.id || over.side !== side) {
                    setOver({ id: p.id, side });
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId && over && dragId !== over.id) {
                    onReorder(
                      moveProfileId(
                        profiles.map((x) => x.id),
                        dragId,
                        over.id,
                        over.side,
                      ),
                    );
                  }
                  endDrag();
                }}
                onDragEnd={endDrag}
                className={cn(
                  "group relative flex items-center gap-1 rounded-sm py-1.5 pl-0.5 pr-2 text-sm hover:bg-accent hover:text-accent-foreground",
                  dragId === p.id && "opacity-40",
                )}
              >
                {over?.id === p.id && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary",
                      over.side === "before" ? "-top-px" : "-bottom-px",
                    )}
                  />
                )}
                <span
                  aria-hidden="true"
                  onPointerDown={() => setArmedId(p.id)}
                  onPointerUp={() => setArmedId(null)}
                  onPointerCancel={() => setArmedId(null)}
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
