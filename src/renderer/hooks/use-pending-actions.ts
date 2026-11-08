import { useAppContext } from "@/context/app-context";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { useRef, useState } from "react";
import { he } from "@shared/locale";

export function usePendingActions() {
  const { setErrorMessage } = useAppContext();
  const [pendingActions, setPendingActions] = useState<ReadonlySet<string>>(new Set());
  const pendingActionsRef = useRef(new Set<string>());

  const runAction = async (key: string, action: () => Promise<unknown>, fallback = he.actionFailed) => {
    if (pendingActionsRef.current.has(key)) return false;
    pendingActionsRef.current.add(key);
    setPendingActions(new Set(pendingActionsRef.current));
    try {
      await action();
      return true;
    } catch (error) {
      setErrorMessage(getHebrewErrorMessage(error, fallback));
      return false;
    } finally {
      pendingActionsRef.current.delete(key);
      setPendingActions(new Set(pendingActionsRef.current));
    }
  };
  const switchBusy = (key: string) => ({ "aria-disabled": pendingActions.has(key), "aria-busy": pendingActions.has(key) });

  return { pendingActions, pendingActionsRef, runAction, switchBusy };
}
