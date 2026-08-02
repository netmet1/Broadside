/**
 * Which build this is, in smoke-test terms.
 *
 * The manifests (`package.json` / `Cargo.toml` / `tauri.conf.json`) carry the
 * release version and nothing else, because an installer version has to stay a
 * plain `x.y.z`. This is the other half: the smoke test the build was handed
 * over for, so a window on screen can be told apart from the copy the installer
 * put on the Start menu. `v1.3.0` alone cannot do that; `v1.3.0-build47-2` can.
 *
 * Set it to the smoke test number the build is for, with the follow-up suffix
 * if there is one (`"47"`, then `"47-2"`, `"47-3"`, ...). Set it to the empty
 * string for a real release, where the version alone is the whole truth.
 */
export const BUILD_TAG = "44-3";

/** The version as it should be shown to a human: the manifest version, plus the
 * build tag when this is a test build. Empty in, empty out, so a version that
 * has not been read yet doesn't paint a bare tag. */
export function withBuildTag(version: string): string {
  if (!version || !BUILD_TAG) return version;
  return `${version}-build${BUILD_TAG}`;
}
