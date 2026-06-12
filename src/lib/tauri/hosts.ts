import { invoke } from "@tauri-apps/api/core";

export type Host = {
  id: number;
  label: string;
  hostname: string;
  port: number;
  username: string;
  color: string;
  linux_flavor: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  auth_method: string | null;
  key_path: string | null;
  has_sudo_password: boolean;
};

export type HostInput = {
  label: string;
  hostname: string;
  port: number;
  username: string;
  color: string;
  linux_flavor: string | null;
  notes: string | null;
};

export type AuthInput =
  | { kind: "password"; value: string }
  | { kind: "key"; path: string; passphrase: string | null };

export type AppErrorPayload = {
  kind:
    | "db"
    | "io"
    | "host_not_found"
    | "invalid_input"
    | "state"
    | "credentials_locked"
    | "credentials"
    | "serde"
    | "ssh"
    | "destructive_blocked";
  message: string;
};

export function listHosts(): Promise<Host[]> {
  return invoke<Host[]>("list_hosts");
}

export function getHost(id: number): Promise<Host> {
  return invoke<Host>("get_host", { id });
}

export function createHost(input: HostInput): Promise<Host> {
  return invoke<Host>("create_host", { input });
}

export function updateHost(id: number, input: HostInput): Promise<Host> {
  return invoke<Host>("update_host", { id, input });
}

export function deleteHost(id: number): Promise<void> {
  return invoke<void>("delete_host", { id });
}

/** Writes all hosts to a CSV (import-compatible columns); returns the count. */
export function exportHosts(path: string): Promise<number> {
  return invoke<number>("export_hosts", { path });
}

/** Whether a local path points at an existing file. */
export function pathIsFile(path: string): Promise<boolean> {
  return invoke<boolean>("path_is_file", { path });
}

export function setHostCredentials(
  host_id: number,
  auth: AuthInput,
): Promise<void> {
  return invoke<void>("set_host_credentials", { hostId: host_id, auth });
}

export function clearHostCredentials(host_id: number): Promise<void> {
  return invoke<void>("clear_host_credentials", { hostId: host_id });
}

/** Sets (string) or clears (null) the host's sudo password (D-026). */
export function setSudoPassword(
  hostId: number,
  value: string | null,
): Promise<void> {
  return invoke<void>("set_sudo_password", { hostId, value });
}

/** Backend-side copy of the stored SSH password into the sudo slot. */
export function setSudoSameAsLogin(hostId: number): Promise<void> {
  return invoke<void>("set_sudo_same_as_login", { hostId });
}

export function isCredentialsUnlocked(): Promise<boolean> {
  return invoke<boolean>("is_credentials_unlocked");
}

export function requiresMasterPassword(): Promise<boolean> {
  return invoke<boolean>("requires_master_password");
}

export function unlockCredentials(masterPassword: string): Promise<boolean> {
  return invoke<boolean>("unlock_credentials", { masterPassword });
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
