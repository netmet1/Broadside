import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { PresentedKey } from "@/lib/tauri/ssh";

export type PtyOpenResult =
  | { status: "opened" }
  | { status: "unknown_key"; key: PresentedKey }
  | {
      status: "key_mismatch";
      stored_fingerprint: string;
      presented: PresentedKey;
    }
  | { status: "auth_failed"; message: string }
  | { status: "unreachable"; message: string }
  | { status: "no_credentials" };

export type PtyClosed = {
  session_id: string;
  exit_code: number | null;
  message: string | null;
};

export function ptyOpen(args: {
  sessionId: string;
  hostId: number;
  cols: number;
  rows: number;
}): Promise<PtyOpenResult> {
  return invoke<PtyOpenResult>("pty_open", args);
}

export function ptyWrite(sessionId: string, data: string): Promise<void> {
  return invoke<void>("pty_write", { sessionId, data });
}

export function ptyResize(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke<void>("pty_resize", { sessionId, cols, rows });
}

export function ptyClose(sessionId: string): Promise<void> {
  return invoke<void>("pty_close", { sessionId });
}

/** Base64-decoded terminal output for one session. */
export function onPtyData(
  handler: (sessionId: string, bytes: Uint8Array) => void,
): Promise<UnlistenFn> {
  return listen<{ session_id: string; data_b64: string }>(
    "pty:data",
    (event) => {
      const raw = atob(event.payload.data_b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      handler(event.payload.session_id, bytes);
    },
  );
}

export function onPtyClosed(
  handler: (closed: PtyClosed) => void,
): Promise<UnlistenFn> {
  return listen<PtyClosed>("pty:closed", (event) => handler(event.payload));
}
