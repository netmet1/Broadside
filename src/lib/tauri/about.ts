import { invoke } from "@tauri-apps/api/core";

/** Opens the donations page in the default browser. The address is the
 * backend's, so this can open that page and no other. */
export function openDonatePage(): Promise<void> {
  return invoke("open_donate_page");
}
