/**
 * Which desktop this is, and the small set of things that differ because of it.
 *
 * Broadside is one frontend for two apps. The backend picks its platform at
 * compile time; this bundle is the same file in both installers, so it asks
 * once, at load, and everything that reads differently on a Mac (a shortcut,
 * the name of the credential store, where deleted files go) reads it from here.
 * Windows is the default when there is nothing to ask, which is the case in node
 * when the help PDF is rendered: that path sets its own platform (see
 * `src/pages/help/platform.tsx`).
 *
 * Nothing here changes what the app does on Windows. Every Windows value below
 * is the text and the key that was hard-coded before the Mac existed.
 */

export type Platform = "windows" | "macos";

/** WKWebView reports `Macintosh` in its user agent; WebView2 never does. */
export const PLATFORM: Platform =
  typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent)
    ? "macos"
    : "windows";

export const IS_MAC = PLATFORM === "macos";

/**
 * Whether the app's own shortcut modifier is held: Ctrl on Windows, ⌘ on a Mac.
 *
 * On a Mac it is ⌘ *without* Ctrl, because there Ctrl is the shell's: Ctrl+F is
 * readline's forward-char and Ctrl+C is an interrupt, as in every Mac terminal,
 * and the app only ever claims the ⌘ chords the shell never sees.
 */
export function isModKey(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey;
}

/**
 * The modifier that makes a drag or a right-click reach past a program with
 * mouse reporting on (tmux, vim with the mouse enabled). Shift on Windows, as
 * Windows Terminal does; ⌥ on a Mac, which is the only modifier xterm.js will
 * force a selection with there (`macOptionClickForcesSelection`).
 */
export function isBypassKey(e: { shiftKey: boolean; altKey: boolean }): boolean {
  return IS_MAC ? e.altKey : e.shiftKey;
}

/** The shortcut modifier's name on its own, for prose ("hold Ctrl and turn the
 * wheel"). */
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";

/** A key chord written once, `mod+shift+g`, or a different chord per platform
 * where the platforms disagree about which keys a job belongs on. */
export type KeySpec = string | { windows: string; macos: string };

/** The app's own shortcuts. Windows is exactly what it always was. The Mac
 * column follows the Mac's conventions where there is one: ⌘C / ⌘V to copy
 * and paste, ⌘⌥←/→ to change tabs (⌥←/→ is word-jump in a Mac shell), and
 * ⇧⌘↩ to maximize, since F11 is Show Desktop or the volume on a Mac keyboard
 * and ⌃⌘F is the system's own full screen. */
export const SHORTCUTS = {
  find: "mod+f",
  gridFullscreen: "mod+shift+g",
  focusControls: "mod+shift+t",
  copy: { windows: "ctrl+shift+c", macos: "cmd+c" },
  paste: { windows: "ctrl+shift+v", macos: "cmd+v" },
  maximize: { windows: "f11", macos: "cmd+shift+enter" },
  prevTab: { windows: "alt+left", macos: "cmd+alt+left" },
  nextTab: { windows: "alt+right", macos: "cmd+alt+right" },
} satisfies Record<string, KeySpec>;

const MAC_SYMBOL: Record<string, string> = {
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  cmd: "⌘",
};
// The order a Mac menu writes them in.
const MAC_ORDER = ["ctrl", "alt", "shift", "cmd"];

const MAC_KEY: Record<string, string> = {
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
  enter: "↩",
  esc: "⎋",
};

/** A shortcut as the platform writes it: `Ctrl+Shift+G` on Windows, `⌘⇧G` on a
 * Mac. `mod` is Ctrl or ⌘ as the platform has it; the other modifier names
 * are taken literally. */
export function keyLabel(spec: KeySpec, platform: Platform = PLATFORM): string {
  const chord = typeof spec === "string" ? spec : spec[platform];
  const parts = chord.split("+").map((p) =>
    p === "mod" ? (platform === "macos" ? "cmd" : "ctrl") : p,
  );
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (platform === "macos") {
    const ordered = MAC_ORDER.filter((m) => mods.includes(m));
    return ordered.map((m) => MAC_SYMBOL[m]).join("") + (MAC_KEY[key] ?? key.toUpperCase());
  }
  const word = (p: string) => (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1));
  return [...mods, key].map(word).join("+");
}

/** The handful of words that name a different thing on each platform. */
export const WORDS_BY_PLATFORM = {
  windows: {
    os: "Windows",
    credentialStore: "Windows Credential Manager",
    credentialStoreShort: "Credential Manager",
    trash: "Recycle Bin",
    thisComputer: "this PC",
    ThisComputer: "This PC",
    drives: "Drives",
    driveList: "drive list",
    keyFileExample: "C:\\Users\\you\\.ssh\\id_ed25519",
  },
  macos: {
    os: "macOS",
    credentialStore: "macOS Keychain",
    credentialStoreShort: "Keychain",
    trash: "Trash",
    thisComputer: "this Mac",
    ThisComputer: "This Mac",
    drives: "Volumes",
    driveList: "volume list",
    keyFileExample: "/Users/you/.ssh/id_ed25519",
  },
} as const;

export const WORDS = WORDS_BY_PLATFORM[PLATFORM];

/** The shell kind to draw for a local shell this machine does not have (a
 * template saved on the other platform, a removed distro): the family every
 * Windows box has, Command Prompt, or on a Mac the POSIX one its shells are. */
export const FALLBACK_SHELL_KIND = IS_MAC ? "posix" : "cmd";
