const MAX_RETAINED_ATTEMPTS = 8;
const ATTEMPT_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type EnrollmentAttemptScope = "mint" | "decision";

export interface EnrollmentAttemptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredAttempt {
  readonly fingerprint: string;
  readonly key: string;
  readonly expiresAt: number;
}

export type EnrollmentAttemptFallback = Map<
  string,
  { readonly key: string; readonly expiresAt: number }
>;

interface StoredAttempts {
  readonly version: 1;
  readonly attempts: readonly StoredAttempt[];
}

function storageKey(scope: EnrollmentAttemptScope, namespace: string): string {
  if (namespace !== "shared" && !/^[a-f0-9]{64}$/.test(namespace)) {
    throw new Error("enrollment attempt storage namespace is invalid");
  }
  return `asimposium.enrollment.${scope}-attempts.${namespace}.v1`;
}

function retainFallback(
  fallback: EnrollmentAttemptFallback,
  identity: string,
  attempt: { readonly key: string; readonly expiresAt: number },
): void {
  fallback.delete(identity);
  fallback.set(identity, attempt);
}

function retainedIdentityCount(
  scope: EnrollmentAttemptScope,
  retained: readonly StoredAttempt[],
  fallback: EnrollmentAttemptFallback,
): number {
  const identities = new Set(retained.map((attempt) => attempt.fingerprint));
  const prefix = `${scope}:`;
  for (const identity of fallback.keys()) {
    if (identity.startsWith(prefix)) identities.add(identity.slice(prefix.length));
  }
  return identities.size;
}

function parsedAttempts(raw: string | null): readonly StoredAttempt[] {
  if (raw === null) return [];
  const parsed = JSON.parse(raw) as Partial<StoredAttempts>;
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.attempts) ||
    parsed.attempts.length > MAX_RETAINED_ATTEMPTS
  ) {
    throw new Error("enrollment recovery storage is invalid");
  }
  const attempts = parsed.attempts;
  const fingerprints = new Set<string>();
  for (const attempt of attempts) {
    if (
      typeof attempt !== "object" ||
      attempt === null ||
      typeof attempt.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(attempt.fingerprint) ||
      typeof attempt.key !== "string" ||
      !/^console-[A-Za-z0-9._-]{1,152}$/.test(attempt.key) ||
      typeof attempt.expiresAt !== "number" ||
      !Number.isSafeInteger(attempt.expiresAt) ||
      attempt.expiresAt <= 0 ||
      fingerprints.has(attempt.fingerprint)
    ) {
      throw new Error("enrollment recovery storage is invalid");
    }
    fingerprints.add(attempt.fingerprint);
  }
  return attempts as readonly StoredAttempt[];
}

type AttemptRead =
  | { readonly ok: true; readonly attempts: readonly StoredAttempt[] }
  | { readonly ok: false };

function readAttempts(
  scope: EnrollmentAttemptScope,
  storage: EnrollmentAttemptStorage | undefined,
  namespace: string,
): AttemptRead {
  if (storage === undefined) return { ok: true, attempts: [] };
  try {
    return {
      ok: true,
      attempts: parsedAttempts(storage.getItem(storageKey(scope, namespace))),
    };
  } catch {
    return { ok: false };
  }
}

function writeAttempts(
  scope: EnrollmentAttemptScope,
  attempts: readonly StoredAttempt[],
  storage: EnrollmentAttemptStorage | undefined,
  namespace: string,
): boolean {
  if (storage === undefined) return false;
  try {
    if (attempts.length === 0) storage.removeItem(storageKey(scope, namespace));
    else
      storage.setItem(
        storageKey(scope, namespace),
        JSON.stringify({ version: 1, attempts }),
      );
    return true;
  } catch {
    return false;
  }
}

export interface PreparedEnrollmentAttempt {
  readonly key: string;
  /** Only the opaque key survives reload; the caller must reconstruct the exact request body. */
  readonly keyReloadSafe: boolean;
}

