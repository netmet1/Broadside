import { invoke } from "@tauri-apps/api/core";

/** One .otlog line (D-010): JSONL {ts, host, stream, data}, ANSI preserved. */
export type OtlogLine = {
  ts: string;
  host: string;
  stream: string;
  data: string;
};

export type AuditInfo = {
  path: string;
  size_bytes: number;
  enabled: boolean;
};

export function saveSession(
  path: string,
  lines: OtlogLine[],
  passphrase: string | null,
): Promise<void> {
  return invoke<void>("save_session", { path, lines, passphrase });
}

export function sessionIsEncrypted(path: string): Promise<boolean> {
  return invoke<boolean>("session_is_encrypted", { path });
}

export function loadSession(
  path: string,
  passphrase: string | null,
): Promise<OtlogLine[]> {
  return invoke<OtlogLine[]>("load_session", { path, passphrase });
}

export function auditInfo(): Promise<AuditInfo> {
  return invoke<AuditInfo>("audit_info");
}

export function auditTail(maxLines: number): Promise<string[]> {
  return invoke<string[]>("audit_tail", { maxLines });
}

export function setAuditEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("set_audit_enabled", { enabled });
}

/** One parsed error-log entry (D-055). */
export type ErrorEntry = {
  ts: string;
  source: string;
  /** Host id for live colour-tinting (LG2); absent on older entries. */
  host_id?: number;
  host_label?: string;
  message: string;
};

export async function errorLogTail(maxLines: number): Promise<ErrorEntry[]> {
  const lines = await invoke<string[]>("error_log_tail", { maxLines });
  const entries: ErrorEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as ErrorEntry);
    } catch {
      // A corrupt line shouldn't hide the rest of the log.
      entries.push({ ts: "", source: "?", message: line });
    }
  }
  return entries;
}

export function clearErrorLog(): Promise<number> {
  return invoke<number>("clear_error_log");
}
