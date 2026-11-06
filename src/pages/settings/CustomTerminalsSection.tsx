import { useCallback, useEffect, useState } from "react";
import { FolderOpenIcon, Loader2Icon, PencilIcon, Trash2Icon } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionHeading } from "@/pages/settings/shared";
import { TerminalColorsBlock } from "@/pages/settings/TerminalColorsBlock";
import { IS_MAC } from "@/lib/platform";
import { errorMessage } from "@/lib/tauri/hosts";
import {
  createCustomTerminal,
  deleteCustomTerminal,
  listCustomTerminals,
  updateCustomTerminal,
  type CustomTerminal,
  type CustomTerminalInput,
  type TerminalFamily,
} from "@/lib/tauri/local";

/** What each family means for the operator, in the words the rest of the app
 * uses. `posix` covers Git Bash, MSYS2 and Cygwin on Windows, and every Unix
 * shell on a Mac. A Mac has no Command Prompt, so it offers no such family. */
const FAMILY_LABELS: Partial<Record<TerminalFamily, string>> = IS_MAC
  ? {
      posix: "Bash-like (zsh, bash, fish)",
      powershell: "PowerShell",
    }
  : {
      posix: "Bash-like (Git Bash, MSYS2, Cygwin)",
      powershell: "PowerShell",
      cmd: "Command Prompt",
    };

/** Where Git Bash usually lives, offered as the starting point for the most
 * common case so the operator rarely has to go hunting. */
const GIT_BASH_GUESS = "C:\\Program Files\\Git\\bin\\bash.exe";
/** Git Bash wants a login, interactive shell or it starts without a prompt. */
const GIT_BASH_ARGS = "--login -i";

/** The examples in the empty form. On a Mac there is no Git Bash to suggest;
 * the usual reason to add a shell there is one Homebrew installed. */
const EXAMPLE_PROGRAM = IS_MAC ? "/opt/homebrew/bin/fish" : GIT_BASH_GUESS;
const EXAMPLE_NAME = IS_MAC ? "fish" : "Git Bash";
const EXAMPLE_ARGS = IS_MAC ? "--login" : GIT_BASH_ARGS;

type Draft = {
  /** null while adding, the row id while editing. */
  id: number | null;
  label: string;
  exePath: string;
  /** Space-separated for editing; split on save. */
  args: string;
  family: TerminalFamily;
};

const EMPTY: Draft = {
  id: null,
  label: "",
  exePath: "",
  args: "",
  family: "posix",
};

/**
 * Settings -> Custom terminals. Terminal applications the operator wants in the
 * Terminals "+" launcher beside the shells Broadside detects on its own.
 *
 * Unlike the neighbouring launcher preferences, these live in the database, not
 * localStorage: a row names an executable the backend will spawn, so keeping it
 * server-side means the frontend only ever sends an id and an arbitrary program
 * path can never cross the IPC boundary. The backend validates the path (must
 * be a full path to an existing .exe on Windows, an executable file on a Mac)
 * at save time and rejects anything else.
 */
