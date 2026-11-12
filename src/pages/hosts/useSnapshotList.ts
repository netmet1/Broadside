import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/tauri/hosts";
import { listSnapshots, type Snapshot } from "@/lib/tauri/snapshots";

/** Every saved snapshot, read when the Library page is built (fresh on each
 * visit), again on `reload`, and whenever `version` moves (App bumps it when a
 * snapshot is saved from its dialog). */
export function useSnapshotList(version: number) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [readCount, setReadCount] = useState(0);
  const reload = useCallback(() => setReadCount((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    listSnapshots()
      .then((list) => {
        if (alive) setSnapshots(list);
      })
      .catch((e) => toast.error(errorMessage(e)))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [readCount, version]);
  return { snapshots, loading, reload };
}
