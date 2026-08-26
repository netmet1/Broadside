import type { ReactNode } from "react";

import { RailFilterControls } from "@/components/RailFilterControls";
import { RAIL_SORT_OPTIONS } from "@/lib/railSort";
import type { Host } from "@/lib/tauri/hosts";
import type { LocalShell } from "@/lib/tauri/local";
import type { TemplateItem } from "@/lib/tauri/templates";
import type { ShellProfile } from "@/lib/localShellProfiles";
import { isTintable } from "@/lib/terminalColors";
import { useHint } from "@/lib/status";
import type { RailFilter } from "@/lib/useRailFilter";
import { cn } from "@/lib/utils";
import { LocalShellIcon } from "@/pages/terminals/LocalShellIcon";
import {
  hostItem,
  profileItem,
  shellItem,
} from "@/pages/templates/items";
import { DRAG_RAIL_PREFIX } from "@/pages/templates/drag";

/**
 * The Templates editor's own left rail: everything a template can be built out
 * of, in four groups, each row a drag source for the canvas.
 *
 * The look is the Broadcast rail's, deliberately, because it is the same kind
 * of thing (a list of targets beside a working area) and one of them being
 * dressed differently would be noise. What it does **not** have is that rail's
 * pair of Clear buttons at the bottom: nothing on this page clears anything,
 * and a button that would be the only destructive control on the screen has no
 * business sitting there looking like the others.
 *
 * A row can also be clicked, which appends it to the end. Dragging is the way
 * the feature was asked for and the only way to put a session in a *particular*
 * box, but a click costs nothing to offer, is faster once you know the order
 * you want, and is the only one of the two a keyboard can do.
 */
