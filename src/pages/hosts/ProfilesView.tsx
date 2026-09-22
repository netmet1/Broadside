import { Fragment, useMemo, type ReactNode } from "react";
import {
  CopyIcon,
  DownloadIcon,
  GripVerticalIcon,
  PencilIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  matchingCustomShell,
  missingShellNote,
  UNMATCHED_CUSTOM,
  type ShellProfile,
} from "@/lib/localShellProfiles";
import { useColumnDrag } from "@/lib/columnDrag";
import {
  PROFILE_COLS,
  PROFILE_COL_WIDTHS_KEY,
  PROFILE_ORDERABLE_COLUMNS,
  profileColumnPrefs,
} from "@/lib/profileColumns";
import { useHint } from "@/lib/status";
import type { LocalShell } from "@/lib/tauri/local";
import { useColumnPrefs } from "@/lib/useColumnPrefs";
import { useProfileRowDrag } from "@/lib/useProfileRowDrag";
import { cn } from "@/lib/utils";
import { useColumnResize } from "@/pages/hosts/useColumnResize";

/**
 * The Profiles side of the Hosts tab: every saved launch profile in a table,
 * with the fields that do not fit in the Terminals "+" menu shown in full.
 *
 * **Why a profile list belongs on this tab.** A profile is a saved way of
 * opening a session, which is what a host is and what a template is made of.
 * So this side works the way the Hosts side does: a folder path and a startup
 * command are readable without hovering, a name can be checked against the
 * shell it actually opens, and a profile opens from its own row or several at
 * once from the ticks. The "+" launcher is still the shortest path to one from
 * the Terminals tab; it is no longer the only one.
 *
 * **The order is the launcher's**, and it can be dragged here too, by the grip
 * at the left of a row, exactly as in the launcher (smoke test 69-6, I): it is
 * one stored order, so a drag in either place is seen in both.
 *
 * **The columns behave like the Hosts table's**: drag a header's name to move
 * it, drag its right edge to resize it (double-click to fit), and hide the
 * optional ones in Settings > Appearance, where the order can be dragged too.
 *
 * The checkboxes mean what the Hosts side's mean: the profiles a rail button
 * acts on, whether that is opening them all at once or writing them to a file.
 */
