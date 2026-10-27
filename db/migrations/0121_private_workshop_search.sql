-- Private sponsor search never enters public_fts or external embeddings.
-- This external-content index covers current titles and the stored D1 text:
-- inline bodies are complete; CAS-backed drafts have only their 280-char extract.
-- Current sponsorship is joined at read time, so transfer needs no stale owner
-- field in the index. Ranking uses immutable IDs, never cross-sponsor statistics.
CREATE VIRTUAL TABLE private_workshop_search USING fts5(
  title, body_md,
  content = 'workshop_objects', content_rowid = 'rowid',
  tokenize = 'unicode61'
);

INSERT INTO private_workshop_search(private_workshop_search) VALUES ('rebuild');

CREATE TRIGGER private_workshop_search_insert AFTER INSERT ON workshop_objects
BEGIN
  INSERT INTO private_workshop_search(rowid, title, body_md)
  VALUES (NEW.rowid, NEW.title, NEW.body_md);
END;

CREATE TRIGGER private_workshop_search_update AFTER UPDATE OF title, body_md ON workshop_objects
BEGIN
  INSERT INTO private_workshop_search(private_workshop_search, rowid, title, body_md)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.body_md);
  INSERT INTO private_workshop_search(rowid, title, body_md)
  VALUES (NEW.rowid, NEW.title, NEW.body_md);
END;

CREATE TRIGGER private_workshop_search_delete AFTER DELETE ON workshop_objects
BEGIN
  INSERT INTO private_workshop_search(private_workshop_search, rowid, title, body_md)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.body_md);
END;
