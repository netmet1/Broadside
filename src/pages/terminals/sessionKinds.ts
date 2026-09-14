/**
 * What *kind* of session a tab is, for the two things on the Terminals tab that
 * act on a kind at a time: **Close others** and the View menu's **Filter**.
 *
 * A kind is as fine as the "+" launcher is, because that is the list an
 * operator already knows: PowerShell, PowerShell 7, Command Prompt, each WSL
 * distro and each custom terminal are kinds of their own. SSH is one kind
 * however many hosts are open, and so are serial consoles however many cables:
 * nobody wants "close the other COM3s". A profile tab counts as the shell it
 * runs, since a profile is a shell in a folder, not a different program.
 *
 * Pure, and kept out of the page so the ordering and the counting can be read
 * without a render path around them.
 */

import type { LocalShell } from "@/lib/tauri/local";
import type { TermSession } from "@/pages/terminals/session";

/** A kind that is open right now, with how many of it. */
export type KindCount = {
  kind: string;
  /** What the kind is called on its own, as the launcher names it. */
  label: string;
  /** How many sessions of it are in the list this was counted from. */
  count: number;
};

const SSH = "ssh";
const SERIAL = "serial";

/** The kind a session belongs to: `"ssh"`, `"serial"`, or its shell's id. */
export function kindOf(s: TermSession): string {
  if (s.type === "ssh") return SSH;
  if (s.shell.id.startsWith("serial:")) return SERIAL;
  return s.shell.id;
}

/** What a kind is called, taken from a session of that kind: the launcher's
 * own label for a shell, and one name for every host and every cable. */
function labelOf(s: TermSession): string {
  const kind = kindOf(s);
  if (kind === SSH) return "SSH";
  if (kind === SERIAL) return "Serial consoles";
  return s.type === "local" ? s.shell.label : kind;
}

/**
 * The kinds open in `sessions`, in the order they are offered.
 *
 * SSH first, because it is what most tabs are. Then the launcher's own order,
 * so the list reads the way the "+" menu does. Serial last, as it is in the
 * launcher. A kind the launcher does not list (a custom terminal deleted in
 * Settings while its tab is still open) goes at the end, in the order its first
 * tab was opened, rather than vanishing from the filter while its tab is there.
 */
export function kindsPresent(
  sessions: readonly TermSession[],
  shells: readonly LocalShell[],
): KindCount[] {
  const found = new Map<string, KindCount>();
  const bySeq = [...sessions].sort((a, b) => a.seq - b.seq);
  for (const s of bySeq) {
    const kind = kindOf(s);
    const entry = found.get(kind);
    if (entry) entry.count += 1;
    else found.set(kind, { kind, label: labelOf(s), count: 1 });
  }
  const order = new Map<string, number>();
  order.set(SSH, 0);
  shells.forEach((sh, i) => order.set(sh.id, i + 1));
  order.set(SERIAL, shells.length + 1);
  const unknownFrom = shells.length + 2;
  // Map iteration is insertion order, which is first-opened order, so a stable
  // sort leaves the unknown kinds exactly where they were found.
  return [...found.values()].sort(
    (a, b) =>
      (order.get(a.kind) ?? unknownFrom) - (order.get(b.kind) ?? unknownFrom),
  );
}

/**
 * The name a kind takes in "Close other ...": plural where English wants one
 * and the word allows it. "Close other Command Prompts" reads; "Close other
 * PowerShells" does not, and neither does a distro name with an s on the end,
 * so everything else keeps the launcher's label as it is.
 */
export function kindPlural(k: Pick<KindCount, "kind" | "label">): string {
  if (k.kind === "cmd") return "Command Prompts";
  if (k.kind === SERIAL) return "serial consoles";
  return k.label;
}

/** A count of one kind in running prose: "3 SSH sessions", "1 serial
 * console", "2 Command Prompt tabs". For the hints, where a bare label after a
 * number ("2 Serial consoles sessions") does not read. */
export function kindCountPhrase(
  k: Pick<KindCount, "kind" | "label">,
  n: number,
): string {
  if (k.kind === SSH) return `${n} SSH ${n === 1 ? "session" : "sessions"}`;
  if (k.kind === SERIAL) return `${n} serial ${n === 1 ? "console" : "consoles"}`;
  return `${n} ${k.label} ${n === 1 ? "tab" : "tabs"}`;
}

/** What "Close others" can offer for one tab. */
export type CloseOthersOptions = {
  /** Every other session in the list, whatever its kind. */
  total: number;
  /** One entry per kind among the others, each counting only the others. Empty
   * when the others are all one kind, because "Close other SSH (4)" beside
   * "Close others (4)" would be the same action twice. */
  perKind: KindCount[];
};

/**
 * The Close others entries for the session `keep`, counted against `present`
 * (the kinds of the sessions the operator can see, from {@link kindsPresent}).
 *
 * Taking the counts rather than the sessions keeps this cheap enough to ask
 * for every tab's menu on every render: it is one pass over the kinds, not one
 * over the sessions.
 */
export function closeOthersOptions(
  present: readonly KindCount[],
  keep: TermSession,
): CloseOthersOptions {
  const own = kindOf(keep);
  const others = present
    .map((k) => (k.kind === own ? { ...k, count: k.count - 1 } : k))
    .filter((k) => k.count > 0);
  const total = others.reduce((n, k) => n + k.count, 0);
  return { total, perKind: others.length >= 2 ? others : [] };
}
