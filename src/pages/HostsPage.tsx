import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DownloadIcon,
  Loader2Icon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  TerminalIcon,
  Trash2Icon,
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

export function HostsPage({
  onOpenTerminal,
  connectedHostIds,
}: {
  onOpenTerminal: (host: Host) => void;
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
        title: "Export hosts to CSV",
        defaultPath: "hosts.csv",
        filters: [{ name: "CSV", extensions: ["csv"] }],
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
            onClick={runExport}
            disabled={loading || hosts.length === 0}
            {...hint("Export all hosts to a CSV file (re-importable)")}
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead className="w-14 text-xs">Status</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Hostname</TableHead>
              <TableHead className="w-20">Port</TableHead>
              <TableHead>Username</TableHead>
              <TableHead>Flavor</TableHead>
              <TableHead className="w-40 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : hosts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                  No hosts yet. Click <span className="font-medium">Add host</span> to create one.
                </TableCell>
              </TableRow>
            ) : (
              hosts.map((h) => (
                <TableRow key={h.id}>
                  <TableCell>
                    <span
                      className="block h-3 w-3 rounded-full"
                      style={{ backgroundColor: h.color }}
                      aria-label={h.color}
                    />
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
                  <TableCell className="font-medium">{h.label}</TableCell>
                  <TableCell className="font-mono text-xs">{h.hostname}</TableCell>
                  <TableCell className="font-mono text-xs">{h.port}</TableCell>
                  <TableCell className="font-mono text-xs">{h.username}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
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
