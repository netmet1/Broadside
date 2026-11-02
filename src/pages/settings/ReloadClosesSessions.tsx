import { useEffect, useState } from "react";

import { openSessionCount, type OpenSessions } from "@/lib/tauri/pty";

/** One sentence for a confirm dialog whose action ends in a reload (Restore
 * from backup, Reset everything): how many open terminals and SFTP connections
 * the reload will close, or nothing when none are open. The backend closes
 * them as the page reloads, since the new page cannot reach them; this is the
 * warning the quit guard gives for quitting.
 *
 * Counted when it mounts, which is when the dialog opens. Inline, because a
 * dialog description is a paragraph. */
export function ReloadClosesSessions() {
  const [open, setOpen] = useState<OpenSessions | null>(null);
  useEffect(() => {
    let live = true;
    openSessionCount()
      .then((n) => {
        if (live) setOpen(n);
      })
      .catch(() => {
        // No count, no sentence: the dialog still reads true without it.
      });
    return () => {
      live = false;
    };
  }, []);

  const what = open ? describeOpenSessions(open) : null;
  if (!what) return null;
  return (
    <strong className="text-foreground">
      The reload closes {what}, wherever they are in Broadside, and anything
      unsaved in those shells is lost.
    </strong>
  );
}

/** "2 open terminals and 1 SFTP connection", or null when nothing is open. */
function describeOpenSessions({ terminals, sftp }: OpenSessions): string | null {
  const parts: string[] = [];
  if (terminals > 0) {
    parts.push(terminals === 1 ? "1 open terminal" : `${terminals} open terminals`);
  }
  if (sftp > 0) {
    parts.push(sftp === 1 ? "1 SFTP connection" : `${sftp} SFTP connections`);
  }
  return parts.length ? parts.join(" and ") : null;
}