export function ProfilesView({
  profiles,
  loading,
  shells,
  selectedIds,
  onToggle,
  onToggleAll,
  onOpen,
  onEdit,
  onDuplicate,
  onExportOne,
  onDelete,
  onReorder,
}: {
  profiles: ShellProfile[];
  loading: boolean;
  /** Every shell that can launch here, to flag a profile naming another. */
  shells: LocalShell[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  /** Tick or clear every profile at once. */
  onToggleAll: (checked: boolean) => void;
  /** Open this one profile as a terminal tab, on the Terminals tab. */
  onOpen: (p: ShellProfile) => void;
  onEdit: (p: ShellProfile) => void;
  onDuplicate: (p: ShellProfile) => void;
  onExportOne: (p: ShellProfile) => void;
  onDelete: (p: ShellProfile) => void;
  /** The whole order after a row is dragged, as ids. */
  onReorder: (ids: string[]) => void;
}) {
  const hint = useHint();
  const allChecked =
    profiles.length > 0 && profiles.every((p) => selectedIds.has(p.id));

  const rowButton =
    "rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground";

  // Column order and the hidden set, live: Settings can change either while
  // this table is on screen, and the event brings it straight here.
  const { hiddenCols, colOrder, saveOrder } = useColumnPrefs(profileColumnPrefs);
  const { dragProps, isTarget } = useColumnDrag(colOrder, saveOrder);
  /** Every column in render order, fixed ones included. The colgroup, the
   * header and each row all walk this, so they cannot disagree. */
  const orderedIds = useMemo(
    () => ["grip", "select", "swatch", ...colOrder, "actions"],
    [colOrder],
  );
  const { colWidths, tableWidth, tableScrollRef, resizeHandle } =
    useColumnResize(orderedIds, {
      cols: PROFILE_COLS,
      widthsKey: PROFILE_COL_WIDTHS_KEY,
      hiddenCols,
    });
  const rowDrag = useProfileRowDrag(
    profiles.map((p) => p.id),
    onReorder,
  );

  /** A movable column's header: the name is the drag handle, on a span rather
   * than the cell so the resize strip on the cell's edge keeps its gesture
   * (the Hosts table's reasoning, see colDrag there). */
  const headCell = (id: string): ReactNode => (
    <TableHead className={cn("relative", hiddenCols.has(id) && "hidden")}>
      <span
        {...dragProps(id)}
        className={cn(
          "block min-w-0 cursor-grab truncate rounded active:cursor-grabbing",
          isTarget(id) && "bg-primary/20 ring-1 ring-primary/50",
        )}
        title="Drag to move this column"
      >
        {PROFILE_ORDERABLE_COLUMNS.find((c) => c.id === id)?.label ?? id}
      </span>
      {resizeHandle(id)}
    </TableHead>
  );

  return (
    <div
      ref={tableScrollRef}
      className="min-h-0 flex-1 overflow-auto [&_[data-slot=table-container]]:overflow-visible"
    >
      {/* Fixed layout, so the two long columns are cut to the width they are
          given rather than stretching the table: a startup command is one line
          of shell and a folder is a path, and either can be longer than the
          window. The full text is the cell's tooltip. */}
      <Table style={{ tableLayout: "fixed", width: tableWidth }}>
        <colgroup>
          {orderedIds.map((id) => {
            const c = PROFILE_COLS.find((x) => x.id === id);
            if (!c) return null;
            return (
              <col
                key={id}
                className={hiddenCols.has(id) ? "hidden" : undefined}
                style={{ width: colWidths[id] ?? c.w }}
              />
            );
          })}
        </colgroup>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <TableHead
              {...hint(
                "Drag a row by its grip to change the order. The Terminals + menu uses the same order",
              )}
            />
            <TableHead className="text-center">
              <input
                type="checkbox"
                className="accent-primary align-middle"
                checked={allChecked}
                onChange={(e) => onToggleAll(e.target.checked)}
                aria-label="Select every profile"
                {...hint(
                  "Tick every profile, to open them all at once or write them to a file",
                )}
              />
            </TableHead>
            <TableHead />
            {colOrder.map((id) => (
              <Fragment key={id}>{headCell(id)}</Fragment>
            ))}
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell
                colSpan={orderedIds.length}
                className="text-center text-sm text-muted-foreground"
              >
                Loading…
              </TableCell>
            </TableRow>
          ) : (
            profiles.map((p) => {
              const shell = shells.find((s) => s.id === p.shellId);
              // A profile a restore left pointing at nothing names the custom
              // shell it wants; the launcher says the same thing in a tooltip.
              const wanted =
                !shell && p.shellId === UNMATCHED_CUSTOM ? p.wantedShell : "";
              const wantedIsBack = !!matchingCustomShell(shells, wanted);
              const dropSide = rowDrag.dropSide(p.id);
              const bodyCell = (id: string): ReactNode => {
                const hide = hiddenCols.has(id) ? "hidden" : "";
                switch (id) {
                  case "name":
                    return (
                      <TableCell
                        className={cn(
                          "truncate font-medium",
                          !shell && "text-muted-foreground line-through",
                        )}
                        title={p.label}
                      >
                        {p.label}
                      </TableCell>
                    );
                  case "shell":
                    return (
                      <TableCell className={cn("truncate", hide)}>
                        {shell ? (
                          shell.label
                        ) : (
                          <span
                            className="text-amber-700 dark:text-amber-400"
                            {...hint(
                              wanted
                                ? wantedIsBack
                                  ? `This profile opened "${wanted}", which is on this machine again: open Edit and pick it.`
                                  : `This profile opened the custom local shell "${wanted}", which isn't on this machine. Add it under Settings > Local shells.`
                                : "This profile's shell isn't available on this machine, so it will not launch.",
                            )}
                          >
                            {wanted ? `${wanted} (missing)` : "Not available"}
                          </span>
                        )}
                      </TableCell>
                    );
                  // Both of these are the reason this list exists: in the "+"
                  // menu they are a tooltip, and a folder you cannot read is a
                  // folder you cannot check.
                  case "folder":
                    return (
                      <TableCell
                        className={cn("truncate font-mono text-xs", hide)}
                        title={p.cwd}
                      >
                        {p.cwd || (
                          <span className="font-sans text-muted-foreground">
                            Home folder
                          </span>
                        )}
                      </TableCell>
                    );
                  case "startup":
                    return (
                      <TableCell
                        className={cn("truncate font-mono text-xs", hide)}
                        title={p.startupCommand}
                      >
                        {p.startupCommand || (
                          <span className="font-sans text-muted-foreground">
                            None
                          </span>
                        )}
                      </TableCell>
                    );
                  default:
                    return null;
                }
              };
              return (
                <TableRow
                  key={p.id}
                  {...rowDrag.rowProps(p.id)}
                  data-state={selectedIds.has(p.id) ? "selected" : undefined}
                  onClick={() => onToggle(p.id)}
                  className={cn(
                    "group cursor-pointer",
                    rowDrag.isDragging(p.id) && "opacity-40",
                    // The drop line, drawn on the cells because a table row
                    // does not reliably paint a shadow of its own.
                    dropSide === "before" &&
                      "[&>td]:shadow-[inset_0_2px_0_0_var(--primary)]",
                    dropSide === "after" &&
                      "[&>td]:shadow-[inset_0_-2px_0_0_var(--primary)]",
                  )}
                >
                  <TableCell
                    className="px-0 text-center"
                    // A press on the grip is the start of a drag, never a
                    // click on the row's tick.
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span
                      aria-hidden="true"
                      {...rowDrag.gripProps(p.id)}
                      className="inline-flex cursor-grab rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 active:cursor-grabbing"
                      {...hint("Drag to change this profile's place in the list")}
                    >
                      <GripVerticalIcon className="h-3.5 w-3.5" />
                    </span>
                  </TableCell>
                  <TableCell className="text-center">
                    <input
                      type="checkbox"
                      className="accent-primary align-middle"
                      checked={selectedIds.has(p.id)}
                      onChange={() => onToggle(p.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Select ${p.label}`}
                    />
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "block h-3 w-3 rounded-full border border-border",
                        !p.color && "border-dashed",
                      )}
                      style={p.color ? { backgroundColor: p.color } : undefined}
                      aria-label={p.color || "the shell's own colour"}
                    />
                  </TableCell>
                  {colOrder.map((id) => (
                    <Fragment key={id}>{bodyCell(id)}</Fragment>
                  ))}
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {/* First, because it is the thing you came to do, and in
                          the same position as the Hosts side's terminal
                          button. Wrapped in a span so the hint still fires
                          when it is disabled: a disabled button emits no
                          mouse events, so the row would explain nothing at
                          the moment it most needs to. */}
                      <span
                        className="inline-flex"
                        // The row toggles its tick, and a disabled button lets
                        // the click through to it: stopped here so a greyed
                        // Open does nothing at all rather than something else.
                        onClick={(e) => e.stopPropagation()}
                        {...(shell ? {} : hint(missingShellNote(p, true)))}
                      >
                        <button
                          type="button"
                          disabled={!shell}
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpen(p);
                          }}
                          aria-label={`Open ${p.label}`}
                          className={cn(
                            rowButton,
                            "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
                          )}
                          {...(shell
                            ? hint(
                                `Open "${p.label}" as a terminal tab: ${shell.label}${
                                  p.cwd ? ` in ${p.cwd}` : ""
                                }`,
                              )
                            : {})}
                        >
                          <TerminalIcon className="h-4 w-4" />
                        </button>
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEdit(p);
                        }}
                        aria-label={`Edit ${p.label}`}
                        className={rowButton}
                        {...hint("Change this profile's shell, folder, startup command or colour")}
                      >
                        <PencilIcon className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDuplicate(p);
                        }}
                        aria-label={`Duplicate ${p.label}`}
                        className={rowButton}
                        {...hint("Copy this profile, named so the two can be told apart")}
                      >
                        <CopyIcon className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onExportOne(p);
                        }}
                        aria-label={`Export ${p.label}`}
                        className={rowButton}
                        {...hint("Write just this profile to a file, importable anywhere")}
                      >
                        <DownloadIcon className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(p);
                        }}
                        aria-label={`Delete ${p.label}`}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-red-500"
                        {...hint(
                          "Delete this profile. Any template that opens it will say it is missing.",
                        )}
                      >
                        <Trash2Icon className="h-4 w-4" />
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
