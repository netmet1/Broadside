import { invoke } from "@tauri-apps/api/core";

import type { ShellCapability } from "@/lib/shells";

export type PresentedKey = {
  key_type: string;
  public_key: string;
  fingerprint_sha256: string;
};

export type ProbeResult =
  // `capability` is decided from the raw probe answer, before `login_shell` is
  // filtered to the shell alphabet, so a console menu reads as "unsupported"
  // here even though its name is dropped from the field beside it.
  | {
      status: "ok";
      latency_ms: number;
      login_shell: string | null;
      capability: ShellCapability;
    }
  | { status: "unknown_key"; key: PresentedKey }
  | {
      status: "key_mismatch";
      stored_fingerprint: string;
      presented: PresentedKey;
    }
  | { status: "auth_failed"; message: string }
  | { status: "unreachable"; message: string }
  | { status: "no_credentials" };

export function testConnection(hostId: number): Promise<ProbeResult> {
  return invoke<ProbeResult>("test_connection", { hostId });
}

export function trustHostKey(
  hostname: string,
  port: number,
  key: PresentedKey,
): Promise<void> {
  return invoke<void>("trust_host_key", {
    hostname,
    port,
    keyType: key.key_type,
    publicKey: key.public_key,
    fingerprintSha256: key.fingerprint_sha256,
  });
}

export function removeHostKey(hostname: string, port: number): Promise<number> {
  return invoke<number>("remove_host_key", { hostname, port });
}
