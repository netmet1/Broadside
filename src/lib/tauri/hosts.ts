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
    | "ssh";
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

export function setHostCredentials(
  host_id: number,
  auth: AuthInput,
): Promise<void> {
  return invoke<void>("set_host_credentials", { hostId: host_id, auth });
}

export function clearHostCredentials(host_id: number): Promise<void> {
  return invoke<void>("clear_host_credentials", { hostId: host_id });
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
