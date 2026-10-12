import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUpDownIcon,
  ChevronDownIcon,
  DownloadIcon,
  LayoutTemplateIcon,
  ListFilterIcon,
  Loader2Icon,
  PencilIcon,
  PlayIcon,
  PlugZapIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SquareTerminalIcon,
  TagIcon,
  TerminalIcon,
  Trash2Icon,
  UnplugIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/EmptyState";
import { HostFormPanel } from "@/components/HostFormPanel";
import { ImportHostsPanel } from "@/components/ImportHostsPanel";
import { DeleteHostDialog } from "@/components/DeleteHostDialog";
import { TofuKeyDialog } from "@/components/TofuKeyDialog";
import { KeyMismatchDialog } from "@/components/KeyMismatchDialog";
import {
  type Host,
  errorMessage,
  exportHosts,
  listHosts,
} from "@/lib/tauri/hosts";
import {
  HIDEABLE_COLUMNS,
  HOST_COLUMNS_EVENT,
  loadColumnOrder,
  loadHiddenCols,
  saveColumnOrder,
} from "@/lib/hostColumns";
import { useColumnDrag } from "@/lib/columnDrag";
import { parseTags } from "@/lib/hostTags";
import { ShellChip } from "@/components/ShellChip";
import { HOSTS_NAV_HINT } from "@/components/AppShell";
import type { ShellCapability } from "@/lib/shells";
import { nextColor } from "@/lib/palette";
import { useHint, usePageStatus } from "@/lib/status";
import { useRailCompact } from "@/lib/useRailCompact";
import { useUiPrefs } from "@/lib/uiPrefs";
import {
  COLS,
  COL_WIDTHS_KEY,
  UNTAGGED_KEY,
  dtStamp,
} from "@/pages/hosts/constants";
import { SortHeader } from "@/pages/hosts/SortHeader";
import { useHostConnTest } from "@/pages/hosts/useHostConnTest";
import { useHostSort } from "@/pages/hosts/useHostSort";
import { useColumnResize } from "@/pages/hosts/useColumnResize";
import { useHostTagFilter } from "@/pages/hosts/useHostTagFilter";
import { TemplatesView } from "@/pages/hosts/TemplatesView";
import { useTemplateList } from "@/pages/hosts/useTemplateList";
import { ProfilesView } from "@/pages/hosts/ProfilesView";
import { ShellProfileDialog } from "@/components/ShellProfileDialog";
import { ShellProfileImportDialog } from "@/components/ShellProfileImportDialog";
import { type ShellProfile } from "@/lib/localShellProfiles";
import { listLocalShells, type LocalShell } from "@/lib/tauri/local";
import { loadDisabledShells } from "@/lib/localShellPrefs";
import { useProfileActions } from "@/lib/useProfileActions";
import { type Template } from "@/lib/tauri/templates";
import {
  HELP_HOSTS,
  HELP_TEMPLATES,
  HELP_TERMINALS,
  type HelpSectionId,
} from "@/pages/help/sections";
import {
  loadHostsSide,
  rememberHostsSide,
  type HostsSide,
} from "@/lib/hostsSide";
import { cn } from "@/lib/utils";



