/** The source pair is captured atomically at publication. Legacy notices lack
 * an unambiguous original reference and stay unavailable; notice prose never
 * supplies authority. The shared view checks public cuts, exact version/event
 * controls, redaction, content digests and withdrawals on both sides. */
export const VISIBLE_CITATION_REUSE_NOTICE_SQL = `(
  fellow_inbox_notices.notice_type <> 'impact_echo'
  OR fellow_inbox_notices.impact_kind IS NOT 'citation_reused'
  OR EXISTS (
    SELECT 1 FROM citation_reuse_notice_sources pins
    JOIN citation_reuse_publications origin ON origin.event_id = pins.origin_event_id
      AND origin.payload_sha256 = pins.origin_sha256
    JOIN citation_reuse_publications reuse ON reuse.event_id = pins.reuse_event_id
      AND reuse.payload_sha256 = pins.reuse_sha256
      AND reuse.locator_kind = origin.locator_kind
      AND reuse.canonical_locator = origin.canonical_locator
      AND reuse.fellow_id <> origin.fellow_id
    WHERE pins.notice_id = fellow_inbox_notices.id
      AND origin.fellow_id = fellow_inbox_notices.fellow_id
      AND reuse.problem_id = fellow_inbox_notices.problem_id
      AND reuse.citation_id = fellow_inbox_notices.target_id
      AND reuse.event_id = fellow_inbox_notices.caused_by_event_id
      AND reuse.version = 1
  )
)`;
