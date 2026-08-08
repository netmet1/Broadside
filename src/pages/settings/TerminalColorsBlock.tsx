import { useState } from "react";
import { RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LocalShellIcon } from "@/pages/terminals/LocalShellIcon";
import { PALETTE } from "@/lib/palette";
import {
  DEFAULT_SHELL_COLORS,
  loadShellColors,
  notifyShellColorsChanged,
  saveShellColors,
  SHELL_KIND_LABELS,
  SHELL_KINDS,
  type ShellKind,
} from "@/lib/terminalColors";

/**
 * Settings -> Custom terminals -> the tab colours block.
 *
 * A colour per *kind* of shell rather than per tab, which is the whole idea and
 * not a shortcut: a host's colour names a machine, and a local tab has no
 * machine to name, so the useful thing for it to say is which language you are
 * about to type in. Two PowerShell tabs being the same colour is not a defect,
 * they are the same thing. A saved profile overrides this, because a profile is
 * a purpose rather than a language; that picker lives in the profile dialog.
 *
 * Saved on click, not behind a Save button. Every other control in this section
 * writes to the database and has a form around it; this writes a UI preference
 * to localStorage, and a colour you cannot see the effect of until you press
 * Save is a colour you have to guess at. The Terminals page is listening (see
 * lib/useShellColors), so the tabs recolour as the swatch is clicked.
 */
export function TerminalColorsBlock() {
  const [colors, setColors] = useState(loadShellColors);

  const set = (kind: ShellKind, color: string | null) => {
    const next = { ...colors, [kind]: color };
    setColors(next);
    saveShellColors(next);
    notifyShellColorsChanged();
  };

  const isDefault = SHELL_KINDS.every(
    (k) => colors[k] === DEFAULT_SHELL_COLORS[k],
  );

  const resetAll = () => {
    setColors({ ...DEFAULT_SHELL_COLORS });
    saveShellColors({ ...DEFAULT_SHELL_COLORS });
    notifyShellColorsChanged();
  };

  return (
    <div className="space-y-3 rounded-md border border-border/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label className="text-xs">Tab colours</Label>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            The colour a local terminal tab and its grid tile wear, the way a
            saved host wears its own. One colour per kind of shell, so the tint
            says which language the tab speaks. A saved profile can override its
            shell&apos;s colour; that is set when you create the profile.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={isDefault}
          onClick={resetAll}
          className="shrink-0"
        >
          <RotateCcwIcon className="h-3.5 w-3.5" />
          Defaults
        </Button>
      </div>

      <ul className="space-y-2">
        {SHELL_KINDS.map((kind) => {
          const color = colors[kind];
          return (
            <li key={kind} className="flex flex-wrap items-center gap-1.5">
              <span className="flex w-56 min-w-0 shrink-0 items-center gap-2 text-xs">
                <LocalShellIcon
                  kind={kind}
                  className="h-3.5 w-3.5 shrink-0"
                  style={color ? { color } : undefined}
                />
                <span className="truncate">{SHELL_KIND_LABELS[kind]}</span>
              </span>
              {/* "None" first, because for serial it is the shipped answer and
                  for the rest it is the way back to a plain tab. */}
              <button
                type="button"
                onClick={() => set(kind, null)}
                aria-label={`No colour for ${SHELL_KIND_LABELS[kind]}`}
                title="No colour"
                className={`h-6 rounded-md border-2 px-2 text-[10px] ${
                  color === null ? "border-foreground" : "border-transparent"
                }`}
              >
                None
              </button>
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set(kind, c)}
                  aria-label={`${SHELL_KIND_LABELS[kind]}: pick colour ${c}`}
                  className={`h-6 w-6 rounded-md border-2 ${
                    color?.toLowerCase() === c.toLowerCase()
                      ? "border-foreground"
                      : "border-transparent"
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
              {/* The preview doubles as the native picker's button, as on the
                  Hosts form. The dark blues this ships with are not in the
                  palette above on purpose (that one is loud, and its reds and
                  greens already mean "host"), so this is how you get back to a
                  default you have clicked away from, and how you reach any
                  other colour. */}
              <span className="relative h-6 w-6 shrink-0">
                <span
                  className="block h-full w-full rounded-md border-2 border-dashed border-border"
                  style={color ? { backgroundColor: color } : undefined}
                  aria-hidden="true"
                />
                <input
                  type="color"
                  value={color ?? DEFAULT_SHELL_COLORS[kind] ?? "#3b82f6"}
                  onChange={(e) => set(kind, e.target.value)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  aria-label={`${SHELL_KIND_LABELS[kind]}: pick any colour`}
                  title="Pick any colour"
                />
              </span>
            </li>
          );
        })}
      </ul>

      <p className="text-[10px] text-muted-foreground">
        A custom terminal takes the colour of the command language it declares,
        so Git Bash and MSYS2 are both Bash-like and wear the same colour.
        Serial ships with no colour: a console cable is the one session that is
        a piece of hardware rather than a program, and leaving it plain is what
        makes the coloured tabs read as the shells.
      </p>
    </div>
  );
}
