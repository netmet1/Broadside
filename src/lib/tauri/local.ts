import { invoke } from "@tauri-apps/api/core";

/** A local shell available to launch as a terminal tab. `id` is `powershell`,
 * `pwsh`, `cmd`, or `wsl:<distro>`; `kind` drives the tab icon. */
export type LocalShell = {
  id: string;
  label: string;
  kind: string;
};

/** Lists the local shells on this machine (PowerShell / pwsh / Command Prompt /
 * installed WSL distros) for the New-local-shell launcher. */
export function listLocalShells(): Promise<LocalShell[]> {
  return invoke<LocalShell[]>("list_local_shells");
}

/** Opens a local shell over ConPTY. After this resolves, the session id flows
 * through the same ptyWrite/ptyResize/ptyClose + pty:data/pty:closed plumbing as
 * an SSH session. `cwd` starts the shell in a chosen directory (a saved
 * profile's working directory); omit it for the shell's default (home). Throws
 * on spawn failure. */
export function ptyOpenLocal(args: {
  sessionId: string;
  shellId: string;
  cwd?: string;
  cols: number;
  rows: number;
}): Promise<void> {
  return invoke<void>("pty_open_local", args);
}
