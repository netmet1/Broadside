import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsUpDownIcon,
  DownloadIcon,
  Loader2Icon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  TerminalIcon,
  Trash2Icon,
  UnplugIcon,
  UploadIcon,
} from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import { type PresentedKey, testConnection } from "@/lib/tauri/ssh";
import { nextColor } from "@/lib/palette";
import { useHint, usePageStatus } from "@/lib/status";

type SortKey = "label" | "status" | "hostname" | "port" | "username" | "flavor";

/** Column layout for the hosts table. Resizable columns get a drag handle and
 * their width persists in localStorage (across tab switches and restarts). */
const COLS: { id: string; w: number; resizable: boolean }[] = [
  { id: "select", w: 40, resizable: false },
  { id: "swatch", w: 40, resizable: false },
  { id: "label", w: 180, resizable: true },
  { id: "status", w: 64, resizable: false },
  { id: "hostname", w: 220, resizable: true },
  { id: "port", w: 90, resizable: true },
  { id: "username", w: 150, resizable: true },
  { id: "flavor", w: 130, resizable: true },
  { id: "actions", w: 210, resizable: false },
];
const COL_WIDTHS_KEY = "hosts-col-widths";
const MIN_COL_W = 56;

/** A clickable column header that toggles sorting on `sortKey` and shows the
 * current direction. */
function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" } | null;
  onSort: (key: SortKey) => void;
}) {
  const active = sort?.key === sortKey;
  const Icon = !active
    ? ChevronsUpDownIcon
    : sort!.dir === "asc"
      ? ArrowUpIcon
      : ArrowDownIcon;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className="-mx-1 flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground"
      aria-label={`Sort by ${label}`}
    >
      {label}
      <Icon
        className={`h-3 w-3 ${active ? "text-foreground" : "text-muted-foreground/50"}`}
      />
    </button>
  );
}

