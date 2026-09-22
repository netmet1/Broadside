import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { type Host, errorMessage, listHosts } from "@/lib/tauri/hosts";
import { localScanDir } from "@/lib/tauri/localfs";
import { type PresentedKey } from "@/lib/tauri/ssh";
import {
  type SftpEntry,
  type TransferMode,
  sftpConnect,
  sftpDelete,
  sftpDisconnect,
  sftpDownload,
  sftpDownloadDir,
  sftpList,
  sftpMkdir,
  sftpScanDir,
  sftpUpload,
  sftpUploadDir,
  sftpCancelTransfer,
  onSftpTransferProgress,
} from "@/lib/tauri/sftp";
import {
  TRANSFER_CONCURRENCY,
  type TransferOutcome,
  baseName,
  folderCancelText,
  isSessionGone,
  posixDirname,
  posixJoin,
  transferSummary,
} from "@/pages/sftp/model";

/** The live browser session: which host, its backend session id, and cwd. */
type Session = {
  host: Host;
  sessionId: string;
  cwd: string;
};

/** One row in the transfer rail: a folder being scanned, or a transfer running
 *  or still waiting for a slot. Totals come from the listing (a file) or the
 *  pre-flight scan (a folder), and are 0 when unknown; the running counts
 *  arrive via events. */
export type ActiveTransfer = {
  transferId: string;
  direction: "put" | "get";
  name: string;
  /** "scanning" while a folder is counted before it may join the queue,
   *  "queued" until a worker picks it up, then "running". */
  status: "scanning" | "queued" | "running";
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
};

/**
 * Everything one drop asked for, so its successes can be said in one toast
 * once the last of them has settled. `pending` counts the items not yet
 * settled; every item settles exactly once, whether it finished, failed, was
 * cancelled, was dropped from the queue, or never got past its scan or its
 * Large-transfer dialog. `closed` means the summary has gone out (or the
 * session went away), after which late settles are ignored.
 */
export type TransferBatch = {
  direction: "put" | "get";
  pending: number;
  done: TransferOutcome[];
  closed: boolean;
};

/** A transfer waiting for a slot: its id, its drop, and the call to make when
 *  it gets one. `run` reports its own failures and cancels, since it is the
 *  only thing that knows what to say, and returns what it delivered. */
type TransferJob = {
  transferId: string;
  direction: "put" | "get";
  batch: TransferBatch;
  run: () => Promise<TransferOutcome | null>;
};

/** Which pane a finished transfer changed, and so which one to re-list. */
type PaneSide = "local" | "remote";

/** How long a pane waits after a transfer lands before re-listing, so a queue
 *  of small files re-lists about once a second rather than once a file. */
const RELIST_DELAY_MS = 1000;

/**
 * Owns the single-host SFTP browser: host list, connect/trust flow (modeled on
 * `useHostConnTest`), the live session + directory listing, and the file
 * operations. The component stays mounted, so an open session survives tab
 * switches until the user disconnects.
 */
