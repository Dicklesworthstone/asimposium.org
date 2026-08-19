import { expect, test } from "bun:test";

import {
  claimEnrollmentRecoveryLock,
  clearEnrollmentAttempt,
  type EnrollmentAttemptFallback,
  type EnrollmentAttemptScope,
  type EnrollmentAttemptStorage,
  enrollmentAttemptsRemain,
  enrollmentRecoveryMarkersMayRemain,
  enrollmentAttemptKey as prepareEnrollmentAttemptKey,
  releaseEnrollmentRecoveryLock,
} from "../../app/console/idempotency.ts";
import {
  beginEnrollmentRecoveryReconciliation,
  enrollmentRecoveryFenceContent,
  enrollmentRecoveryFenceIsScrubbed,
  mountEnrollmentRecoveryFence,
  recordEnrollmentRecoveryOwner,
  settleEnrollmentRecoveryFailure,
} from "../../app/enrollment-recovery-sentinel.tsx";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);
const OWNER_A = "1".repeat(64);
const OWNER_B = "2".repeat(64);
const NOW = 1_786_000_000_000;
const RECOVERY_PAYLOAD = `v1.${"A".repeat(16)}.${"B".repeat(22)}`;

function enrollmentAttemptKey(
  scope: EnrollmentAttemptScope,
  fingerprint: string,
  serverNow: number,
  storage: EnrollmentAttemptStorage | null | undefined,
  fallback: EnrollmentAttemptFallback,
  createKey?: () => string,
  storageNamespace?: string,
) {
  return prepareEnrollmentAttemptKey(
    scope,
    fingerprint,
    RECOVERY_PAYLOAD,
    serverNow,
    storage,
    fallback,
    createKey,
    storageNamespace,
  );
}

test("an opaque server-keyed attempt identity survives a reconstructed request after reload", () => {
  const storage = new MemoryStorage();
  const first = enrollmentAttemptKey(
    "mint",
    FINGERPRINT_A,
    NOW,
    storage,
    new Map(),
    () => "console-first",
  );
  const afterReload = enrollmentAttemptKey(
    "mint",
    FINGERPRINT_A,
    NOW + 1,
    storage,
    new Map(),
    () => {
      throw new Error("reload minted a replacement key");
    },
  );

  expect(first).toEqual({
    key: "console-first",
    recoveryPayload: RECOVERY_PAYLOAD,
    keyReloadSafe: true,
  });
  expect(afterReload).toEqual(first);
  expect([...storage.values.values()].join("\n")).toContain(FINGERPRINT_A);
});

test("editing away and back preserves each fingerprint key, while success clears only one", () => {
  const storage = new MemoryStorage();
  const fallback: EnrollmentAttemptFallback = new Map();
  let sequence = 0;
  const createKey = () => `console-key-${++sequence}`;

  const a1 = enrollmentAttemptKey("decision", FINGERPRINT_A, NOW, storage, fallback, createKey);
  const b1 = enrollmentAttemptKey("decision", FINGERPRINT_B, NOW, storage, fallback, createKey);
  const a2 = enrollmentAttemptKey("decision", FINGERPRINT_A, NOW, storage, fallback, createKey);
  expect([a1.key, b1.key, a2.key]).toEqual(["console-key-1", "console-key-2", "console-key-1"]);

  expect(clearEnrollmentAttempt("decision", FINGERPRINT_A, storage, fallback)).toBe(true);
  const b2 = enrollmentAttemptKey("decision", FINGERPRINT_B, NOW, storage, new Map(), createKey);
  const a3 = enrollmentAttemptKey("decision", FINGERPRINT_A, NOW, storage, new Map(), createKey);
  expect(b2.key).toBe("console-key-2");
  expect(a3.key).toBe("console-key-3");
});

test("lifecycle recovery reuses only the exact command scope and key", () => {
  const storage = new MemoryStorage();
  const revoke = enrollmentAttemptKey(
    "credential-revoke",
    FINGERPRINT_A,
    NOW,
    storage,
    new Map(),
    () => "console-revoke",
    OWNER_A,
  );
  const replay = enrollmentAttemptKey(
    "credential-revoke",
    FINGERPRINT_A,
    NOW + 1,
    storage,
    new Map(),
    () => {
      throw new Error("exact lifecycle replay minted a replacement key");
    },
    OWNER_A,
  );
  const transition = enrollmentAttemptKey(
    "fellow-lifecycle",
    FINGERPRINT_A,
    NOW + 1,
    storage,
    new Map(),
    () => "console-transition",
    OWNER_A,
  );

  expect(replay).toEqual(revoke);
  expect(transition.key).toBe("console-transition");
  expect(transition.key).not.toBe(revoke.key);
  expect(
    clearEnrollmentAttempt("credential-revoke", FINGERPRINT_A, storage, new Map(), OWNER_A),
  ).toBe(true);
  expect(enrollmentAttemptsRemain("fellow-lifecycle", storage, new Map(), OWNER_A)).toBe(true);
});

