import { useEffect, useState } from "react";

import type { Page } from "@/components/AppShell";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PAGES } from "@/lib/pages";
import { loadStartPage, saveStartPage } from "@/lib/startPage";
import { useHint } from "@/lib/status";
import { startupTemplate, type Template } from "@/lib/tauri/templates";
import { SectionHeading } from "@/pages/settings/shared";

/**
 * Settings -> Startup: which tab Broadside opens on.
 *
 * Its own section, and the first, because nothing else on the page is about
 * what happens before anyone has touched the app, and it is the thing somebody
 * who opens Settings to "make it open on Terminals" is looking for.
 *
 * **A template set to open at startup takes this over.** Its launch lands on
 * Terminals whatever this says, so while one is set the choice is greyed, and
 * the hint and a note say which template holds it. The rule is the user's own:
 * greyed rather than hidden, with the reason on it.
 */
export function StartupSection({
  id,
  visible,
}: {
  id: string;
  /** Settings stays mounted, so this is the only way to hear that the page is
   * being looked at again. */
  visible: boolean;
}) {
  const hint = useHint();
  const [page, setPage] = useState<Page>(loadStartPage);
  // The template that holds startup, if any. Asked on mount and every time the
  // page is shown again: the setting lives in the Templates editor, nothing
  // announces a change to it, and this page stays mounted across the trip
  // there and back.
  const [holder, setHolder] = useState<Template | null>(null);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    startupTemplate()
      .then((t) => {
        if (alive) setHolder(t && t.startup !== "off" ? t : null);
      })
      .catch(() => {
        // Unknown is treated as free: a failed read must not lock a setting
        // behind a template that may not exist.
        if (alive) setHolder(null);
      });
    return () => {
      alive = false;
    };
  }, [visible]);

  const locked = holder !== null;

  return (
    <section id={id} className="space-y-4">
      <SectionHeading
        title="Startup"
        hint="Which tab Broadside shows when it starts."
      />
      <div className="grid max-w-md gap-1.5">
        <Label htmlFor="start-page">Open on</Label>
        <Select
          value={page}
          disabled={locked}
          onValueChange={(v) => {
            const next = v as Page;
            saveStartPage(next);
            setPage(next);
          }}
        >
          <SelectTrigger
            id="start-page"
            size="sm"
            className="w-56"
            {...hint(
              locked
                ? "A template already consumes this option, please disable its startup first."
                : "The tab Broadside opens on. Hosts unless you pick another.",
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGES.map((p) => (
              <SelectItem key={p.page} value={p.page}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {locked ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            “{holder.name}” is set to open at startup, so Broadside starts on
            Terminals. Set that template to Don&apos;t open at startup, in its
            editor on the Templates tab, to choose a tab here.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Applies the next time Broadside starts; no Save needed. Reset puts
            it back to Hosts.
          </p>
        )}
      </div>
    </section>
  );
}
