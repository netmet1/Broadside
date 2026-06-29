import { type ShortcutScope } from "@/lib/tauri/settings";

/** Human-readable scope names for the add/edit form and row tooltips. */
export const SCOPE_LABELS: Record<ShortcutScope, string> = {
  ssh: "SSH / WSL (Linux)",
  local: "Command Prompt / PowerShell",
  both: "Both (Linux and Windows)",
};

/** Stable DOM id for a settings section, used by the jump-to dropdown. */
export function sectionDomId(title: string): string {
  return "settings-sec-" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Section render order — also the jump-to dropdown list. */
export const SECTION_TITLES = [
  "Performance",
  "Network probe",
  "Destructive command guard",
  "Shortcut commands",
  "Appearance",
  "Backup & Restore",
  "Help",
  "Audit log",
  "Security",
  "Reset",
  "Danger Zone",
];

// The search filter and scroll position persist across tab switches (Settings
// unmounts on navigation) but NOT across restarts — sessionStorage clears when
// the app window closes. Matches the existing rail/sort persistence pattern.
export const SEARCH_STORAGE_KEY = "settings-search";
export const SECTION_SCROLL_KEY = "settings-scroll-section";
/** Sticky-header height to discount when finding the section nearest the top
 * (matches the sections' scroll-margin-top: 4rem in index.css). */
export const STICKY_OFFSET_PX = 64;