test("an edit-back hit remains recoverable when the bounded cache is full", () => {
  const storage = new MemoryStorage();
  const fallback: EnrollmentAttemptFallback = new Map();
  const fingerprints = Array.from({ length: 9 }, (_, index) =>
    index.toString(16).padStart(64, "0"),
  );
  for (const [index, fingerprint] of fingerprints.slice(0, 8).entries()) {
    enrollmentAttemptKey("mint", fingerprint, NOW, storage, fallback, () => `console-${index}`);
  }
  enrollmentAttemptKey("mint", fingerprints[0] ?? "", NOW, storage, fallback);
  expect(() =>
    enrollmentAttemptKey(
      "mint",
      fingerprints[8] ?? "",
      NOW,
      storage,
      fallback,
      () => "console-new",
    ),
  ).toThrow("Eight enrollment attempts still have unresolved recovery markers");

  expect(
    enrollmentAttemptKey("mint", fingerprints[0] ?? "", NOW, storage, new Map(), () => {
      throw new Error("promoted entry was evicted");
    }).key,
  ).toBe("console-0");
});

test("new writes require durable tab storage while a trusted fallback can retry", () => {
  const storage = new MemoryStorage();
  const fallback: EnrollmentAttemptFallback = new Map();
  const first = enrollmentAttemptKey(
    "mint",
    FINGERPRINT_A,
    NOW,
    storage,
    fallback,
    () => "console-local",
  );
  const second = enrollmentAttemptKey("mint", FINGERPRINT_A, NOW + 1, undefined, fallback, () => {
    throw new Error("fallback minted a replacement key");
  });
  expect(second).toMatchObject({
    key: first.key,
    recoveryPayload: first.recoveryPayload,
  });
  expect(first.keyReloadSafe).toBe(true);
  expect(second.keyReloadSafe).toBe(false);

  const throwing: EnrollmentAttemptStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {
      throw new Error("disabled");
    },
  };
  expect(() =>
    enrollmentAttemptKey("mint", FINGERPRINT_B, NOW, throwing, new Map(), () => "console-volatile"),
  ).toThrow("No enrollment write was sent");
  expect(clearEnrollmentAttempt("mint", FINGERPRINT_B, throwing, new Map())).toBe(false);
});

test("browser storage access failure is never reported as empty or durably cleared", () => {
  let createCalls = 0;
  expect(() =>
    enrollmentAttemptKey("mint", FINGERPRINT_A, NOW, null, new Map(), () => {
      createCalls += 1;
      return "console-unsafe";
    }),
  ).toThrow("Browser storage is temporarily unavailable");
  expect(createCalls).toBe(0);
  expect(enrollmentAttemptsRemain("mint", null, new Map())).toBe(true);
  expect(clearEnrollmentAttempt("mint", FINGERPRINT_A, null, new Map())).toBe(false);
});

test("the root-layout sentinel sees every retained namespace and fails closed on unreadable storage", () => {
  const storage = new MemoryStorage();
  expect(enrollmentRecoveryMarkersMayRemain(storage)).toBe(false);
  enrollmentAttemptKey(
    "decision",
    FINGERPRINT_A,
    NOW,
    storage,
    new Map(),
    () => "console-sentinel",
    OWNER_A,
  );
  expect(enrollmentRecoveryMarkersMayRemain(storage)).toBe(true);
  expect(enrollmentRecoveryMarkersMayRemain(null)).toBe(true);
  const unreadable: Pick<Storage, "length" | "key" | "getItem"> = {
    get length(): number {
      throw new Error("storage disabled");
    },
    key: () => null,
    getItem: () => null,
  };
  expect(enrollmentRecoveryMarkersMayRemain(unreadable)).toBe(true);
});

