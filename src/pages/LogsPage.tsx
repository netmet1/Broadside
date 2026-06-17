import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderOpenIcon,
  RefreshCwIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { SearchBar, type SearchMode } from "@/components/SearchBar";
import { HighlightedLine } from "@/components/Highlight";
import { errorMessage, listHosts, type Host } from "@/lib/tauri/hosts";
import {
  auditInfo,
  auditTail,
  clearErrorLog,
  errorLogTail,
  exportAuditLog,
  exportErrorLog,
  loadErrorLogFile,
  loadSession,
  sessionIsEncrypted,
  setAuditEnabled,
  type AuditInfo,
  type ErrorEntry,
  type OtlogLine,
} from "@/lib/tauri/logs";
import {
  type HistoryEntry,
  type HistoryHost,
  clearCommandHistory,
  commandHistory,
} from "@/lib/tauri/settings";
import {
  buildMatcher,
  isMatcher,
  matchLine,
  type LineMatch,
  type SearchOptions,
} from "@/lib/search";
import { cn } from "@/lib/utils";

type Tab = "session" | "audit" | "history" | "errors";

/** Colour for a host we can't resolve live (deleted, or a source without ids). */
const HOST_UNKNOWN_COLOR = "#6b7280";
const MAX_HISTORY_HOSTS = 8;

/** Human label for a command's source (LG1). */
const SOURCE_LABEL: Record<string, string> = {
  broadcast: "Broadcast",
  ptybroadcast: "PTY Broadcast",
  omniterminal: "OmniTerminal",
};

/** The target hosts of a command-history entry, colour-tinted live by id
 * (D-061 sub-4). OmniTerminal entries read `OmniTerminal <hosts> <command>`;
 * colour/label come from the current host (grey + snapshot label if gone). */
function HistoryHosts({
  entry,
  hostsById,
}: {
  entry: HistoryEntry;
  hostsById: Map<number, Host>;
}) {
  const sourceLabel = entry.source ? SOURCE_LABEL[entry.source] : null;
  if (entry.hosts.length === 0) {
    return (
      <span className="shrink-0 text-muted-foreground">
        {sourceLabel && (
          <span className="text-foreground/70">{sourceLabel} </span>
        )}
        {entry.host_count}h
      </span>
    );
  }
  const shown = entry.hosts.slice(0, MAX_HISTORY_HOSTS);
  const extra = entry.hosts.length - shown.length;
  const tint = (h: HistoryHost) => {
    const live = h.id != null ? hostsById.get(h.id) : undefined;
    return {
      color: live?.color ?? HOST_UNKNOWN_COLOR,
      label: live?.label ?? h.label,
    };
  };
  return (
    <span className="inline-flex shrink-0 items-baseline gap-1 overflow-hidden">
      {sourceLabel && (
        <span className="shrink-0 text-foreground/70">{sourceLabel}</span>
      )}
      {shown.map((h, i) => {
        const { color, label } = tint(h);
        return (
          <span
            key={i}
            className="max-w-24 truncate"
            style={{ color }}
            title={label}
          >
            {label}
            {i < shown.length - 1 ? "," : ""}
          </span>
        );
      })}
      {extra > 0 && <span className="text-muted-foreground">+{extra}</span>}
    </span>
  );
}

