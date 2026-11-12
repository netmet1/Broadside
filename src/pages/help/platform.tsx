/**
 * Help that is right on either platform.
 *
 * The Help tab speaks to the machine it is running on: a Mac reader is told
 * about the Keychain and ⌘C, a Windows reader about Credential Manager and
 * Ctrl+Shift+C, and neither has to read past the other's. The help PDF is one
 * document that ships with both apps, so it is printed in a third mode that
 * says both, the Windows wording first (it is the original) and the Mac's after
 * it, marked as such.
 *
 * The mode is read when a component renders, not when this file loads. Section
 * bodies are element trees built at module load (see content.tsx), and the PDF
 * build sets its mode only after importing them; anything that decided its text
 * at load time would be stuck with whatever the default was then. So every
 * difference goes through one of the components here, and nothing in Help
 * computes a platform string up front.
 *
 * Each component also tells the help filter which of its words are on screen
 * (`searchNode`, read by ./searchText), so a Mac reader searching for
 * "Keychain" finds the paragraph that says it, and one searching for
 * "PowerShell" is not sent to a sentence that is not there.
 */

/* eslint-disable react-refresh/only-export-components */
// A mode setter beside the components that read it; nothing here is edited
// with fast refresh in mind.

import { type ReactNode } from "react";

import { type KeySpec, keyLabel, PLATFORM, type Platform } from "@/lib/platform";
import { powershellInstalled, usePowershellInstalled } from "@/lib/powershell";

export type HelpMode = Platform | "both";

let mode: HelpMode = PLATFORM;

/** Which platform Help speaks to. The PDF build sets `both`; the app never
 * calls this and gets the platform it is running on. */
export function setHelpPlatform(next: HelpMode): void {
  mode = next;
}

export function helpMode(): HelpMode {
  return mode;
}

type PlatProps = {
  win: ReactNode;
  mac: ReactNode;
  /** What the PDF says instead, where "X (on a Mac, Y)" would not read:
   * "Broadside is a desktop app for Windows and macOS". */
  both?: ReactNode;
};

/** A phrase that differs: one or the other, or in the PDF the Windows phrase
 * with the Mac's after it in brackets (or `both`, when given). For inline text;
 * see {@link OnWindows} and {@link OnMac} for whole sentences. */
export function Plat({ win, mac, both }: PlatProps) {
  if (mode === "windows") return <>{win}</>;
  if (mode === "macos") return <>{mac}</>;
  if (both !== undefined) return <>{both}</>;
  return (
    <>
      {win}{" "}
      <span data-h="plat">(on a Mac, {mac})</span>
    </>
  );
}

Plat.searchNode = (props: Record<string, unknown>): ReactNode => {
  const { win, mac, both } = props as PlatProps;
  if (mode === "windows") return win;
  if (mode === "macos") return mac;
  return both ?? [win, mac];
};

type BlockProps = { children: ReactNode };

/** Content for one platform only: a sentence, a whole bullet's worth, or a
 * run of paragraphs. In the PDF it is kept, led by a small label saying which
 * platform it is about. The label is inline so the same component works inside
 * a bullet (`<li><OnWindows>…</OnWindows><OnMac>…</OnMac></li>` reads as one
 * bullet with two halves) as well as between paragraphs. */
function onlyOn(platform: Platform, label: string) {
  function Block({ children }: BlockProps) {
    if (mode === "both") {
      // The spaces either side keep an inline half from running into the
      // sentence before it; between blocks they collapse to nothing.
      return (
        <>
          {" "}
          <span data-h="plat-label" className="font-semibold">
            {label}:
          </span>{" "}
          {children}{" "}
        </>
      );
    }
    return mode === platform ? <>{children}</> : null;
  }
  Block.searchNode = (props: Record<string, unknown>): ReactNode =>
    mode === "both" || mode === platform ? (props as BlockProps).children : null;
  return Block;
}

export const OnWindows = onlyOn("windows", "On Windows");
export const OnMac = onlyOn("macos", "On a Mac");

/** A key or chord (see `SHORTCUTS` in lib/platform), as the platform writes
 * it. In the PDF, both: `Ctrl+Shift+C (on a Mac, ⌘C)`. */
export function Keys({ k }: { k: KeySpec }) {
  if (mode !== "both") return <>{keyLabel(k, mode)}</>;
  const win = keyLabel(k, "windows");
  const mac = keyLabel(k, "macos");
  if (win === mac) return <>{win}</>;
  return (
    <>
      {win} <span data-h="plat">(on a Mac, {mac})</span>
    </>
  );
}

Keys.searchNode = (props: Record<string, unknown>): ReactNode => {
  const { k } = props as { k: KeySpec };
  if (mode !== "both") return keyLabel(k, mode);
  return `${keyLabel(k, "windows")} ${keyLabel(k, "macos")}`;
};

type IfPowershellProps = { children: ReactNode; without?: ReactNode };

function powershellHere(): boolean {
  return mode !== "macos" || powershellInstalled();
}

/** Words about PowerShell, for a Mac that may not have it (see
 * lib/powershell): `children` where PowerShell is on the machine, `without`
 * (or nothing) on a Mac where it is not. Windows always has it, and the PDF,
 * which speaks to every machine, always says it, so both read exactly as they
 * did before this existed. Use it inside a `Plat`'s `mac` or an `OnMac`. */
export function IfPowershell({ children, without }: IfPowershellProps) {
  // Subscribed so the Help tab follows an install without a restart; the mode
  // check comes after, so the hook is called on every render.
  const installed = usePowershellInstalled();
  return <>{mode !== "macos" || installed ? children : without}</>;
}

IfPowershell.searchNode = (props: Record<string, unknown>): ReactNode => {
  const { children, without } = props as IfPowershellProps;
  return powershellHere() ? children : without;
};