test("a signed-out disabled surface stays visible without registering a recovery fence", () => {
  const unmount = mountEnrollmentRecoveryFence("signed-out", false);
  try {
    expect(enrollmentRecoveryFenceIsScrubbed(undefined, false)).toBe(false);
    expect(beginEnrollmentRecoveryReconciliation()).toBeUndefined();
  } finally {
    unmount();
  }
});

test("PLANTED: each recovery fence remains owner-scoped through failed, stale, signed-out, and same-owner reconciliations", () => {
  const unmountA1 = mountEnrollmentRecoveryFence("server-render-a1", true);
  let unmountA2: (() => void) | undefined;
  let unmountUnconfiguredA2: (() => void) | undefined;
  let unmountB: (() => void) | undefined;
  let unmountA3: (() => void) | undefined;
  try {
    expect(enrollmentRecoveryFenceIsScrubbed(OWNER_A, true)).toBe(false);
    const generationA1 = beginEnrollmentRecoveryReconciliation();
    if (generationA1 === undefined)
      throw new Error("mounted owner A1 did not start reconciliation");
    // A signal scrubs every fence, including a sponsor page whose recovery
    // configuration temporarily produced no owner.
    expect(enrollmentRecoveryFenceIsScrubbed(OWNER_A, true)).toBe(true);
    expect(enrollmentRecoveryFenceIsScrubbed(undefined, true)).toBe(true);
    const lateAResult = "https://a.asimposium.org/join/A#v1.secret";
    expect(
      enrollmentRecoveryFenceContent(enrollmentRecoveryFenceIsScrubbed(OWNER_A, true), lateAResult),
    ).not.toBe(lateAResult);

    // A queued stale A2 and an unconfigured owner-less A2 both remain hidden
    // before the independently derived owner result arrives.
    unmountA2 = mountEnrollmentRecoveryFence("server-render-a2", true);
    unmountUnconfiguredA2 = mountEnrollmentRecoveryFence("server-render-a2-unconfigured", true);
    expect(enrollmentRecoveryFenceIsScrubbed(OWNER_A, true)).toBe(true);
    expect(enrollmentRecoveryFenceIsScrubbed(undefined, true)).toBe(true);

    expect(recordEnrollmentRecoveryOwner(generationA1, "usr_not-an-opaque-recovery-owner")).toBe(
      false,
    );
    expect(recordEnrollmentRecoveryOwner(generationA1, OWNER_B)).toBe(true);
    // Confirmation for B is per owner: both mounted A fences and a later A
    // promise stay hidden, while B can render without router.refresh granting
    // any authority by itself.
    expect(enrollmentRecoveryFenceIsScrubbed(OWNER_A, true)).toBe(true);
    expect(enrollmentRecoveryFenceIsScrubbed(OWNER_B, true)).toBe(false);
    expect(enrollmentRecoveryFenceIsScrubbed(undefined, true)).toBe(true);
    expect(
      enrollmentRecoveryFenceContent(enrollmentRecoveryFenceIsScrubbed(OWNER_A, true), lateAResult),
    ).not.toBe(lateAResult);
    unmountB = mountEnrollmentRecoveryFence("server-render-b", true);
    expect(enrollmentRecoveryFenceIsScrubbed(OWNER_B, true)).toBe(false);
    unmountA3 = mountEnrollmentRecoveryFence("server-render-a3", true);
    expect(enrollmentRecoveryFenceIsScrubbed(OWNER_A, true)).toBe(true);
    const bSurface = "B recovery surface";
    expect(
      enrollmentRecoveryFenceContent(enrollmentRecoveryFenceIsScrubbed(OWNER_B, true), bSurface),
    ).toBe(bSurface);

    // Transport/configuration failure remains scrubbed, but opens generation 2
    // for a later signal. A late generation-1 confirmation cannot settle it.
    const failedGeneration = beginEnrollmentRecoveryReconciliation();
    if (failedGeneration === undefined)
      throw new Error("B did not start a retryable reconciliation");
    expect(enrollmentRecoveryFenceIsScrubbed(undefined, true)).toBe(true);
    expect(settleEnrollmentRecoveryFailure(failedGeneration)).toBe(true);
    expect(enrollmentRecoveryFenceIsScrubbed(OWNER_B, true)).toBe(true);
    expect(enrollmentRecoveryFenceIsScrubbed(undefined, true)).toBe(true);
    const retryGeneration = beginEnrollmentRecoveryReconciliation();
    if (retryGeneration === undefined) throw new Error("failed generation did not admit retry");
    expect(recordEnrollmentRecoveryOwner(failedGeneration, OWNER_B)).toBe(false);
    expect(enrollmentRecoveryFenceIsScrubbed(OWNER_B, true)).toBe(true);
    expect(recordEnrollmentRecoveryOwner(retryGeneration, OWNER_B)).toBe(true);
    expect(enrollmentRecoveryFenceIsScrubbed(OWNER_B, true)).toBe(false);
    expect(enrollmentRecoveryFenceIsScrubbed(OWNER_A, true)).toBe(true);

    // Signed-out confirmation is an explicit null state, never an undefined
    // owner match. A future B requires another current-generation confirmation.
    const signedOutGeneration = beginEnrollmentRecoveryReconciliation();
    if (signedOutGeneration === undefined)
      throw new Error("B did not start signed-out reconciliation");
    expect(recordEnrollmentRecoveryOwner(signedOutGeneration, null)).toBe(true);
    expect(enrollmentRecoveryFenceIsScrubbed(undefined, true)).toBe(true);
    expect(enrollmentRecoveryFenceIsScrubbed(OWNER_B, true)).toBe(true);
    const returnGeneration = beginEnrollmentRecoveryReconciliation();
    if (returnGeneration === undefined)
      throw new Error("signed-out confirmation did not admit B retry");
    expect(recordEnrollmentRecoveryOwner(returnGeneration, OWNER_B)).toBe(true);
    expect(enrollmentRecoveryFenceIsScrubbed(OWNER_B, true)).toBe(false);

    // The same owner is safe only after its own exact-generation confirmation.
    const sameOwnerGeneration = beginEnrollmentRecoveryReconciliation();
    if (sameOwnerGeneration === undefined)
      throw new Error("B did not start same-owner reconciliation");
    expect(recordEnrollmentRecoveryOwner(sameOwnerGeneration, OWNER_A)).toBe(true);
    expect(enrollmentRecoveryFenceIsScrubbed(OWNER_A, true)).toBe(false);
    expect(enrollmentRecoveryFenceIsScrubbed(OWNER_B, true)).toBe(true);
  } finally {
    unmountA3?.();
    unmountB?.();
    unmountUnconfiguredA2?.();
    unmountA2?.();
    unmountA1();
  }
});

