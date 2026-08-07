import { invoke } from "@tauri-apps/api/core";

import type { LocalShell } from "@/lib/tauri/local";

/** A COM port present on this machine right now. */
export type SerialPort = {
  /** Always `COM<n>`. */
  name: string;
  /** What the OS knows the port to be: a USB adapter's product string, or the
   * driver's name for a built-in port. Empty when there is nothing to say. */
  description: string;
};

/** Line speeds offered in the launcher, slowest first. Not every speed a driver
 * will accept, just the ones anyone picks: the low end for old console ports,
 * the high end for USB adapters on modern boards. */
export const BAUD_RATES = [
  2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
] as const;

/** 9600 8N1 is what a console port on a router, switch or firewall is set to
 * unless someone changed it, which is the case this feature exists for. A
 * board that wants 115200 says so in its documentation and the choice is
 * remembered per port from then on. */
export const DEFAULT_BAUD = 9600;

/** The COM ports on this machine. Asked for fresh every time the launcher
 * opens: a serial adapter is a thing you unplug. */
export function listSerialPorts(): Promise<SerialPort[]> {
  return invoke<SerialPort[]>("list_serial_ports");
}

/** The launchable id for a port at a speed.
 *
 * A serial console is opened through `pty_open_local` with this as its shell
 * id, which is the same convention `wsl:<distro>` and `custom:<id>` already
 * use: the id names the target, the backend resolves and validates it. That is
 * what lets a serial session be an ordinary `LocalShell` everywhere else in the
 * app, so tabs, the grid, Reconnect, Find and the broadcast rails need to know
 * nothing about it. */
export function serialShellId(port: string, baud: number): string {
  return `serial:${port}@${baud}`;
}

/** A port and speed as a launchable shell. The label is what the tab is called,
 * so it carries the speed: two consoles open at different speeds are otherwise
 * indistinguishable, and the speed is exactly what you check when the output is
 * garbage. */
export function serialAsShell(port: SerialPort, baud: number): LocalShell {
  return {
    id: serialShellId(port.name, baud),
    label: `${port.name} @ ${baud}`,
    kind: "serial",
  };
}

/** Remembered line speeds, by port name. Deliberately localStorage rather than
 * the database: it is a per-machine convenience about hardware plugged into
 * this machine, and it should not travel in a backup to a different one. */
const BAUD_KEY = "serial-baud-by-port";

function readBauds(): Record<string, number> {
  try {
    const raw = localStorage.getItem(BAUD_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, number> = {};
    for (const [port, baud] of Object.entries(parsed as object)) {
      if (typeof baud === "number" && Number.isFinite(baud)) out[port] = baud;
    }
    return out;
  } catch {
    // Corrupt or unreadable: fall back to the default rather than throwing
    // inside a menu render.
    return {};
  }
}

/** The speed to offer for a port: the one it was last opened at, or 9600. */
export function loadBaud(port: string): number {
  return readBauds()[port] ?? DEFAULT_BAUD;
}

/** Remember the speed a port was last opened at, so the second time is one
 * click. */
export function saveBaud(port: string, baud: number): void {
  try {
    localStorage.setItem(
      BAUD_KEY,
      JSON.stringify({ ...readBauds(), [port]: baud }),
    );
  } catch {
    // A full or disabled store costs the convenience, never the connection.
  }
}
