import { useEffect, useRef } from "react";

export type PageRecoveryReason = "focus" | "visible" | "online";

export function usePageRecovery(
  onRecover: (reason: PageRecoveryReason) => void | Promise<void>,
  options: { minIntervalMs?: number } = {},
) {
  const callbackRef = useRef(onRecover);
  const lastRunAtRef = useRef(0);
  const minIntervalMs = options.minIntervalMs ?? 1000;

  useEffect(() => {
    callbackRef.current = onRecover;
  }, [onRecover]);

  useEffect(() => {
    function recover(reason: PageRecoveryReason) {
      if (document.visibilityState !== "visible") return;
      if (!navigator.onLine) return;

      const now = Date.now();
      if (now - lastRunAtRef.current < minIntervalMs) return;
      lastRunAtRef.current = now;

      void callbackRef.current(reason);
    }

    function handleFocus() {
      recover("focus");
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") recover("visible");
    }

    function handleOnline() {
      recover("online");
    }

    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [minIntervalMs]);
}
