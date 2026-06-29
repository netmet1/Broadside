import { type Dispatch, type SetStateAction, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/tauri/hosts";
import {
  type AppSettings,
  type ShortcutCommand,
  type ShortcutScope,
  saveShortcuts,
} from "@/lib/tauri/settings";

/** Shortcut-command editor (D-054): add/edit/delete the one-click commands
 * shown in the Broadcast/Terminals dropdown. Form state is self-contained;
 * persistence reads/writes the shared app settings. */
export function useShortcuts(
  settings: AppSettings | null,
  setSettings: Dispatch<SetStateAction<AppSettings | null>>,
) {
  const [shortcutFormOpen, setShortcutFormOpen] = useState(false);
  const [shortcutCmd, setShortcutCmd] = useState("");
  const [shortcutLabel, setShortcutLabel] = useState("");
  const [shortcutScope, setShortcutScope] = useState<ShortcutScope>("ssh");
  const [editingShortcutId, setEditingShortcutId] = useState<string | null>(
    null,
  );
  const [shortcutSubmitAttempted, setShortcutSubmitAttempted] = useState(false);

  /** Wholesale-replace persistence for shortcuts (mirrors guard rules). */
  const persistShortcuts = async (shortcuts: ShortcutCommand[]) => {
    try {
      await saveShortcuts(shortcuts);
      setSettings((prev) =>
        prev ? { ...prev, user_shortcuts: shortcuts } : prev,
      );
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    }
  };

  const shortcutCmdMissing = shortcutCmd.trim().length === 0;

  const submitShortcut = async () => {
    if (!settings) return;
    if (shortcutCmdMissing) {
      setShortcutSubmitAttempted(true);
      toast.error("Command is required");
      return;
    }
    const cmd = shortcutCmd.trim();
    const label = shortcutLabel.trim() || null; // empty label = show the command
    const next = editingShortcutId
      ? settings.user_shortcuts.map((s) =>
          s.id === editingShortcutId
            ? { ...s, command: cmd, scope: shortcutScope, label }
            : s,
        )
      : [
          ...settings.user_shortcuts,
          {
            id: `shortcut-${crypto.randomUUID().slice(0, 8)}`,
            command: cmd,
            scope: shortcutScope,
            label,
          },
        ];
    if (await persistShortcuts(next)) {
      setShortcutCmd("");
      setShortcutLabel("");
      setShortcutScope("ssh");
      setEditingShortcutId(null);
      setShortcutSubmitAttempted(false);
      setShortcutFormOpen(false);
    }
  };

  const editShortcut = (s: ShortcutCommand) => {
    setEditingShortcutId(s.id);
    setShortcutCmd(s.command);
    setShortcutLabel(s.label ?? "");
    setShortcutScope(s.scope);
    setShortcutSubmitAttempted(false);
    setShortcutFormOpen(true);
  };

  const deleteShortcut = (id: string) => {
    if (!settings) return;
    persistShortcuts(settings.user_shortcuts.filter((s) => s.id !== id));
  };

  /** Close the add/edit form, discarding any in-progress input. */
  const cancelShortcutForm = () => {
    setShortcutFormOpen(false);
    setEditingShortcutId(null);
    setShortcutCmd("");
    setShortcutLabel("");
    setShortcutScope("ssh");
    setShortcutSubmitAttempted(false);
  };

  return {
    shortcutFormOpen,
    setShortcutFormOpen,
    shortcutCmd,
    setShortcutCmd,
    shortcutLabel,
    setShortcutLabel,
    shortcutScope,
    setShortcutScope,
    editingShortcutId,
    setEditingShortcutId,
    shortcutSubmitAttempted,
    setShortcutSubmitAttempted,
    shortcutCmdMissing,
    submitShortcut,
    editShortcut,
    deleteShortcut,
    cancelShortcutForm,
  };
}
