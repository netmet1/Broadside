import { invoke } from "@tauri-apps/api/core";

import type { ShellCapability, ShellIntegrationPref } from "@/lib/shells";

export type Host = {
  id: number;
  label: string;
  hostname: string;
  port: number;
  username: string;
  color: string;
  /** Optional free-text grouping tag (for table sorting). */
  tag: string | null;
  linux_flavor: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  auth_method: string | null;
  key_path: string | null;
  has_sudo_password: boolean;
  /** The login shell seen on the last successful connect, e.g. "bash" or
   * "fish". Backend-written, so it is absent from {@link HostInput}. Null means
   * not probed yet, never "unsupported". */
  login_shell: string | null;
  /** What the probe concluded Broadside could send this host. Backend-written.
   * Null means never probed. Carried separately from `login_shell` because that
   * column is held to the shell alphabet, so a console menu stores as null and
   * would otherwise be indistinguishable from a probe that got no answer. */
  shell_capability: ShellCapability | null;
  /** The operator's standing override. Null means "auto", i.e. believe the
   * probe. The one shell field the host form writes. */
  shell_integration: ShellIntegrationPref | null;
  /** When the last attempt to reach this host failed (RFC3339), or null if the
   * last one worked or nobody has tried. Backend-written by every path that
   * connects, so the red Test button is the database's answer and not the
   * page's memory of this session. */
  connect_failed_at: string | null;
  /** How often a closed pane asks this host whether it is back, in seconds.
   * Null means the default, {@link DEFAULT_PROBE_INTERVAL_SECS};
   * {@link PROBE_INTERVAL_OFF} means don't ask, and don't draw the pill.
   * Form-written, through its own call like `shell_integration`. */
  probe_interval_secs: number | null;
};

/** How often a closed pane asks a host whether it is back, when the host has no
 * answer of its own. Kept in step with the Rust constant of the same name: the
 * pane needs it to work out how many probes fit in the two-minute window it
 * shows, and that sum has to agree with the interval actually being used. */
export const DEFAULT_PROBE_INTERVAL_SECS = 3;
export const MIN_PROBE_INTERVAL_SECS = 1;
export const MAX_PROBE_INTERVAL_SECS = 10;
/** Turned off for this host: no probing, and no pill on its closed panes. Zero
 * rather than another null because null already means "nobody has said", which
 * is not the same answer and must keep following the default if it moves. */
export const PROBE_INTERVAL_OFF = 0;

export type HostInput = {
  label: string;
  hostname: string;
  port: number;
  username: string;
  color: string;
  tag: string | null;
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

/** Saves the order after a drag on the Hosts table. Every list of hosts in
 * the application reads them in this order. */
export function reorderHosts(ids: number[]): Promise<void> {
  return invoke<void>("reorder_hosts", { ids });
}

export function deleteHost(id: number): Promise<void> {
  return invoke<void>("delete_host", { id });
}

/** The host's standing answer for shell integration (D-067). Its own call
 * rather than a field on {@link HostInput}, because the connect path owns the
 * other shell columns and an ordinary form save must not disturb them. */
export function setHostShellIntegration(
  id: number,
  pref: ShellIntegrationPref,
): Promise<Host> {
  return invoke<Host>("set_host_shell_integration", { id, pref });
}

/** How often a closed pane asks this host whether it is back, 1-10 seconds, or
 * null for the default. Its own call for the same reason as the shell
 * preference above: a CSV import has no column for it, so importing a host must
 * leave whatever is stored alone rather than write an answer it invented. */
export function setHostProbeInterval(
  id: number,
  secs: number | null,
): Promise<Host> {
  return invoke<Host>("set_host_probe_interval", { id, secs });
}

/** Is this host's SSH port accepting connections?
 *
 * What a pane sitting on a Reconnect button actually wants to know, and the
 * reason it is a TCP connect rather than a ping: a rebooting Linux box answers
 * ICMP tens of seconds before `sshd` binds, so a ping that has come back only
 * says the kernel is up. This goes true when Reconnect would work. */
export function probeHostReachable(id: number): Promise<boolean> {
  return invoke<boolean>("probe_host_reachable", { id });
}

/** Writes all hosts to a CSV or .xlsx file (chosen by the path extension,
 * import-compatible columns); returns the count. */
export function exportHosts(path: string): Promise<number> {
  return invoke<number>("export_hosts", { path });
}

/** Whether a local path points at an existing file. */
export function pathIsFile(path: string): Promise<boolean> {
  return invoke<boolean>("path_is_file", { path });
}

/** What reading a private key file turned up. `encrypted` means it needs a
 * passphrase and none was given; `wrong_passphrase` means the one given does
 * not open it. */
export type KeyCheck =
  | { status: "ok" }
  | { status: "encrypted" }
  | { status: "wrong_passphrase" }
  | { status: "unreadable"; message: string };

/** Reads a private key exactly the way a connect will, and reports what
 * happened instead of connecting. The passphrase decrypts a local file before
 * the SSH handshake begins, so no server can ever challenge for it: the form is
 * the only place it can be asked for, which is why it checks here rather than
 * leaving an encrypted key to fail on first use. */
export function checkPrivateKey(
  path: string,
  passphrase: string | null,
): Promise<KeyCheck> {
  return invoke<KeyCheck>("check_private_key", { path, passphrase });
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
