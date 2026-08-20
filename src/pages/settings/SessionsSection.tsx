import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useHint } from "@/lib/status";
import {
  DEFAULT_IDLE_SECS,
  IDLE_SECS_MAX,
  IDLE_SECS_MIN,
  KEEPALIVE_SECS,
  SESSION_PREFS_EVENT,
  type SessionPrefs,
  loadSessionPrefs,
  saveIdleEnabled,
  saveIdleSecs,
  saveKeepalive,
} from "@/lib/sessionPrefs";
import { SectionHeading } from "@/pages/settings/shared";

/** Settings -> Sessions: how long an idle terminal is kept, and whether the
 * connection is kept warm. Both are localStorage prefs (per machine), written
 * the moment they change, and both take effect without a restart: the timeout
 * reaches panes that are already open, the keepalive reaches the next
 * connection. */
export function SessionsSection({ id }: { id: string }) {
  const hint = useHint();
  const [prefs, setPrefs] = useState<SessionPrefs>(loadSessionPrefs);

  // Another copy of these values is the terminals themselves, and a pane
  // reading a stale one would time out on a number the operator has already
  // changed. Same event the grid prefs use, and for the same reason: the
  // browser's own storage event never reaches the document that made the write.
  useEffect(() => {
    const read = () => setPrefs(loadSessionPrefs());
    window.addEventListener(SESSION_PREFS_EVENT, read);
    return () => window.removeEventListener(SESSION_PREFS_EVENT, read);
  }, []);

  const enabled = prefs.idleSecs !== null;

  return (
    <section id={id} className="space-y-4">
      <SectionHeading
        title="Sessions"
        hint="How long an idle terminal is kept open, and whether the connection is kept warm."
      />
      <div className="grid max-w-md gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="session-timeout">Session timeout</Label>
          <p className="text-xs text-muted-foreground">
            Close an SSH terminal that has been completely quiet for this long,
            in seconds. Quiet means nothing typed <em>and</em> nothing printed,
            so a command still producing output is never cut off. Local shells
            and serial consoles are left alone.
          </p>
          <div className="flex items-center gap-3 pt-0.5">
            <IdleField
              value={prefs.idleDraft}
              enabled={enabled}
              onCommit={saveIdleSecs}
            />
            <label
              className="flex cursor-pointer items-center gap-2 text-sm"
              {...hint(
                "Off means a terminal stays open until you close it. This is how Broadside ships.",
              )}
            >
              <input
                type="checkbox"
                className="accent-primary"
                checked={!enabled}
                onChange={(e) => saveIdleEnabled(!e.target.checked)}
              />
              Disabled
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Off by default, and worth leaving off unless you want it: sitting at
            a prompt for half an hour in the middle of a maintenance window is
            ordinary, and this closes the shell when it happens. A pane closed
            this way says so, keeps its scrollback, and offers Reconnect.
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label>Keep alive</Label>
          <label
            className="flex cursor-pointer items-center gap-2 text-sm"
            {...hint(
              `Send a small packet every ${KEEPALIVE_SECS} seconds so the connection is not dropped for being quiet`,
            )}
          >
            <input
              type="checkbox"
              className="accent-primary"
              checked={prefs.keepalive}
              onChange={(e) => saveKeepalive(e.target.checked)}
            />
            Keep SSH connections alive
          </label>
          <p className="text-xs text-muted-foreground">
            Sends a keepalive every {KEEPALIVE_SECS} seconds, so a firewall or
            router between you and the host does not quietly forget the
            connection while nothing is being typed. Without it, a session left
            sitting can be cut in the middle, and the way you find out is that a
            keystroke goes nowhere. On by default. It applies to connections
            opened from now on, not to terminals already open.
          </p>
        </div>
      </div>
    </section>
  );
}

/** The seconds box. Empty and greyed while the timeout is disabled, which is
 * what "disable empties the field" asked for, and it keeps the number you had
 * so switching it back on does not make you type it again. */
function IdleField({
  value,
  enabled,
  onCommit,
}: {
  value: number;
  enabled: boolean;
  onCommit: (secs: number) => void;
}) {
  const [text, setText] = useState(String(value));
  // Adjusted during render rather than in an effect, React's documented way of
  // resetting state derived from a prop, and the only one the compiler's
  // set-state-in-effect rule allows. Guarded on the previous *value*, so an
  // edit in the box is not fought by the render that follows it.
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    setText(String(value));
  }
  const parsed = Number.parseInt(text, 10);
  const invalid =
    !Number.isFinite(parsed) || parsed < IDLE_SECS_MIN || parsed > IDLE_SECS_MAX;

  return (
    <Input
      id="session-timeout"
      type="number"
      inputMode="numeric"
      min={IDLE_SECS_MIN}
      max={IDLE_SECS_MAX}
      className={`w-32 ${invalid && enabled ? "border-destructive" : ""}`}
      disabled={!enabled}
      value={enabled ? text : ""}
      placeholder={String(DEFAULT_IDLE_SECS)}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number.parseInt(e.target.value, 10);
        if (Number.isFinite(n) && n >= IDLE_SECS_MIN && n <= IDLE_SECS_MAX) {
          onCommit(n);
        }
      }}
    />
  );
}