export function CustomTerminalsSection({ id }: { id: string }) {
  const [rows, setRows] = useState<CustomTerminal[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => {
    listCustomTerminals()
      .then(setRows)
      .catch((e) => toast.error(errorMessage(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(reload, [reload]);

  const browse = useCallback(async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        // A Mac program has no extension to filter on.
        filters: IS_MAC ? undefined : [{ name: "Programs", extensions: ["exe"] }],
      });
      if (typeof picked === "string") {
        setDraft((d) => (d ? { ...d, exePath: picked } : d));
      }
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    // Arguments are typed as one line but stored (and passed) as a list, so
    // nothing is ever handed to a shell to re-parse.
    const input: CustomTerminalInput = {
      label: draft.label,
      exe_path: draft.exePath,
      args: draft.args.split(/\s+/).filter(Boolean),
      family: draft.family,
    };
    try {
      if (draft.id === null) await createCustomTerminal(input);
      else await updateCustomTerminal(draft.id, input);
      setDraft(null);
      reload();
    } catch (e) {
      // The backend is the authority on whether a path is launchable, so its
      // message is the one worth showing.
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [draft, reload]);

  const remove = useCallback(
    async (row: CustomTerminal) => {
      try {
        await deleteCustomTerminal(row.id);
        toast.success(`Removed ${row.label}`);
        reload();
      } catch (e) {
        toast.error(errorMessage(e));
      }
    },
    [reload],
  );

  return (
    <section id={id} className="space-y-4">
      <SectionHeading
        title="Custom terminals"
        hint={`Add your own terminal application (${IS_MAC ? "fish, PowerShell, or any other shell" : "Git Bash, MSYS2, Cygwin"}) to the Terminals + launcher, alongside the shells Broadside detects, and choose the colour each kind of local tab wears.`}
      />

      <div className="max-w-2xl space-y-3">
        <p className="text-xs text-muted-foreground">
          Anything you add here appears in the Terminals <strong>+</strong> menu
          straight away, can be used by a saved shell profile, and can be
          broadcast to like any other local shell. The program must be a full
          path to{" "}
          {IS_MAC ? (
            "a program that exists and is marked executable."
          ) : (
            <>
              an <code>.exe</code> that exists.
            </>
          )}
        </p>

        <TerminalColorsBlock />

        {loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No custom terminals yet.
          </p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-md border border-border/60">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{r.label}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">
                    {r.exe_path}
                    {r.args.length > 0 && ` ${r.args.join(" ")}`}
                  </div>
                </div>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {r.family}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  aria-label={`Edit ${r.label}`}
                  onClick={() =>
                    setDraft({
                      id: r.id,
                      label: r.label,
                      exePath: r.exe_path,
                      args: r.args.join(" "),
                      family: r.family,
                    })
                  }
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-destructive"
                  aria-label={`Remove ${r.label}`}
                  onClick={() => remove(r)}
                >
                  <Trash2Icon className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {draft === null ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setDraft(EMPTY)}>
              Add a terminal
            </Button>
            {/* The overwhelmingly common case, pre-filled so it is one click
                plus a Save rather than remembering a path and two flags.
                Windows only: there is no Git Bash on a Mac. */}
            {!IS_MAC && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setDraft({
                    id: null,
                    label: "Git Bash",
                    exePath: GIT_BASH_GUESS,
                    args: GIT_BASH_ARGS,
                    family: "posix",
                  })
                }
              >
                Add Git Bash
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3 rounded-md border border-border/60 p-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">Name</Label>
              <Input
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                placeholder={EXAMPLE_NAME}
                className="text-sm"
              />
              <p className="text-[10px] text-muted-foreground">
                Shown in the launcher and used as the tab title.
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label className="text-xs">Program</Label>
              <div className="flex gap-2">
                <Input
                  value={draft.exePath}
                  onChange={(e) =>
                    setDraft({ ...draft, exePath: e.target.value })
                  }
                  placeholder={EXAMPLE_PROGRAM}
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono text-xs"
                />
                <Button size="sm" variant="outline" onClick={browse}>
                  <FolderOpenIcon className="h-3.5 w-3.5" />
                  Browse
                </Button>
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label className="text-xs">Arguments</Label>
              <Input
                value={draft.args}
                onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                placeholder={EXAMPLE_ARGS}
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs"
              />
              {/* Git Bash opens perfectly well without arguments: a program
                  started in a terminal tab already has a screen and a keyboard.
                  What --login buys is the Git for Windows profile. Say that,
                  because the older wording sent people hunting for a prompt
                  that was never missing. Help's Terminals section agrees. */}
              <p className="text-[10px] text-muted-foreground">
                Separated by spaces. Passed to the program directly, so there is
                no shell to quote for.{" "}
                {IS_MAC ? (
                  <>
                    A shell runs without them; <code>--login</code> (or{" "}
                    <code>-l</code>) is what loads your profile, and with it
                    the Homebrew tools on the path, as Broadside's own shells
                    do.
                  </>
                ) : (
                  <>
                    Git Bash runs without them; <code>{GIT_BASH_ARGS}</code> is
                    what loads the Git for Windows profile, with its coloured{" "}
                    <code>MINGW64</code> prompt and the Unix tools on the path.
                  </>
                )}
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label className="text-xs">Command language</Label>
              <select
                value={draft.family}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    family: e.target.value as TerminalFamily,
                  })
                }
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring"
              >
                {(Object.keys(FAMILY_LABELS) as TerminalFamily[]).map((f) => (
                  <option key={f} value={f}>
                    {FAMILY_LABELS[f]}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-muted-foreground">
                Picks the icon, and which PTY Broadcast tab this terminal joins
                so one command is always valid for everything it goes to.
              </p>
            </div>

            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={saving}>
                {saving && <Loader2Icon className="animate-spin" />}
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDraft(null)}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
