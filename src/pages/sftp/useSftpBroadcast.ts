import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import type { UnknownKeyEntry } from "@/components/BatchTofuDialog";
import { type Host, errorMessage, listHosts } from "@/lib/tauri/hosts";
import { localListDir, localMkdir, localScanDir } from "@/lib/tauri/localfs";
import {
  type TransferMode,
  onSftpTransferProgress,
  sftpConnect,
  sftpDisconnect,
  sftpDownload,
  sftpDownloadDir,
  sftpEnsureRemoteDir,
  sftpList,
  sftpScanDir,
  sftpUpload,
  sftpUploadDir,
} from "@/lib/tauri/sftp";
import { baseName, posixDirname, posixJoin, winDirname, winJoin } from "@/pages/sftp/model";

/** How many hosts transfer at once. Single-file transfers stream (bounded RAM),
 *  but a small cap still keeps concurrent connections + memory reasonable. */
const CONCURRENCY = 4;
/** Persisted collapse state for the host rail (mirrors the other broadcast pages). */
const RAIL_COLLAPSED_KEY = "sftp-broadcast-rail-collapsed";

/** Transfer direction. `put` = local is the source (→ remote hosts); `get` =
 *  remote hosts are the source (→ local, one folder per host label). */
export type Direction = "put" | "get";

/** Per-host transfer state for one broadcast run. `bytesTotal`/`filesTotal` come
 *  from an up-front stat/scan (0 until known); running counts arrive via events. */
export type HostXfer = {
  hostId: number;
  status: "pending" | "running" | "ok" | "fail";
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  message: string | null;
};

/** True if `s` uses the shell-glob wildcards we expand on a GET source (`*` or
 *  `?`). A `[` character-class isn't supported; it's matched literally. */
function hasGlob(s: string): boolean {
  return /[*?]/.test(s);
}

/** Compile a simple shell glob (`*`, `?`) to an anchored, case-sensitive RegExp.
 *  Only ever applied to a single path segment (the file-name), so `/` is treated
 *  as any other literal. Every other regex metacharacter is escaped. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function newXfer(hostId: number): HostXfer {
  return {
    hostId,
    status: "pending",
    filesDone: 0,
    filesTotal: 0,
    bytesDone: 0,
    bytesTotal: 0,
    message: null,
  };
}

/**
 * Owns the multi-host SFTP broadcast: host list + rail selection, the direction
 * / source / destination inputs, and the bounded-parallel fan-out that opens one
 * SFTP session per host and runs a put/get on each while publishing per-host
 * progress. The backend is single-session-per-host, so this manages N sessions
 * itself (unlike the single-host `useSftpBrowser`).
 */