export function HostsPage({
  onOpenTerminal,
  onOpenTerminals,
  onTerminateHost,
  connectedHostIds,
  openHostIds,
  onEditTemplate,
  onOpenTemplate,
  onOpenProfiles,
  onOpenHelp,
  startWithNewHost = false,
  onNewHostConsumed,
}: {
  onOpenTerminal: (host: Host) => void;
  /** Open terminal tabs for several hosts at once (multi-select). */
  onOpenTerminals: (hosts: Host[]) => void;
  /** Terminate every live terminal session for this host. */
  onTerminateHost: (hostId: number) => void;
  /** Hosts with at least one live terminal session. */
  connectedHostIds: Set<number>;
  /** Hosts with at least one open terminal tab (for the already-open guards). */
  openHostIds: Set<number>;
  /** Switch to the Templates tab with this template loaded, or a new one. */
  onEditTemplate: (template: Template | null) => void;
  /** Open every session in this template. The App layer owns what happens when
   * terminals are already open, because it is the one that knows. */
  onOpenTemplate: (template: Template) => void;
  /** Open these saved profiles as terminal tabs: one from its row, or every one
   * ticked. Resolved and opened by the App layer, through the same path a
   * template launch and the "+" launcher take. */
  onOpenProfiles: (profiles: ShellProfile[]) => void;
  onOpenHelp: (section: HelpSectionId) => void;
  /** Arrive with the new-host form open (New, in the Terminals "+" menu's
   * Hosts section). One-shot: cleared by the caller once taken. */
  startWithNewHost?: boolean;
  onNewHostConsumed?: () => void;
}) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [loading, setLoading] = useState(true);
  // Which side of the Hosts | Templates toggle is showing. Persisted, because
  // an operator who works from templates should not have to pick the same side
  // of the same switch on every launch.
  const [side, setSide] = useState<HostsSide>(loadHostsSide);
  const chooseSide = useCallback((next: HostsSide) => {
    setSide(next);
    rememberHostsSide(next);
  }, []);
  const {
    templates,
    loading: templatesLoading,
    selectedId: selectedTemplateId,
    setSelectedId: setSelectedTemplateId,
    selected: selectedTemplate,
    deleting: deletingTemplate,
    setDeleting: setDeletingTemplate,
    runDelete: runDeleteTemplate,
    duplicate: duplicateTemplate,
  } = useTemplateList();
  // Saved launch profiles, the third side. The Hosts page is built fresh on
  // every visit (App renders it behind `page === "hosts"`), so the hook is
  // always "visible" while this component exists and re-reads on each arrival.
  const {
    profiles,
    loading: profilesLoading,
    saveProfile,
    deleteProfile,
    duplicateProfile,
    reorderProfiles,
    exportProfiles,
    importRows,
    importing,
    startImport,
    cancelImport,
    confirmImport,
  } = useProfileActions(true);
  /** Ticked for a launch or an export, the way the Hosts side's ticks are for
   * Multi-terminal. Ids, so a profile deleted elsewhere just drops out. */
  const [profileSelection, setProfileSelection] = useState<Set<string>>(
    new Set(),
  );
  /** The ticked profiles themselves, in launcher order, or undefined when
   * nothing is ticked: that is what "export everything" looks like to the
   * hook, so the two Export items differ only in what they pass. Multi-profile
   * takes the same list, and is disabled when there is none. */
  const pickedProfiles = useMemo(() => {
    const picked = profiles.filter((p) => profileSelection.has(p.id));
    return picked.length > 0 ? picked : undefined;
  }, [profiles, profileSelection]);
  const toggleProfile = useCallback((id: string) => {
    setProfileSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const toggleAllProfiles = useCallback(
    (checked: boolean) => {
      setProfileSelection(checked ? new Set(profiles.map((p) => p.id)) : new Set());
    },
    [profiles],
  );
  /** Open every ticked profile at once, then clear the ticks: the same
   * gesture, and the same clearing, as Multi-terminal on the Hosts side.
   *
   * No already-open question here, deliberately. Two terminals on one machine
   * is worth asking about because a second login can matter; a second shell in
   * the same folder is just a second shell, and the "+" launcher has always
   * opened one without asking. */
  const openSelectedProfiles = useCallback(() => {
    if (!pickedProfiles) return;
    onOpenProfiles(pickedProfiles);
    setProfileSelection(new Set());
  }, [pickedProfiles, onOpenProfiles]);
  /** The profile editor: null = closed; { profile: null } = new; else edit. */
  const [profileEdit, setProfileEdit] = useState<{
    profile: ShellProfile | null;
  } | null>(null);
  /** Held rather than its id, so the dialog can name it whatever happens to
   * the list underneath while the question is on screen. */
  const [profileDelete, setProfileDelete] = useState<ShellProfile | null>(null);
  // Every shell that can launch here, minus the ones hidden in Settings: the
  // same list the "+" launcher offers, so a profile cannot be pointed at a
  // shell from here that cannot be picked there.
  const [localShells, setLocalShells] = useState<LocalShell[]>([]);
  // Read at mount, which is every arrival on this tab, so a shell hidden in
  // Settings is hidden here the next time you look. Nothing to subscribe to:
  // the page is built fresh each visit.
  const [disabledShells] = useState<Set<string>>(loadDisabledShells);
  useEffect(() => {
    listLocalShells()
      .then(setLocalShells)
      .catch(() => {
        // Costs the shell column its names, never the list of profiles.
      });
  }, []);
  const enabledShells = useMemo(
    () => localShells.filter((s) => !disabledShells.has(s.id)),
    [localShells, disabledShells],
  );

  // Captured once, the way Help captures its focus: the prop is cleared the
  // moment it is taken, and the form must not then close again.
  const [formOpen, setFormOpen] = useState(startWithNewHost);
  const [arrivedForNew] = useState(startWithNewHost);
  useEffect(() => {
    if (arrivedForNew) onNewHostConsumed?.();
  }, [arrivedForNew, onNewHostConsumed]);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<Host | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState<Host | null>(null);

  // A test that connects re-reads the login shell and stores it, so the row
  // takes the new answer straight away rather than waiting for the page to be
  // left and come back. Patched in place, not re-listed: the test says exactly
  // what it stored, and a reload here would fight the sort and the filters.
  const applyLoginShell = useCallback(
    (
      hostId: number,
      loginShell: string | null,
      capability: ShellCapability | null,
    ) => {
      setHosts((prev) =>
        prev.map((h) =>
          h.id === hostId &&
          (h.login_shell !== loginShell || h.shell_capability !== capability)
            ? { ...h, login_shell: loginShell, shell_capability: capability }
            : h,
        ),
      );
    },
    [],
  );

  // Same idea for the reachability mark the backend just wrote. The button goes
  // red (or stops being red) with the toast, and the timestamp here is only ever
  // read as "set or not", so being milliseconds out from the stored one is of no
  // consequence: the next load takes the database's value anyway.
  const applyReachability = useCallback((hostId: number, failed: boolean) => {
    const at = failed ? new Date().toISOString() : null;
    setHosts((prev) =>
      prev.map((h) =>
        h.id === hostId && (h.connect_failed_at === null) === failed
          ? { ...h, connect_failed_at: at }
          : h,
      ),
    );
  }, []);

  // Per-host connection test + the TOFU / key-mismatch dialogs it can surface.
  const { testingId, tofu, setTofu, mismatch, setMismatch, runTest } =
    useHostConnTest(applyLoginShell, applyReachability);

  const defaultColor = useMemo(
    () => nextColor(hosts.map((h) => h.color)),
    [hosts],
  );
  const hint = useHint();

  const connectedCount = useMemo(
    () => hosts.filter((h) => connectedHostIds.has(h.id)).length,
    [hosts, connectedHostIds],
  );

  // Column order (dragged by the header labels, persisted). The three fixed
  // columns are not in it: the checkbox and swatch are the row's grip and the
  // actions are its tail, so they bracket whatever order the rest are in.
  const [colOrder, setColOrder] = useState(loadColumnOrder);
  const { dragProps, isTarget } = useColumnDrag(colOrder, (next) => {
    setColOrder(next);
    saveColumnOrder(next);
  });
  useEffect(() => {
    const read = () => setColOrder(loadColumnOrder());
    window.addEventListener(HOST_COLUMNS_EVENT, read);
    return () => window.removeEventListener(HOST_COLUMNS_EVENT, read);
  }, []);
  /** Every column id in render order, fixed ones included. The colgroup, the
   * header and each row all walk this, so they cannot disagree. */
  const orderedIds = useMemo(
    () => ["select", "swatch", ...colOrder, "actions"],
    [colOrder],
  );

  // Columns the user hid from Settings → Appearance (read on mount; the Hosts
  // tab remounts when shown, so it always reflects the latest choice).
  const [hiddenCols] = useState(loadHiddenCols);
  // Drag-to-resize / double-click-to-fit columns.
  const { colWidths, tableWidth, tableScrollRef, resizeHandle } =
    useColumnResize(orderedIds, {
      cols: COLS,
      widthsKey: COL_WIDTHS_KEY,
      hiddenCols,
    });

  /**
   * Everything that makes a column header draggable, and a target for another
   * one: spread onto the span wrapping each header's label.
   *
   * On a span inside the cell and not on the cell itself, deliberately. The
   * cell's right edge carries the resize strip, and a draggable *ancestor*
   * swallows that gesture as a column drag, so dragging a column wider would
   * move it instead. The strip is this span's sibling, painted over it, so the
   * span can be as wide as the cell without taking the resize away.
   */
  const colDrag = (id: string) => ({
    ...dragProps(id),
    // `flex`, never `inline-flex`, and this is not cosmetic. An inline box is
    // sized shrink-to-fit, which here means "as wide as the sort button's
    // content, less the 4px that button bleeds either side" (SortHeader is
    // `-mx-1 px-1` so its hover plate lines up with the cell's text). The
    // button's own `max-w-full` then resolves against that 8px-short width and
    // ellipsises a header that had all the room in the world: `Label` came out
    // as `La...` and `Username` as `Userna...` however wide the column was
    // dragged. A block-level flex box fills the cell, so a header truncates
    // when its column is genuinely too narrow and not before. `flex-1` is for
    // the Tag header, where this span shares a flex row with the filter icon
    // and would otherwise be shrink-to-fit all over again.
    className: `flex min-w-0 flex-1 cursor-grab rounded active:cursor-grabbing${
      isTarget(id) ? " bg-primary/20 ring-1 ring-primary/50" : ""
    }`,
    title: "Drag to move this column",
  });

  /**
   * Each movable column's header cell, by id.
   *
   * A lookup rather than a written-out sequence because the order is the
   * user's now: the colgroup, this and the body cells all walk `colOrder`,
   * so they cannot get out of step with one another. The cells themselves
   * are unchanged; only what decides their position has moved.
   */
  const headCell = (id: string): ReactNode => {
    switch (id) {
      case "label":
        return (
          <TableHead className="relative">
            <span {...colDrag("label")}>
              <SortHeader
                label="Label"
                sortKey="label"
                sort={sort}
                onSort={toggleSort}
                headHint={hint("The host's unique display name, shown in its colour, in logs, and when picking hosts")}
              />
            </span>
            {resizeHandle("label")}
          </TableHead>
        );
      case "status":
        return (
          <TableHead className={hiddenCols.has("status") ? "hidden" : "text-xs"}>
            <span {...colDrag("status")}>
              <SortHeader
                label="Status"
                display="S"
                sortKey="status"
                sort={sort}
                onSort={toggleSort}
                headHint={hint("Status (S): terminal connection. Green dot = a terminal to this host is connected; otherwise none is open")}
              />
            </span>
          </TableHead>
        );
      case "hostname":
        return (
          <TableHead className="relative">
            <span {...colDrag("hostname")}>
              <SortHeader
                label="Hostname"
                sortKey="hostname"
                sort={sort}
                onSort={toggleSort}
                headHint={hint("The host's address: the IP or DNS name used to connect")}
              />
            </span>
            {resizeHandle("hostname")}
          </TableHead>
        );
      case "port":
        return (
          <TableHead className={hiddenCols.has("port") ? "hidden" : "relative"}>
            <span {...colDrag("port")}>
              <SortHeader
                label="Port"
                sortKey="port"
                sort={sort}
                onSort={toggleSort}
                headHint={hint("The SSH port (default 22)")}
              />
            </span>
            {resizeHandle("port")}
          </TableHead>
        );
      case "username":
        return (
          <TableHead className={hiddenCols.has("username") ? "hidden" : "relative"}>
            <span {...colDrag("username")}>
              <SortHeader
                label="Username"
                sortKey="username"
                sort={sort}
                onSort={toggleSort}
                headHint={hint("The SSH login user for this host")}
              />
            </span>
            {resizeHandle("username")}
          </TableHead>
        );
      case "tag":
        return (
          <TableHead className={hiddenCols.has("tag") ? "hidden" : "relative"}>
            <div className="flex min-w-0 items-center gap-1">
              <span {...colDrag("tag")}>
                <SortHeader
                  label="Tag"
                  sortKey="tag"
                  sort={sort}
                  onSort={toggleSort}
                  headHint={hint("Tags for grouping/sorting; separate multiple with commas (e.g. prod, db)")}
                />
              </span>
              <div ref={tagMenuRef} className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setTagMenuOpen((v) => !v)}
                  aria-label="Filter by tag"
                  aria-expanded={tagMenuOpen}
                  className={`rounded p-0.5 ${
                    tagFilterActive
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                  }`}
                  {...hint(
                    tagFilterActive
                      ? "Tag filter active, click to change (this session only)"
                      : "Filter which hosts show by tag (this session only)",
                  )}
                >
                  <ListFilterIcon className="h-3.5 w-3.5" />
                </button>
                {tagMenuOpen && (
                  <div className="absolute left-0 top-full z-50 mt-1 max-h-72 w-52 overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
                    <div className="flex items-center justify-between px-2 py-1 text-[11px] font-normal text-muted-foreground">
                      <span>Show tags</span>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="hover:text-foreground"
                          onClick={() => setAllTagsVisible(true)}
                        >
                          All
                        </button>
                        <button
                          type="button"
                          className="hover:text-foreground"
                          onClick={() => setAllTagsVisible(false)}
                        >
                          None
                        </button>
                      </div>
                    </div>
                    {tagOptions.length === 0 && !hasUntagged ? (
                      <p className="px-2 py-1.5 text-xs font-normal text-muted-foreground">
                        No tags yet.
                      </p>
                    ) : (
                      <>
                        {tagOptions.map((t) => {
                          const key = t.toLowerCase();
                          return (
                            <label
                              key={key}
                              className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm font-normal hover:bg-accent"
                            >
                              <input
                                type="checkbox"
                                className="accent-primary"
                                checked={!hiddenTags.has(key)}
                                onChange={() => toggleTagFilter(key)}
                              />
                              <span className="min-w-0 truncate">{t}</span>
                            </label>
                          );
                        })}
                        {hasUntagged && (
                          <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm font-normal italic text-muted-foreground hover:bg-accent">
                            <input
                              type="checkbox"
                              className="accent-primary"
                              checked={!hiddenTags.has(UNTAGGED_KEY)}
                              onChange={() => toggleTagFilter(UNTAGGED_KEY)}
                            />
                            <span>(untagged)</span>
                          </label>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
            {resizeHandle("tag")}
          </TableHead>
        );
      case "flavor":
        return (
          <TableHead className={hiddenCols.has("flavor") ? "hidden" : "relative"}>
            <span {...colDrag("flavor")}>
              <SortHeader
                label="Flavor"
                sortKey="flavor"
                sort={sort}
                onSort={toggleSort}
                headHint={hint("The host's Linux distribution (icon only), set on the host form")}
              />
            </span>
            {resizeHandle("flavor")}
          </TableHead>
        );
      default:
        return null;
    }
  };

  /** The same for one row's cells. `h` is the host the row is about. */
  const bodyCell = (h: Host, id: string): ReactNode => {
    switch (id) {
      case "label":
        return (
              <TableCell className="truncate font-medium" title={labelTooltip(h)}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{h.label}</span>
                  {/* A login shell we can't fully drive (fish, csh), one we
                      can't drive at all (a console menu), or one we could
                      not read. Only shown once a connect has actually
                      reached a verdict, so an unprobed host is never
                      flagged on a guess (X4, D-067). */}
                  <ShellChip
                    capability={h.shell_capability}
                    loginShell={h.login_shell}
                    pref={h.shell_integration}
                  />
                </span>
              </TableCell>
        );
      case "status":
        return (
              <TableCell className={hiddenCols.has("status") ? "hidden" : undefined}>
                <span
                  className={`block h-2.5 w-2.5 rounded-full ${
                    connectedHostIds.has(h.id)
                      ? "bg-emerald-500"
                      : "bg-red-500/70"
                  }`}
                  title={
                    connectedHostIds.has(h.id)
                      ? "Connected: live terminal session"
                      : "Not connected"
                  }
                  aria-label={
                    connectedHostIds.has(h.id) ? "Connected" : "Not connected"
                  }
                />
              </TableCell>
        );
      case "hostname":
        return (
              <TableCell className="truncate font-mono text-xs" title={h.hostname}>
                {h.hostname}
              </TableCell>
        );
      case "port":
        return (
              <TableCell
                className={
                  hiddenCols.has("port")
                    ? "hidden"
                    : "truncate font-mono text-xs"
                }
              >
                {h.port}
              </TableCell>
        );
      case "username":
        return (
              <TableCell
                className={
                  hiddenCols.has("username")
                    ? "hidden"
                    : "truncate font-mono text-xs"
                }
                title={h.username}
              >
                {h.username}
              </TableCell>
        );
      case "tag":
        return (
              <TableCell
                className={hiddenCols.has("tag") ? "hidden" : "text-xs"}
                title={h.tag ?? undefined}
              >
                {parseTags(h.tag).length === 0 ? (
                  <span className="text-muted-foreground">-</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {parseTags(h.tag).map((t) => (
                      <span
                        key={t}
                        className="rounded bg-muted px-1.5 py-0.5 text-[11px] leading-tight"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </TableCell>
        );
      case "flavor":
        return (
              <TableCell
                className={
                  hiddenCols.has("flavor")
                    ? "hidden"
                    : "truncate text-xs text-muted-foreground"
                }
              >
                {h.linux_flavor ?? "-"}
              </TableCell>
        );
      default:
        return null;
    }
  };

  // Column sorting (persisted for the session) + the sorted view.
  const { sort, toggleSort, sortedHosts } = useHostSort(
    hosts,
    connectedHostIds,
  );

  // Tag filter (#8) + label search + the sorted-and-filtered view for the table.
  const {
    hiddenTags,
    tagOptions,
    hasUntagged,
    tagFilterActive,
    toggleTagFilter,
    setAllTagsVisible,
    labelQuery,
    setLabelQuery,
    labelFilterActive,
    visibleHosts,
    tagMenuOpen,
    setTagMenuOpen,
    tagMenuRef,
  } = useHostTagFilter(hosts, sortedHosts);

  // Per-host "missing fields" popup (#9): which hidden columns + their values.
  const [infoHost, setInfoHost] = useState<Host | null>(null);

  // Multi-select for the "Multi-terminal" action.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Out of room: the words go and the icons stay. Every width in this row is a
  // rem and the window's minimum is in pixels, so a row that fits at a 16px app
  // font runs off the edge above it (see lib/useRailCompact). The selection
  // count is in the key because the Multi-terminal label changes width with it.
  const railRef = useRef<HTMLDivElement>(null);
  const { prefs } = useUiPrefs();
  // `side` is in the key because the three rails are different widths, and the
  // two selection counts because both Multi- buttons change width with them.
  const compact = useRailCompact(
    railRef,
    [
      prefs.appFontSize,
      side,
      selectedIds.size > 0,
      profileSelection.size > 0,
    ].join("|"),
  );

  const toggleSelected = (id: number) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allDisplayedSelected =
    visibleHosts.length > 0 && visibleHosts.every((h) => selectedIds.has(h.id));
  const someSelected = selectedIds.size > 0 && !allDisplayedSelected;
  const toggleSelectAll = () =>
    setSelectedIds(
      allDisplayedSelected ? new Set() : new Set(visibleHosts.map((h) => h.id)),
    );
  // H7: opening a single host that already has a terminal asks first.
  const [reopenConfirm, setReopenConfirm] = useState<Host | null>(null);
  const handleOpenTerminal = (host: Host) => {
    if (openHostIds.has(host.id)) {
      setReopenConfirm(host);
    } else {
      onOpenTerminal(host);
    }
  };

  // H8: Multi-terminal warns about the already-open hosts; the user keeps the
  // ones they want duplicated checked and unchecks the rest.
  const [multiDup, setMultiDup] = useState<{
    chosen: Host[];
    dups: Host[];
    checked: Set<number>;
  } | null>(null);
  const openSelectedTerminals = () => {
    const chosen = hosts.filter((h) => selectedIds.has(h.id));
    if (chosen.length === 0) return;
    const dups = chosen.filter((h) => openHostIds.has(h.id));
    if (dups.length === 0) {
      onOpenTerminals(chosen);
      setSelectedIds(new Set());
      return;
    }
    setMultiDup({ chosen, dups, checked: new Set(dups.map((h) => h.id)) });
  };
  const toggleDup = (id: number) =>
    setMultiDup((prev) => {
      if (!prev) return prev;
      const checked = new Set(prev.checked);
      if (checked.has(id)) checked.delete(id);
      else checked.add(id);
      return { ...prev, checked };
    });
  const confirmMulti = () => {
    if (!multiDup) return;
    // Open every host that isn't already open, plus the duplicates still checked.
    const toOpen = multiDup.chosen.filter(
      (h) => !openHostIds.has(h.id) || multiDup.checked.has(h.id),
    );
    if (toOpen.length > 0) onOpenTerminals(toOpen);
    setSelectedIds(new Set());
    setMultiDup(null);
  };

  usePageStatus(
    side === "profiles"
      ? profilesLoading
        ? null
        : profileSelection.size > 0
          ? `Showing ${profiles.length} ${
              profiles.length === 1 ? "profile" : "profiles"
            } · ${profileSelection.size} ticked`
          : `Showing ${profiles.length} ${
              profiles.length === 1 ? "profile" : "profiles"
            }`
      : side === "templates"
      ? templatesLoading
        ? null
        : `Showing ${templates.length} ${
            templates.length === 1 ? "template" : "templates"
          }`
      : loading
        ? null
        : (tagFilterActive || labelFilterActive) && visibleHosts.length !== hosts.length
          ? `Showing ${visibleHosts.length} of ${hosts.length} hosts (filtered) · ${connectedCount} connected`
          : `Showing ${hosts.length} ${hosts.length === 1 ? "host" : "hosts"} · ${connectedCount} connected`,
    !formOpen && !importOpen,
  );

  const refresh = useCallback(async () => {
    try {
      const list = await listHosts();
      setHosts(list);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // The first load. Called here rather than through `refresh` so the state
  // write is visibly in a continuation instead of behind a function the effect
  // body appears to run synchronously, and so a list arriving after the page
  // goes away is dropped. `refresh` stays for the reloads after an add, edit,
  // delete or import.
  useEffect(() => {
    let alive = true;
    listHosts()
      .then((list) => {
        if (alive) setHosts(list);
      })
      .catch((e) => toast.error(errorMessage(e)))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (host: Host) => {
    // Opening the form used to clear the failed mark, on the theory that the
    // operator was about to fix whatever was wrong. It no longer does: the mark
    // now means "the last attempt to reach this host failed", and editing the
    // row is not an attempt. It clears when the host answers.
    setEditing(host);
    setFormOpen(true);
  };

  const openDelete = (host: Host) => {
    setDeleting(host);
    setDeleteOpen(true);
  };

  const handleSaved = () => {
    setFormOpen(false);
    refresh();
  };

  const runExport = useCallback(async () => {
    try {
      const path = await saveDialog({
        title: "Export hosts",
        defaultPath: `${dtStamp()}-broadside-hosts.csv`,
        filters: [
          { name: "CSV", extensions: ["csv"] },
          { name: "Excel workbook", extensions: ["xlsx"] },
        ],
      });
      if (typeof path !== "string") return;
      const count = await exportHosts(path);
      toast.success(`Exported ${count} ${count === 1 ? "host" : "hosts"}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, []);

  /** A hidden column's value as plain text, for the Label cell's tooltip. A
   * `title` attribute takes a string and nothing else, so the chips and colours
   * the popup can afford are not available here. */
  const hiddenValueText = (colId: string, h: Host): string => {
    switch (colId) {
      case "status":
        return connectedHostIds.has(h.id) ? "Connected" : "Not connected";
      case "port":
        return String(h.port);
      case "username":
        return h.username || "-";
      case "tag": {
        const tags = parseTags(h.tag);
        return tags.length === 0 ? "-" : tags.join(", ");
      }
      case "flavor":
        return h.linux_flavor ?? "-";
      default:
        return "-";
    }
  };

  /**
   * The Label cell's tooltip: the things this row is not showing you.
   *
   * It used to be `title={h.label}`, which repeated a word already on screen
   * and taught you to ignore it. What is worth surfacing on hover is what the
   * table cannot fit: the host's notes, and any column hidden from Settings →
   * Appearance, one per line.
   *
   * The label leads, because `truncate` can clip it and a tooltip that exists
   * anyway may as well finish the sentence. But only when there is something
   * else to say: with no notes and no hidden columns there is no tooltip at
   * all, rather than the echo this replaces.
   *
   * Newlines are real line breaks in a native tooltip, which is the whole
   * reason this is a `title` and not a component. It also survives the row
   * being scrolled, re-sorted or re-rendered under the cursor, which a
   * hover-card anchored to a cell in a virtualised-feeling table does not.
   */
  const labelTooltip = (h: Host): string | undefined => {
    const notes = h.notes?.trim();
    const hidden = HIDEABLE_COLUMNS.filter((c) => hiddenCols.has(c.id));
    if (!notes && hidden.length === 0) return undefined;
    const lines = [h.label];
    if (notes) lines.push("", notes);
    if (hidden.length > 0) {
      lines.push("");
      for (const c of hidden) lines.push(`${c.label}: ${hiddenValueText(c.id, h)}`);
    }
    return lines.join("\n");
  };

  // Renders a hidden column's value for the per-host "missing fields" popup (#9).
  const renderHiddenValue = (colId: string, h: Host): ReactNode => {
    switch (colId) {
      case "status":
        return connectedHostIds.has(h.id) ? "Connected" : "Not connected";
      case "port":
        return h.port;
      case "username":
        return h.username || "-";
      case "tag": {
        const tags = parseTags(h.tag);
        return tags.length === 0 ? (
          "-"
        ) : (
          <div className="flex flex-wrap gap-1">
            {tags.map((t) => (
              <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                {t}
              </span>
            ))}
          </div>
        );
      }
      case "flavor":
        return h.linux_flavor ?? "-";
      default:
        return "-";
    }
  };

  if (formOpen) {
    return (
      <HostFormPanel
        key={editing?.id ?? "new"}
        host={editing}
        defaultColor={defaultColor}
        existingHosts={hosts}
        onCancel={() => setFormOpen(false)}
        onSaved={handleSaved}
      />
    );
  }

  if (importOpen) {
    return (
      <ImportHostsPanel
        existingColors={hosts.map((h) => h.color)}
        onCancel={() => setImportOpen(false)}
        onImported={refresh}
      />
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div ref={railRef} className="flex items-center justify-between gap-4">
        {/* No subtitle under the heading. What it said reaches the status bar
            instead, from this heading and from the sidebar's Hosts button,
            which is where every other page's description already lives. The
            room it gave back is what keeps the buttons on the right labelled
            for longer at a narrow window.

            The heading is not a control, so it takes the hint on hover only;
            the sidebar button is the one that answers to Tab. */}
        <div className="flex min-w-0 items-center gap-3">
          <h1
            className="min-w-0 truncate font-heading text-xl font-semibold tracking-tight"
            {...hint(HOSTS_NAV_HINT)}
          >
            Hosts
          </h1>
          {/* Two lists on one tab, switched the way the Terminals rail switches
              between Tabs and Grid. They belong together: a template is an
              arrangement of the machines in the other list, and keeping it on
              its own tab would mean two places to go to answer "what have I got
              and how do I open it". The Templates *editor* is elsewhere; this
              is the list. */}
          <div
            role="group"
            aria-label="Hosts, templates or profiles"
            className="flex shrink-0 items-center gap-0.5 rounded-md border border-input p-0.5"
          >
            <button
              type="button"
              onClick={() => chooseSide("hosts")}
              aria-pressed={side === "hosts"}
              className={cn(
                "flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium transition-colors",
                side === "hosts"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              {...hint("The machines Broadside knows about.")}
            >
              <ServerIcon className="h-3.5 w-3.5" />
              Hosts
            </button>
            <button
              type="button"
              onClick={() => chooseSide("templates")}
              aria-pressed={side === "templates"}
              className={cn(
                "flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium transition-colors",
                side === "templates"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              {...hint(
                "Saved arrangements of sessions. Pick one and press Open to launch the whole set.",
              )}
            >
              <LayoutTemplateIcon className="h-3.5 w-3.5" />
              Templates
            </button>
            {/* The third list. A profile is a saved way of opening a session,
                the same kind of thing as the two beside it, and until now it
                could only be managed from a dropdown on another tab: a folder
                path and a startup command had to be read through a tooltip.
                The "+" launcher is still where they are used. */}
            <button
              type="button"
              onClick={() => chooseSide("profiles")}
              aria-pressed={side === "profiles"}
              className={cn(
                "flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium transition-colors",
                side === "profiles"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              {...hint(
                "Saved local-shell launch profiles: a shell, a folder and an optional startup command. Open one from its row, or tick several and open them together.",
              )}
            >
              <SquareTerminalIcon className="h-3.5 w-3.5" />
              Profiles
            </button>
          </div>
        </div>
        {side === "profiles" ? (
          <div className="flex shrink-0 gap-2">
            {/* The same button the Hosts side has, doing the same thing to the
                same kind of list: open every ticked one at once. A profile is
                a saved way of opening a session, so a list of them that could
                not open one was the odd thing out on this tab. */}
            <Button
              variant="outline"
              onClick={openSelectedProfiles}
              disabled={profileSelection.size === 0}
              aria-label="Multi-profile"
              {...hint(
                profileSelection.size > 0
                  ? "Open a terminal tab for every ticked profile at once"
                  : "Tick some profiles first. This opens a terminal tab for each of them at once.",
              )}
            >
              <TerminalIcon />
              {compact ? "" : "Multi-profile"}
              {profileSelection.size > 0
                ? compact
                  ? profileSelection.size
                  : ` (${profileSelection.size})`
                : ""}
            </Button>
            {/* Export is the button, because per-profile export is the reason
                this side has an Import/Export of its own: the "+" menu can only
                write the lot. What it writes follows the ticks, and with none
                it writes everything, so the plain case needs no ticking. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  aria-label="Import / Export profiles"
                  {...hint(
                    "Move profiles in or out of Broadside as a JSON file. No credentials are included.",
                  )}
                >
                  <ArrowUpDownIcon />
                  {!compact && (
                    <>
                      Import / Export
                      <ChevronDownIcon className="-mr-1 opacity-60" />
                    </>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => void exportProfiles(pickedProfiles)}
                  disabled={profilesLoading || profileSelection.size === 0}
                  {...hint(
                    "Write the ticked profiles to a file. One ticked profile writes one profile.",
                  )}
                >
                  <DownloadIcon />
                  {profileSelection.size === 0
                    ? "Export ticked profiles…"
                    : profileSelection.size === 1
                      ? "Export the ticked profile…"
                      : `Export ${profileSelection.size} ticked profiles…`}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void exportProfiles()}
                  disabled={profilesLoading || profiles.length === 0}
                  {...hint(
                    "Write every profile to a file, in launcher order, re-importable here or on another PC",
                  )}
                >
                  <DownloadIcon />
                  Export all profiles…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void startImport()}
                  {...hint(
                    "Add profiles from a file. You see every profile, startup command included, before anything is saved.",
                  )}
                >
                  <UploadIcon />
                  Import profiles…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              onClick={() => setProfileEdit({ profile: null })}
              aria-label="New profile"
              {...hint("Save a shell, a folder and an optional startup command as a profile")}
            >
              <PlusIcon />
              {!compact && "New profile"}
            </Button>
          </div>
        ) : side === "templates" ? (
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              onClick={() => selectedTemplate && onOpenTemplate(selectedTemplate)}
              disabled={!selectedTemplate}
              aria-label="Open template"
              {...hint(
                selectedTemplate
                  ? `Open every session in "${selectedTemplate.name}", in order, on the Terminals tab`
                  : "Pick a template first. Open launches the whole arrangement at once."
              )}
            >
              <PlayIcon />
              {compact ? "" : "Open"}
            </Button>
            <Button
              onClick={() => onEditTemplate(null)}
              aria-label="New template"
              {...hint("Build a new arrangement on the Templates tab")}
            >
              <PlusIcon />
              {!compact && "New template"}
            </Button>
          </div>
        ) : (
        <div className="flex shrink-0 gap-2">
          {/* Ctrl-f style label search over the table, mirroring the broadcast
              rails' "Find by label…" box. Narrows the table with the tag filter. */}
          {/* min-w-0 so this is what gives up room first when the row is
              tight: a search box that has narrowed still takes what you type,
              which is more than can be said for a button off the edge. */}
          <div className="relative w-52 min-w-0 self-center">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={labelQuery}
              onChange={(e) => setLabelQuery(e.target.value)}
              placeholder="Find by label…"
              aria-label="Find hosts by label"
              spellCheck={false}
              className="h-9 w-full rounded-md border border-input bg-background py-1 pl-8 pr-8 text-sm outline-none focus-visible:border-ring"
            />
            {labelQuery && (
              <button
                type="button"
                onClick={() => setLabelQuery("")}
                aria-label="Clear label search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Button
            variant="outline"
            onClick={openSelectedTerminals}
            disabled={selectedIds.size === 0}
            aria-label="Multi-terminal"
            {...hint("Open a terminal tab for every selected host at once")}
          >
            <TerminalIcon />
            {/* The count survives losing the label: it is the live number of
                ticked hosts and the whole reason to glance at this button. */}
            {compact ? "" : "Multi-terminal"}
            {selectedIds.size > 0
              ? compact
                ? selectedIds.size
                : ` (${selectedIds.size})`
              : ""}
          </Button>
          {/* Import and export are one menu, not two buttons. At the app's own
              1024px minimum window this rail had nothing left to give: Button
              is shrink-0 whitespace-nowrap, so the row simply ran off the edge
              into the page's horizontal scrollbar. These two are also the least
              used things here, which makes them the right pair to fold.
              Folding was measured at a 16px app font, though, and every width
              in the row is a rem, so above that the labels go too (see
              lib/useRailCompact). */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                aria-label="Import / Export"
                {...hint("Move hosts in or out of Broadside as a CSV or Excel file")}
              >
                <ArrowUpDownIcon />
                {!compact && (
                  <>
                    Import / Export
                    <ChevronDownIcon className="-mr-1 opacity-60" />
                  </>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => void runExport()}
                disabled={loading || hosts.length === 0}
                {...hint("Export all hosts to a CSV or Excel (.xlsx) file, re-importable. No credentials are included.")}
              >
                <DownloadIcon />
                Export hosts…
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setImportOpen(true)}
                {...hint("Bulk-add hosts from a CSV or Excel file")}
              >
                <UploadIcon />
                Import hosts…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            onClick={openAdd}
            aria-label="Add host"
            {...hint("Add a single host through the form")}
          >
            <PlusIcon />
            {!compact && "Add host"}
          </Button>
        </div>
        )}
      </div>

      {side === "profiles" ? (
        profilesLoading || profiles.length > 0 ? (
          <ProfilesView
            profiles={profiles}
            loading={profilesLoading}
            shells={localShells}
            selectedIds={profileSelection}
            onToggle={toggleProfile}
            onToggleAll={toggleAllProfiles}
            onOpen={(p) => onOpenProfiles([p])}
            onEdit={(p) => setProfileEdit({ profile: p })}
            onDuplicate={duplicateProfile}
            onExportOne={(p) => void exportProfiles([p])}
            onDelete={setProfileDelete}
            onReorder={reorderProfiles}
          />
        ) : (
          <EmptyState
            icon={SquareTerminalIcon}
            title="Profiles"
            actionLabel="Create your first profile"
            onAction={() => setProfileEdit({ profile: null })}
            actionHint="A shell, a folder and an optional startup command, saved under a name"
            description="A profile is a saved way of opening a local shell: which shell, which folder, and a command to run once it opens. Kept here, opened from here or from the Terminals + menu."
            helpSection={HELP_TERMINALS}
            onOpenHelp={onOpenHelp}
          />
        )
      ) : side === "templates" ? (
        templatesLoading || templates.length > 0 ? (
          <TemplatesView
            templates={templates}
            loading={templatesLoading}
            selectedId={selectedTemplateId}
            onSelect={setSelectedTemplateId}
            onEdit={onEditTemplate}
            onDuplicate={(t) => void duplicateTemplate(t)}
            onDelete={setDeletingTemplate}
          />
        ) : (
          <EmptyState
            icon={LayoutTemplateIcon}
            title="Templates"
            actionLabel="Create your first template"
            onAction={() => onEditTemplate(null)}
            actionHint="Build an arrangement of sessions on the Templates tab"
            description="A template is a saved arrangement of terminal sessions. Build it once, then open the whole set from here in a single action."
            helpSection={HELP_TEMPLATES}
            onOpenHelp={onOpenHelp}
          />
        )
      ) : !loading && hosts.length === 0 ? (
        /* Nothing here yet, so nothing to put in a table. The headings used to
           stay up over an empty grid with one line of text under them, which
           made a fresh install look like a page that had failed to load rather
           than one nobody had used. Only what is *drawn* changes: the hosts are
           read, saved and deleted exactly as before. */
        <EmptyState
          icon={ServerIcon}
          title="Hosts"
          actionLabel="Add your first host"
          onAction={openAdd}
          actionHint="Add a single host through the form"
          description="A host is a machine Broadside can reach over SSH: an address, a user name and how to authenticate. Everything else in the application works from this list."
          helpSection={HELP_HOSTS}
          onOpenHelp={onOpenHelp}
        />
      ) : (
      /* Neutralize the shadcn Table's own overflow wrapper so THIS div is the
          single scroll container for both axes, gives a viewport-pinned
          horizontal scrollbar and lets the header stick on vertical scroll. */
      <div
        ref={tableScrollRef}
        className="min-h-0 flex-1 overflow-auto [&_[data-slot=table-container]]:overflow-visible"
      >
        <Table style={{ tableLayout: "fixed", width: tableWidth }}>
          <colgroup>
            {orderedIds.map((id) => {
              const c = COLS.find((x) => x.id === id);
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
              <TableHead className="text-center">
                <input
                  type="checkbox"
                  className="accent-primary align-middle"
                  checked={allDisplayedSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleSelectAll}
                  disabled={loading || hosts.length === 0}
                  aria-label="Select all hosts"
                  {...hint("Select or deselect every host (for Multi-terminal)")}
                />
              </TableHead>
              <TableHead {...hint("Open a terminal to this host")} />
              {colOrder.map((id) => (
                <Fragment key={id}>{headCell(id)}</Fragment>
              ))}
              <TableHead
                className="text-right"
                {...hint("Edit, open a terminal, or delete this host")}
              >
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-sm text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : visibleHosts.length === 0 ? (
              /* Filtered down to nothing. There is no "no hosts at all" case
                 here any more: with an empty list the table is not drawn, and
                 the centred empty state is on screen instead. */
              <TableRow>
                <TableCell colSpan={10} className="text-center text-sm text-muted-foreground">
                  No hosts match the current filter.{" "}
                  <button
                    type="button"
                    className="font-medium text-primary hover:underline"
                    onClick={() => {
                      setAllTagsVisible(true);
                      setLabelQuery("");
                    }}
                  >
                    Clear filter
                  </button>
                </TableCell>
              </TableRow>
            ) : (
              visibleHosts.map((h) => (
                <TableRow
                  key={h.id}
                  data-state={selectedIds.has(h.id) ? "selected" : undefined}
                >
                  <TableCell className="text-center">
                    <input
                      type="checkbox"
                      className="accent-primary align-middle"
                      checked={selectedIds.has(h.id)}
                      onChange={() => toggleSelected(h.id)}
                      aria-label={`Select ${h.label}`}
                    />
                  </TableCell>
                  <TableCell>
                    <span
                      className="block h-3 w-3 rounded-full"
                      style={{ backgroundColor: h.color }}
                      aria-label={h.color}
                    />
                  </TableCell>
                  {colOrder.map((id) => (
                    <Fragment key={id}>{bodyCell(h, id)}</Fragment>
                  ))}
                  <TableCell className="text-right">
                    {hiddenCols.size > 0 && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setInfoHost(h)}
                        aria-label="Show hidden fields"
                        {...hint(`Show ${h.label}'s hidden columns and their values`)}
                      >
                        <TagIcon />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleOpenTerminal(h)}
                      aria-label="Open terminal"
                      {...hint(`Open a terminal tab on ${h.label}`)}
                    >
                      <TerminalIcon />
                    </Button>
                    {/* Wrapped in a span so the help tip (and native title)
                        still fire on hover when the button is disabled:
                        disabled buttons don't emit mouse events. */}
                    <span
                      className="inline-flex"
                      title={
                        connectedHostIds.has(h.id)
                          ? `Terminate the live terminal session(s) on ${h.label}`
                          : `${h.label} has no live terminal session to terminate`
                      }
                      {...hint(
                        connectedHostIds.has(h.id)
                          ? `Terminate the live terminal session(s) on ${h.label}`
                          : `${h.label} has no live terminal session to terminate`,
                      )}
                    >
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onTerminateHost(h.id)}
                        disabled={!connectedHostIds.has(h.id)}
                        aria-label="Terminate session"
                      >
                        <UnplugIcon />
                      </Button>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => runTest(h)}
                      disabled={testingId !== null}
                      aria-label="Test connection"
                      {...hint(
                        h.connect_failed_at !== null
                          ? `The last attempt to reach ${h.label} failed. Retry, or edit the host.`
                          : `Test SSH connectivity and host key for ${h.label}`,
                      )}
                    >
                      {testingId === h.id ? (
                        <Loader2Icon className="animate-spin" />
                      ) : (
                        <PlugZapIcon
                          className={
                            h.connect_failed_at !== null
                              ? "text-red-500"
                              : undefined
                          }
                        />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => openEdit(h)}
                      aria-label="Edit"
                      {...hint(`Edit ${h.label}: connection details and credentials`)}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => openDelete(h)}
                      aria-label="Delete"
                      {...hint(`Delete ${h.label} and its stored credentials`)}
                    >
                      <Trash2Icon />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      )}

      {/* Deleting a template from the list beside the hosts. Its own dialog
          rather than the host one: nothing here is a machine, and the wording
          that matters is which of the two is going. */}
      <AlertDialog
        open={deletingTemplate !== null}
        onOpenChange={(o) => {
          if (!o) setDeletingTemplate(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete &ldquo;{deletingTemplate?.name}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The arrangement goes. The hosts, shells and profiles it names are
              not touched, and neither is anything currently open.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void runDeleteTemplate()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* The profile editor, the same dialog the Terminals "+" menu opens: one
          form for one thing, wherever you reached it from. */}
      <ShellProfileDialog
        open={profileEdit !== null}
        onOpenChange={(open) => {
          if (!open) setProfileEdit(null);
        }}
        shells={enabledShells}
        initial={profileEdit?.profile ?? null}
        onSave={saveProfile}
      />

      {/* The import preview. Every profile in the file, startup commands in
          full, before anything is saved. */}
      <ShellProfileImportDialog
        rows={importRows}
        shells={localShells}
        busy={importing}
        onCancel={cancelImport}
        onConfirm={() => void confirmImport()}
      />

      {/* Deleting a profile. The "+" menu asks for a double-click first,
          because the bin sits a few pixels from Edit in a menu people move
          through quickly; here the row is a table row with room around it, so
          the dialog is the whole guard, as it is for a host. */}
      <AlertDialog
        open={profileDelete !== null}
        onOpenChange={(o) => {
          if (!o) setProfileDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete &ldquo;{profileDelete?.label}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The profile goes, here and in the Terminals + menu. Nothing open
              is affected, and a template that opens this profile will say it is
              missing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (profileDelete) deleteProfile(profileDelete.id);
                setProfileDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* #9: per-host view of the columns hidden from the table. */}
      <AlertDialog
        open={infoHost !== null}
        onOpenChange={(o) => !o && setInfoHost(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: infoHost?.color }}
              />
              {infoHost?.label}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Columns hidden from the table
              <br />
              (change in Settings → Appearance):
            </AlertDialogDescription>
          </AlertDialogHeader>
          <dl className="space-y-2 text-sm">
            {infoHost &&
              HIDEABLE_COLUMNS.filter((c) => hiddenCols.has(c.id)).map((c) => (
                <div key={c.id} className="flex items-start gap-3">
                  <dt className="w-24 shrink-0 text-muted-foreground">
                    {c.label}
                  </dt>
                  <dd className="min-w-0 flex-1">
                    {renderHiddenValue(c.id, infoHost)}
                  </dd>
                </div>
              ))}
          </dl>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setInfoHost(null)}>
              Close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DeleteHostDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        host={deleting}
        onDeleted={refresh}
      />

      <TofuKeyDialog
        open={tofu !== null}
        onOpenChange={(open) => !open && setTofu(null)}
        host={tofu?.host ?? null}
        presentedKey={tofu?.key ?? null}
        onTrusted={runTest}
      />

      <KeyMismatchDialog
        open={mismatch !== null}
        onOpenChange={(open) => !open && setMismatch(null)}
        host={mismatch?.host ?? null}
        storedFingerprint={mismatch?.stored ?? null}
        presented={mismatch?.presented ?? null}
        onTrusted={runTest}
      />

      {/* H7: opening a single host that already has a terminal asks first. */}
      <AlertDialog
        open={reopenConfirm !== null}
        onOpenChange={(o) => !o && setReopenConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Terminal already open</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-semibold text-foreground">
                {reopenConfirm?.label}
              </span>{" "}
              already has an open terminal tab. Open another one?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (reopenConfirm) onOpenTerminal(reopenConfirm);
                setReopenConfirm(null);
              }}
            >
              Open another
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* H8: Multi-terminal, pick which already-open hosts to duplicate. */}
      <AlertDialog
        open={multiDup !== null}
        onOpenChange={(o) => !o && setMultiDup(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Some hosts are already open</AlertDialogTitle>
            <AlertDialogDescription>
              These already have an open terminal. Keep the ones you want to open
              a duplicate of checked; uncheck the rest. Other selected hosts open
              as usual.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-60 space-y-1 overflow-auto py-1">
            {multiDup?.dups.map((h) => (
              <label
                key={h.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
              >
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={multiDup.checked.has(h.id)}
                  onChange={() => toggleDup(h.id)}
                />
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: h.color }}
                />
                <span className="min-w-0 truncate">{h.label}</span>
              </label>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmMulti}>
              Open terminals
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
