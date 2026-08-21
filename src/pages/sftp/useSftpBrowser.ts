import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { type Host, errorMessage, listHosts } from "@/lib/tauri/hosts";
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
  sftpUpload,
  sftpUploadDir,
  sftpCancelTransfer,
  onSftpTransferProgress,
} from "@/lib/tauri/sftp";
import {
  TRANSFER_CONCURRENCY,
  baseName,
  formatSize,
  isSessionGone,
  posixDirname,
  posixJoin,
} from "@/pages/sftp/model";

/** The live browser session: which host, its backend session id, and cwd. */
type Session = {
  host: Host;
  sessionId: string;
  cwd: string;
};

/** One transfer in the stack, running or still waiting for a slot. Totals come
 *  from the listing (a file) or the pre-flight scan (a folder), and are 0 when
 *  unknown; the running counts arrive via events. */
export type ActiveTransfer = {
  transferId: string;
  direction: "put" | "get";
  name: string;
  /** "queued" until a worker picks it up, then "running". */
  status: "queued" | "running";
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
};

/** A transfer waiting for a slot: its id, and the call to make when it gets
 *  one. `run` reports its own outcome (it is the only thing that knows what to
 *  say); `cancelled()` tells it whether the user pulled this one, which the
 *  single-file calls need because a cancelled transfer comes back with the bytes
 *  it managed rather than with an error. */
