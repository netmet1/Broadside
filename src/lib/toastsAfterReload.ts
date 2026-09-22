import { toast } from "sonner";

/**
 * Toasts that belong to the page *after* a reload.
 *
 * A restore reloads the app 700 ms after it finishes, so anything it toasted
 * was gone before it could be read (smoke test 69-6, C4), and the warning was
 * the one toast in the app that tells you to go and do something. Stashed in
 * sessionStorage, which a reload keeps and a restart does not, and shown once
 * the new page is up, with a warning staying until it is closed.
 */

const KEY = "broadside.toastsAfterReload";

type Queued = { kind: "success" | "warning"; message: string };

export function queueToastAfterReload(kind: Queued["kind"], message: string) {
  try {
    const list = JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as Queued[];
    list.push({ kind, message });
    sessionStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // No storage: the toast is simply not repeated after the reload.
  }
}

/** Shows (once) whatever the page before the reload queued. */
export function replayToastsAfterReload() {
  let list: Queued[] = [];
  try {
    list = JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as Queued[];
    sessionStorage.removeItem(KEY);
  } catch {
    return;
  }
  for (const q of Array.isArray(list) ? list : []) {
    if (typeof q?.message !== "string") continue;
    if (q.kind === "warning") {
      toast.warning(q.message, { duration: Infinity, closeButton: true });
    } else {
      toast.success(q.message, { duration: 8000 });
    }
  }
}