export function useSftpBroadcast(visible: boolean, mode: TransferMode) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Rail: collapse persists across restarts; sort order is in-memory.
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem(RAIL_COLLAPSED_KEY) === "1",
  );
  const toggleRail = useCallback(() => {
    setRailCollapsed((c) => {
      localStorage.setItem(RAIL_COLLAPSED_KEY, c ? "0" : "1");
      return !c;
    });
  }, []);
  const [railSort, setRailSort] = useState("az");

  // Direction + inputs. Default: local is source (put), toggle to the left.
  const [direction, setDirection] = useState<Direction>("put");
  // "Create path if it doesn't exist" — session-only (in-memory), off by default.
  const [createPath, setCreatePath] = useState(false);
  // Local side: a file or folder chosen via the native picker.
  const [localPath, setLocalPath] = useState("");
  const [localIsDir, setLocalIsDir] = useState(false);
  // Remote side: a path typed manually (a directory for put, a file/dir for get).
  const [remotePath, setRemotePath] = useState("");

  // Per-host results for the current run, plus the host order to render them in.
  const [results, setResults] = useState<Map<number, HostXfer>>(new Map());
  const [runHostIds, setRunHostIds] = useState<number[]>([]);
  const [running, setRunning] = useState(false);

  // Batch host-key trust (mirrors command Broadcast): unknown-key hosts collected
  // during a run, surfaced in one dialog, retried on accept.
  const [tofuEntries, setTofuEntries] = useState<UnknownKeyEntry[]>([]);
  const [tofuOpen, setTofuOpen] = useState(false);

  // Live SFTP sessions for the in-flight run (hostId → sessionId), and the map
  // from a transfer's id back to its host (to route progress events).
  const sessionsRef = useRef<Map<number, string>>(new Map());
  const xferIdToHost = useRef<Map<string, number>>(new Map());

  // Volatile run config read inside the (stable) worker callbacks — avoids stale
  // closures without threading every input through the callback deps.
  const cfgRef = useRef({ direction, createPath, localPath, localIsDir, remotePath, mode });
  cfgRef.current = { direction, createPath, localPath, localIsDir, remotePath, mode };

  // Load the host list when the page becomes visible. Nothing is selected by
  // default — broadcasting writes to every selected host, so the user opts in
  // deliberately. Refresh on return so label/colour edits show up; drop any
  // selected ids that no longer exist.
  useEffect(() => {
    if (!visible) return;
    listHosts()
      .then((hs) => {
        setHosts(hs);
        setSelected((prev) => {
          const live = new Set(hs.map((h) => h.id));
          const next = new Set([...prev].filter((id) => live.has(id)));
          return next.size === prev.size ? prev : next;
        });
      })
      .catch((e) => toast.error(errorMessage(e)));
  }, [visible]);

  // Fold live transfer-progress events into the matching host's result.
  useEffect(() => {
    const unlisten = onSftpTransferProgress((e) => {
      const hostId = xferIdToHost.current.get(e.transfer_id);
      if (hostId === undefined) return;
      setResults((prev) => {
        const cur = prev.get(hostId);
        if (!cur) return prev;
        // Don't let the transfer's final progress event (which can arrive after
        // the call resolves) revert a host that already finished.
        if (cur.status === "ok" || cur.status === "fail") return prev;
        const next = new Map(prev);
        next.set(hostId, {
          ...cur,
          status: "running",
          filesDone: e.files_done,
          bytesDone: e.bytes_done,
        });
        return next;
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const patch = useCallback((hostId: number, partial: Partial<HostXfer>) => {
    setResults((prev) => {
      const cur = prev.get(hostId);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(hostId, { ...cur, ...partial });
      return next;
    });
  }, []);

  // --- Selection + rail -----------------------------------------------------
  const allSelected = hosts.length > 0 && selected.size === hosts.length;
  const toggleAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === hosts.length ? new Set() : new Set(hosts.map((h) => h.id)),
    );
  }, [hosts]);
  const toggleHost = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // --- Native pickers -------------------------------------------------------
  const pickLocalFile = useCallback(async () => {
    const picked = await open({ directory: false, multiple: false });
    if (typeof picked === "string") {
      setLocalPath(picked);
      setLocalIsDir(false);
    }
  }, []);
  const pickLocalFolder = useCallback(async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setLocalPath(picked);
      setLocalIsDir(true);
    }
  }, []);

  // On GET the local side is a per-host destination *folder*, so a file picked
  // earlier under PUT can't be a valid target — drop it when the direction flips
  // (the "Browse file…" button is hidden on GET for the same reason).
  useEffect(() => {
    if (direction === "get" && localPath && !localIsDir) {
      setLocalPath("");
    }
  }, [direction, localPath, localIsDir]);

  /** Size of a single local file (from listing its parent), 0 if unknown. */
  const localFileSize = useCallback(async (path: string): Promise<number> => {
    const parent = winDirname(path);
    if (!parent) return 0;
    try {
      const items = await localListDir(parent);
      const base = baseName(path);
      return items.find((e) => e.name === base)?.size ?? 0;
    } catch {
      return 0;
    }
  }, []);

  // --- Per-host transfer ----------------------------------------------------
  const doPut = useCallback(
    async (host: Host, sessionId: string) => {
      const cfg = cfgRef.current;
      const destDir = cfg.remotePath.trim();
      // Ensure (or require) the destination directory.
      if (cfg.createPath) {
        await sftpEnsureRemoteDir(sessionId, destDir);
      } else {
        try {
          await sftpList(sessionId, destDir);
        } catch {
          throw new Error(`path not found: ${destDir}`);
        }
      }
      const transferId = crypto.randomUUID();
      xferIdToHost.current.set(transferId, host.id);
      const remoteTarget = posixJoin(destDir, baseName(cfg.localPath));
      if (cfg.localIsDir) {
        const totals = await localScanDir(cfg.localPath);
        patch(host.id, { status: "running", filesTotal: totals.files, bytesTotal: totals.bytes });
        const stats = await sftpUploadDir({
          hostId: host.id,
          sessionId,
          localPath: cfg.localPath,
          remotePath: remoteTarget,
          transferId,
          mode: cfg.mode,
        });
        patch(host.id, {
          status: "ok",
          filesDone: stats.files + stats.skipped,
          bytesDone: stats.bytes,
          message: `${stats.files} files, ${stats.bytes} bytes` +
            (stats.skipped ? `, ${stats.skipped} skipped` : ""),
        });
      } else {
        const size = await localFileSize(cfg.localPath);
        patch(host.id, { status: "running", filesTotal: 1, bytesTotal: size });
        const bytes = await sftpUpload({
          hostId: host.id,
          sessionId,
          localPath: cfg.localPath,
          remotePath: remoteTarget,
          transferId,
        });
        patch(host.id, { status: "ok", filesDone: 1, bytesDone: bytes, message: `${bytes} bytes` });
      }
    },
    [patch, localFileSize],
  );

  const doGet = useCallback(
    async (host: Host, sessionId: string) => {
      const cfg = cfgRef.current;
      const src = cfg.remotePath.trim();

      // Wildcard source (e.g. /home/user/*.p12): expand the glob against its
      // parent directory and fetch every match into this host's folder. Only the
      // final path segment may contain wildcards; the directory part is literal.
      const pattern = baseName(src);
      if (hasGlob(pattern)) {
        const dir = posixDirname(src);
        let items;
        try {
          items = await sftpList(sessionId, dir);
        } catch {
          throw new Error(`cannot read ${dir}`);
        }
        const re = globToRegExp(pattern);
        const matches = items.filter((e) => re.test(e.name));
        if (matches.length === 0) {
          throw new Error(`no matches for ${pattern} in ${dir}`);
        }
        const destFolder = winJoin(cfg.localPath, host.label);
        await localMkdir(destFolder).catch(() => {});
        const bytesTotal = matches.reduce(
          (n, e) => n + (e.kind === "file" ? e.size ?? 0 : 0),
          0,
        );
        patch(host.id, { status: "running", filesTotal: matches.length, bytesTotal });
        let filesDone = 0;
        let bytesDone = 0;
        for (const e of matches) {
          const remoteItem = posixJoin(dir, e.name);
          const localTarget = winJoin(destFolder, e.name);
          // Each file gets its own transfer id, but it's deliberately NOT mapped
          // in xferIdToHost: live progress events would overwrite the cumulative
          // filesDone/bytesDone we patch after each file with per-file values and
          // make the counter jump backwards. Per-file completion patches suffice.
          const transferId = crypto.randomUUID();
          if (e.kind === "dir") {
            const stats = await sftpDownloadDir({
              hostId: host.id,
              sessionId,
              remotePath: remoteItem,
              localPath: localTarget,
              transferId,
              mode: cfg.mode,
            });
            bytesDone += stats.bytes;
          } else {
            const bytes = await sftpDownload({
              hostId: host.id,
              sessionId,
              remotePath: remoteItem,
              localPath: localTarget,
              transferId,
            });
            bytesDone += bytes;
          }
          filesDone += 1;
          patch(host.id, { filesDone, bytesDone });
        }
        patch(host.id, {
          status: "ok",
          filesDone,
          bytesDone,
          message: `${filesDone} file${filesDone === 1 ? "" : "s"}, ${bytesDone} bytes`,
        });
        return;
      }

      // Detect file-vs-dir + size by listing the remote parent.
      const parent = posixDirname(src);
      let entry;
      try {
        const items = await sftpList(sessionId, parent);
        entry = items.find((e) => e.path === src || e.name === baseName(src));
      } catch {
        throw new Error(`cannot read ${parent}`);
      }
      if (!entry) throw new Error(`path not found: ${src}`);
      // Auto-create a per-host-label folder under the chosen local destination.
      const destFolder = winJoin(cfg.localPath, host.label);
      await localMkdir(destFolder).catch(() => {
        // Ignore "already exists"; a real failure surfaces on the write below.
      });
      const transferId = crypto.randomUUID();
      xferIdToHost.current.set(transferId, host.id);
      const localTarget = winJoin(destFolder, baseName(src));
      if (entry.kind === "dir") {
        const totals = await sftpScanDir(sessionId, src);
        patch(host.id, { status: "running", filesTotal: totals.files, bytesTotal: totals.bytes });
        const stats = await sftpDownloadDir({
          hostId: host.id,
          sessionId,
          remotePath: src,
          localPath: localTarget,
          transferId,
          mode: cfg.mode,
        });
        patch(host.id, {
          status: "ok",
          filesDone: stats.files + stats.skipped,
          bytesDone: stats.bytes,
          message: `${stats.files} files, ${stats.bytes} bytes` +
            (stats.skipped ? `, ${stats.skipped} skipped` : ""),
        });
      } else {
        patch(host.id, { status: "running", filesTotal: 1, bytesTotal: entry.size ?? 0 });
        const bytes = await sftpDownload({
          hostId: host.id,
          sessionId,
          remotePath: src,
          localPath: localTarget,
          transferId,
        });
        patch(host.id, { status: "ok", filesDone: 1, bytesDone: bytes, message: `${bytes} bytes` });
      }
    },
    [patch],
  );

  const runOne = useCallback(
    async (host: Host, unknown: UnknownKeyEntry[]) => {
      patch(host.id, { status: "running" });
      try {
        const sessionId = crypto.randomUUID();
        const res = await sftpConnect(host.id, sessionId);
        switch (res.status) {
          case "ok":
            sessionsRef.current.set(host.id, sessionId);
            break;
          case "unknown_key":
            unknown.push({
              hostId: host.id,
              label: host.label,
              hostname: host.hostname,
              port: host.port,
              key: res.key,
            });
            patch(host.id, { status: "fail", message: "host key not trusted — accept in the dialog" });
            return;
          case "key_mismatch":
            patch(host.id, { status: "fail", message: "host key changed — refused" });
            return;
          case "auth_failed":
            patch(host.id, { status: "fail", message: `auth failed: ${res.message}` });
            return;
          case "unreachable":
            patch(host.id, { status: "fail", message: `unreachable: ${res.message}` });
            return;
          case "no_credentials":
            patch(host.id, { status: "fail", message: "no credentials stored" });
            return;
        }
        if (cfgRef.current.direction === "put") await doPut(host, sessionId);
        else await doGet(host, sessionId);
      } catch (e) {
        patch(host.id, { status: "fail", message: errorMessage(e) });
      }
    },
    [patch, doPut, doGet],
  );

  /** Runs (or re-runs) the transfer for a specific set of hosts, bounded-parallel. */
  const runForHosts = useCallback(
    async (targets: Host[]) => {
      if (targets.length === 0) return;
      setRunning(true);
      setRunHostIds((prev) => {
        const seen = new Set(prev);
        const add = targets.map((h) => h.id).filter((id) => !seen.has(id));
        return add.length ? [...prev, ...add] : prev;
      });
      setResults((prev) => {
        const next = new Map(prev);
        for (const h of targets) next.set(h.id, newXfer(h.id));
        return next;
      });

      const unknown: UnknownKeyEntry[] = [];
      const queue = [...targets];
      const worker = async () => {
        // Safe with concurrent workers: no await between length check and shift.
        while (queue.length > 0) {
          const host = queue.shift()!;
          await runOne(host, unknown);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker),
      );

      // Tear the run's sessions down (fresh connect on the next run/retry).
      for (const sid of sessionsRef.current.values()) {
        void sftpDisconnect(sid).catch(() => {});
      }
      sessionsRef.current.clear();
      if (unknown.length > 0) {
        setTofuEntries(unknown);
        setTofuOpen(true);
      }
      setRunning(false);
    },
    [runOne],
  );

  const runTransfer = useCallback(() => {
    const targets = hosts.filter((h) => selected.has(h.id));
    setRunHostIds(targets.map((h) => h.id));
    setResults(new Map(targets.map((h) => [h.id, newXfer(h.id)])));
    void runForHosts(targets);
  }, [hosts, selected, runForHosts]);

  /** Retry the hosts whose keys were just trusted in the batch dialog. */
  const retryHosts = useCallback(
    (hostIds: number[]) => {
      const targets = hosts.filter((h) => hostIds.includes(h.id));
      void runForHosts(targets);
    },
    [hosts, runForHosts],
  );

  const clearResults = useCallback(() => {
    setResults(new Map());
    setRunHostIds([]);
  }, []);

  const canRun =
    !running &&
    selected.size > 0 &&
    localPath.trim() !== "" &&
    remotePath.trim() !== "";

  // Disconnect any lingering sessions on unmount. Capture the (stable) map
  // object so the cleanup reads the same live sessions, not a moved ref.
  useEffect(() => {
    const sessions = sessionsRef.current;
    return () => {
      for (const sid of sessions.values()) {
        void sftpDisconnect(sid).catch(() => {});
      }
      sessions.clear();
    };
  }, []);

  return {
    hosts,
    selected,
    setSelected,
    allSelected,
    toggleAll,
    toggleHost,
    // rail
    railCollapsed,
    toggleRail,
    railSort,
    setRailSort,
    // direction + inputs
    direction,
    setDirection,
    createPath,
    setCreatePath,
    localPath,
    localIsDir,
    pickLocalFile,
    pickLocalFolder,
    remotePath,
    setRemotePath,
    // run + results
    results,
    runHostIds,
    running,
    canRun,
    runTransfer,
    retryHosts,
    clearResults,
    // batch trust
    tofuEntries,
    tofuOpen,
    setTofuOpen,
  };
}
