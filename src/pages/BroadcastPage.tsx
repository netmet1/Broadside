import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  SendIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Composer } from "@/components/Composer";
import { ConfirmDestructiveDialog } from "@/components/ConfirmDestructiveDialog";
import {
  BatchTofuDialog,
  type UnknownKeyEntry,
} from "@/components/BatchTofuDialog";
import { KeyMismatchDialog } from "@/components/KeyMismatchDialog";
import {
  type ExecResult,
  type GuardHit,
  type HostExecReport,
  broadcastCommand,
  checkDestructive,
  onBroadcastResult,
} from "@/lib/tauri/broadcast";
import { type Host, errorMessage, listHosts } from "@/lib/tauri/hosts";
import type { PresentedKey } from "@/lib/tauri/ssh";

const DEFAULT_TIMEOUT_SECS = 30;

type Block = HostExecReport & { collapsed: boolean };

export function BroadcastPage() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [command, setCommand] = useState("");
  const [timeoutSecs, setTimeoutSecs] = useState(String(DEFAULT_TIMEOUT_SECS));
  const [running, setRunning] = useState(false);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [pendingHosts, setPendingHosts] = useState<Set<number>>(new Set());
  const [guardHits, setGuardHits] = useState<GuardHit[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [tofuEntries, setTofuEntries] = useState<UnknownKeyEntry[]>([]);
  const [tofuOpen, setTofuOpen] = useState(false);
  const [mismatch, setMismatch] = useState<{
    host: Host;
    stored: string;
    presented: PresentedKey;
  } | null>(null);

  const runIdRef = useRef<string>("");
  const lastCommandRef = useRef<string>("");
  const lastConfirmedRef = useRef<boolean>(false);
  const outputRef = useRef<HTMLDivElement>(null);

  const hostsById = useMemo(() => {
    const map = new Map<number, Host>();
    for (const h of hosts) map.set(h.id, h);
    return map;
  }, [hosts]);

  useEffect(() => {
    listHosts()
      .then((all) => {
        setHosts(all);
        // Pre-select everything — broadcast-to-all is the common case.
        setSelected(new Set(all.map((h) => h.id)));
      })
      .catch((e) => toast.error(errorMessage(e)));
  }, []);

  useEffect(() => {
    const unlisten = onBroadcastResult((report) => {
      if (report.run_id !== runIdRef.current) return;
      setPendingHosts((prev) => {
        const next = new Set(prev);
        next.delete(report.host_id);
        return next;
      });
      setBlocks((prev) => [
        // A retry replaces the host's previous block.
        ...prev.filter((b) => b.host_id !== report.host_id),
        { ...report, collapsed: false },
      ]);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [blocks]);

  const allSelected = hosts.length > 0 && selected.size === hosts.length;
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(hosts.map((h) => h.id)));
  };
  const toggleHost = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const parsedTimeout = (() => {
    const n = Number(timeoutSecs);
    return Number.isFinite(n) && n >= 1 && n <= 3600 ? Math.floor(n) : null;
  })();

  const runBroadcast = useCallback(
    async (hostIds: number[], cmd: string, confirmed: boolean) => {
      const runId = crypto.randomUUID();
      runIdRef.current = runId;
      lastCommandRef.current = cmd;
      lastConfirmedRef.current = confirmed;
      setRunning(true);
      setPendingHosts(new Set(hostIds));
      try {
        const reports = await broadcastCommand({
          runId,
          hostIds,
          command: cmd,
          timeoutSecs: parsedTimeout ?? DEFAULT_TIMEOUT_SECS,
          confirmed,
        });
        const unknown: UnknownKeyEntry[] = [];
        for (const r of reports) {
          if (r.result.status === "unknown_key") {
            const host = hostsById.get(r.host_id);
            if (host) {
              unknown.push({
                hostId: host.id,
                label: host.label,
                hostname: host.hostname,
                port: host.port,
                key: r.result.key,
              });
            }
          }
        }
        if (unknown.length > 0) {
          setTofuEntries(unknown);
          setTofuOpen(true);
        }
      } catch (e) {
        toast.error(errorMessage(e));
        setPendingHosts(new Set());
      } finally {
        setRunning(false);
      }
    },
    [hostsById, parsedTimeout],
  );

  const send = useCallback(async () => {
    const cmd = command.trim();
    if (!cmd || selected.size === 0 || running || parsedTimeout === null) {
      return;
    }
    setBlocks([]);
    try {
      const hits = await checkDestructive(cmd);
      if (hits.length > 0) {
        setGuardHits(hits);
        setConfirmOpen(true);
        return;
      }
    } catch (e) {
      toast.error(errorMessage(e));
      return;
    }
    runBroadcast([...selected], cmd, false);
  }, [command, selected, running, parsedTimeout, runBroadcast]);

  const retryHosts = useCallback(
    (hostIds: number[]) => {
      runBroadcast(hostIds, lastCommandRef.current, lastConfirmedRef.current);
    },
    [runBroadcast],
  );

  const toggleCollapsed = (hostId: number) => {
    setBlocks((prev) =>
      prev.map((b) =>
        b.host_id === hostId ? { ...b, collapsed: !b.collapsed } : b,
      ),
    );
  };

  const waitingLabels = [...pendingHosts]
    .map((id) => hostsById.get(id)?.label ?? `#${id}`)
    .join(", ");

  return (
    <div className="flex h-full min-h-screen">
      {/* Host selection rail */}
      <div className="flex w-60 shrink-0 flex-col border-r border-border/50">
        <label className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium">
          <input
            type="checkbox"
            className="accent-primary"
            checked={allSelected}
            onChange={toggleAll}
            disabled={running}
          />
          Select all
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {selected.size}/{hosts.length}
          </span>
        </label>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {hosts.map((h) => (
            <label
              key={h.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
            >
              <input
                type="checkbox"
                className="accent-primary"
                checked={selected.has(h.id)}
                onChange={() => toggleHost(h.id)}
                disabled={running}
              />
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: h.color }}
              />
              <span className="truncate">{h.label}</span>
            </label>
          ))}
          {hosts.length === 0 && (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              No hosts configured. Add hosts on the Hosts page first.
            </p>
          )}
        </div>
      </div>

      {/* Output + composer */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={outputRef} className="min-h-0 flex-1 overflow-y-auto p-4">
          {blocks.length === 0 && pendingHosts.size === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Select hosts, type a command, press Enter.
            </p>
          )}
          <div className="space-y-3">
            {blocks.map((block) => (
              <OutputBlock
                key={block.host_id}
                block={block}
                onToggle={() => toggleCollapsed(block.host_id)}
                onReviewMismatch={(stored, presented) => {
                  const host = hostsById.get(block.host_id);
                  if (host) setMismatch({ host, stored, presented });
                }}
              />
            ))}
          </div>
          {pendingHosts.size > 0 && (
            <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
              <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
              Waiting on {pendingHosts.size}: {waitingLabels}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border/50 p-3">
          <Composer
            value={command}
            onChange={setCommand}
            onSubmit={send}
            disabled={running}
            placeholder={
              selected.size === 0
                ? "Select at least one host…"
                : `Broadcast to ${selected.size} ${selected.size === 1 ? "host" : "hosts"}…`
            }
          />
          <div className="flex items-center gap-1.5">
            <Input
              value={timeoutSecs}
              onChange={(e) => setTimeoutSecs(e.target.value)}
              disabled={running}
              aria-label="Timeout in seconds"
              className={`h-10 w-16 text-center font-mono text-sm ${parsedTimeout === null ? "border-destructive" : ""}`}
            />
            <span className="text-xs text-muted-foreground">s</span>
          </div>
          <Button
            onClick={send}
            disabled={
              running ||
              !command.trim() ||
              selected.size === 0 ||
              parsedTimeout === null
            }
            aria-label="Send"
          >
            {running ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <SendIcon />
            )}
            Send
          </Button>
        </div>
      </div>

      <ConfirmDestructiveDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        command={command.trim()}
        hits={guardHits}
        hostLabels={[...selected]
          .map((id) => hostsById.get(id)?.label ?? `#${id}`)
          .sort()}
        onConfirmed={() => runBroadcast([...selected], command.trim(), true)}
      />

      <BatchTofuDialog
        open={tofuOpen}
        onOpenChange={setTofuOpen}
        entries={tofuEntries}
        onTrusted={retryHosts}
      />

      <KeyMismatchDialog
        open={mismatch !== null}
        onOpenChange={(open) => !open && setMismatch(null)}
        host={mismatch?.host ?? null}
        storedFingerprint={mismatch?.stored ?? null}
        presented={mismatch?.presented ?? null}
        onTrusted={(host) => retryHosts([host.id])}
      />
    </div>
  );
}

function statusSummary(result: ExecResult): {
  text: string;
  tone: "ok" | "warn" | "error";
} {
  switch (result.status) {
    case "completed": {
      if (result.timed_out) {
        return {
          text: `[TIMEOUT] ${(result.duration_ms / 1000).toFixed(1)}s`,
          tone: "error",
        };
      }
      const exit = result.exit_code ?? "?";
      return {
        text: `exit ${exit} · ${(result.duration_ms / 1000).toFixed(1)}s`,
        tone: result.exit_code === 0 ? "ok" : "warn",
      };
    }
    case "unknown_key":
      return { text: "unknown host key", tone: "warn" };
    case "key_mismatch":
      return { text: "HOST KEY CHANGED", tone: "error" };
    case "auth_failed":
      return { text: "auth failed", tone: "error" };
    case "unreachable":
      return { text: "unreachable", tone: "error" };
    case "no_credentials":
      return { text: "no credentials", tone: "warn" };
  }
}

function OutputBlock({
  block,
  onToggle,
  onReviewMismatch,
}: {
  block: Block;
  onToggle: () => void;
  onReviewMismatch: (stored: string, presented: PresentedKey) => void;
}) {
  const { result } = block;
  const summary = statusSummary(result);
  const toneClass =
    summary.tone === "ok"
      ? "text-emerald-400"
      : summary.tone === "warn"
        ? "text-amber-400"
        : "text-red-400";

  return (
    <div className="overflow-hidden rounded-md border border-border/40">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/40"
      >
        {block.collapsed ? (
          <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: block.color }}
        />
        <span className="font-medium">{block.label}</span>
        <span className={`ml-auto font-mono text-xs ${toneClass}`}>
          {summary.text}
        </span>
      </button>
      {!block.collapsed && (
        <div className="px-3 pb-3">
          <BlockBody result={result} onReviewMismatch={onReviewMismatch} />
        </div>
      )}
    </div>
  );
}

function BlockBody({
  result,
  onReviewMismatch,
}: {
  result: ExecResult;
  onReviewMismatch: (stored: string, presented: PresentedKey) => void;
}) {
  switch (result.status) {
    case "completed":
      return (
        <div className="space-y-2 font-mono text-xs">
          {result.stdout && (
            <pre className="whitespace-pre-wrap break-words">{result.stdout}</pre>
          )}
          {result.stderr && (
            <pre className="whitespace-pre-wrap break-words text-red-400/90">
              {result.stderr}
            </pre>
          )}
          {!result.stdout && !result.stderr && (
            <p className="text-muted-foreground">(no output)</p>
          )}
          {result.timed_out && (
            <p className="text-red-400">
              [TIMEOUT — partial output above]
            </p>
          )}
        </div>
      );
    case "unknown_key":
      return (
        <p className="text-xs text-muted-foreground">
          First contact with this endpoint — trust its key in the dialog to
          proceed.
        </p>
      );
    case "key_mismatch":
      return (
        <div className="space-y-2 text-xs">
          <p className="flex items-center gap-1.5 text-red-400">
            <TriangleAlertIcon className="h-3.5 w-3.5" />
            The server's key does not match the stored fingerprint. Connection
            refused.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onReviewMismatch(result.stored_fingerprint, result.presented)
            }
          >
            Review…
          </Button>
        </div>
      );
    case "auth_failed":
    case "unreachable":
      return <p className="text-xs text-red-400/90">{result.message}</p>;
    case "no_credentials":
      return (
        <p className="text-xs text-muted-foreground">
          No credentials stored — edit the host on the Hosts page.
        </p>
      );
  }
}
