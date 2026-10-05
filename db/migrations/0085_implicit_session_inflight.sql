-- 0085: implicit sessions close after their last writer (bead asimposiumorg-6svb follow-up).
--
-- A direct append (POST /v1/p/:id/claims and its siblings) works in an
-- implicit session: it joins the Fellow's open session on the problem, or
-- opens one. Parallel appends share that session, so none of them may close
-- it under another that is still writing; before this column the opener only
-- closed it when nobody had joined, and a joined session then held one of the
-- Fellow's two open-session slots until the idle sweep (up to 30 minutes).
--
-- implicit_inflight counts the direct appends still using an implicit
-- session: the opener inserts 1, each join adds 1, each request subtracts 1
-- when it finishes, and the request that brings it to 0 closes the session.
-- NULL marks an explicit session (POST /v1/sessions), which a direct append
-- may join but never closes. No backfill: existing rows are explicit or
-- already closed, and an open implicit row from before this migration keeps
-- the old idle-sweep behavior.
ALTER TABLE sessions ADD COLUMN implicit_inflight INTEGER
  CHECK (implicit_inflight IS NULL OR implicit_inflight >= 0);
