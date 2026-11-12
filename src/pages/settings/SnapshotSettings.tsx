import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useHint } from "@/lib/status";
import {
  SESSION_PREFS_EVENT,
  SNAPSHOT_HOLD_MAX,
  SNAPSHOT_HOLD_MIN,
  saveSnapshotAutoConnect,
  saveSnapshotHoldOver,
  snapshotAutoConnect,
  snapshotHoldOver,
} from "@/lib/sessionPrefs";

/**
 * Settings > Sessions > Snapshots: whether opening a snapshot connects
 * everything at once, and past how many workspaces it waits instead.
 *
 * Turning the auto-connect on asks first. Turning it off never does, because
 * that is the safe direction.
 */
export function SnapshotSettings() {
  const hint = useHint();
  const [auto, setAuto] = useState(snapshotAutoConnect);
  const [over, setOver] = useState(snapshotHoldOver);
  const [text, setText] = useState(() => String(snapshotHoldOver()));
  const [asking, setAsking] = useState(false);

  // Reset defaults in this section writes these too.
  useEffect(() => {
    const read = () => {
      setAuto(snapshotAutoConnect());
      const n = snapshotHoldOver();
      setOver(n);
      setText(String(n));
    };
    window.addEventListener(SESSION_PREFS_EVENT, read);
    return () => window.removeEventListener(SESSION_PREFS_EVENT, read);
  }, []);

  const parsed = Number.parseInt(text, 10);
  const invalid =
    !Number.isFinite(parsed) || parsed < SNAPSHOT_HOLD_MIN || parsed > SNAPSHOT_HOLD_MAX;

  return (
    <div className="grid gap-1.5">
      <Label>Snapshots</Label>
      <div
        className="flex items-center gap-2 text-sm"
        {...hint(
          "How many workspaces a snapshot may have before its sessions wait for a Connect button",
        )}
      >
        <span className={auto ? "text-muted-foreground" : undefined}>
          Wait for Connect when a snapshot has more than
        </span>
        <Input
          type="number"
          inputMode="numeric"
          min={SNAPSHOT_HOLD_MIN}
          max={SNAPSHOT_HOLD_MAX}
          aria-label="Workspaces before a snapshot waits"
          className={`w-20 ${invalid && !auto ? "border-destructive" : ""}`}
          disabled={auto}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n >= SNAPSHOT_HOLD_MIN && n <= SNAPSHOT_HOLD_MAX) {
              setOver(n);
              saveSnapshotHoldOver(n);
            }
          }}
        />
        <span className={auto ? "text-muted-foreground" : undefined}>
          {over === 1 ? "workspace" : "workspaces"}
        </span>
      </div>
      <label
        className="flex cursor-pointer items-center gap-2 text-sm"
        {...hint(
          auto
            ? "On: every snapshot connects all its sessions as it opens. Untick to have big ones wait again"
            : "Off: a snapshot past the number above opens with a Connect button in each workspace. Turning this on asks first",
        )}
      >
        <input
          type="checkbox"
          className="accent-primary"
          checked={auto}
          onChange={(e) => {
            if (e.target.checked) {
              setAsking(true);
              return;
            }
            setAuto(false);
            saveSnapshotAutoConnect(false);
          }}
        />
        Connect every workspace as soon as a snapshot opens
      </label>
      <p className="text-xs text-muted-foreground">
        A snapshot with more workspaces than this opens with its sessions not
        connected, and each workspace shows a <strong>Connect</strong> button to
        press when you are ready. Between {SNAPSHOT_HOLD_MIN} and{" "}
        {SNAPSHOT_HOLD_MAX}; 2 by default. Ticking the box connects everything
        straight away, however many there are.
      </p>

      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Connect everything when a snapshot opens?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  A snapshot can hold many workspaces. With this on, opening one
                  starts every session in all of them at the same moment, before
                  you have looked at what it holds.
                </p>
                <p>
                  That many logins at once can lock accounts, trip rate limits or
                  set off intrusion alarms on the hosts, and every local shell
                  runs its startup command. On a shared or unattended machine it
                  means live sessions from the moment the snapshot opens.
                </p>
                <p>
                  Leave it off to press Connect in each workspace instead.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep asking</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setAuto(true);
                saveSnapshotAutoConnect(true);
              }}
            >
              Connect automatically
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