export function HostsPage({
  onOpenTerminal,
  onOpenTerminals,
  onTerminateHost,
  connectedHostIds,
}: {
  onOpenTerminal: (host: Host) => void;
  /** Open terminal tabs for several hosts at once (multi-select). */
  onOpenTerminals: (hosts: Host[]) => void;
  /** Terminate every live terminal session for this host. */
  onTerminateHost: (hostId: number) => void;
  /** Hosts with at least one live terminal session. */
  connectedHostIds: Set<number>;
}) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<Host | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState<Host | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [tofu, setTofu] = useState<{ host: Host; key: PresentedKey } | null>(
    null,
  );
  const [mismatch, setMismatch] = useState<{
    host: Host;
    stored: string;
    presented: PresentedKey;
  } | null>(null);

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
  const tableWidth = COLS.reduce((sum, c) => sum + (colWidths[c.id] ?? c.w), 0);
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

  /** A thin drag strip on a column header's right edge. Returns JSX (not a
   * component) so it isn't remounted each render. */
  const resizeHandle = (id: string) => (
    <span
      onMouseDown={(e) => startResize(id, e)}
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-primary/40"
      aria-hidden
      title="Drag to resize column"
    />
  );

  // Column sorting. null = the order the backend returned (insertion order).
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(
    null,
  );
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
        case "flavor":
          return (h.linux_flavor ?? "").toLowerCase();
      }
    };
    return [...hosts].sort((a, b) => {
      const va = valueOf(a);
      const vb = valueOf(b);
      if (va < vb) return -1 * factor;
      if (va > vb) return 1 * factor;
      // Stable, predictable tiebreak by label.
      return a.label.localeCompare(b.label);
    });
  }, [hosts, sort, connectedHostIds]);

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
    sortedHosts.length > 0 && sortedHosts.every((h) => selectedIds.has(h.id));
  const someSelected = selectedIds.size > 0 && !allDisplayedSelected;
  const toggleSelectAll = () =>
    setSelectedIds(
      allDisplayedSelected ? new Set() : new Set(sortedHosts.map((h) => h.id)),
    );
  const openSelectedTerminals = () => {
    const chosen = hosts.filter((h) => selectedIds.has(h.id));
    if (chosen.length === 0) return;
    onOpenTerminals(chosen);
    setSelectedIds(new Set());
  };

  usePageStatus(
    loading
      ? null
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
        defaultPath: "hosts.csv",
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

  const runTest = useCallback(async (host: Host) => {
    setTestingId(host.id);
    try {
      const result = await testConnection(host.id);
      switch (result.status) {
        case "ok":
          toast.success(`${host.label}: connected (${result.latency_ms}ms)`);
          break;
        case "unknown_key":
          setTofu({ host, key: result.key });
          break;
        case "key_mismatch":
          setMismatch({
            host,
            stored: result.stored_fingerprint,
            presented: result.presented,
          });
          break;
        case "auth_failed":
          toast.error(`${host.label}: authentication failed — ${result.message}`);
          break;
        case "unreachable":
          toast.error(`${host.label}: unreachable — ${result.message}`);
          break;
        case "no_credentials":
          toast.warning(
            `${host.label}: no credentials stored. Edit the host to add them.`,
          );
          break;
      }
    } catch (e) {
      toast.error(`${host.label}: ${errorMessage(e)}`);
    } finally {
      setTestingId(null);
    }
  }, []);

  if (formOpen) {
    return (
      <HostFormPanel
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
            {...hint("Export all hosts to a CSV or Excel (.xlsx) file (re-importable)")}
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

      <div className="min-h-0 flex-1 overflow-auto">
        <Table style={{ tableLayout: "fixed", width: tableWidth }}>
          <colgroup>
            {COLS.map((c) => (
              <col key={c.id} style={{ width: colWidths[c.id] ?? c.w }} />
            ))}
          </colgroup>
          <TableHeader>
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
              <TableHead />
              <TableHead className="relative">
                <SortHeader label="Label" sortKey="label" sort={sort} onSort={toggleSort} />
                {resizeHandle("label")}
              </TableHead>
              <TableHead className="text-xs">
                <SortHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
              </TableHead>
              <TableHead className="relative">
                <SortHeader label="Hostname" sortKey="hostname" sort={sort} onSort={toggleSort} />
                {resizeHandle("hostname")}
              </TableHead>
              <TableHead className="relative">
                <SortHeader label="Port" sortKey="port" sort={sort} onSort={toggleSort} />
                {resizeHandle("port")}
              </TableHead>
              <TableHead className="relative">
                <SortHeader label="Username" sortKey="username" sort={sort} onSort={toggleSort} />
                {resizeHandle("username")}
              </TableHead>
              <TableHead className="relative">
                <SortHeader label="Flavor" sortKey="flavor" sort={sort} onSort={toggleSort} />
                {resizeHandle("flavor")}
              </TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-sm text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : hosts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-sm text-muted-foreground">
                  No hosts yet. Click <span className="font-medium">Add host</span> to create one.
                </TableCell>
              </TableRow>
            ) : (
              sortedHosts.map((h) => (
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
                  <TableCell>
                    <span
                      className={`block h-2.5 w-2.5 rounded-full ${
                        connectedHostIds.has(h.id)
                          ? "bg-emerald-500"
                          : "bg-red-500/70"
                      }`}
                      title={
                        connectedHostIds.has(h.id)
                          ? "Connected — live terminal session"
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
                  <TableCell className="truncate font-mono text-xs">{h.port}</TableCell>
                  <TableCell className="truncate font-mono text-xs" title={h.username}>
                    {h.username}
                  </TableCell>
                  <TableCell className="truncate text-xs text-muted-foreground">
                    {h.linux_flavor ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onOpenTerminal(h)}
                      aria-label="Open terminal"
                      {...hint(`Open an interactive terminal tab on ${h.label}`)}
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
                      {...hint(`Edit ${h.label} — connection details and credentials`)}
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
    </div>
  );
}