/** Search state shared by both tabs: scan a flat list of lines. */
function useLineSearch(lines: { key: string; text: string }[]) {
  const [mode, setMode] = useState<SearchMode | null>(null);
  const [pattern, setPattern] = useState("");
  const [options, setOptions] = useState<SearchOptions | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  const matcherOrError = useMemo(
    () =>
      mode !== null && options !== null ? buildMatcher(pattern, options) : null,
    [mode, pattern, options],
  );
  const matcher = isMatcher(matcherOrError) ? matcherOrError : null;

  const scan = useMemo(() => {
    if (!matcher) return null;
    const perLine = new Map<number, LineMatch[]>();
    const hits: { lineIdx: number; match: LineMatch }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const matches = matchLine(matcher, lines[i].text);
      if (matches.length > 0) {
        perLine.set(i, matches);
        for (const m of matches) hits.push({ lineIdx: i, match: m });
      }
    }
    return { perLine, hits };
  }, [matcher, lines]);

  useEffect(() => setActiveIdx(0), [pattern, options]);

  const navigate = useCallback(
    (dir: 1 | -1) => {
      if (!scan || scan.hits.length === 0) return;
      setActiveIdx((i) => (i + dir + scan.hits.length) % scan.hits.length);
    },
    [scan],
  );

  const close = useCallback(() => {
    setMode(null);
    setPattern("");
    setOptions(null);
    setActiveIdx(0);
  }, []);

  const status = (() => {
    if (matcherOrError && "error" in matcherOrError) {
      return { text: matcherOrError.error, tone: "error" as const };
    }
    if (!scan || !pattern) return { text: "", tone: "normal" as const };
    if (scan.hits.length === 0)
      return { text: "No matches", tone: "normal" as const };
    const base = `${scan.hits.length} ${scan.hits.length === 1 ? "match" : "matches"}`;
    return {
      text:
        mode === "find" ? `${activeIdx + 1}/${scan.hits.length} · ${base}` : base,
      tone: "normal" as const,
    };
  })();

  const activeHit =
    mode === "find" && scan && scan.hits.length > 0
      ? scan.hits[Math.min(activeIdx, scan.hits.length - 1)]
      : null;

  return {
    mode,
    setMode,
    setQuery: (p: string, o: SearchOptions) => {
      setPattern(p);
      setOptions(o);
    },
    pattern,
    scan,
    activeHit,
    navigate,
    close,
    status,
    filterActive: mode === "filter" && matcher !== null && pattern !== "",
    // Find hides nothing (D-015) but dims non-matching rows for contrast.
    findActive: mode === "find" && matcher !== null && pattern !== "",
  };
}

