import { useCallback, useEffect, useMemo, useState } from "react";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
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
import { DeleteHostDialog } from "@/components/DeleteHostDialog";
import { type Host, errorMessage, listHosts } from "@/lib/tauri/hosts";
import { nextColor } from "@/lib/palette";

export function HostsPage() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Host | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState<Host | null>(null);

  const defaultColor = useMemo(
    () => nextColor(hosts.map((h) => h.color)),
    [hosts],
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

  const countLabel = loading
    ? ""
    : `Showing ${hosts.length} ${hosts.length === 1 ? "host" : "hosts"}`;

  return (
    <div className="flex h-full min-h-screen flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Hosts</h1>
          <p className="text-sm text-muted-foreground">
            SSH connection targets. Credentials are managed separately.
          </p>
        </div>
        <Button onClick={openAdd}>
          <PlusIcon />
          Add host
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead>Label</TableHead>
              <TableHead>Hostname</TableHead>
              <TableHead className="w-20">Port</TableHead>
              <TableHead>Username</TableHead>
              <TableHead>Flavor</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : hosts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
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
                      onClick={() => openEdit(h)}
                      aria-label="Edit"
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => openDelete(h)}
                      aria-label="Delete"
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

      <div className="flex justify-end text-xs text-muted-foreground">
        {countLabel}
      </div>

      <DeleteHostDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        host={deleting}
        onDeleted={refresh}
      />
    </div>
  );
}
