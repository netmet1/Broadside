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

/** Progress for an in-flight recursive folder transfer. Totals come from the
 *  pre-flight scan (0 if unknown); the running counts arrive via events. */
export type ActiveTransfer = {
  transferId: string;
  direction: "put" | "get";
  name: string;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
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
  const [busy, setBusy] = useState(false); // mkdir / upload / download / delete
  // Live progress for the in-flight recursive folder transfer (null when idle).
  const [transfer, setTransfer] = useState<ActiveTransfer | null>(null);

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
  // The live session id (or null) — lets an async transfer tell whether its
  // session is still current before refreshing (it may have been disconnected).
  const currentSessionId = useRef<string | null>(null);
  useEffect(() => {
    currentSessionId.current = session?.sessionId ?? null;
  }, [session]);

  // Fold live transfer-progress events into the active transfer (matched by id).
  useEffect(() => {
    const unlisten = onSftpTransferProgress((e) => {
      setTransfer((t) =>
        t && t.transferId === e.transfer_id
          ? { ...t, filesDone: e.files_done, bytesDone: e.bytes_done }
          : t,
      );
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
      // A dropped/restarted backend session can't be recovered here — reset so
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
    void sftpDisconnect(session.sessionId).catch(() => {
      // Best-effort: the session may already be gone.
    });
    setSession(null);
    setEntries([]);
  }, [session]);

  /** Runs a file op with the busy flag + toast/refresh boilerplate. */
  const runOp = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

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

  const upload = useCallback(
    (localPath: string): Promise<void> => {
      if (!session) return Promise.resolve();
      const remotePath = posixJoin(session.cwd, baseName(localPath));
      return runOp(async () => {
        const bytes = await sftpUpload({
          hostId: session.host.id,
          sessionId: session.sessionId,
          localPath,
          remotePath,
        });
        toast.success(`Uploaded ${baseName(localPath)} (${bytes} bytes)`);
        await list(session.sessionId, session.cwd);
      });
    },
    [session, runOp, list],
  );

  const download = useCallback(
    (entry: { path: string; name: string }, localPath: string): Promise<void> => {
      if (!session) return Promise.resolve();
      return runOp(async () => {
        const bytes = await sftpDownload({
          hostId: session.host.id,
          sessionId: session.sessionId,
          remotePath: entry.path,
          localPath,
        });
        toast.success(`Downloaded ${entry.name} (${bytes} bytes)`);
      });
    },
    [session, runOp],
  );

  /** Recursively uploads a local folder into the remote cwd (as `<name>/`),
   *  publishing live progress. `totals` (from the pre-flight scan) seed the bar. */
  const uploadDir = useCallback(
    (
      localPath: string,
      mode: TransferMode,
      totals?: { files: number; bytes: number },
    ): Promise<void> => {
      if (!session) return Promise.resolve();
      const name = baseName(localPath);
      const remotePath = posixJoin(session.cwd, name);
      const transferId = crypto.randomUUID();
      setTransfer({
        transferId,
        direction: "put",
        name,
        filesDone: 0,
        filesTotal: totals?.files ?? 0,
        bytesDone: 0,
        bytesTotal: totals?.bytes ?? 0,
      });
      setBusy(true);
      return sftpUploadDir({
        hostId: session.host.id,
        sessionId: session.sessionId,
        localPath,
        remotePath,
        transferId,
        mode,
      })
        .then(async (stats) => {
          const skip = stats.skipped > 0 ? `, ${stats.skipped} skipped` : "";
          if (stats.cancelled) {
            toast.warning(
              `Upload cancelled — ${stats.files} files (${formatSize(stats.bytes)}) transferred${skip} before stopping`,
            );
          } else {
            toast.success(
              `Uploaded folder ${name} (${stats.files} files, ${formatSize(stats.bytes)}${skip})`,
            );
          }
          // Refresh so partial/complete results show — unless the session is
          // already gone (e.g. cancelled via Disconnect).
          if (currentSessionId.current === session.sessionId)
            await list(session.sessionId, session.cwd);
        })
        .catch((e) => {
          toast.error(errorMessage(e));
        })
        .finally(() => {
          setBusy(false);
          setTransfer(null);
        });
    },
    [session, list],
  );

  /** Recursively downloads a remote folder to `localPath` (a `<name>` dir),
   *  publishing live progress. */
  const downloadDir = useCallback(
    (
      entry: { path: string; name: string },
      localPath: string,
      mode: TransferMode,
      totals?: { files: number; bytes: number },
    ): Promise<void> => {
      if (!session) return Promise.resolve();
      const transferId = crypto.randomUUID();
      setTransfer({
        transferId,
        direction: "get",
        name: entry.name,
        filesDone: 0,
        filesTotal: totals?.files ?? 0,
        bytesDone: 0,
        bytesTotal: totals?.bytes ?? 0,
      });
      setBusy(true);
      return sftpDownloadDir({
        hostId: session.host.id,
        sessionId: session.sessionId,
        remotePath: entry.path,
        localPath,
        transferId,
        mode,
      })
        .then((stats) => {
          const skip = stats.skipped > 0 ? `, ${stats.skipped} skipped` : "";
          if (stats.cancelled) {
            toast.warning(
              `Download cancelled — ${stats.files} files (${formatSize(stats.bytes)}) transferred${skip} before stopping`,
            );
          } else {
            toast.success(
              `Downloaded folder ${entry.name} (${stats.files} files, ${formatSize(stats.bytes)}${skip})`,
            );
          }
        })
        .catch((e) => {
          toast.error(errorMessage(e));
        })
        .finally(() => {
          setBusy(false);
          setTransfer(null);
        });
    },
    [session],
  );

  /** Signals the in-flight recursive transfer to stop at the next file. */
  const cancelTransfer = useCallback(() => {
    if (session) {
      void sftpCancelTransfer(session.sessionId).catch(() => {
        // Best-effort; the transfer may already be finishing.
      });
    }
  }, [session]);

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
    busy,
    transfer,
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
