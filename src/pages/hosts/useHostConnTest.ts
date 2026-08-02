import { useCallback, useState } from "react";
import { toast } from "sonner";

import { shellNotice, type ShellCapability } from "@/lib/shells";
import { type Host, errorMessage } from "@/lib/tauri/hosts";
import { type PresentedKey, testConnection } from "@/lib/tauri/ssh";

/** Per-host connection test ("Test" action). Owns the in-flight host id, plus
 * the TOFU (unknown key) and key-mismatch dialog state the test can surface.
 *
 * Whether the last attempt failed is no longer kept here. It lives on the host
 * row (`connect_failed_at`), written by the backend from every path that
 * connects, because a machine being down outlives the page that noticed: the
 * red mark used to be forgotten by the next launch, which is precisely when it
 * was worth having. This hook only reports what it just learned so the row on
 * screen keeps up.
 *
 * `onShellRead` is the same idea for the shell columns. A test that connects
 * stores what it read of the login shell, so the amber chip is stale the moment
 * the toast appears: it was drawn from the list the page loaded, and nothing
 * told that list the answer had changed. */
export function useHostConnTest(
  onShellRead?: (
    hostId: number,
    loginShell: string | null,
    capability: ShellCapability | null,
  ) => void,
  onReachability?: (hostId: number, failed: boolean) => void,
) {
  const [testingId, setTestingId] = useState<number | null>(null);
  const [tofu, setTofu] = useState<{ host: Host; key: PresentedKey } | null>(
    null,
  );
  const [mismatch, setMismatch] = useState<{
    host: Host;
    stored: string;
    presented: PresentedKey;
  } | null>(null);

  // Mirrors what the backend just wrote to `connect_failed_at`, so the button
  // changes colour with the toast rather than on the next visit to the page.
  const markFailed = useCallback(
    (hostId: number, failed: boolean) => {
      onReachability?.(hostId, failed);
    },
    [onReachability],
  );

  const runTest = useCallback(
    async (host: Host) => {
      setTestingId(host.id);
      try {
        const result = await testConnection(host.id);
        switch (result.status) {
          case "ok":
            toast.success(`${host.label}: connected (${result.latency_ms}ms)`);
            // Surface a shell we can't fully drive here too, so Test connection
            // is one of the ways an operator finds out (X4). Separate toast:
            // the connection genuinely succeeded, this is a caveat about it.
            // Driven off the capability rather than the name, because the two
            // cases worth reporting most (a console menu, an unanswered probe)
            // have no name to test.
            // Through the same helper the chip and the terminal strip use, so
            // the toast cannot say "this host runs fish" a second after the row
            // stopped marking it (or the reverse: nag about an unread shell on
            // a host that has already been told what it is).
            {
              const notice = shellNotice(
                result.capability,
                host.shell_integration,
                result.login_shell,
              );
              if (notice) toast.warning(notice.message);
            }
            // The row is now out of date in both directions: a shell that has
            // become unsupported has no chip yet, and one that has been put
            // back to bash still has the old one. This is the only outcome
            // that writes the columns, so it is the only one that reports.
            onShellRead?.(host.id, result.login_shell, result.capability);
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
    [markFailed, onShellRead],
  );

  return {
    testingId,
    tofu,
    setTofu,
    mismatch,
    setMismatch,
    runTest,
  };
}
