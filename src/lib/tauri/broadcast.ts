import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { PresentedKey } from "@/lib/tauri/ssh";

export type ExecResult =
  | {
      status: "completed";
      exit_code: number | null;
      stdout: string;
      stderr: string;
      duration_ms: number;
      timed_out: boolean;
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

export type HostExecReport = {
  run_id: string;
  host_id: number;
  label: string;
  color: string;
  result: ExecResult;
};

export type GuardHit = {
  rule_id: string;
  description: string;
};

export function checkDestructive(command: string): Promise<GuardHit[]> {
  return invoke<GuardHit[]>("check_destructive", { command });
}

export function broadcastCommand(args: {
  runId: string;
  hostIds: number[];
  command: string;
  timeoutSecs?: number;
  confirmed?: boolean;
}): Promise<HostExecReport[]> {
  return invoke<HostExecReport[]>("broadcast_command", {
    runId: args.runId,
    hostIds: args.hostIds,
    command: args.command,
    timeoutSecs: args.timeoutSecs ?? null,
    confirmed: args.confirmed ?? null,
  });
}

/** Per-host completion events for a broadcast run (D-003 first-done-first). */
export function onBroadcastResult(
  handler: (report: HostExecReport) => void,
): Promise<UnlistenFn> {
  return listen<HostExecReport>("broadcast:result", (event) =>
    handler(event.payload),
  );
}
