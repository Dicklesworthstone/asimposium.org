"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useLayoutEffect, useSyncExternalStore } from "react";

import { availableSessionStorage, enrollmentRecoveryMarkersMayRemain } from "./console/idempotency";

type RecoveryFenceListener = () => void;
type RecoveryOwnerReconcile = () => Promise<
  { readonly ok: true; readonly recoveryOwner: string | null } | { readonly ok: false }
>;
type RecoveryOwner = string | null;
type RecoveryFenceState =
  | { readonly phase: "boot" }
  | {
      readonly phase: "checking";
      readonly generation: number;
      readonly priorAllowedRecoveryOwner: RecoveryOwner | undefined;
    }
  | {
      readonly phase: "failed";
      readonly generation: number;
      readonly priorAllowedRecoveryOwner: RecoveryOwner | undefined;
    }
  | {
      readonly phase: "confirmed";
      readonly generation: number;
      readonly allowedRecoveryOwner: RecoveryOwner;
    };

const recoveryFenceListeners = new Set<RecoveryFenceListener>();
const activeRecoveryFenceTokens = new Map<string, number>();
let recoveryFenceGeneration = 0;
let activeRecoveryFence: RecoveryFenceState = { phase: "boot" };
let recoveryFenceRevision = 0;
const RECOVERY_OWNER = /^[a-f0-9]{64}$/;

function publishRecoveryFenceChange(): void {
  recoveryFenceRevision += 1;
  for (const listener of recoveryFenceListeners) listener();
}

function subscribeToRecoveryFence(listener: RecoveryFenceListener): () => void {
  recoveryFenceListeners.add(listener);
  return () => recoveryFenceListeners.delete(listener);
}

function recoveryFenceSnapshot(): number {
  return recoveryFenceRevision;
}

/**
 * Begin one owner reconciliation after a browser signal that may accompany a
 * host-only Auth.js session change. The synchronous state change is the
 * confidentiality boundary: the refresh is deliberately second and may fail.
 */
export function beginEnrollmentRecoveryReconciliation(): number | undefined {
  if (activeRecoveryFenceTokens.size === 0 || activeRecoveryFence.phase === "checking")
    return undefined;
  recoveryFenceGeneration += 1;
  const priorAllowedRecoveryOwner =
    activeRecoveryFence.phase === "confirmed"
      ? activeRecoveryFence.allowedRecoveryOwner
      : activeRecoveryFence.phase === "failed"
        ? activeRecoveryFence.priorAllowedRecoveryOwner
        : undefined;
  activeRecoveryFence = {
    phase: "checking",
    generation: recoveryFenceGeneration,
    priorAllowedRecoveryOwner,
  };
  publishRecoveryFenceChange();
  return recoveryFenceGeneration;
}

/**
 * Each mounted boundary decides independently. Once a post-signal action has
 * allowed B, a concurrent or delayed A boundary stays scrubbed rather than
 * inheriting a global "unblocked" state.
 */
export function enrollmentRecoveryFenceIsScrubbed(
  recoveryOwner: string | undefined,
  enabled: boolean,
): boolean {
  if (!enabled) return false;
  if (activeRecoveryFence.phase === "boot") return false;
  if (activeRecoveryFence.phase !== "confirmed") return true;
  if (activeRecoveryFence.allowedRecoveryOwner === null) return true;
  return activeRecoveryFence.allowedRecoveryOwner !== recoveryOwner;
}

/**
 * Accept one server-derived opaque owner only for the pending reconciliation.
 * A client-side render token is intentionally absent from this comparison: it
 * identifies an effect lifetime, never a principal or release authority.
 */
export function recordEnrollmentRecoveryOwner(generation: number, recoveryOwner: unknown): boolean {
  if (
    activeRecoveryFence.phase !== "checking" ||
    activeRecoveryFence.generation !== generation ||
    (recoveryOwner !== null &&
      (typeof recoveryOwner !== "string" || !RECOVERY_OWNER.test(recoveryOwner)))
  ) {
    return false;
  }
  activeRecoveryFence = {
    phase: "confirmed",
    generation,
    allowedRecoveryOwner: recoveryOwner,
  };
  publishRecoveryFenceChange();
  return true;
}

/** A failed current-generation action stays scrubbed but admits a later signal retry. */
export function settleEnrollmentRecoveryFailure(generation: number): boolean {
  if (activeRecoveryFence.phase !== "checking" || activeRecoveryFence.generation !== generation) {
    return false;
  }
  activeRecoveryFence = {
    phase: "failed",
    generation,
    priorAllowedRecoveryOwner: activeRecoveryFence.priorAllowedRecoveryOwner,
  };
  publishRecoveryFenceChange();
  return true;
}

