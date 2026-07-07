import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

/**
 * The app version, read once from `tauri.conf.json` (the value the installer
 * stamps and `@tauri-apps/api/app`'s `getVersion` returns) — e.g. "1.0.0".
 *
 * Single source of truth for every version label in the UI, so a release only
 * needs the manifest bumps (package.json / Cargo.toml / tauri.conf.json) and
 * the displayed version follows automatically — never hand-edited.
 *
 * `fallback` is shown until the async read resolves (default: empty, so a
 * transient "v" alone isn't painted).
 */
export function useAppVersion(fallback = ""): string {
  const [version, setVersion] = useState(fallback);
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(fallback));
  }, [fallback]);
  return version;
}
