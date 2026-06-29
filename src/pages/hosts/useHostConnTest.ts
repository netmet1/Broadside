import { useCallback, useState } from "react";
import { toast } from "sonner";

import { type Host, errorMessage } from "@/lib/tauri/hosts";
import { type PresentedKey, testConnection } from "@/lib/tauri/ssh";

/** Per-host connection test ("Test" action). Owns the in-flight host id plus
 * the TOFU (unknown key) and key-mismatch dialog state the test can surface. */
export function useHostConnTest() {
  const [testingId, setTestingId] = useState<number | null>(null);
  const [tofu, setTofu] = useState<{ host: Host; key: PresentedKey } | null>(
    null,
  );
  const [mismatch, setMismatch] = useState<{
    host: Host;
    stored: string;
    presented: PresentedKey;
  } | null>(null);

  const runTest = useCallback(async (host: Host) => {
    setTestingId(host.id);
    try {
      const result = await testConnection(host.id);
      switch (result.status) {
        case "ok":
          toast.success(`${host.label}: connected (${result.latency_ms}ms)`);
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
          toast.error(
            `${host.label}: authentication failed (${result.message})`,
          );
          break;
        case "unreachable":
          toast.error(`${host.label}: unreachable (${result.message})`);
          break;
        case "no_credentials":
          toast.warning(
            `${host.label}: no credentials stored. Edit the host to add them.`,
          );
          break;
      }
    } catch (e) {
      toast.error(`${host.label}: ${errorMessage(e)}`);
    } finally {
      setTestingId(null);
    }
  }, []);

  return {
    testingId,
    tofu,
    setTofu,
    mismatch,
    setMismatch,
    runTest,
  };
}