test("malformed persistent recovery state fails closed without replacing any key", () => {
  const corruptValues = [
    "not json",
    JSON.stringify({ version: 3, attempts: [] }),
    JSON.stringify({
      version: 2,
      attempts: [
        {
          fingerprint: FINGERPRINT_A,
          key: "console-valid",
          recoveryPayload: RECOVERY_PAYLOAD,
          expiresAt: NOW + 1_000,
        },
        {
          fingerprint: "invalid",
          key: "console-invalid",
          recoveryPayload: RECOVERY_PAYLOAD,
          expiresAt: NOW + 1_000,
        },
      ],
    }),
    JSON.stringify({
      version: 2,
      attempts: [
        {
          fingerprint: FINGERPRINT_A,
          key: "console-one",
          recoveryPayload: RECOVERY_PAYLOAD,
          expiresAt: NOW + 1_000,
        },
        {
          fingerprint: FINGERPRINT_A,
          key: "console-two",
          recoveryPayload: RECOVERY_PAYLOAD,
          expiresAt: NOW + 1_000,
        },
      ],
    }),
  ];

  for (const raw of corruptValues) {
    const storage = new MemoryStorage();
    storage.values.set("asimposium.enrollment.mint-attempts.shared.v2", raw);
    let createCalls = 0;
    expect(() =>
      enrollmentAttemptKey("mint", FINGERPRINT_B, NOW, storage, new Map(), () => {
        createCalls += 1;
        return "console-replacement";
      }),
    ).toThrow("Browser storage is temporarily unavailable");
    expect(createCalls).toBe(0);
    expect(storage.values.get("asimposium.enrollment.mint-attempts.shared.v2")).toBe(raw);
    expect(enrollmentAttemptsRemain("mint", storage, new Map())).toBe(true);
  }
});

