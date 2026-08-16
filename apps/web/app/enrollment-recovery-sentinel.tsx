"use client";

import { useEffect } from "react";

import {
  availableSessionStorage,
  enrollmentRecoveryMarkersMayRemain,
} from "./console/idempotency";

/**
 * The root layout survives Next.js client navigation, unlike an individual
 * mint or approval card. Keep one tab-wide unload guard here so moving between
 * `/console` and `/approve` cannot silently discard an unresolved one-time
 * Idempotency-Key. The handler reads current storage at unload time; no stale
 * component snapshot decides whether the warning is still needed.
 */
export function EnrollmentRecoverySentinel() {
  useEffect(() => {
    const warnIfRecoveryMayRemain = (event: BeforeUnloadEvent) => {
      if (!enrollmentRecoveryMarkersMayRemain(availableSessionStorage())) {
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnIfRecoveryMayRemain);
    return () =>
      window.removeEventListener("beforeunload", warnIfRecoveryMayRemain);
  }, []);

  return null;
}
