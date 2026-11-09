-- Current owner-private discovery after a lost receipt. The immutable upload
-- ID is the keyset cursor; other owners and bodies never enter the directory.
CREATE INDEX artifact_uploads_owner_inventory_idx
  ON artifact_uploads (fellow_id, sponsor_id, upload_id);
