import { useEffect, useMemo, useState } from "react";
import { FolderOpenIcon, Loader2Icon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { errorMessage } from "@/lib/tauri/hosts";
import {
  type ImportOutcome,
  type RowPreview,
  importHosts,
  previewImport,
} from "@/lib/tauri/import";
import { nextColor } from "@/lib/palette";
import { cn } from "@/lib/utils";

/**
 * Bulk host import wizard (D-025/D-047): pick a .csv/.xlsx file, review the
 * per-row validation report, import the ready rows. Inline page-swap panel
 * like the host form (D-027). Credentials are never importable — they're
 * set per host afterwards.
 */
export function ImportHostsPanel({
  existingColors,
  onCancel,
  onImported,
}: {
  existingColors: string[];
  onCancel: () => void;
  onImported: () => void;
}) {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [rows, setRows] = useState<RowPreview[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);

  // Signal AppShell to blur the sidebar while this panel is mounted.
  useEffect(() => {
    document.documentElement.dataset.formOverlay = "true";
    return () => {
      delete document.documentElement.dataset.formOverlay;
    };
  }, []);

  // Escape closes (unless an import is in flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !importing) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [importing, onCancel]);

  const counts = useMemo(() => {
    if (!rows) return { ready: 0, duplicate: 0, error: 0 };
    return {
      ready: rows.filter((r) => r.status === "ready").length,
      duplicate: rows.filter((r) => r.status === "duplicate").length,
      error: rows.filter((r) => r.status === "error").length,
    };
  }, [rows]);

  const chooseFile = async () => {
    try {
      const path = await openDialog({
        multiple: false,
        directory: false,
        title: "Import hosts",
        filters: [{ name: "Spreadsheets", extensions: ["csv", "xlsx"] }],
      });
      if (typeof path !== "string") return;
      setLoading(true);
      setOutcome(null);
      try {
        setRows(await previewImport(path));
        setFilePath(path);
      } finally {
        setLoading(false);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  /** Resolve `#auto` colors: next unused palette hue, falling back to a
   * random unused color once the palette is exhausted — auto assignments
   * never duplicate an in-use color (D-051). Explicit colors pass through. */
  const resolveColors = (ready: RowPreview[]): RowPreview[] => {
    const used = existingColors.slice();
    return ready.map((r) => {
      if (r.color !== "#auto") {
        used.push(r.color);
        return r;
      }
      const color = nextColor(used);
      used.push(color);
      return { ...r, color };
    });
  };

  const runImport = async () => {
    if (!rows) return;
    setImporting(true);
    try {
      const ready = resolveColors(rows.filter((r) => r.status === "ready"));
      const result = await importHosts(
        ready.map((r) => ({
          label: r.label,
          hostname: r.hostname,
          port: r.port,
          username: r.username,
          color: r.color,
          linux_flavor: r.linux_flavor,
          notes: r.notes,
        })),
      );
      setOutcome(result);
      if (result.imported > 0) {
        toast.success(
          `Imported ${result.imported} ${result.imported === 1 ? "host" : "hosts"}`,
        );
        onImported();
      }
      if (result.skipped.length > 0) {
        toast.warning(`${result.skipped.length} skipped — see report`);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setImporting(false);
    }
  };

  const statusBadge = (row: RowPreview) => {
    switch (row.status) {
      case "ready":
        return <span className="text-xs text-emerald-400">ready</span>;
      case "duplicate":
        return <span className="text-xs text-amber-400">duplicate — skipped</span>;
      case "error":
        return <span className="text-xs text-red-400">{row.message}</span>;
    }
  };

  return (
    <div className="flex h-full min-h-screen flex-col gap-4 p-6">
      <div>
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          Import hosts
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          CSV or Excel with a header row. Required columns:{" "}
          <span className="font-mono text-xs">label, hostname, username</span>.
          Optional:{" "}
          <span className="font-mono text-xs">
            port, color, linux_flavor, notes
          </span>
          . A color of <span className="font-mono text-xs">#auto</span> (or
          empty) picks the next palette hue. Duplicate labels are skipped.
          Credentials are never imported — set them per host afterwards.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={chooseFile} disabled={loading || importing}>
          {loading ? <Loader2Icon className="animate-spin" /> : <FolderOpenIcon />}
          Choose file…
        </Button>
        {filePath && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {filePath}
          </span>
        )}
      </div>

      {rows && (
        <>
          <div className="text-sm text-muted-foreground">
            {rows.length} rows ·{" "}
            <span className="text-emerald-400">{counts.ready} ready</span>
            {counts.duplicate > 0 && (
              <>
                {" · "}
                <span className="text-amber-400">{counts.duplicate} duplicate</span>
              </>
            )}
            {counts.error > 0 && (
              <>
                {" · "}
                <span className="text-red-400">{counts.error} invalid</span>
              </>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14">Row</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Hostname</TableHead>
                  <TableHead className="w-16">Port</TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead className="w-20">Color</TableHead>
                  <TableHead>Flavor</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.row_number}
                    className={cn(r.status !== "ready" && "opacity-70")}
                  >
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.row_number}
                    </TableCell>
                    <TableCell className="font-medium">{r.label}</TableCell>
                    <TableCell className="font-mono text-xs">{r.hostname}</TableCell>
                    <TableCell className="font-mono text-xs">{r.port}</TableCell>
                    <TableCell className="font-mono text-xs">{r.username}</TableCell>
                    <TableCell>
                      {r.color === "#auto" ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          auto
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5">
                          <span
                            className="h-3 w-3 rounded-full"
                            style={{ backgroundColor: r.color }}
                          />
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.linux_flavor ?? "—"}
                    </TableCell>
                    <TableCell>{statusBadge(r)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {outcome && outcome.skipped.length > 0 && (
        <div className="space-y-1 text-xs">
          <p className="font-medium text-amber-400">
            Skipped during import:
          </p>
          {outcome.skipped.map((s, i) => (
            <p key={i} className="font-mono text-muted-foreground">
              {s.label} — {s.reason}
            </p>
          ))}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={importing}>
          {outcome ? "Done" : "Cancel"}
        </Button>
        <Button
          onClick={runImport}
          disabled={importing || counts.ready === 0 || outcome !== null}
        >
          {importing ? <Loader2Icon className="animate-spin" /> : <UploadIcon />}
          Import {counts.ready} {counts.ready === 1 ? "host" : "hosts"}
        </Button>
      </div>
    </div>
  );
}
