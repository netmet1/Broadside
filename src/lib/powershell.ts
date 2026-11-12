/**
 * Whether PowerShell is on this machine, for whether the app talks about it.
 *
 * Windows always has it (Windows PowerShell ships with every copy), so there
 * the answer is yes and nothing is ever asked: every Windows screen is exactly
 * what it was. A Mac has it only if PowerShell 7 (`pwsh`) was installed, and
 * most Macs have not, so a Mac without it leaves PowerShell out everywhere it
 * would otherwise show: the Shortcut commands scopes and the built-in
 * PowerShell shortcuts, the Terminal colours row, the PTY Broadcast tab and the
 * broadcast rail's family, the Custom terminals family, and the Help wording.
 *
 * Nothing is deleted. A PowerShell shortcut restored from a Windows backup is
 * only hidden, and shows again once `pwsh` is installed.
 *
 * The backend looks (see `powershell_installed`): at start, and again each
 * time Settings is shown or a custom terminal is saved, so installing it needs
 * no restart. Until an answer arrives the last one is used, kept in
 * localStorage like the other presentation prefs. A Mac that has never been
 * asked starts at no, which is what most Macs are, so PowerShell does not flash
 * up and vanish on a first run.
 */

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

import { IS_MAC } from "@/lib/platform";

const KEY = "powershell-installed";

function readLast(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let installed: boolean = IS_MAC ? readLast() : true;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The answer as it stands now, for code outside React (the help search). */
export function powershellInstalled(): boolean {
  return installed;
}

/** The answer, re-rendering when it changes. The third argument is for the
 * help PDF, which renders Help on a server and needs a snapshot there too. */
export function usePowershellInstalled(): boolean {
  return useSyncExternalStore(subscribe, powershellInstalled, powershellInstalled);
}

/** Ask the backend again. Never on Windows, where the answer cannot change. A
 * failed ask keeps the last answer. */
export async function refreshPowershell(): Promise<void> {
  if (!IS_MAC) return;
  let next: boolean;
  try {
    next = await invoke<boolean>("powershell_installed");
  } catch {
    return;
  }
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    // The answer still holds for this run.
  }
  if (next === installed) return;
  installed = next;
  for (const l of listeners) l();
}