export function LogsPage({ visible }: { visible: boolean }) {
  const [tab, setTab] = useState<Tab>("session");

  // Session tab state
  const [sessionPath, setSessionPath] = useState<string | null>(null);
  const [sessionLines, setSessionLines] = useState<OtlogLine[]>([]);
  const [collapsedHosts, setCollapsedHosts] = useState<Set<string>>(new Set());
  const [passphraseOpen, setPassphraseOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  // Audit tab state
  const [info, setInfo] = useState<AuditInfo | null>(null);
  const [auditLines, setAuditLines] = useState<string[]>([]);

  // Command history tab state
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  // Live host lookup for colour-tinting history entries (D-061 sub-4):
  // colour/label resolve by id at render, so a recolour/rename shows on refresh.
  const [hostsById, setHostsById] = useState<Map<number, Host>>(new Map());

  // Error log tab state (D-055)
  const [errorEntries, setErrorEntries] = useState<ErrorEntry[]>([]);

  const sessionSearchLines = useMemo(
    () =>
      sessionLines.map((l, i) => ({
        key: `${i}`,
        text: l.data,
      })),
    [sessionLines],
  );
  const auditSearchLines = useMemo(
    () => auditLines.map((text, i) => ({ key: `${i}`, text })),
    [auditLines],
  );
  const historySearchLines = useMemo(
    () => historyEntries.map((e, i) => ({ key: `${i}`, text: e.command })),
    [historyEntries],
  );
  const errorSearchLines = useMemo(
    () =>
      errorEntries.map((e, i) => ({
        key: `${i}`,
        // host_label is rendered as a separate tinted span (LG2), so it's not
        // part of the searched/highlighted text here.
        text: `${e.source} ${e.message}`,
      })),
    [errorEntries],
  );

  const sessionSearch = useLineSearch(sessionSearchLines);
  const auditSearch = useLineSearch(auditSearchLines);
  const historySearch = useLineSearch(historySearchLines);
  const errorSearch = useLineSearch(errorSearchLines);
  const search =
    tab === "session"
      ? sessionSearch
      : tab === "audit"
        ? auditSearch
        : tab === "history"
          ? historySearch
          : errorSearch;

  // Ctrl+F / Ctrl+Shift+F while this page is visible (D-015).
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        search.setMode(e.shiftKey ? "filter" : "find");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, search]);

  const refreshAudit = useCallback(async () => {
    try {
      setInfo(await auditInfo());
      // Newest first (LG6) — the tail is chronological (oldest first).
      setAuditLines((await auditTail(1000)).reverse());
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (visible && tab === "audit") refreshAudit();
  }, [visible, tab, refreshAudit]);

  const refreshHistory = useCallback(async () => {
    try {
      setHistoryEntries(await commandHistory(1000));
      // Reload hosts too so a colour/rename change since last view shows.
      setHostsById(
        new Map((await listHosts()).map((h) => [h.id, h] as const)),
      );
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (visible && tab === "history") refreshHistory();
  }, [visible, tab, refreshHistory]);

  const refreshErrors = useCallback(async () => {
    try {
      // Newest first (LG6) — the tail is chronological (oldest first).
      setErrorEntries((await errorLogTail(1000)).reverse());
      // Hosts for live-by-id tinting of the host label (LG2).
      setHostsById(
        new Map((await listHosts()).map((h) => [h.id, h] as const)),
      );
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (visible && tab === "errors") refreshErrors();
  }, [visible, tab, refreshErrors]);

  const openSession = async () => {
    try {
      const path = await openDialog({
        multiple: false,
        directory: false,
        title: "Open session or error log",
        filters: [
          { name: "Session or error log", extensions: ["otlog", "jsonl"] },
        ],
      });
      if (typeof path !== "string") return;
      // Load an exported error log into the session viewer (LG5).
      if (path.toLowerCase().endsWith(".jsonl")) {
        const entries = await loadErrorLogFile(path);
        const lines: OtlogLine[] = entries.map((e) => ({
          ts: e.ts,
          host: e.host_label ?? e.source,
          stream: "stderr",
          data: `${e.source} — ${e.message}`,
        }));
        setSessionLines(lines);
        setSessionPath(path);
        setCollapsedHosts(new Set());
        toast.success(`Loaded ${lines.length} error entries`);
        return;
      }
      if (await sessionIsEncrypted(path)) {
        setPendingPath(path);
        setPassphrase("");
        setPassphraseOpen(true);
        return;
      }
      await doLoad(path, null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const doLoad = async (path: string, pass: string | null) => {
    try {
      const lines = await loadSession(path, pass);
      setSessionLines(lines);
      setSessionPath(path);
      setCollapsedHosts(new Set());
      setPassphraseOpen(false);
      toast.success(`Loaded ${lines.length} lines`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  /** Export the audit/error log to a chosen path (LG3/LG4). */
  const exportLog = async (kind: "audit" | "errors") => {
    try {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      const stamp =
        `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
        `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      const path = await saveDialog({
        title: kind === "audit" ? "Export audit log" : "Export error log",
        defaultPath: `${stamp}-omniterminal-${kind}.jsonl`,
      });
      if (typeof path !== "string") return;
      const bytes =
        kind === "audit" ? await exportAuditLog(path) : await exportErrorLog(path);
      toast.success(`Exported ${(bytes / 1024).toFixed(1)} KB`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  /** Group lines per host in first-seen order (mirrors broadcast blocks). */
  const hostGroups = useMemo(() => {
    const order: string[] = [];
    const byHost = new Map<string, { line: OtlogLine; idx: number }[]>();
    sessionLines.forEach((line, idx) => {
      if (!byHost.has(line.host)) {
        byHost.set(line.host, []);
        order.push(line.host);
      }
      byHost.get(line.host)!.push({ line, idx });
    });
    return order.map((host) => ({ host, entries: byHost.get(host)! }));
  }, [sessionLines]);

  const toggleHost = (host: string) => {
    setCollapsedHosts((prev) => {
      const next = new Set(prev);
      if (next.has(host)) {
        next.delete(host);
      } else {
        next.add(host);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4 border-b border-border/50 px-4 pt-3">
        {(["session", "audit", "history", "errors"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "border-b-2 pb-2 text-sm font-medium capitalize",
              tab === t
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "session"
              ? "Session viewer"
              : t === "audit"
                ? "Audit log"
                : t === "history"
                  ? "Command history"
                  : "Errors"}
          </button>
        ))}
      </div>

      {search.mode !== null && (
        <SearchBar
          modes={["find", "filter"]}
          mode={search.mode}
          onModeChange={search.setMode}
          status={search.status.text}
          statusTone={search.status.tone}
          onQueryChange={search.setQuery}
          onNavigate={search.navigate}
          onClose={search.close}
        />
      )}

      {tab === "session" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-3 px-4 py-2">
            <Button variant="outline" size="sm" onClick={openSession}>
              <FolderOpenIcon />
              Open Session or ErrorLog…
            </Button>
            {sessionPath && (
              <span className="truncate font-mono text-xs text-muted-foreground">
                {sessionPath} · {sessionLines.length} lines
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {sessionLines.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Open a saved .otlog file to view it. Save one from the
                Broadcast page after a run.
              </p>
            ) : (
              <div className="space-y-3">
                {hostGroups.map(({ host, entries }) => {
                  const visibleEntries = sessionSearch.filterActive
                    ? entries.filter(
                        ({ idx }) => sessionSearch.scan?.perLine.has(idx) ?? false,
                      )
                    : entries;
                  if (sessionSearch.filterActive && visibleEntries.length === 0) {
                    return (
                      <div
                        key={host}
                        className="flex items-center gap-2 rounded-md border border-border/30 px-3 py-1.5 text-xs text-muted-foreground"
                      >
                        {host} — 0 matches
                      </div>
                    );
                  }
                  const collapsed = collapsedHosts.has(host);
                  return (
                    <div
                      key={host}
                      className="overflow-hidden rounded-md border border-border/40"
                    >
                      <button
                        type="button"
                        onClick={() => toggleHost(host)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/40"
                      >
                        {collapsed ? (
                          <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="font-medium">{host}</span>
                        <span className="ml-auto font-mono text-xs text-muted-foreground">
                          {visibleEntries.length} lines
                        </span>
                      </button>
                      {!collapsed && (
                        <div className="px-3 pb-3 font-mono text-xs">
                          {visibleEntries.map(({ line, idx }) => {
                            const matches =
                              sessionSearch.scan?.perLine.get(idx) ?? null;
                            const isActiveLine =
                              sessionSearch.activeHit?.lineIdx === idx;
                            return (
                              <pre
                                key={idx}
                                className={cn(
                                  "whitespace-pre-wrap break-words",
                                  line.stream === "stderr" && "text-red-400/90",
                                  line.stream === "status" &&
                                    "text-muted-foreground italic",
                                  sessionSearch.findActive &&
                                    !matches &&
                                    "opacity-40",
                                )}
                              >
                                {matches && sessionSearch.mode !== null ? (
                                  <HighlightedLine
                                    text={line.data}
                                    matches={matches}
                                    activeRange={
                                      isActiveLine
                                        ? sessionSearch.activeHit!.match
                                        : null
                                    }
                                  />
                                ) : (
                                  line.data
                                )}
                              </pre>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : tab === "audit" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-3 px-4 py-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-primary"
                checked={info?.enabled ?? true}
                onChange={async (e) => {
                  try {
                    await setAuditEnabled(e.target.checked);
                    refreshAudit();
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              />
              Audit logging enabled
            </label>
            <Button variant="ghost" size="sm" onClick={refreshAudit}>
              <RefreshCwIcon />
              Refresh
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={auditLines.length === 0}
              onClick={() => exportLog("audit")}
            >
              Export…
            </Button>
            {info && (
              <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
                {info.path} · {(info.size_bytes / 1024).toFixed(1)} KB
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 font-mono text-xs">
            {auditLines.length === 0 ? (
              <p className="py-8 text-center font-sans text-sm text-muted-foreground">
                No audit entries yet. Broadcasts, host-key trust decisions,
                terminals opened and saved sessions are recorded here.
              </p>
            ) : (
              auditLines.map((text, idx) => {
                const matches = auditSearch.scan?.perLine.get(idx) ?? null;
                if (auditSearch.filterActive && !matches) return null;
                const isActiveLine = auditSearch.activeHit?.lineIdx === idx;
                return (
                  <pre
                    key={idx}
                    className={cn(
                      "whitespace-pre-wrap break-words",
                      auditSearch.findActive && !matches && "opacity-40",
                    )}
                  >
                    {matches && auditSearch.mode !== null ? (
                      <HighlightedLine
                        text={text}
                        matches={matches}
                        activeRange={
                          isActiveLine ? auditSearch.activeHit!.match : null
                        }
                      />
                    ) : (
                      text
                    )}
                  </pre>
                );
              })
            )}
          </div>
        </div>
      ) : tab === "history" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-3 px-4 py-2">
            <Button variant="ghost" size="sm" onClick={refreshHistory}>
              <RefreshCwIcon />
              Refresh
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={historyEntries.length === 0}
              onClick={async () => {
                try {
                  await clearCommandHistory();
                  setHistoryEntries([]);
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Clear history
            </Button>
            {historyEntries.length > 0 && (
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                {historyEntries.length}{" "}
                {historyEntries.length === 1 ? "command" : "commands"}
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {historyEntries.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No commands yet. Broadcast commands are recorded here and
                recallable in the composer with Up/Down.
              </p>
            ) : (
              historyEntries.map((entry, idx) => {
                const matches = historySearch.scan?.perLine.get(idx) ?? null;
                if (historySearch.filterActive && !matches) return null;
                const isActiveLine = historySearch.activeHit?.lineIdx === idx;
                return (
                  <div
                    key={entry.id}
                    className={cn(
                      "flex items-baseline gap-3 py-0.5 font-mono text-xs",
                      historySearch.findActive && !matches && "opacity-40",
                    )}
                  >
                    <span className="shrink-0 text-muted-foreground">
                      {new Date(entry.ts).toLocaleString()}
                    </span>
                    <HistoryHosts entry={entry} hostsById={hostsById} />
                    <pre className="whitespace-pre-wrap break-words">
                      {matches && historySearch.mode !== null ? (
                        <HighlightedLine
                          text={entry.command}
                          matches={matches}
                          activeRange={
                            isActiveLine ? historySearch.activeHit!.match : null
                          }
                        />
                      ) : (
                        entry.command
                      )}
                    </pre>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-3 px-4 py-2">
            <Button variant="ghost" size="sm" onClick={refreshErrors}>
              <RefreshCwIcon />
              Refresh
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={errorEntries.length === 0}
              onClick={async () => {
                try {
                  await clearErrorLog();
                  setErrorEntries([]);
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Clear errors
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={errorEntries.length === 0}
              onClick={() => exportLog("errors")}
            >
              Export…
            </Button>
            {errorEntries.length > 0 && (
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                {errorEntries.length} {errorEntries.length === 1 ? "error" : "errors"}
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {errorEntries.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No errors recorded. Connection and broadcast failures that
                show a toast are also kept here for later review.
              </p>
            ) : (
              errorEntries.map((entry, idx) => {
                const matches = errorSearch.scan?.perLine.get(idx) ?? null;
                if (errorSearch.filterActive && !matches) return null;
                const isActiveLine = errorSearch.activeHit?.lineIdx === idx;
                // Tint the host label live-by-id (LG2): current colour/label by
                // id, grey + snapshot label if the host is gone or predates ids.
                const live =
                  entry.host_id != null ? hostsById.get(entry.host_id) : undefined;
                const tintColor = live?.color ?? HOST_UNKNOWN_COLOR;
                const tintLabel = live?.label ?? entry.host_label;
                const display = `${entry.source} ${entry.message}`;
                return (
                  <div
                    key={idx}
                    className={cn(
                      "flex items-baseline gap-3 py-0.5 font-mono text-xs",
                      errorSearch.findActive && !matches && "opacity-40",
                    )}
                  >
                    <span className="shrink-0 text-muted-foreground">
                      {entry.ts ? new Date(entry.ts).toLocaleString() : "—"}
                    </span>
                    {tintLabel && (
                      <span
                        className="max-w-32 shrink-0 truncate"
                        style={{ color: tintColor }}
                        title={tintLabel}
                      >
                        {tintLabel}
                      </span>
                    )}
                    <pre className="whitespace-pre-wrap break-words text-red-400/90">
                      {matches && errorSearch.mode !== null ? (
                        <HighlightedLine
                          text={display}
                          matches={matches}
                          activeRange={
                            isActiveLine ? errorSearch.activeHit!.match : null
                          }
                        />
                      ) : (
                        display
                      )}
                    </pre>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      <Dialog open={passphraseOpen} onOpenChange={setPassphraseOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Encrypted session</DialogTitle>
            <DialogDescription>
              This .otlog file is encrypted. Enter its passphrase to open it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1">
            <Label htmlFor="open-passphrase">Passphrase</Label>
            <Input
              id="open-passphrase"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pendingPath && passphrase) {
                  doLoad(pendingPath, passphrase);
                }
              }}
              autoComplete="off"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPassphraseOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!passphrase}
              onClick={() => pendingPath && doLoad(pendingPath, passphrase)}
            >
              Open
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