export function useSftpBrowser(visible: boolean) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  // Connecting (opening the session) vs listing (navigating an open session).
  const [connecting, setConnecting] = useState(false);
  const [listing, setListing] = useState(false);
  const [opBusy, setOpBusy] = useState(false); // mkdir / delete
  // Everything scanning, in flight or waiting, in the order it was asked for.
  const [transfers, setTransfers] = useState<ActiveTransfer[]>([]);
  // Bumped (a moment after a transfer lands) for the pane it landed in, so each
  // pane shows new files as they arrive instead of only when the queue empties.
  const [relistSeq, setRelistSeq] = useState({ local: 0, remote: 0 });

  // Trust dialogs, same shape as useHostConnTest.
  const [tofu, setTofu] = useState<{ host: Host; key: PresentedKey } | null>(
    null,
  );
  const [mismatch, setMismatch] = useState<{
    host: Host;
    stored: string;
    presented: PresentedKey;
  } | null>(null);

  // A monotonically-increasing id keyed per host so a stale in-flight connect
  // can't clobber a newer session.
  const connectSeq = useRef(0);
  // The transfer queue: the jobs waiting for a slot and how many slots are
  // taken. Refs rather than state, because the workers read them between awaits
  // and must see the live values, not the ones that were current when the
  // worker started.
  const queueRef = useRef<TransferJob[]>([]);
  const workersRef = useRef(0);
  // Scans under way, and whether each has been cancelled. A local scan cannot
  // be stopped at the far end (it is only reading this disk), so a cancelled
  // one is simply not listened to when it comes back.
  const scansRef = useRef(new Map<string, boolean>());
  // Drops whose summary has not gone out yet, so a disconnect can say what
  // they managed before it.
  const batchesRef = useRef(new Set<TransferBatch>());
  const relistTimers = useRef<Partial<Record<PaneSide, number>>>({});
  // The session as of the last render, for code that has been awaiting and
  // needs to know whether the session it started on is still the live one.
  const sessionRef = useRef<Session | null>(null);
  useLayoutEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    const timers = relistTimers.current;
    return () => {
      for (const t of Object.values(timers)) window.clearTimeout(t);
    };
  }, []);

  const relistSoon = useCallback((side: PaneSide) => {
    if (relistTimers.current[side] !== undefined) return;
    relistTimers.current[side] = window.setTimeout(() => {
      relistTimers.current[side] = undefined;
      setRelistSeq((s) => ({ ...s, [side]: s[side] + 1 }));
    }, RELIST_DELAY_MS);
  }, []);

  /** Sends a drop's one success toast, if anything in it succeeded. */
  const closeBatch = useCallback((batch: TransferBatch) => {
    if (batch.closed) return;
    batch.closed = true;
    batchesRef.current.delete(batch);
    const text = transferSummary(batch.direction, batch.done);
    if (text) toast.success(text);
  }, []);

  /** Starts a drop of `count` items. */
  const beginBatch = useCallback(
    (direction: "put" | "get", count: number): TransferBatch => {
      const batch: TransferBatch = {
        direction,
        pending: count,
        done: [],
        closed: false,
      };
      batchesRef.current.add(batch);
      return batch;
    },
    [],
  );

  /** Marks one item of a drop as over, with what it delivered if it
   *  succeeded. The last one sends the summary. */
  const settle = useCallback(
    (batch: TransferBatch, outcome?: TransferOutcome | null) => {
      if (batch.closed) return;
      if (outcome) batch.done.push(outcome);
      batch.pending -= 1;
      if (batch.pending <= 0) closeBatch(batch);
    },
    [closeBatch],
  );

  /**
   * Drops everything still waiting for a slot. Nothing is open at the far end
   * for a transfer that never started, so there is nothing to stop and nothing
   * to say about it: it simply never happened.
   *
   * It does not touch what is already running. The two callers deal with those
   * differently: a cancel-all asks the backend to stop them, a disconnect takes
   * the session away and the backend stops them on the way out. Either way each
   * one reports its own outcome when it unwinds.
   */
  const abandonQueue = useCallback(() => {
    const dropped = queueRef.current;
    queueRef.current = [];
    const ids = new Set(dropped.map((j) => j.transferId));
    setTransfers((prev) => prev.filter((t) => !ids.has(t.transferId)));
    for (const job of dropped) settle(job.batch);
  }, [settle]);

  /** Marks every scan under way as cancelled and takes its row away. A remote
   *  scan is also stopped at the far end by the caller (cancel-all or
   *  disconnect both reach every flag the session has). */
  const abandonScans = useCallback(() => {
    const ids = new Set(scansRef.current.keys());
    for (const id of ids) scansRef.current.set(id, true);
    setTransfers((prev) => prev.filter((t) => !ids.has(t.transferId)));
  }, []);

  // Fold live transfer-progress events into the matching transfer.
  useEffect(() => {
    const unlisten = onSftpTransferProgress((e) => {
      setTransfers((prev) => {
        const i = prev.findIndex((t) => t.transferId === e.transfer_id);
        if (i < 0) return prev;
        const next = [...prev];
        next[i] = { ...next[i], filesDone: e.files_done, bytesDone: e.bytes_done };
        return next;
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Load the host list when the page first becomes visible (and refresh on
  // return so colour/label edits show up), mirroring the other pages.
  useEffect(() => {
    if (!visible) return;
    listHosts()
      .then(setHosts)
      .catch((e) => toast.error(errorMessage(e)));
  }, [visible]);

  const list = useCallback(async (sessionId: string, path: string) => {
    setListing(true);
    try {
      const items = await sftpList(sessionId, path);
      setEntries(items);
      return true;
    } catch (e) {
      const msg = errorMessage(e);
      toast.error(msg);
      // A dropped/restarted backend session can't be recovered here, reset so
      // the user reconnects rather than staring at a dead listing.
      if (isSessionGone(msg)) {
        setSession(null);
        setEntries([]);
      }
      return false;
    } finally {
      setListing(false);
    }
  }, []);

  /** Connects to a host (used for the initial connect and for retry-after-trust
   *  from the TOFU / mismatch dialogs). */
  const connect = useCallback(
    async (host: Host) => {
      const seq = (connectSeq.current += 1);
      setConnecting(true);
      // A fresh backend session id per connect attempt.
      const sessionId = crypto.randomUUID();
      try {
        const result = await sftpConnect(host.id, sessionId);
        if (seq !== connectSeq.current) return; // superseded by a newer connect
        switch (result.status) {
          case "ok":
            setSession({ host, sessionId, cwd: result.cwd });
            await list(sessionId, result.cwd);
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
            toast.error(`${host.label}: authentication failed (${result.message})`);
            break;
          case "unreachable":
            toast.error(`${host.label}: unreachable (${result.message})`);
            break;
          case "no_credentials":
            toast.warning(
              `${host.label}: no credentials stored. Add them on the Hosts page.`,
            );
            break;
        }
      } catch (e) {
        if (seq === connectSeq.current) toast.error(errorMessage(e));
      } finally {
        if (seq === connectSeq.current) setConnecting(false);
      }
    },
    [list],
  );

  /** Navigates to an absolute remote path within the current session. */
  const navigate = useCallback(
    async (path: string) => {
      if (!session) return;
      const ok = await list(session.sessionId, path);
      if (ok) setSession((s) => (s ? { ...s, cwd: path } : s));
    },
    [session, list],
  );

  const goUp = useCallback(() => {
    if (!session) return;
    void navigate(posixDirname(session.cwd));
  }, [session, navigate]);

  const refresh = useCallback(() => {
    if (session) void list(session.sessionId, session.cwd);
  }, [session, list]);

  const disconnect = useCallback(() => {
    if (!session) return;
    connectSeq.current += 1; // cancel any in-flight connect
    // Nothing queued or scanning survives losing the session it was going to
    // use, and what is already running is stopped by the backend as the
    // session is removed (scans included).
    abandonQueue();
    abandonScans();
    // Say now what each drop managed before the disconnect. What is still
    // running will report its own cancel as it unwinds.
    for (const batch of [...batchesRef.current]) closeBatch(batch);
    void sftpDisconnect(session.sessionId).catch(() => {
      // Best-effort: the session may already be gone.
    });
    setSession(null);
    setEntries([]);
  }, [session, abandonQueue, abandonScans, closeBatch]);

  /** Runs a file op with the busy flag + toast/refresh boilerplate. */
  const runOp = useCallback(
    async (fn: () => Promise<void>) => {
      setOpBusy(true);
      try {
        await fn();
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setOpBusy(false);
      }
    },
    [],
  );

  /**
   * Adds a transfer to the queue and makes sure something is working on it.
   *
   * It appears in the stack as queued straight away, so dropping twenty files
   * reads as twenty things about to happen rather than four things and silence.
   * Workers are the same shape as the Broadcast tab's fan-out: each one takes
   * the next job until the queue is empty, so the cap is a count of workers
   * rather than a scheduler.
   */
  const enqueue = useCallback(
    (
      transfer: Omit<ActiveTransfer, "status" | "filesDone" | "bytesDone">,
      batch: TransferBatch,
      run: TransferJob["run"],
    ) => {
      setTransfers((prev) => [
        ...prev,
        { ...transfer, status: "queued", filesDone: 0, bytesDone: 0 },
      ]);
      queueRef.current.push({
        transferId: transfer.transferId,
        direction: transfer.direction,
        batch,
        run,
      });

      while (
        workersRef.current < TRANSFER_CONCURRENCY &&
        queueRef.current.length > 0
      ) {
        workersRef.current += 1;
        void (async () => {
          for (;;) {
            // Safe with concurrent workers: no await between the length check
            // and the shift.
            const job = queueRef.current.shift();
            if (!job) break;
            setTransfers((prev) =>
              prev.map((t) =>
                t.transferId === job.transferId ? { ...t, status: "running" } : t,
              ),
            );
            let outcome: TransferOutcome | null = null;
            try {
              outcome = await job.run();
            } catch (e) {
              toast.error(errorMessage(e));
            } finally {
              setTransfers((prev) =>
                prev.filter((t) => t.transferId !== job.transferId),
              );
              settle(job.batch, outcome);
              // A cancel or failure removed files too, so the pane is re-read
              // whatever the outcome.
              relistSoon(job.direction === "put" ? "remote" : "local");
            }
          }
          workersRef.current -= 1;
        })();
      }
    },
    [settle, relistSoon],
  );

  // Re-list the remote side when an upload has landed there. Latched on the
  // sequence number rather than run on every change, because `refresh` takes a
  // new identity whenever the session or cwd changes and that is not a reason
  // to list again.
  const handledRelist = useRef(0);
  useEffect(() => {
    if (relistSeq.remote === handledRelist.current) return;
    handledRelist.current = relistSeq.remote;
    refresh();
  }, [relistSeq.remote, refresh]);

  const mkdir = useCallback(
    (name: string) => {
      if (!session || !name.trim()) return;
      const target = posixJoin(session.cwd, name.trim());
      void runOp(async () => {
        await sftpMkdir(session.sessionId, target);
        toast.success(`Created ${name.trim()}`);
        await list(session.sessionId, session.cwd);
      });
    },
    [session, runOp, list],
  );

  /**
   * Counts a folder before it may join the queue, as a row in the rail with its
   * own Cancel. Resolves with the totals, or null when there is nothing to go
   * on with: the scan was cancelled, it failed (and has said so), or the
   * session it was scanning for is no longer the live one.
   */
  const scanDir = useCallback(
    async (
      direction: "put" | "get",
      path: string,
      name: string,
    ): Promise<{ files: number; bytes: number } | null> => {
      const started = sessionRef.current;
      if (!started) return null;
      const scanId = crypto.randomUUID();
      scansRef.current.set(scanId, false);
      setTransfers((prev) => [
        ...prev,
        {
          transferId: scanId,
          direction,
          name,
          status: "scanning",
          filesDone: 0,
          filesTotal: 0,
          bytesDone: 0,
          bytesTotal: 0,
        },
      ]);
      const stillWanted = () =>
        scansRef.current.get(scanId) === false &&
        sessionRef.current?.sessionId === started.sessionId;
      try {
        const stats =
          direction === "put"
            ? await localScanDir(path)
            : await sftpScanDir(started.sessionId, path, scanId);
        if (stats.cancelled || !stillWanted()) return null;
        return { files: stats.files, bytes: stats.bytes };
      } catch (e) {
        if (stillWanted()) toast.error(errorMessage(e));
        return null;
      } finally {
        scansRef.current.delete(scanId);
        setTransfers((prev) => prev.filter((t) => t.transferId !== scanId));
      }
    },
    [],
  );

  /**
   * Queues one file for upload into the remote cwd, with a progress bar.
   *
   * `size` is the file's length from the listing we already have, and is what
   * makes the bar a percentage rather than a pulse. It is optional because not
   * every caller has it; without it the bar still appears and still counts the
   * bytes as they go, it just cannot say how far along they are.
   *
   * The destination is the cwd at the moment it was asked for, not the one it
   * eventually runs in, because where the file was dropped is what the user
   * meant and they are free to navigate while it waits.
   */
  const upload = useCallback(
    (localPath: string, size: number | undefined, batch: TransferBatch) => {
      if (!session) {
        settle(batch);
        return;
      }
      const name = baseName(localPath);
      const remotePath = posixJoin(session.cwd, name);
      const transferId = crypto.randomUUID();
      enqueue(
        {
          transferId,
          direction: "put",
          name,
          // One file, so the bar drops the file counter and shows bytes alone.
          // A single-file progress event reports files_done: 0 throughout (there
          // is no file to have finished until the whole thing has), so a "0/1
          // files" that only ever reads 0/1 would be worse than saying nothing.
          filesTotal: 1,
          bytesTotal: size ?? 0,
        },
        batch,
        async () => {
          const r = await sftpUpload({
            hostId: session.host.id,
            sessionId: session.sessionId,
            localPath,
            remotePath,
            transferId,
          });
          // No byte count on a cancel: the part-written file has been removed,
          // so those bytes crossed the wire and then went nowhere, and a number
          // beside the word "cancelled" reads like something was kept.
          if (r.cancelled) {
            toast.warning(`Upload cancelled: ${name} (partial file removed)`);
            return null;
          }
          return { name, isDir: false, files: 1, bytes: r.bytes, skipped: 0 };
        },
      );
    },
    [session, enqueue, settle],
  );

  /** Queues one remote file for download. See `upload` for why the size is
   *  optional and what it buys. */
  const download = useCallback(
    (
      entry: { path: string; name: string; size?: number },
      localPath: string,
      batch: TransferBatch,
    ) => {
      if (!session) {
        settle(batch);
        return;
      }
      const transferId = crypto.randomUUID();
      enqueue(
        {
          transferId,
          direction: "get",
          name: entry.name,
          filesTotal: 1,
          bytesTotal: entry.size ?? 0,
        },
        batch,
        async () => {
          const r = await sftpDownload({
            hostId: session.host.id,
            sessionId: session.sessionId,
            remotePath: entry.path,
            localPath,
            transferId,
          });
          if (r.cancelled) {
            toast.warning(
              `Download cancelled: ${entry.name} (partial file removed)`,
            );
            return null;
          }
          return {
            name: entry.name,
            isDir: false,
            files: 1,
            bytes: r.bytes,
            skipped: 0,
          };
        },
      );
    },
    [session, enqueue, settle],
  );

  /** Queues a recursive folder upload into the remote cwd (as `<name>/`),
   *  publishing live progress. `totals` (from the pre-flight scan) seed the bar. */
  const uploadDir = useCallback(
    (
      localPath: string,
      mode: TransferMode,
      totals: { files: number; bytes: number },
      batch: TransferBatch,
    ) => {
      if (!session) {
        settle(batch);
        return;
      }
      const name = baseName(localPath);
      const remotePath = posixJoin(session.cwd, name);
      const transferId = crypto.randomUUID();
      enqueue(
        {
          transferId,
          direction: "put",
          name,
          filesTotal: totals.files,
          bytesTotal: totals.bytes,
        },
        batch,
        async () => {
          const stats = await sftpUploadDir({
            hostId: session.host.id,
            sessionId: session.sessionId,
            localPath,
            remotePath,
            transferId,
            mode,
          });
          if (stats.cancelled) {
            toast.warning(folderCancelText("put", name, stats));
            return null;
          }
          return {
            name,
            isDir: true,
            files: stats.files,
            bytes: stats.bytes,
            skipped: stats.skipped,
          };
        },
      );
    },
    [session, enqueue, settle],
  );

  /** Queues a recursive folder download to `localPath` (a `<name>` dir),
   *  publishing live progress. */
  const downloadDir = useCallback(
    (
      entry: { path: string; name: string },
      localPath: string,
      mode: TransferMode,
      totals: { files: number; bytes: number },
      batch: TransferBatch,
    ) => {
      if (!session) {
        settle(batch);
        return;
      }
      const transferId = crypto.randomUUID();
      enqueue(
        {
          transferId,
          direction: "get",
          name: entry.name,
          filesTotal: totals.files,
          bytesTotal: totals.bytes,
        },
        batch,
        async () => {
          const stats = await sftpDownloadDir({
            hostId: session.host.id,
            sessionId: session.sessionId,
            remotePath: entry.path,
            localPath,
            transferId,
            mode,
          });
          if (stats.cancelled) {
            toast.warning(folderCancelText("get", entry.name, stats));
            return null;
          }
          return {
            name: entry.name,
            isDir: true,
            files: stats.files,
            bytes: stats.bytes,
            skipped: stats.skipped,
          };
        },
      );
    },
    [session, enqueue, settle],
  );

  /**
   * Stops a scan or a transfer: one by id, or all of them with no id.
   *
   * A transfer that has not started yet has nothing open at the far end, so
   * cancelling it is simply dropping it off the list. A scan or a running
   * transfer is signalled and stops at its next step; a running transfer keeps
   * the whole files it has already delivered and removes the one it was part
   * way through.
   */
  const cancelTransfer = useCallback(
    (transferId?: string) => {
      if (!session) return;
      if (transferId) {
        if (scansRef.current.has(transferId)) {
          scansRef.current.set(transferId, true);
          setTransfers((prev) =>
            prev.filter((t) => t.transferId !== transferId),
          );
          void sftpCancelTransfer(session.sessionId, transferId).catch(() => {});
          return;
        }
        const job = queueRef.current.find((j) => j.transferId === transferId);
        if (job) {
          queueRef.current = queueRef.current.filter((j) => j !== job);
          setTransfers((prev) =>
            prev.filter((t) => t.transferId !== transferId),
          );
          settle(job.batch);
          return;
        }
        void sftpCancelTransfer(session.sessionId, transferId).catch(() => {
          // Best-effort; the transfer may already be finishing.
        });
        return;
      }
      abandonQueue();
      abandonScans();
      void sftpCancelTransfer(session.sessionId).catch(() => {});
    },
    [session, abandonQueue, abandonScans, settle],
  );

  const remove = useCallback(
    (entry: { path: string; name: string; kind: string }) => {
      if (!session) return;
      void runOp(async () => {
        await sftpDelete(session.sessionId, entry.path, entry.kind === "dir");
        toast.success(`Deleted ${entry.name}`);
        await list(session.sessionId, session.cwd);
      });
    },
    [session, runOp, list],
  );

  return {
    hosts,
    session,
    entries,
    connecting,
    listing,
    // One flag for "this pane is mid-something", covering both a one-shot op
    // and anything in the transfer rail.
    busy: opBusy || transfers.length > 0,
    transfers,
    relistSeq,
    connect,
    navigate,
    goUp,
    refresh,
    disconnect,
    mkdir,
    beginBatch,
    settle,
    scanDir,
    upload,
    download,
    uploadDir,
    downloadDir,
    cancelTransfer,
    remove,
    // Trust dialogs
    tofu,
    setTofu,
    mismatch,
    setMismatch,
  };
}
