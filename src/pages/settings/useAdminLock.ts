import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/tauri/hosts";
import {
  type AdminLockStatus,
  adminLockStatus,
  removeAdminLock,
  resetAdminPasscode,
  setAdminPasscode,
} from "@/lib/tauri/settings";

/** Opt-in admin lock (gates the sudo toggle, credential editing and Reset).
 * Owns all lock/passcode/recovery state and loads the current status on mount. */
export function useAdminLock() {
  const [lockStatus, setLockStatus] = useState<AdminLockStatus | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [passcodeFormOpen, setPasscodeFormOpen] = useState(false);
  const [pcNew, setPcNew] = useState("");
  const [pcConfirm, setPcConfirm] = useState("");
  const [pcSaving, setPcSaving] = useState(false);
  // The one-time recovery code, shown once after set/reset until acknowledged.
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  // Recover-with-recovery-code form.
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [recCode, setRecCode] = useState("");
  const [recNewPc, setRecNewPc] = useState("");

  // True when a lock is set but this session hasn't been unlocked yet — the
  // sensitive controls are disabled until the user unlocks.
  const adminLocked = !!lockStatus?.lock_set && !lockStatus.unlocked;

  const refreshLock = useCallback(async () => {
    try {
      setLockStatus(await adminLockStatus());
    } catch {
      // Non-fatal; the section just won't reflect the latest lock state.
    }
  }, []);

  useEffect(() => {
    refreshLock();
  }, [refreshLock]);

  const savePasscode = async () => {
    if (pcNew.length < 4) {
      toast.error("Passcode must be at least 4 characters");
      return;
    }
    if (pcNew !== pcConfirm) {
      toast.error("Passcodes don't match");
      return;
    }
    setPcSaving(true);
    try {
      const recovery = await setAdminPasscode(pcNew);
      setRecoveryCode(recovery);
      setPcNew("");
      setPcConfirm("");
      setPasscodeFormOpen(false);
      await refreshLock();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPcSaving(false);
    }
  };

  const submitRecover = async () => {
    if (recNewPc.length < 4) {
      toast.error("New passcode must be at least 4 characters");
      return;
    }
    try {
      const newRecovery = await resetAdminPasscode(recCode.trim(), recNewPc);
      if (newRecovery === null) {
        toast.error("Recovery code is incorrect");
        return;
      }
      setRecoveryCode(newRecovery);
      setRecCode("");
      setRecNewPc("");
      setRecoverOpen(false);
      await refreshLock();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const removeLock = async () => {
    try {
      await removeAdminLock();
      await refreshLock();
      toast.success("Admin lock removed");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return {
    lockStatus,
    adminLocked,
    refreshLock,
    unlockOpen,
    setUnlockOpen,
    passcodeFormOpen,
    setPasscodeFormOpen,
    pcNew,
    setPcNew,
    pcConfirm,
    setPcConfirm,
    pcSaving,
    savePasscode,
    recoveryCode,
    setRecoveryCode,
    recoverOpen,
    setRecoverOpen,
    recCode,
    setRecCode,
    recNewPc,
    setRecNewPc,
    submitRecover,
    removeLock,
  };
}
