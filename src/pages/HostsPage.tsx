import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DownloadIcon,
  ListFilterIcon,
  Loader2Icon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  TagIcon,
  TerminalIcon,
  Trash2Icon,
  UnplugIcon,
  UploadIcon,
} from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import { HIDEABLE_COLUMNS, loadHiddenCols } from "@/lib/hostColumns";
import { allTags, firstTag, parseTags } from "@/lib/hostTags";
import { nextColor } from "@/lib/palette";
import { useHint, usePageStatus } from "@/lib/status";
import {
  COLS,
  COL_WIDTHS_KEY,
  MIN_COL_W,
  SORT_STORAGE_KEY,
  type SortKey,
  TAG_FILTER_KEY,
  UNTAGGED_KEY,
  dtStamp,
} from "@/pages/hosts/constants";
import { SortHeader } from "@/pages/hosts/SortHeader";
import { useHostConnTest } from "@/pages/hosts/useHostConnTest";

export function HostsPage({
  onOpenTerminal,
  onOpenTerminals,
  onTerminateHost,
  connectedHostIds,
  openHostIds,
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
}) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<Host | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState<Host | null>(null);

  // Per-host connection test + the TOFU / key-mismatch dialogs it can surface.
  const { testingId, tofu, setTofu, mismatch, setMismatch, runTest } =
    useHostConnTest();

  const defaultColor = useMemo(
    () => nextColor(hosts.map((h) => h.color)),
    [hosts],
  );
  const hint = useHint();

  const connectedCount = useMemo(
    () => hosts.filter((h) => connectedHostIds.has(h.id)).length,
    [hosts, connectedHostIds],
  );

  // Persisted column widths (drag-to-resize). Survives tab switches + restart.
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    const defaults = Object.fromEntries(COLS.map((c) => [c.id, c.w]));
    try {
      const saved = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) ?? "{}");
      return { ...defaults, ...saved };
    } catch {
      return defaults;
    }
  });
  // Columns the user hid from Settings → Appearance (read on mount; the Hosts
  // tab remounts when shown, so it always reflects the latest choice).
  const [hiddenCols] = useState(loadHiddenCols);
  const tableWidth = COLS.filter((c) => !hiddenCols.has(c.id)).reduce(
    (sum, c) => sum + (colWidths[c.id] ?? c.w),
    0,
  );
  const startResize = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = colWidths[id];
      const onMove = (me: MouseEvent) => {
        const w = Math.max(MIN_COL_W, startW + me.clientX - startX);
        setColWidths((prev) => ({ ...prev, [id]: w }));
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setColWidths((prev) => {
          localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(prev));
          return prev;
        });
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [colWidths],
  );

  // Double-click a divider to auto-size the column to its widest cell (H14).
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const measureCanvas = useRef<HTMLCanvasElement | null>(null);
  const autoSizeColumn = useCallback((id: string) => {
    const colIndex = COLS.findIndex((c) => c.id === id);
    const container = tableScrollRef.current;
    if (colIndex < 0 || !container) return;
    const canvas =
      measureCanvas.current ??
      (measureCanvas.current = document.createElement("canvas"));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let max = 0;
    container.querySelectorAll<HTMLTableRowElement>("tr").forEach((tr) => {
      const cell = tr.children[colIndex] as HTMLElement | undefined;
      const text = cell?.textContent ?? "";
      if (!cell || !text) return;
      const cs = getComputedStyle(cell);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      max = Math.max(max, ctx.measureText(text).width);
    });
    // + cell padding (px-2 each side) + a little slack for the sort arrow.
    const width = Math.max(MIN_COL_W, Math.ceil(max) + 28);
    setColWidths((prev) => {
      const next = { ...prev, [id]: width };
      localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  /** A thin drag strip on a column header's right edge. Returns JSX (not a
   * component) so it isn't remounted each render. */
  const resizeHandle = (id: string) => (
    <span
      onMouseDown={(e) => startResize(id, e)}
      onDoubleClick={() => autoSizeColumn(id)}
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize border-r border-border/70 hover:border-primary hover:bg-primary/20"
      aria-hidden
      title="Drag to resize · double-click to fit"
    />
  );

  // Column sorting. null = the order the backend returned (insertion order).
  // Restored from sessionStorage so it survives tab switches, not restart.
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(
    () => {
      try {
        const raw = sessionStorage.getItem(SORT_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
  );
  useEffect(() => {
    if (sort) sessionStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
    else sessionStorage.removeItem(SORT_STORAGE_KEY);
  }, [sort]);
  const toggleSort = useCallback((key: SortKey) => {
    setSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  }, []);

  const sortedHosts = useMemo(() => {
    if (!sort) return hosts;
    const factor = sort.dir === "asc" ? 1 : -1;
    const valueOf = (h: Host): string | number => {
      switch (sort.key) {
        case "label":
          return h.label.toLowerCase();
        case "status":
          return connectedHostIds.has(h.id) ? 0 : 1; // connected first (asc)
        case "hostname":
          return h.hostname.toLowerCase();
        case "port":
          return h.port;
        case "username":
          return h.username.toLowerCase();
        case "tag":
          return firstTag(h.tag);
        case "flavor":
          return (h.linux_flavor ?? "").toLowerCase();
      }
    };
    return [...hosts].sort((a, b) => {
      // Tag sort: by FIRST tag (multi-tag hosts). Untagged hosts always rank
      // after tagged ones, then `factor` flips that — so they sink to the
      // bottom for A-Z and rise to the top for Z-A (user request) rather than
      // clumping with the empty string.
      if (sort.key === "tag") {
        const ta = firstTag(a.tag);
        const tb = firstTag(b.tag);
        const ea = ta === "";
        const eb = tb === "";
        if (ea || eb) {
          if (ea && eb) return a.label.localeCompare(b.label);
          return (ea ? 1 : -1) * factor;
        }
        const cmp = ta.localeCompare(tb, undefined, { sensitivity: "base" });
        if (cmp !== 0) return cmp * factor;
        return a.label.localeCompare(b.label); // stable tiebreak, un-flipped
      }
      const va = valueOf(a);
      const vb = valueOf(b);
      if (va < vb) return -1 * factor;
      if (va > vb) return 1 * factor;
      // Stable, predictable tiebreak by label.
      return a.label.localeCompare(b.label);
    });
  }, [hosts, sort, connectedHostIds]);

  // Tag filter (#8): the set of UNCHECKED tags (lowercase) plus UNTAGGED_KEY for
  // no-tag hosts. Empty = everything shown. Persists for the session only.
  const [hiddenTags, setHiddenTags] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(sessionStorage.getItem(TAG_FILTER_KEY) ?? "[]");
      if (Array.isArray(raw)) {
        return new Set(raw.filter((x) => typeof x === "string"));
      }
    } catch {
      // Fall through to an empty set (no filtering).
    }
    return new Set();
  });
  useEffect(() => {
    sessionStorage.setItem(TAG_FILTER_KEY, JSON.stringify([...hiddenTags]));
  }, [hiddenTags]);

  // Every distinct tag in use (for the dropdown) + whether any host is untagged.
  const tagOptions = useMemo(() => allTags(hosts.map((h) => h.tag)), [hosts]);
  const hasUntagged = useMemo(
    () => hosts.some((h) => parseTags(h.tag).length === 0),
    [hosts],
  );
  const tagFilterActive = hiddenTags.size > 0;
  const toggleTagFilter = (key: string) =>
    setHiddenTags((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const setAllTagsVisible = (visible: boolean) =>
    setHiddenTags(
      visible
        ? new Set()
        : new Set([
            ...tagOptions.map((t) => t.toLowerCase()),
            ...(hasUntagged ? [UNTAGGED_KEY] : []),
          ]),
    );

  // Apply the tag filter (OR semantics): a host shows if any of its tags is
  // still checked; an untagged host shows unless "(untagged)" is unchecked.
  const visibleHosts = useMemo(() => {
    if (hiddenTags.size === 0) return sortedHosts;
    return sortedHosts.filter((h) => {
      const tags = parseTags(h.tag);
      if (tags.length === 0) return !hiddenTags.has(UNTAGGED_KEY);
      return tags.some((t) => !hiddenTags.has(t.toLowerCase()));
    });
  }, [sortedHosts, hiddenTags]);

  // Self-contained tag-filter dropdown, opened from the Tag header icon.
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const tagMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tagMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!tagMenuRef.current?.contains(e.target as Node)) setTagMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTagMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [tagMenuOpen]);

  // Per-host "missing fields" popup (#9): which hidden columns + their values.
  const [infoHost, setInfoHost] = useState<Host | null>(null);

  // Multi-select for the "Multi-terminal" action.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
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
    loading
      ? null
      : tagFilterActive && visibleHosts.length !== hosts.length
        ? `Showing ${visibleHosts.length} of ${hosts.length} hosts (tag filter) · ${connectedCount} connected`
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

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (host: Host) => {
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Hosts</h1>
          <p className="text-sm text-muted-foreground">
            SSH connection targets. Credentials are managed separately.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={openSelectedTerminals}
            disabled={selectedIds.size === 0}
            {...hint("Open a terminal tab for every selected host at once")}
          >
            <TerminalIcon />
            Multi-terminal{selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
          </Button>
          <Button
            variant="outline"
            onClick={runExport}
            disabled={loading || hosts.length === 0}
            {...hint("Export all hosts to a CSV or Excel (.xlsx) file (re-importable). No credentials are included; it's safe to hand to a restricted operator to import under their own login.")}
          >
            <DownloadIcon />
            Export hosts…
          </Button>
          <Button
            variant="outline"
            onClick={() => setImportOpen(true)}
            {...hint("Bulk-add hosts from a CSV or Excel file")}
          >
            <UploadIcon />
            Import hosts…
          </Button>
          <Button onClick={openAdd} {...hint("Add a single host through the form")}>
            <PlusIcon />
            Add host
          </Button>
        </div>
      </div>

      {/* Neutralize the shadcn Table's own overflow wrapper so THIS div is the
          single scroll container for both axes — gives a viewport-pinned
          horizontal scrollbar and lets the header stick on vertical scroll. */}
      <div
        ref={tableScrollRef}
        className="min-h-0 flex-1 overflow-auto [&_[data-slot=table-container]]:overflow-visible"
      >
        <Table style={{ tableLayout: "fixed", width: tableWidth }}>
          <colgroup>
            {COLS.map((c) => (
              <col
                key={c.id}
                className={hiddenCols.has(c.id) ? "hidden" : undefined}
                style={{ width: colWidths[c.id] ?? c.w }}
              />
            ))}
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
              <TableHead className="relative">
                <SortHeader
                  label="Label"
                  sortKey="label"
                  sort={sort}
                  onSort={toggleSort}
                  headHint={hint("The host's unique display name, shown in its colour, in logs, and when picking hosts")}
                />
                {resizeHandle("label")}
              </TableHead>
              <TableHead className={hiddenCols.has("status") ? "hidden" : "text-xs"}>
                <SortHeader
                  label="Status"
                  display="S"
                  sortKey="status"
                  sort={sort}
                  onSort={toggleSort}
                  headHint={hint("Status (S): terminal connection. Green dot = a terminal to this host is connected; otherwise none is open")}
                />
              </TableHead>
              <TableHead className="relative">
                <SortHeader
                  label="Hostname"
                  sortKey="hostname"
                  sort={sort}
                  onSort={toggleSort}
                  headHint={hint("The host's address: the IP or DNS name used to connect")}
                />
                {resizeHandle("hostname")}
              </TableHead>
              <TableHead className={hiddenCols.has("port") ? "hidden" : "relative"}>
                <SortHeader
                  label="Port"
                  sortKey="port"
                  sort={sort}
                  onSort={toggleSort}
                  headHint={hint("The SSH port (default 22)")}
                />
                {resizeHandle("port")}
              </TableHead>
              <TableHead className={hiddenCols.has("username") ? "hidden" : "relative"}>
                <SortHeader
                  label="Username"
                  sortKey="username"
                  sort={sort}
                  onSort={toggleSort}
                  headHint={hint("The SSH login user for this host")}
                />
                {resizeHandle("username")}
              </TableHead>
              <TableHead className={hiddenCols.has("tag") ? "hidden" : "relative"}>
                <div className="flex min-w-0 items-center gap-1">
                  <SortHeader
                    label="Tag"
                    sortKey="tag"
                    sort={sort}
                    onSort={toggleSort}
                    headHint={hint("Tags for grouping/sorting; separate multiple with commas (e.g. prod, db)")}
                  />
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
                          ? "Tag filter active — click to change (this session only)"
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
              <TableHead className={hiddenCols.has("flavor") ? "hidden" : "relative"}>
                <SortHeader
                  label="Flavor"
                  sortKey="flavor"
                  sort={sort}
                  onSort={toggleSort}
                  headHint={hint("The host's Linux distribution (icon only), set on the host form")}
                />
                {resizeHandle("flavor")}
              </TableHead>
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
            ) : hosts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-sm text-muted-foreground">
                  No hosts yet. Click <span className="font-medium">Add host</span> to create one.
                </TableCell>
              </TableRow>
            ) : visibleHosts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-sm text-muted-foreground">
                  No hosts match the current tag filter.{" "}
                  <button
                    type="button"
                    className="font-medium text-primary hover:underline"
                    onClick={() => setAllTagsVisible(true)}
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
                  <TableCell className="truncate font-medium" title={h.label}>
                    {h.label}
                  </TableCell>
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
                  <TableCell className="truncate font-mono text-xs" title={h.hostname}>
                    {h.hostname}
                  </TableCell>
                  <TableCell
                    className={
                      hiddenCols.has("port")
                        ? "hidden"
                        : "truncate font-mono text-xs"
                    }
                  >
                    {h.port}
                  </TableCell>
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
                  <TableCell
                    className={
                      hiddenCols.has("flavor")
                        ? "hidden"
                        : "truncate text-xs text-muted-foreground"
                    }
                  >
                    {h.linux_flavor ?? "-"}
                  </TableCell>
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
                        still fire on hover when the button is disabled —
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
                      {...hint(`Test SSH connectivity and host key for ${h.label}`)}
                    >
                      {testingId === h.id ? (
                        <Loader2Icon className="animate-spin" />
                      ) : (
                        <PlugZapIcon />
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

      {/* H8: Multi-terminal — pick which already-open hosts to duplicate. */}
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