test("the component-local fallback refuses overflow without evicting unresolved attempts", () => {
  const storage = new MemoryStorage();
  const fallback: EnrollmentAttemptFallback = new Map();
  const fingerprints = Array.from({ length: 9 }, (_, index) =>
    (index + 1).toString(16).padStart(64, "0"),
  );
  for (const [index, fingerprint] of fingerprints.slice(0, 8).entries()) {
    enrollmentAttemptKey("mint", fingerprint, NOW, storage, fallback, () => `console-${index}`);
  }
  expect(() =>
    enrollmentAttemptKey(
      "mint",
      fingerprints[8] ?? "",
      NOW,
      undefined,
      fallback,
      () => "console-8",
    ),
  ).toThrow("Eight enrollment attempts still have unresolved recovery markers");
  expect(fallback.size).toBe(8);
  expect([...fallback.keys()].some((key) => key.endsWith(fingerprints[0] ?? ""))).toBe(true);
  expect(() => enrollmentAttemptKey("mint", "not-a-fingerprint", NOW, undefined, fallback)).toThrow(
    "enrollment attempt fingerprint is invalid",
  );
});

test("an elapsed recovery marker blocks replacement instead of risking a duplicate", () => {
  const storage = new MemoryStorage();
  const fallback: EnrollmentAttemptFallback = new Map();
  expect(
    enrollmentAttemptKey("mint", FINGERPRINT_A, NOW, storage, fallback, () => "console-old").key,
  ).toBe("console-old");

  expect(() =>
    enrollmentAttemptKey(
      "mint",
      FINGERPRINT_A,
      NOW + 24 * 60 * 60 * 1_000,
      storage,
      fallback,
      () => "console-new",
    ),
  ).toThrow("this tab will not mint a replacement");
  expect([...storage.values.values()].join("\n")).toContain("console-old");
});

test("a transient persistent read failure never erases unrelated recovery markers", () => {
  const storage = new MemoryStorage();
  const fallback: EnrollmentAttemptFallback = new Map();
  enrollmentAttemptKey("decision", FINGERPRINT_A, NOW, storage, fallback, () => "console-a");
  enrollmentAttemptKey("decision", FINGERPRINT_B, NOW, storage, fallback, () => "console-b");
  const persistedBefore = [...storage.values.values()].join("\n");
  let failNextRead = true;
  const oneShotFailure: EnrollmentAttemptStorage = {
    getItem: (key) => {
      if (failNextRead) {
        failNextRead = false;
        throw new Error("transient read failure");
      }
      return storage.getItem(key);
    },
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
  };

  expect(clearEnrollmentAttempt("decision", FINGERPRINT_A, oneShotFailure, fallback)).toBe(false);
  expect([...storage.values.values()].join("\n")).toBe(persistedBefore);
  expect(fallback.has(`decision:${FINGERPRINT_A}`)).toBe(true);

  expect(clearEnrollmentAttempt("decision", FINGERPRINT_A, oneShotFailure, fallback)).toBe(true);
  const persistedAfter = [...storage.values.values()].join("\n");
  expect(persistedAfter).not.toContain("console-a");
  expect(persistedAfter).toContain("console-b");
});

test("a transient persistent read failure cannot create or overwrite an unknown attempt", () => {
  const storage = new MemoryStorage();
  enrollmentAttemptKey("mint", FINGERPRINT_A, NOW, storage, new Map(), () => "console-existing");
  const persistedBefore = [...storage.values.values()].join("\n");
  let createCalls = 0;
  const readFailure: EnrollmentAttemptStorage = {
    getItem: () => {
      throw new Error("transient read failure");
    },
    setItem: () => {
      throw new Error("must not write after failed read");
    },
    removeItem: () => {
      throw new Error("must not remove after failed read");
    },
  };

  expect(() =>
    enrollmentAttemptKey("mint", FINGERPRINT_B, NOW, readFailure, new Map(), () => {
      createCalls += 1;
      return "console-new";
    }),
  ).toThrow("Browser storage is temporarily unavailable");
  expect(createCalls).toBe(0);
  expect([...storage.values.values()].join("\n")).toBe(persistedBefore);

  const fallback: EnrollmentAttemptFallback = new Map([
    [
      `mint:${FINGERPRINT_A}`,
      {
        key: "console-existing",
        recoveryPayload: RECOVERY_PAYLOAD,
        expiresAt: NOW + 10_000,
      },
    ],
  ]);
  expect(enrollmentAttemptKey("mint", FINGERPRINT_A, NOW + 1, readFailure, fallback)).toEqual({
    key: "console-existing",
    recoveryPayload: RECOVERY_PAYLOAD,
    keyReloadSafe: false,
  });
});

