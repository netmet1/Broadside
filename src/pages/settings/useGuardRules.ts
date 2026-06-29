import { type Dispatch, type SetStateAction, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/tauri/hosts";
import {
  type AppSettings,
  type UserRule,
  saveGuardRules,
} from "@/lib/tauri/settings";

const splitList = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** Destructive-command guard rule form + persistence. The form state is
 * self-contained; persistence reads/writes the shared app settings, so the
 * page passes `settings`/`setSettings` in. */
export function useGuardRules(
  settings: AppSettings | null,
  setSettings: Dispatch<SetStateAction<AppSettings | null>>,
) {
  // Guard rule form
  const [formOpen, setFormOpen] = useState(false);
  const [ruleDesc, setRuleDesc] = useState("");
  const [ruleCommands, setRuleCommands] = useState("");
  const [ruleFlags, setRuleFlags] = useState("");
  const [rulePaths, setRulePaths] = useState("");
  const [ruleArgs, setRuleArgs] = useState("");
  const [ruleTip, setRuleTip] = useState("");
  // Drives the red outline on required fields after a failed submit.
  const [ruleSubmitAttempted, setRuleSubmitAttempted] = useState(false);
  // Backend rejection message shown inline in the form (keeps it open).
  const [ruleError, setRuleError] = useState<string | null>(null);

  // Help-tip modal (core + user rules)
  const [helpRule, setHelpRule] = useState<{
    title: string;
    tip: string;
  } | null>(null);

  /** Wholesale-replace persistence — the backend validates each rule.
   * Returns whether the save succeeded; the caller decides what to do with a
   * failure (the add-rule form keeps itself open so input isn't lost). */
  const persistRules = async (rules: UserRule[]): Promise<string | null> => {
    try {
      await saveGuardRules(rules);
      setSettings((prev) => (prev ? { ...prev, user_rules: rules } : prev));
      return null;
    } catch (e) {
      return errorMessage(e);
    }
  };

  const ruleDescMissing = ruleDesc.trim().length === 0;
  const ruleCommandTokens = splitList(ruleCommands);
  const ruleCommandsMissing = ruleCommandTokens.length === 0;
  // The backend rejects command names containing whitespace; catch it here so
  // the field can be highlighted instead of the save failing with a toast.
  const ruleCommandsHaveSpace = ruleCommandTokens.some((c) => /\s/.test(c));
  const ruleCommandsInvalid = ruleCommandsMissing || ruleCommandsHaveSpace;

  const addRule = async () => {
    if (!settings) return;
    // Invalid input keeps the form open with everything intact and the
    // offending field(s) highlighted — no reset, no disappearing form.
    if (ruleDescMissing || ruleCommandsInvalid) {
      setRuleSubmitAttempted(true);
      setRuleError(null);
      return;
    }
    const tip = ruleTip.trim();
    const rule: UserRule = {
      id: `user-${crypto.randomUUID().slice(0, 8)}`,
      description: ruleDesc.trim(),
      commands: ruleCommandTokens,
      required_flags: splitList(ruleFlags),
      path_patterns: splitList(rulePaths),
      arg_all_of: splitList(ruleArgs),
      help_tip: tip.length > 0 ? tip : null,
      enabled: true,
    };
    const err = await persistRules([...settings.user_rules, rule]);
    if (err) {
      // Backend rejected it — keep the form open so the user can fix it.
      setRuleError(err);
      setRuleSubmitAttempted(true);
      return;
    }
    setRuleDesc("");
    setRuleCommands("");
    setRuleFlags("");
    setRulePaths("");
    setRuleArgs("");
    setRuleTip("");
    setRuleSubmitAttempted(false);
    setRuleError(null);
    setFormOpen(false);
  };

  const toggleRule = async (id: string) => {
    if (!settings) return;
    const err = await persistRules(
      settings.user_rules.map((r) =>
        r.id === id ? { ...r, enabled: !r.enabled } : r,
      ),
    );
    if (err) toast.error(err);
  };

  const deleteRule = async (id: string) => {
    if (!settings) return;
    const err = await persistRules(
      settings.user_rules.filter((r) => r.id !== id),
    );
    if (err) toast.error(err);
  };

  return {
    formOpen,
    setFormOpen,
    ruleDesc,
    setRuleDesc,
    ruleCommands,
    setRuleCommands,
    ruleFlags,
    setRuleFlags,
    rulePaths,
    setRulePaths,
    ruleArgs,
    setRuleArgs,
    ruleTip,
    setRuleTip,
    ruleSubmitAttempted,
    setRuleSubmitAttempted,
    ruleError,
    setRuleError,
    helpRule,
    setHelpRule,
    ruleDescMissing,
    ruleCommandsMissing,
    ruleCommandsHaveSpace,
    ruleCommandsInvalid,
    addRule,
    toggleRule,
    deleteRule,
  };
}