export function TemplateRail({
  sortedHosts,
  enabledShells,
  customTerminals,
  sortedProfiles,
  shellColors,
  hostsError,
  filter,
  sort,
  onSortChange,
  onAdd,
  disabled,
}: {
  sortedHosts: Host[];
  enabledShells: LocalShell[];
  customTerminals: LocalShell[];
  sortedProfiles: ShellProfile[];
  shellColors: Record<string, string | null | undefined>;
  hostsError: string | null;
  filter: RailFilter;
  sort: string;
  onSortChange: (sort: string) => void;
  /** Append this item to the template being edited (a row click). */
  onAdd: (item: TemplateItem) => void;
  /** The template is full: rows stop responding and say why. */
  disabled: boolean;
}) {
  const hint = useHint();
  const visibleHosts = sortedHosts.filter(filter.matches);

  return (
    <div className="flex h-full min-h-0 w-56 shrink-0 flex-col border-r border-border/50 bg-background">
      <div className="shrink-0 border-b border-border/50 px-2 py-1.5">
        <label
          htmlFor="template-rail-sort"
          className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          Drag into the grid
        </label>
        <select
          id="template-rail-sort"
          value={sort}
          onChange={(e) => onSortChange(e.target.value)}
          className="mt-1 w-full rounded-md border border-input bg-background px-1.5 py-1 text-xs outline-none focus-visible:border-ring"
          aria-label="Sort the rail"
          {...hint(
            "Sorts inside each group. Hosts reorder; shells and terminals keep the order the launcher gives them, and profiles only sort by name.",
          )}
        >
          {RAIL_SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="shrink-0 pt-2">
        <RailFilterControls f={filter} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        <Group title="Hosts" count={visibleHosts.length}>
          {hostsError ? (
            <Note>Couldn't read the hosts: {hostsError}</Note>
          ) : sortedHosts.length === 0 ? (
            <Note>No hosts yet. Add one on the Hosts tab.</Note>
          ) : visibleHosts.length === 0 ? (
            <Note>No hosts match the current filter.</Note>
          ) : (
            visibleHosts.map((h) => (
              <Row
                key={h.id}
                dragId={`${DRAG_RAIL_PREFIX}host:${h.id}`}
                label={h.label}
                detail={`${h.username}@${h.hostname}:${h.port}`}
                color={isTintable(h.color) ? h.color : null}
                disabled={disabled}
                onAdd={() => onAdd(hostItem(h))}
              />
            ))
          )}
        </Group>

        <Group title="Local shells" count={enabledShells.length}>
          {enabledShells.length === 0 ? (
            <Note>
              No local shells, or all of them are hidden in Settings,
              Appearance.
            </Note>
          ) : (
            enabledShells.map((s) => (
              <Row
                key={s.id}
                dragId={`${DRAG_RAIL_PREFIX}shell:${s.id}`}
                label={s.label}
                detail={s.id}
                color={
                  isTintable(shellColors[s.kind]) ? shellColors[s.kind]! : null
                }
                shellKind={s.kind}
                disabled={disabled}
                onAdd={() => onAdd(shellItem(s))}
              />
            ))
          )}
        </Group>

        <Group title="Custom terminals" count={customTerminals.length}>
          {customTerminals.length === 0 ? (
            <Note>
              None yet. Add one in Settings, Terminals (Git Bash, MSYS2,
              Cygwin).
            </Note>
          ) : (
            customTerminals.map((s) => (
              <Row
                key={s.id}
                dragId={`${DRAG_RAIL_PREFIX}shell:${s.id}`}
                label={s.label}
                detail={s.kind}
                color={
                  isTintable(shellColors[s.kind]) ? shellColors[s.kind]! : null
                }
                shellKind={s.kind}
                disabled={disabled}
                onAdd={() => onAdd(shellItem(s))}
              />
            ))
          )}
        </Group>

        <Group title="Shell profiles" count={sortedProfiles.length}>
          {sortedProfiles.length === 0 ? (
            <Note>
              None yet. A profile opens a shell in a chosen folder and can run a
              command on start; make one from the "+" on the Terminals tab.
            </Note>
          ) : (
            sortedProfiles.map((p) => (
              <Row
                key={p.id}
                dragId={`${DRAG_RAIL_PREFIX}profile:${p.id}`}
                label={p.label}
                detail={p.cwd || p.shellId}
                color={isTintable(p.color) ? p.color : null}
                shellKind="cmd"
                disabled={disabled}
                onAdd={() => onAdd(profileItem(p))}
              />
            ))
          )}
        </Group>
      </div>
    </div>
  );
}

function Group({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-border/60 pb-1 last:border-b-0">
      <div className="flex items-baseline justify-between px-2 py-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground/70">
          {count}
        </span>
      </div>
      {children}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-1 text-xs leading-tight text-muted-foreground">
      {children}
    </p>
  );
}

function Row({
  dragId,
  label,
  detail,
  color,
  shellKind,
  disabled,
  onAdd,
}: {
  dragId: string;
  label: string;
  detail: string;
  color: string | null;
  /** Absent means a host, which takes the coloured dot instead of an icon. */
  shellKind?: string;
  disabled: boolean;
  onAdd: () => void;
}) {
  const hint = useHint();
  return (
    <button
      type="button"
      draggable={!disabled}
      disabled={disabled}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("text/plain", dragId);
      }}
      onClick={onAdd}
      title={detail}
      {...hint(
        disabled
          ? "This template is full. Remove a session before adding another."
          : `Drag ${label} into a box, or click to add it at the end.`,
      )}
      className={cn(
        "flex w-full items-center gap-2 px-2 py-1 text-left text-xs",
        disabled
          ? "cursor-not-allowed opacity-40"
          : "cursor-grab hover:bg-accent/30 active:cursor-grabbing",
      )}
    >
      {shellKind === undefined ? (
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: color ?? "#6b7280" }}
        />
      ) : (
        <LocalShellIcon
          kind={shellKind}
          className={cn("h-3 w-3 shrink-0", !color && "text-muted-foreground")}
          style={color ? { color } : undefined}
        />
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}
