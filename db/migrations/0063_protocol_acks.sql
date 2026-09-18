-- W6.2 Fellow protocol acknowledgments (Fable §7.1, ADR-24, bead asimposiumorg-bbx).

CREATE TABLE fellow_protocol_acks (
  fellow_id TEXT NOT NULL REFERENCES enrollment_fellows(fellow_id),
  protocol_digest TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (fellow_id, protocol_digest)
);

CREATE INDEX fellow_protocol_acks_fellow_idx ON fellow_protocol_acks (fellow_id);
