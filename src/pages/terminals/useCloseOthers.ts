/**
 * **Close others**: close every session except one, or every other session of
 * one kind.
 *
 * Only what the operator can see. A tab hidden by the View menu's Filter is
 * never closed by an action aimed at the tabs on screen: "others" means the
 * others in front of you, and a shell nobody is looking at is exactly the one
 * that would be lost without anyone noticing. Close all, which says "all", still
 * means all.
 *
 * One target closes at once, the same as pressing its x. Two or more ask first,
 * whatever "Ask before acting on more than" is set to: that setting is about
 * how big a batch is worth a question, and this is a different question. The
 * tab you right-clicked is the only one you pointed at, and everything else
 * this closes is off to the side of it, so even two is worth one look.
 */

import { useCallback, useMemo, useRef, useState } from "react";

import { kindOf } from "@/pages/terminals/sessionKinds";
import type { TermSession } from "@/pages/terminals/session";

export type CloseOthersRequest = {
  /** The session that stays. */
  keepId: string;
  /** Only sessions of this kind, or every kind when null. */
  kind: string | null;
};

export type CloseOthers = {
  /** Close the others now, or ask first when there are two or more. */
  request: (req: CloseOthersRequest) => void;
  /** The sessions waiting on the dialog's answer, read live: one that closed on
   * its own meanwhile is not counted, and not closed twice. Empty when nothing
   * is pending, which is also what keeps the dialog shut. */
  pending: TermSession[];
  confirm: () => void;
  cancel: () => void;
  /** For the dialog's `onCloseAutoFocus`: hands the keyboard to the kept tab
   * once the dialog has gone, rather than back to the menu that opened it. */
  onDialogClosed: (e: Event) => void;
};

export function useCloseOthers({
  sessions,
  visibleSessions,
  closeSession,
  activateDeliberately,
}: {
  /** Every session, for re-reading a pending batch at the moment it is answered. */
  sessions: readonly TermSession[];
  /** The sessions the filter leaves on screen: the only ones this may close. */
  visibleSessions: readonly TermSession[];
  closeSession: (id: string) => void;
  /** The kept tab ends up active and holding the keyboard. */
  activateDeliberately: (id: string) => void;
}): CloseOthers {
  const [held, setHeld] = useState<{ keepId: string; ids: Set<string> } | null>(
    null,
  );
  // Set when a confirmed batch has closed, read once as the dialog goes. A ref
  // because it only steers a focus handler and must not cost a render.
  const refocus = useRef<string | null>(null);

  const closeAndKeep = useCallback(
    (ids: Iterable<string>, keepId: string) => {
      for (const id of ids) closeSession(id);
      // App re-picks the active tab by index when the active one closes, which
      // can land anywhere. The tab this was asked from is the one being worked
      // in, so that is where the ring and the keyboard go.
      activateDeliberately(keepId);
    },
    [closeSession, activateDeliberately],
  );

  const request = useCallback(
    ({ keepId, kind }: CloseOthersRequest) => {
      const targets = visibleSessions.filter(
        (s) => s.id !== keepId && (kind === null || kindOf(s) === kind),
      );
      if (targets.length === 0) return;
      if (targets.length === 1) {
        closeAndKeep([targets[0]!.id], keepId);
        return;
      }
      setHeld({ keepId, ids: new Set(targets.map((s) => s.id)) });
    },
    [visibleSessions, closeAndKeep],
  );

  // Memoized so the dialog can hold on to the last non-empty list by identity
  // while it animates out, rather than reading "Close 0" on its way off screen.
  const pending = useMemo(
    () => (held ? sessions.filter((s) => held.ids.has(s.id)) : []),
    [held, sessions],
  );

  const confirm = useCallback(() => {
    if (!held) return;
    setHeld(null);
    for (const s of pending) closeSession(s.id);
    // Active now, so nothing is drawn with the ring on whichever tab App picked
    // by position; the keyboard follows once the dialog has gone.
    activateDeliberately(held.keepId);
    refocus.current = held.keepId;
  }, [held, pending, closeSession, activateDeliberately]);

  const cancel = useCallback(() => setHeld(null), []);

  const onDialogClosed = useCallback(
    (e: Event) => {
      const keepId = refocus.current;
      if (keepId === null) return;
      refocus.current = null;
      e.preventDefault();
      activateDeliberately(keepId);
    },
    [activateDeliberately],
  );

  return { request, pending, confirm, cancel, onDialogClosed };
}
