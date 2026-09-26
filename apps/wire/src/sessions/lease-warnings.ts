import type { D1Database } from "@cloudflare/workers-types";

/** How long before a lease lapses its holder is warned (Fable §7.5, bead
 * asimposiumorg-1e7). Long enough to hand back or release; short enough that
 * a two-hour lease is not announced at birth. */
export const LEASE_WARNING_WINDOW_MS = 15 * 60_000;
export const LEASE_WARNING_SWEEP_LIMIT = 64;

export interface LeaseWarningSweepResult {
  readonly warned: number;
  readonly hasMore: boolean;
}

interface ExpiringLease {
  lease_id: string;
  leased_until: string;
}

// One private notice per lease term. The id binds the lease and its deadline,
// so overlapping sweeps and replays cannot duplicate it, and a renewed lease
// is warned again. Every effect rechecks the lease is still held and still
// inside the window, so a release between selection and insert wins.
export const LEASE_WARNING_NOTICE_SQL = `
  INSERT INTO fellow_inbox_notices (
    id, fellow_id, problem_id, notice_type, seq, title, detail,
    impact_kind, caused_by_event_id, target_id, acknowledged_at, expires_at, created_at
  )
  SELECT 'N-lease-expiry-' || l.lease_id || '-' || l.leased_until, l.fellow_id, l.problem_id,
    'lease_expiry_warning',
    (SELECT CASE WHEN COALESCE(MAX(n.seq), 0) < 9007199254740991
      THEN COALESCE(MAX(n.seq), 0) + 1 ELSE NULL END
     FROM fellow_inbox_notices n WHERE n.fellow_id = l.fellow_id),
    'Lease on ' || l.object_ref || ' expires soon',
    'Your lease ends at ' || l.leased_until || '. Release it if the work is done or abandoned; an expired lease is coordination state, not lost work.',
    NULL, NULL, l.lease_id, NULL,
    CAST(unixepoch(l.leased_until, 'subsec') * 1000 AS INTEGER), ?
  FROM leases l
  JOIN enrollment_fellows f ON f.fellow_id = l.fellow_id AND f.status = 'active'
  JOIN problems p ON p.id = l.problem_id AND p.status <> 'private-draft'
  WHERE l.lease_id = ? AND l.leased_until = ?
    AND l.status IN ('active', 'challenged')
    AND l.leased_until > ? AND l.leased_until <= ?
  ON CONFLICT (id) DO NOTHING`;

/** One bounded pass over leases entering the warning window. The next
 * scheduled tick drains any remainder. No public event or cursor moves. */
export async function warnExpiringLeases(
  db: D1Database,
  options: { readonly now?: number; readonly limit?: number } = {},
): Promise<LeaseWarningSweepResult> {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? LEASE_WARNING_SWEEP_LIMIT;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > 8_640_000_000_000_000 - LEASE_WARNING_WINDOW_MS ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > LEASE_WARNING_SWEEP_LIMIT
  ) {
    throw new TypeError("Invalid lease warning sweep bounds.");
  }
  const from = new Date(now).toISOString();
  const until = new Date(now + LEASE_WARNING_WINDOW_MS).toISOString();
  const selected = await db
    .prepare(`SELECT l.lease_id, l.leased_until FROM leases l
      WHERE l.status IN ('active', 'challenged')
        AND l.leased_until > ? AND l.leased_until <= ?
        AND NOT EXISTS (SELECT 1 FROM fellow_inbox_notices n
          WHERE n.id = 'N-lease-expiry-' || l.lease_id || '-' || l.leased_until)
      ORDER BY l.leased_until, l.lease_id LIMIT ?`)
    .bind(from, until, limit + 1)
    .all<ExpiringLease>();
  const leases = selected.results.slice(0, limit);
  if (leases.length === 0) return { warned: 0, hasMore: false };
  const results = await db.batch(
    leases.map((lease) =>
      db
        .prepare(LEASE_WARNING_NOTICE_SQL)
        .bind(now, lease.lease_id, lease.leased_until, from, until),
    ),
  );
  return {
    warned: results.reduce((total, result) => total + (result.meta.changes ?? 0), 0),
    hasMore: selected.results.length > limit,
  };
}