test("clearing one attempt keeps navigation guarded until every marker is resolved", () => {
  const storage = new MemoryStorage();
  const fallback: EnrollmentAttemptFallback = new Map();
  enrollmentAttemptKey("mint", FINGERPRINT_A, NOW, storage, fallback, () => "console-a");
  enrollmentAttemptKey("mint", FINGERPRINT_B, NOW, storage, fallback, () => "console-b");
  expect(enrollmentAttemptsRemain("mint", storage, fallback)).toBe(true);
  expect(clearEnrollmentAttempt("mint", FINGERPRINT_B, storage, fallback)).toBe(true);
  expect(enrollmentAttemptsRemain("mint", storage, fallback)).toBe(true);
  expect(clearEnrollmentAttempt("mint", FINGERPRINT_A, storage, fallback)).toBe(true);
  expect(enrollmentAttemptsRemain("mint", storage, fallback)).toBe(false);

  const uncertain: EnrollmentAttemptStorage = {
    getItem: () => {
      throw new Error("read uncertainty");
    },
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  expect(enrollmentAttemptsRemain("mint", uncertain, new Map())).toBe(true);
});

test("one sponsor cannot consume or clear another sponsor's recovery capacity", () => {
  const storage = new MemoryStorage();
  const ownerAFingerprints = Array.from({ length: 8 }, (_, index) =>
    (index + 10).toString(16).padStart(64, "0"),
  );
  for (const [index, fingerprint] of ownerAFingerprints.entries()) {
    enrollmentAttemptKey(
      "mint",
      fingerprint,
      NOW,
      storage,
      new Map(),
      () => `console-owner-a-${index}`,
      OWNER_A,
    );
  }

  expect(
    enrollmentAttemptKey(
      "mint",
      FINGERPRINT_B,
      NOW,
      storage,
      new Map(),
      () => "console-owner-b",
      OWNER_B,
    ).key,
  ).toBe("console-owner-b");
  expect(enrollmentAttemptsRemain("mint", storage, new Map(), OWNER_A)).toBe(true);
  expect(enrollmentAttemptsRemain("mint", storage, new Map(), OWNER_B)).toBe(true);
  expect(clearEnrollmentAttempt("mint", FINGERPRINT_B, storage, new Map(), OWNER_B)).toBe(true);
  expect(enrollmentAttemptsRemain("mint", storage, new Map(), OWNER_B)).toBe(false);
  expect(enrollmentAttemptsRemain("mint", storage, new Map(), OWNER_A)).toBe(true);
});

/**
 * The synchronous barrier behind the retained-decision recovery control.
 *
 * Deferred on purpose: both invocations happen before anything releases, which
 * is exactly the window `useTransition`'s `pending` leaves open — it is still
 * false until React re-renders, so a double click reaches the action twice and
 * issues the same sealed one-time recovery twice.
 *
 * This drives the same functions `cards.tsx` calls, on the same
 * `{ current: boolean }` shape a ref already is, so it is the shipped path
 * rather than a second spelling of it.
 */
test("two recovery invocations before release admit exactly one", () => {
  const cell = { current: false };
  let dispatched = 0;
  const invoke = () => {
    if (!claimEnrollmentRecoveryLock(cell)) return;
    dispatched += 1;
  };

  invoke();
  invoke();

  expect(dispatched).toBe(1);
  expect(cell.current).toBe(true);
});

test("releasing the recovery lock readmits a retry", () => {
  const cell = { current: false };

  // A refusal that leaves the marker retained has to stay retryable, so the
  // barrier must collapse concurrent invocations without making the control
  // single-use.
  expect(claimEnrollmentRecoveryLock(cell)).toBe(true);
  expect(claimEnrollmentRecoveryLock(cell)).toBe(false);

  releaseEnrollmentRecoveryLock(cell);
  expect(cell.current).toBe(false);
  expect(claimEnrollmentRecoveryLock(cell)).toBe(true);
  // Still one at a time after the retry is admitted.
  expect(claimEnrollmentRecoveryLock(cell)).toBe(false);
});

test("recovery locks are per-cell, so one retained decision cannot block another", () => {
  const first = { current: false };
  const second = { current: false };

  expect(claimEnrollmentRecoveryLock(first)).toBe(true);
  // No module-level state: a second retained attempt renders its own control
  // with its own ref and must still be recoverable while the first is in flight.
  expect(claimEnrollmentRecoveryLock(second)).toBe(true);
  expect(claimEnrollmentRecoveryLock(first)).toBe(false);
  expect(claimEnrollmentRecoveryLock(second)).toBe(false);
});