type TransferJob = {
  transferId: string;
  run: (cancelled: () => boolean) => Promise<void>;
};

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
  // Everything in flight or waiting, in the order it was asked for.
  const [transfers, setTransfers] = useState<ActiveTransfer[]>([]);
  // Bumped each time the queue empties, so both panes can be re-listed once at
  // the end instead of after every file.
  const [idleSeq, setIdleSeq] = useState(0);

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
  // The transfer queue: jobs waiting for a slot, how many slots are taken, and
  // which transfers the user has pulled. Refs rather than state, because the
  // workers read them between awaits and must see the live values, not the ones
  // that were current when the worker started.
  const queueRef = useRef<TransferJob[]>([]);
  const workersRef = useRef(0);
  const cancelledRef = useRef<Set<string>>(new Set());

  /**
   * Empties the queue: whatever had not started is simply forgotten (nothing is
   * open for it at the far end, so there is nothing to stop), and whatever is
   * already running is noted as cancelled so its toast says so rather than
   * claiming a partial transfer finished.
   *
   * It does not signal the backend. The two callers do that differently: a
   * cancel-all asks it to stop the transfers, a disconnect takes the session
   * away and the backend stops them on the way out.
   */
  const abandonQueue = useCallback(() => {
    const queued = new Set(queueRef.current.map((j) => j.transferId));
    queueRef.current = [];
    for (const t of transfers) {
      if (!queued.has(t.transferId)) cancelledRef.current.add(t.transferId);
    }
    setTransfers((prev) => prev.filter((t) => !queued.has(t.transferId)));
  }, [transfers]);

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
    // Nothing queued survives losing the session it was going to use, and what
    // is already running is stopped by the backend as the session is removed.
    abandonQueue();
    void sftpDisconnect(session.sessionId).catch(() => {
      // Best-effort: the session may already be gone.
    });
    setSession(null);
    setEntries([]);
  }, [session, abandonQueue]);

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
      run: TransferJob["run"],
    ) => {
      setTransfers((prev) => [
        ...prev,
        { ...transfer, status: "queued", filesDone: 0, bytesDone: 0 },
      ]);
      queueRef.current.push({ transferId: transfer.transferId, run });

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
            try {
              await job.run(() => cancelledRef.current.has(job.transferId));
            } catch (e) {
              toast.error(errorMessage(e));
            } finally {
              cancelledRef.current.delete(job.transferId);
              setTransfers((prev) =>
                prev.filter((t) => t.transferId !== job.transferId),
              );
            }
          }
          workersRef.current -= 1;
          // The last worker to leave found the queue empty, so everything asked
          // for is done and the listings can be brought up to date once.
          if (workersRef.current === 0) setIdleSeq((n) => n + 1);
        })();
      }
    },
    [],
  );

  // Re-list the remote side when the queue drains: an upload put files there,
  // and a folder GET may have been cancelled part-way. Latched on the sequence
  // number rather than run on every change, because `refresh` takes a new
  // identity whenever the session or cwd changes and that is not a reason to
  // list again.
  const handledIdle = useRef(0);
  useEffect(() => {
    if (idleSeq === handledIdle.current) return;
    handledIdle.current = idleSeq;
    refresh();
  }, [idleSeq, refresh]);

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
    (localPath: string, size?: number) => {
      if (!session) return;
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
        async (cancelled) => {
          const bytes = await sftpUpload({
            hostId: session.host.id,
            sessionId: session.sessionId,
            localPath,
            remotePath,
            transferId,
          });
          // A cancelled single file comes back with the bytes it managed rather
          // than an error, so only the queue knows it was pulled.
          if (cancelled()) {
            toast.warning(
              `Upload cancelled: ${name} (${formatSize(bytes)} transferred)`,
            );
          } else {
            toast.success(`Uploaded ${name} (${formatSize(bytes)})`);
          }
        },
      );
    },
    [session, enqueue],
  );

  /** Queues one remote file for download. See `upload` for why the size is
   *  optional and what it buys. */
  const download = useCallback(
    (
      entry: { path: string; name: string; size?: number },
      localPath: string,
    ) => {
      if (!session) return;
      const transferId = crypto.randomUUID();
      enqueue(
        {
          transferId,
          direction: "get",
          name: entry.name,
          filesTotal: 1,
          bytesTotal: entry.size ?? 0,
        },
        async (cancelled) => {
          const bytes = await sftpDownload({
            hostId: session.host.id,
            sessionId: session.sessionId,
            remotePath: entry.path,
            localPath,
            transferId,
          });
          if (cancelled()) {
            toast.warning(
              `Download cancelled: ${entry.name} (${formatSize(bytes)} transferred)`,
            );
          } else {
            toast.success(`Downloaded ${entry.name} (${formatSize(bytes)})`);
          }
        },
      );
    },
    [session, enqueue],
  );

  /** Queues a recursive folder upload into the remote cwd (as `<name>/`),
   *  publishing live progress. `totals` (from the pre-flight scan) seed the bar. */
  const uploadDir = useCallback(
    (
      localPath: string,
      mode: TransferMode,
      totals?: { files: number; bytes: number },
    ) => {
      if (!session) return;
      const name = baseName(localPath);
      const remotePath = posixJoin(session.cwd, name);
      const transferId = crypto.randomUUID();
      enqueue(
        {
          transferId,
          direction: "put",
          name,
          filesTotal: totals?.files ?? 0,
          bytesTotal: totals?.bytes ?? 0,
        },
        async () => {
          const stats = await sftpUploadDir({
            hostId: session.host.id,
            sessionId: session.sessionId,
            localPath,
            remotePath,
            transferId,
            mode,
          });
          const skip = stats.skipped > 0 ? `, ${stats.skipped} skipped` : "";
          if (stats.cancelled) {
            toast.warning(
              `Upload cancelled: ${stats.files} files (${formatSize(stats.bytes)}) transferred${skip} before stopping`,
            );
          } else {
            toast.success(
              `Uploaded folder ${name} (${stats.files} files, ${formatSize(stats.bytes)}${skip})`,
            );
          }
        },
      );
    },
    [session, enqueue],
  );

  /** Queues a recursive folder download to `localPath` (a `<name>` dir),
   *  publishing live progress. */
  const downloadDir = useCallback(
    (
      entry: { path: string; name: string },
      localPath: string,
      mode: TransferMode,
      totals?: { files: number; bytes: number },
    ) => {
      if (!session) return;
      const transferId = crypto.randomUUID();
      enqueue(
        {
          transferId,
          direction: "get",
          name: entry.name,
          filesTotal: totals?.files ?? 0,
          bytesTotal: totals?.bytes ?? 0,
        },
        async () => {
          const stats = await sftpDownloadDir({
            hostId: session.host.id,
            sessionId: session.sessionId,
            remotePath: entry.path,
            localPath,
            transferId,
            mode,
          });
          const skip = stats.skipped > 0 ? `, ${stats.skipped} skipped` : "";
          if (stats.cancelled) {
            toast.warning(
              `Download cancelled: ${stats.files} files (${formatSize(stats.bytes)}) transferred${skip} before stopping`,
            );
          } else {
            toast.success(
              `Downloaded folder ${entry.name} (${stats.files} files, ${formatSize(stats.bytes)}${skip})`,
            );
          }
        },
      );
    },
    [session, enqueue],
  );

  /**
   * Stops a transfer: one by id, or all of them with no id.
   *
   * A transfer that has not started yet has nothing open at the far end, so
   * cancelling it is simply dropping it off the list. One that is running is
   * signalled and stops at its next chunk, keeping whatever it has already
   * written; the id is remembered so that when it comes back with a byte count
   * rather than an error, the toast says cancelled instead of done.
   */
  const cancelTransfer = useCallback(
    (transferId?: string) => {
      if (!session) return;
      if (transferId) {
        const queued = queueRef.current.some((j) => j.transferId === transferId);
        if (queued) {
          queueRef.current = queueRef.current.filter(
            (j) => j.transferId !== transferId,
          );
          setTransfers((prev) =>
            prev.filter((t) => t.transferId !== transferId),
          );
          return;
        }
        cancelledRef.current.add(transferId);
        void sftpCancelTransfer(session.sessionId, transferId).catch(() => {
          // Best-effort; the transfer may already be finishing.
        });
        return;
      }
      abandonQueue();
      void sftpCancelTransfer(session.sessionId).catch(() => {});
    },
    [session, abandonQueue],
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
    // and anything in the transfer queue.
    busy: opBusy || transfers.length > 0,
    transfers,
    idleSeq,
    connect,
    navigate,
    goUp,
    refresh,
    disconnect,
    mkdir,
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
