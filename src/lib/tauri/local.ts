import { invoke } from "@tauri-apps/api/core";

/** A local shell available to launch as a terminal tab. `id` is `powershell`,
 * `pwsh`, `cmd`, `wsl:<distro>`, or `custom:<id>` for a user-defined terminal
 * application; `kind` drives the tab icon and which PTY Broadcast family the
 * session belongs to. */
export type LocalShell = {
  id: string;
  label: string;
  kind: string;
};

/** Which shell language a custom terminal speaks. It picks the launcher icon
 * and, more importantly, the PTY Broadcast family the session joins: a session
 * belonging to no family would silently vanish from every broadcast panel. */
export type TerminalFamily = "posix" | "powershell" | "cmd";

/** A user-defined terminal application (Git Bash and the like). Stored in the
 * database, not localStorage: the row names an executable the backend will
 * spawn, and keeping it server-side means the frontend only ever sends an id,
 * so an arbitrary program path can never cross the IPC boundary. */
export type CustomTerminal = {
  id: number;
  label: string;
  exe_path: string;
  args: string[];
  family: TerminalFamily;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type CustomTerminalInput = {
  label: string;
  exe_path: string;
  args: string[];
  family: TerminalFamily;
};

/** The detected shells only (PowerShell / pwsh / Command Prompt / installed WSL
 * distros). Cached in the backend for the app's lifetime. */
function listDetectedShells(): Promise<LocalShell[]> {
  return invoke<LocalShell[]>("list_local_shells");
}

export function listCustomTerminals(): Promise<CustomTerminal[]> {
  return invoke<CustomTerminal[]>("list_custom_terminals");
}

export function createCustomTerminal(
  input: CustomTerminalInput,
): Promise<CustomTerminal> {
  return invoke<CustomTerminal>("create_custom_terminal", { input });
}

export function updateCustomTerminal(
  id: number,
  input: CustomTerminalInput,
): Promise<CustomTerminal> {
  return invoke<CustomTerminal>("update_custom_terminal", { id, input });
}

export function deleteCustomTerminal(id: number): Promise<number> {
  return invoke<number>("delete_custom_terminal", { id });
}

/** Turn a stored custom terminal into a launchable shell entry. */
export function customAsShell(t: CustomTerminal): LocalShell {
  return { id: `custom:${t.id}`, label: t.label, kind: t.family };
}

/** Everything the New-local-shell launcher can open: the detected shells plus
 * the operator's own terminal applications.
 *
 * The two come from different places on purpose. Detection spawns wsl.exe and
 * is cached for the app's lifetime; custom terminals are a cheap database read
 * done fresh every time, so one added in Settings shows up in the launcher
 * immediately with no cache to invalidate and no restart. */
export async function listLocalShells(): Promise<LocalShell[]> {
  const [detected, custom] = await Promise.all([
    listDetectedShells(),
    // A failure here must not cost you the shells that were detected.
    listCustomTerminals().catch(() => [] as CustomTerminal[]),
  ]);
  return [...detected, ...custom.map(customAsShell)];
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
