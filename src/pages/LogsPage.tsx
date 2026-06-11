import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderOpenIcon,
  RefreshCwIcon,
} from "lucide-react";
import { toast } from "sonner";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

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
import { errorMessage } from "@/lib/tauri/hosts";
import {
  auditInfo,
  auditTail,
  loadSession,
  sessionIsEncrypted,
  setAuditEnabled,
  type AuditInfo,
  type OtlogLine,
} from "@/lib/tauri/logs";
import {
  buildMatcher,
  isMatcher,
  matchLine,
  type LineMatch,
  type SearchOptions,
} from "@/lib/search";
import { cn } from "@/lib/utils";

type Tab = "session" | "audit";

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

  const sessionSearch = useLineSearch(sessionSearchLines);
  const auditSearch = useLineSearch(auditSearchLines);
  const search = tab === "session" ? sessionSearch : auditSearch;

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
      setAuditLines(await auditTail(1000));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (visible && tab === "audit") refreshAudit();
  }, [visible, tab, refreshAudit]);

  const openSession = async () => {
    try {
      const path = await openDialog({
        multiple: false,
        directory: false,
        title: "Open session file",
        filters: [{ name: "OmniTerminal session", extensions: ["otlog"] }],
      });
      if (typeof path !== "string") return;
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
    <div className="flex h-full min-h-screen flex-col">
      <div className="flex items-center gap-4 border-b border-border/50 px-4 pt-3">
        {(["session", "audit"] as const).map((t) => (
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
            {t === "session" ? "Session viewer" : "Audit log"}
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
              Open session…
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
      ) : (
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
            {info && (
              <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
                {info.path} · {(info.size_bytes / 1024).toFixed(1)} KB
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 font-mono text-xs">
            {auditLines.length === 0 ? (
              <p className="py-8 text-center font-sans text-sm text-muted-foreground">
                No audit entries yet. Broadcasts, key-trust decisions, PTY
                opens and session saves are recorded here.
              </p>
            ) : (
              auditLines.map((text, idx) => {
                const matches = auditSearch.scan?.perLine.get(idx) ?? null;
                if (auditSearch.filterActive && !matches) return null;
                const isActiveLine = auditSearch.activeHit?.lineIdx === idx;
                return (
                  <pre key={idx} className="whitespace-pre-wrap break-words">
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
