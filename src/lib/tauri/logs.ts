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
