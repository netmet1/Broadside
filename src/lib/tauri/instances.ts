import { invoke } from "@tauri-apps/api/core";

/** How many other copies of Broadside were already running on this data folder
 * when this one started. A test build with its own data folder is not counted. */
export function otherInstanceCount(): Promise<number> {
  return invoke("other_instance_count");
}
