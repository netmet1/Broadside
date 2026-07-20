import { useCallback, useState } from "react";
import { toast } from "sonner";

import { isShellSupported, unsupportedShellMessage } from "@/lib/shells";
import { type Host, errorMessage } from "@/lib/tauri/hosts";
import { type PresentedKey, testConnection } from "@/lib/tauri/ssh";

/** Per-host connection test ("Test" action). Owns the in-flight host id, the
 * set of hosts whose last test failed (drives the red Test-button icon), plus
 * the TOFU (unknown key) and key-mismatch dialog state the test can surface. */
export function useHostConnTest() {
  const [testingId, setTestingId] = useState<number | null>(null);
  // Hosts whose most recent test ended in a definitive failure (auth /
  // unreachable / no-credentials / error). Cleared by a successful re-test or
  // by opening the host's edit form.
  const [failedIds, setFailedIds] = useState<Set<number>>(new Set());
  const [tofu, setTofu] = useState<{ host: Host; key: PresentedKey } | null>(
    null,
  );
  const [mismatch, setMismatch] = useState<{
    host: Host;
    stored: string;
    presented: PresentedKey;
  } | null>(null);

  const markFailed = useCallback((hostId: number, failed: boolean) => {
    setFailedIds((prev) => {
      if (failed === prev.has(hostId)) return prev;
      const next = new Set(prev);
      if (failed) next.add(hostId);
      else next.delete(hostId);
      return next;
    });
  }, []);

  /** Reset a host's failed indicator — called when its edit form opens so the
   * operator can correct the credentials/details without a stale red mark. */
  const clearFailed = useCallback((hostId: number) => {
    markFailed(hostId, false);
  }, [markFailed]);

  const runTest = useCallback(
    async (host: Host) => {
      setTestingId(host.id);
      try {
        const result = await testConnection(host.id);
        switch (result.status) {
          case "ok":
            toast.success(`${host.label}: connected (${result.latency_ms}ms)`);
            // Surface an unsupported login shell here too, so Test connection
            // is one of the ways an operator finds out (X4). Separate toast:
            // the connection genuinely succeeded, this is a caveat about it.
            if (result.login_shell && !isShellSupported(result.login_shell)) {
              toast.warning(unsupportedShellMessage(result.login_shell));
            }
            markFailed(host.id, false);
            break;
          case "unknown_key":
            // Pending a trust decision — not a failure; leave the mark as-is.
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
            toast.error(
              `${host.label}: authentication failed (${result.message})`,
            );
            markFailed(host.id, true);
            break;
          case "unreachable":
            toast.error(`${host.label}: unreachable (${result.message})`);
            markFailed(host.id, true);
            break;
          case "no_credentials":
            toast.warning(
              `${host.label}: no credentials stored. Edit the host to add them.`,
            );
            markFailed(host.id, true);
            break;
        }
      } catch (e) {
        toast.error(`${host.label}: ${errorMessage(e)}`);
        markFailed(host.id, true);
      } finally {
        setTestingId(null);
      }
    },
    [markFailed],
  );

  return {
    testingId,
    failedIds,
    clearFailed,
    tofu,
    setTofu,
    mismatch,
    setMismatch,
    runTest,
  };
}
