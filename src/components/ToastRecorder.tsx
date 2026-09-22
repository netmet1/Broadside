import { isValidElement, useEffect, useRef, type ReactNode } from "react";
import { useSonner, type ToastT } from "sonner";

import { appendToastLog, type ToastEntry } from "@/lib/tauri/logs";
import { replayToastsAfterReload } from "@/lib/toastsAfterReload";

/** Plain text of a toast's title or description, or "" when there is none. */
function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "function") return textOf((node as () => ReactNode)());
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) {
    return textOf((node.props as { children?: unknown }).children);
  }
  return "";
}

function kindOf(t: ToastT): ToastEntry["kind"] | null {
  switch (t.type) {
    case "success":
    case "error":
    case "warning":
    case "info":
      return t.type;
    case "loading":
      // Still in progress: recorded once it settles into a result.
      return null;
    default:
      return "message";
  }
}

/** How long an updated toast must stay still before its new text is recorded. */
const SETTLE_MS = 1000;

/**
 * Writes every toast to the toast history (Logs > Toasts History) as it
 * appears, so the ones that went by too fast can be read again.
 *
 * A toast is recorded the moment it is first seen, not when it closes, so one
 * raised just before a reload is not lost with the page. A toast updated in
 * place under the same id (the terminal zoom readout, a loading toast turning
 * into a result) is written again only once it has stopped changing, so a
 * burst of zoom steps leaves its first and last size, not twenty lines.
 *
 * Also the place that replays toasts queued across a reload, since it mounts
 * after the Toaster and its subscription is live by then.
 */
export function ToastRecorder() {
  const { toasts } = useSonner();
  /** id -> the "kind|text" last written for it. */
  const written = useRef(new Map<string | number, string>());
  const pending = useRef(new Map<string | number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    for (const t of toasts) {
      const kind = kindOf(t);
      if (!kind) continue;
      const message = textOf(t.title).trim();
      if (!message) continue;
      const description = textOf(t.description).trim() || null;
      const sig = `${kind}|${message}|${description ?? ""}`;
      const prev = written.current.get(t.id);
      if (prev === sig) continue;
      const write = () => {
        written.current.set(t.id, sig);
        pending.current.delete(t.id);
        void appendToastLog(kind, message, description).catch(() => {});
      };
      clearTimeout(pending.current.get(t.id));
      if (prev === undefined) {
        write();
      } else {
        pending.current.set(t.id, setTimeout(write, SETTLE_MS));
      }
    }
  }, [toasts]);

  useEffect(() => {
    const timers = pending.current;
    const replay = setTimeout(replayToastsAfterReload, 300);
    return () => {
      clearTimeout(replay);
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);

  return null;
}