/**
 * Register a mounted recovery boundary. Its render token only identifies the
 * effect lifetime; owner-specific visibility is decided separately above.
 */
export function mountEnrollmentRecoveryFence(renderToken: string, enabled: boolean): () => void {
  if (!enabled) return () => undefined;
  activeRecoveryFenceTokens.set(renderToken, (activeRecoveryFenceTokens.get(renderToken) ?? 0) + 1);
  return () => {
    const active = activeRecoveryFenceTokens.get(renderToken);
    if (active === undefined || active <= 1) activeRecoveryFenceTokens.delete(renderToken);
    else activeRecoveryFenceTokens.set(renderToken, active - 1);
  };
}

function useEnrollmentRecoveryFence(
  renderToken: string,
  recoveryOwner: string | undefined,
  enabled: boolean,
): boolean {
  useSyncExternalStore(subscribeToRecoveryFence, recoveryFenceSnapshot, () => 0);
  useLayoutEffect(() => mountEnrollmentRecoveryFence(renderToken, enabled), [enabled, renderToken]);
  return enrollmentRecoveryFenceIsScrubbed(recoveryOwner, enabled);
}

/**
 * A page-scoped client boundary for every enrollment surface. Its token is
 * generated by the server page on every RSC render; it contains no principal.
 */
export function EnrollmentRecoveryFence({
  children,
  enabled,
  recoveryOwner,
  renderToken,
}: {
  readonly children: ReactNode;
  readonly enabled: boolean;
  readonly recoveryOwner?: string;
  readonly renderToken: string;
}) {
  const scrubbed = useEnrollmentRecoveryFence(renderToken, recoveryOwner, enabled);
  return enrollmentRecoveryFenceContent(scrubbed, children);
}

/** Keep the component's secret-bearing child selection directly unit-testable without a DOM. */
export function enrollmentRecoveryFenceContent(scrubbed: boolean, children: ReactNode): ReactNode {
  if (scrubbed) {
    return (
      <div className="quiet" role="status" aria-live="polite">
        Sign-in state may have changed. Enrollment data and recovery controls are hidden while this
        page reconciles.
      </div>
    );
  }
  return children;
}

/**
 * The root layout survives Next.js client navigation, unlike an individual
 * mint or approval card. Keep one tab-wide unload guard here so moving between
 * `/console` and `/approve` cannot silently discard an unresolved one-time
 * Idempotency-Key. The handler reads current storage at unload time; no stale
 * component snapshot decides whether the warning is still needed.
 */
export function EnrollmentRecoverySentinel({
  reconcileEnrollmentRecoveryOwner,
}: {
  readonly reconcileEnrollmentRecoveryOwner: RecoveryOwnerReconcile;
}) {
  const router = useRouter();
  useEffect(() => {
    const warnIfRecoveryMayRemain = (event: BeforeUnloadEvent) => {
      if (!enrollmentRecoveryMarkersMayRemain(availableSessionStorage())) {
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    };
    const reconcileOwner = () => {
      const generation = beginEnrollmentRecoveryReconciliation();
      if (generation === undefined) return;
      void reconcileEnrollmentRecoveryOwner()
        .then((result) => {
          if (!result.ok) {
            settleEnrollmentRecoveryFailure(generation);
            return;
          }
          if (!recordEnrollmentRecoveryOwner(generation, result.recoveryOwner)) {
            settleEnrollmentRecoveryFailure(generation);
            return;
          }
          router.refresh();
        })
        .catch(() => {
          settleEnrollmentRecoveryFailure(generation);
        });
    };
    const reconcileWhenVisible = () => {
      if (document.visibilityState === "visible") reconcileOwner();
    };
    window.addEventListener("beforeunload", warnIfRecoveryMayRemain);
    window.addEventListener("focus", reconcileOwner);
    window.addEventListener("pageshow", reconcileOwner);
    window.addEventListener("storage", reconcileOwner);
    document.addEventListener("visibilitychange", reconcileWhenVisible);
    return () => {
      window.removeEventListener("beforeunload", warnIfRecoveryMayRemain);
      window.removeEventListener("focus", reconcileOwner);
      window.removeEventListener("pageshow", reconcileOwner);
      window.removeEventListener("storage", reconcileOwner);
      document.removeEventListener("visibilitychange", reconcileWhenVisible);
    };
  }, [reconcileEnrollmentRecoveryOwner, router]);

  return null;
}
