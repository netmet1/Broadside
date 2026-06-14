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

/** Why a block isn't mirrored as text (D-061). `normal` blocks carry output
 * lines; the others are full-screen/redrawing TUI apps shown as a notice. */
export type BlockInteractivity = "normal" | "alt_screen" | "redraw";

/** One completed command on a session, for the OmniTerminal aggregate view
 * (D-061). Emitted when the command finishes (OSC 133 `D`) or on session close. */
export type PtyBlock = {
  session_id: string;
  /** Command text captured from the shell, when known. */
  command: string | null;
  /** Output lines (plain text). Empty when interactive. */
  lines: string[];
  /** Exit status, when the shell reported one. */
  exit_code: number | null;
  interactivity: BlockInteractivity;
};

export function onPtyBlock(
  handler: (block: PtyBlock) => void,
): Promise<UnlistenFn> {
  return listen<PtyBlock>("pty:block", (event) => handler(event.payload));
}

/** One persisted PTY-broadcast dispatch (D-059). */
export type StoredPtyDispatch = {
  label: string;
  color: string;
  ok: boolean;
  message: string | null;
};

export type StoredPtyRun = {
  run_id: string;
  ts: string;
  command: string;
  results: StoredPtyDispatch[];
};

/** Persists one PTY-broadcast dispatch run (also records the command in the
 * shared recall history). */
export function ptyHistoryAdd(args: {
  runId: string;
  ts: string;
  command: string;
  results: StoredPtyDispatch[];
}): Promise<void> {
  return invoke<void>("pty_history_add", {
    runId: args.runId,
    ts: args.ts,
    command: args.command,
    results: args.results,
  });
}

/** Persisted PTY dispatch history, oldest run first (survives restarts). */
export function ptyHistoryList(maxRuns: number): Promise<StoredPtyRun[]> {
  return invoke<StoredPtyRun[]>("pty_history_list", { maxRuns });
}

/** Clears the persistent PTY dispatch history. Returns rows removed. */
export function ptyHistoryClear(): Promise<number> {
  return invoke<number>("pty_history_clear");
}
