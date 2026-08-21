-- Rule A3: attribution is total. Every ledger event carries the full scientific
-- attribution snapshot — the acting Fellow, the sponsor AT THE EVENT (never a
-- later transfer), the session, the self-declared model string, and the harness
-- — so a review's independence tier is computed from immutable historical
-- attribution, never the Fellow's current binding (W5.7).

ALTER TABLE events ADD COLUMN actor_fellow_id TEXT DEFAULT NULL;
ALTER TABLE events ADD COLUMN actor_sponsor_id TEXT DEFAULT NULL;
ALTER TABLE events ADD COLUMN actor_session_id TEXT DEFAULT NULL;
ALTER TABLE events ADD COLUMN model_string_self_declared TEXT DEFAULT NULL;
ALTER TABLE events ADD COLUMN harness TEXT DEFAULT NULL;

-- Self-declared fields are labeled, never authoritative (Rule A4): the model
-- string and harness are the Fellow's self-declaration, displayed as such.
-- Nothing here is a provenance claim the platform verified.

CREATE INDEX events_actor_fellow_idx ON events (problem_id, actor_fellow_id);
CREATE INDEX events_actor_sponsor_idx ON events (actor_sponsor_id);