export function enrollmentAttemptKey(
  scope: EnrollmentAttemptScope,
  fingerprint: string,
  serverNow: number,
  storage: EnrollmentAttemptStorage | undefined,
  fallback: EnrollmentAttemptFallback,
  createKey: () => string = () => `console-${crypto.randomUUID()}`,
  storageNamespace = "shared",
): PreparedEnrollmentAttempt {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error("enrollment attempt fingerprint is invalid");
  }
  if (!Number.isSafeInteger(serverNow) || serverNow <= 0) {
    throw new Error("enrollment attempt time is invalid");
  }
  const fallbackKey = `${scope}:${fingerprint}`;
  const read = readAttempts(scope, storage, storageNamespace);
  if (!read.ok) {
    const fallbackPrior = fallback.get(fallbackKey);
    if (fallbackPrior === undefined) {
      throw new Error(
        "Browser storage is temporarily unavailable. This tab will not create a new enrollment attempt until the existing recovery markers can be read safely.",
      );
    }
    if (fallbackPrior.expiresAt <= serverNow) {
      throw new Error(
        "The 24-hour recovery window for these exact settings has ended. To avoid a duplicate enrollment, this tab will not mint a replacement. Verify the earlier outcome; close this tab only if you intentionally want to start over.",
      );
    }
    return { key: fallbackPrior.key, keyReloadSafe: false };
  }
  const retained = read.attempts;
  const retainedPrior = retained.find((attempt) => attempt.fingerprint === fingerprint);
  const fallbackPrior = fallback.get(fallbackKey);
  const prior =
    retainedPrior === undefined
      ? fallbackPrior
      : { key: retainedPrior.key, expiresAt: retainedPrior.expiresAt };
  if (prior !== undefined) {
    if (prior.expiresAt <= serverNow) {
      throw new Error(
        "The 24-hour recovery window for these exact settings has ended. To avoid a duplicate enrollment, this tab will not mint a replacement. Verify the earlier outcome; close this tab only if you intentionally want to start over.",
      );
    }
    retainFallback(fallback, fallbackKey, prior);
    return { key: prior.key, keyReloadSafe: retainedPrior !== undefined };
  }
  if (retainedIdentityCount(scope, retained, fallback) >= MAX_RETAINED_ATTEMPTS) {
    throw new Error(
      "Eight enrollment attempts still have unresolved recovery markers in this tab. Verify and finish one of them, or close this tab only if you intentionally want to reset those safeguards.",
    );
  }
  const key = createKey();
  if (!/^console-[A-Za-z0-9._-]{1,152}$/.test(key)) {
    throw new Error("generated enrollment idempotency key is invalid");
  }
  // This is a conservative browser retry cutoff measured from the preflight,
  // not a claim about the Worker's later commit timestamp. At or after the
  // cutoff we refuse to mint a replacement key; silently rotating it could
  // duplicate a write whose original outcome was ambiguous.
  const expiresAt = serverNow + ATTEMPT_REPLAY_WINDOW_MS;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("enrollment attempt time is invalid");
  }
  retainFallback(fallback, fallbackKey, { key, expiresAt });
  const keyReloadSafe = writeAttempts(
    scope,
    [
      { fingerprint, key, expiresAt },
      ...retained.filter((attempt) => attempt.fingerprint !== fingerprint),
    ],
    storage,
    storageNamespace,
  );
  return { key, keyReloadSafe };
}

export function clearEnrollmentAttempt(
  scope: EnrollmentAttemptScope,
  fingerprint: string,
  storage: EnrollmentAttemptStorage | undefined,
  fallback: EnrollmentAttemptFallback,
  storageNamespace = "shared",
): boolean {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) return false;
  const fallbackKey = `${scope}:${fingerprint}`;
  if (storage === undefined) {
    fallback.delete(fallbackKey);
    return true;
  }
  const read = readAttempts(scope, storage, storageNamespace);
  if (!read.ok) return false;
  const written = writeAttempts(
    scope,
    read.attempts.filter((attempt) => attempt.fingerprint !== fingerprint),
    storage,
    storageNamespace,
  );
  if (written) fallback.delete(fallbackKey);
  return written;
}

/** Conservatively report whether this tab still owns any unresolved marker. */
export function enrollmentAttemptsRemain(
  scope: EnrollmentAttemptScope,
  storage: EnrollmentAttemptStorage | undefined,
  fallback: EnrollmentAttemptFallback,
  storageNamespace = "shared",
): boolean {
  const prefix = `${scope}:`;
  if ([...fallback.keys()].some((identity) => identity.startsWith(prefix))) return true;
  if (storage === undefined) return false;
  const read = readAttempts(scope, storage, storageNamespace);
  return !read.ok || read.attempts.length > 0;
}

export function availableSessionStorage(): EnrollmentAttemptStorage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
