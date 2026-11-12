# Nightly database snapshots and ledger archives

The existing five-minute Worker cron creates a bounded daily SQL database
snapshot and advances a separate archive of published problem ledgers.
Both write only to the private `ARTIFACTS` R2 binding; the
public artifact bucket never receives backup files. Deployment and the
provider's actual cron delivery remain operator responsibilities.

The SQL snapshot includes application accounts, credentials, private drafts,
workshops and operational tables. The separate **published-problem ledger
archive** excludes that private state. Neither replaces D1 Time Travel,
current deletion-control replay, CAS body retention/inventory, guarded recovery
or provider restore drills. Those remain requirements of W2.8 and OPS.6.

## Complete SQL snapshot

Cloudflare's ordinary SQL exporter rejects databases containing virtual tables.
ASImposium has both public and private FTS5 indexes. The Worker therefore reads
the complete application schema and SQLite-formatted rows through D1 instead.
It captures all rows in one D1 batch transaction and checks that schema and
table definitions still match the prepared queries. Concurrent ordinary writes
cannot splice together different table snapshots. Schema changes or growth
beyond the measured read budgets refuse the attempt.

Integer values are formatted inside SQLite, preserving int64 values. Text and
BLOB literals preserve NULs and original bytes; finite REAL values use round-trip
formatting. Rowids, WITHOUT ROWID keys, generated columns and AUTOINCREMENT
sequence state survive. Schema definitions include indexes, triggers and views.
Import data before installing triggers, then restore sequence values after all
table inserts. Standalone FTS contents are copied logically; external-content
FTS is rebuilt from its restored source rows. Engine shadow pages and Cloudflare
internal tables are excluded. Nondefault persisted FTS configuration or an
unsupported virtual table refuses the snapshot rather than silently changing
search behavior.

The launch implementation is bounded: at most 256 application tables, 2,000
rows per table, 1 MiB of SQL per table, 8 MiB total and 16,000 statements.
Measurement transfers counts only. Actual table reads share a fixed aggregate
budget; excess state is an explicit failed backup, never a truncated success.
These limits require a later scalable recovery path before a larger database
can rely on this producer.

The current checkpoint signing key must have an independently configured public
pin. The private SQL object is created conditionally, read back and verified
before the signed completion manifest is created. A ten-minute conditional lease
coordinates concurrent cron deliveries. Interrupted uploads have no completion
manifest; after lease expiry a new attempt preserves those objects and creates
a fresh archive. Existing completion objects are never overwritten. Later ticks
verify the signed manifest and the SQL object's R2 checksum with a HEAD request.

Storage keys:

- `backups/control/database-v1.json`: the bounded lease, outside dated retention.
- `backups/sql/YYYY-MM-DD/<uuid>.sql`: confidential SQL, including private data.
- `backups/sql/YYYY-MM-DD/complete.json`: signed digest, source binding/origin,
  statement byte boundaries and table counts. It is private too.

SQL snapshots are disabled until an independent destination pin is configured.
Prepare a fresh marker locally for each environment:

```sh
bun scripts/verify-database-backup.ts \
  --prepare-destination ./new-private-destination.bin
```

The command exclusively creates a 32-byte file with mode `0600`; an existing
destination is refused. Its output contains the SHA-256 pin and the reserved,
content-addressed `marker_key`, never the marker bytes. Independently verify the
actual private bucket's provider identity and lack of public delivery, then
upload those exact bytes to that new key in `ARTIFACTS`. Never replace an
existing designation or copy a marker to another bucket/environment. Configure
the Worker variable `DATABASE_BACKUP_DESTINATION_SHA256` with the printed digest.
This source change provisions neither the object nor the variable remotely.

Before SQL access or publication, including an existing-completion check, the
Worker requires the designated 32 bytes in `ARTIFACTS` and their absence from
`PUBLIC_ARTIFACTS`. It never creates the marker. Missing pins disable the job;
invalid pins, missing/changed markers, distinct swapped destinations, aliases
and public-side marker copies refuse. Storage lookup errors fail closed.

The independent provisioning step is a trust boundary: a pin designates a
physical namespace, not proof that a provider administrator will never attach a
public domain to it later. Validate actual provider bindings and topology before
provisioning. Local tests establish the destination guard, not deployed DNS or
bucket policy. No public resource serves these archives. Keep the marker prefix
outside the dated archive lifecycle and outside point-in-time SQL recovery.

Download SQL and its completion manifest through the private operator channel,
using exclusive local destinations and restricted filesystem permissions. Verify
with a public key acquired independently of the archive:

```sh
bun scripts/verify-database-backup.ts \
  --manifest ./complete.json --sql ./snapshot.sql \
  --key '<key-id>=<trusted-ed25519-public-key-hex>'
```

This offline command prints only bounded metadata and never executes SQL.
The complete SQL must import into an empty, unmigrated, separately identified
scratch database, with foreign keys deferred until the import transaction ends.
Existing or migrated application schemas are not valid import targets.
Raw import restores historical authority: keep it quarantined. Authenticate
the independently current deletion journal before any recovery write, replay
its controls through the existing lifecycle paths afterward, and recheck current
authority before considering cutover. The original whole-system recovery item
remains open for that integrated procedure and its provider drill. A successful
raw SQL round-trip does not establish deletion-safe service recovery.

Apply the disclosed 90-day lifecycle to dated `backups/sql/` objects, including
interrupted uploads. Do not expire the lease or deletion journal with a broad
bucket rule. Cron emits `nightly-database-backup` with counts/status or a coarse
failure code; it never logs SQL, rows, signing material or credentials.

## Operation and limits

The first tick of a UTC day captures a finite problem-ID upper bound and a
creation-time cutoff. Each tick processes at most one bounded portion of one
problem, then saves its cursor. A run that spans midnight finishes its captured sweep before starting
the new day's sweep. A problem published behind an already advanced cursor
is picked up by the next sweep; this is not a simultaneous database snapshot.

Each tick is capped at 1,000 events, 4 MiB of payload bytes and 12 MiB of
serialized export. Payload size is checked before fetching bodies. Small
problems retain the ordinary JSONL archive. Larger problems continue through
numbered segments over later ticks, preserving the original terminal cursor
and root even while new events arrive. Each segment verifies its linkage from
the preceding verified root. The constant-size durable cursor retains only the
last verified event/root and segment number, not an array of the whole history.

The scheduler reports `segment-written` while a problem is incomplete and
does not increment its archived-problem count. Only the last successful segment
publishes a completion manifest, containing the terminal signature. Missing,
changed, truncated or reordered segments fail offline verification. A missing
or oversized single payload still fails explicitly; the task never increases
its memory budget to fit it. A failed scope leaves no successful receipt and
the sweep continues to other problems. Partial segment objects can remain until
the archive lifecycle expires; they are not a recoverable whole-problem archive.

R2 conditional writes protect the progress cursor with a ten-minute lease.
Overlapping ticks have one lease owner. If a worker dies, a later tick reclaims
the expired lease and retries. Data files use the existing content-addressed
keys, so a crash after publication but before cursor advance does not skip the
problem or mint a second logical archive. A stale owner cannot overwrite a
newer's progress. R2 puts for an export/signature pair are not a transaction;
the signature companion is written first and successful completion is recorded
only after the export is durable.

## Keys and authenticity

`CHECKPOINT_SIGNING_KEY` and `CHECKPOINT_VERIFY_KEYS` must be configured, with
the signing key's public key explicitly pinned in the verification keyring.
The checkpoint signer runs before the backup task. Missing keys return an
explicit `disabled` result; malformed, duplicate or mismatched configured keys
fail the task. Neither state means backups completed.

Before writing an archive, the Worker verifies its event/payload chain and
requires a cryptographically valid signature on the exact terminal checkpoint.
If the bounded signer has not reached that checkpoint, the scheduler records
`waiting-for-signature` and retains the exact prefix for a later tick. New
appends cannot continually move that target out of reach. Verification uses
the configured public key pins, not merely keys advertised in the backup.
The first wait time is durable. If the signature is still unavailable after
24 hours, the problem records `BACKUP_SIGNATURE_UNAVAILABLE` and the sweep
continues to other scopes; the final report is incomplete. Retries never reset
that deadline. A broken signer cannot silently stall every other archive forever.

## Storage and monitoring

- `backups/control/nightly-v1.json`: current run, cursor, pending prefix, lease,
  cumulative written/empty/failed counts, and final report pointer.
- `backups/YYYY-MM-DD/P-…/<chain-prefix>.jsonl`: verified ledger export.
- The adjacent `.checkpoints.json`: terminal signature companion.
- `backups/YYYY-MM-DD/P-…/<full-root>.segments/<number>.jsonl`: bounded
  continuation segments for a large problem.
- The adjacent `<full-root>.manifest.json`: successful completion witness for
  that segmented archive; includes its exact terminal signature and segment count.
- `backups/receipts/YYYY-MM-DD/P-…/<attempt>.json`: written/empty/failed result.
- `backups/runs/YYYY-MM-DD/<attempt>.json`: final report referenced by the
  conditional progress record. Unreferenced reports can be interrupted attempts.

Cron logs emit `stage: nightly-ledger-backup`, its explicit state, and counts.
Any export failure is recorded and the cron reports failure; a finished sweep
with failures stays `incomplete` for that day. Logs and failure receipts contain
bounded codes and identifiers, never raw SQL errors, event bodies or secrets.
A malformed progress object is refused rather than reset to a false empty run.

Configure the disclosed 90-day lifecycle only for dated archive, receipt and
run-report prefixes. Do not expire `backups/control/`, CAS, or
`journal/deletion/` through a broad `backups/` or bucket-wide rule. No lifecycle
policy or cloud resource is provisioned by this source change. Restores must
still verify and replay the latest signed deletion journal: an old archive's
presence does not authorize serving data subsequently erased or controlled.

## Recovering a segmented archive

Download the private manifest and its segment prefix while preserving their
storage-key paths under a local directory. Supply a public key obtained through
an independent trusted channel, not a key chosen by the archive itself:

```sh
bun scripts/assemble-ledger-backup.ts \
  --manifest ./downloaded-manifest.json \
  --segments-root ./downloaded-private-objects \
  --output ./recovered-ledger.jsonl \
  --key '<key-id>=<trusted-ed25519-public-key-hex>'
```

Assembly verifies the signature before reading segments, checks every payload,
envelope, chain link and checkpoint, and requires the exact terminal root. It
produces the ordinary v3 JSONL export plus `recovered-ledger.jsonl.checkpoints.json`.
Existing destinations are refused. This is an offline host operation: assembly
and the existing full-export restore path still need memory for the complete
problem. The scheduled Worker never assembles a whole large history in memory.
Use the existing guarded scratch restore with the latest signed deletion journal;
assembly alone does not authorize service cutover or bypass retained controls.
Run `deletionSafeRestore` from the offline operator process against its separately
validated scratch D1 binding. Its required `readCurrentJournal` callback must
re-read `fetchLatestDeletionJournal(currentPrivateBucket, independentlyPinnedKeys)`
and return that result's `head` (or `null` when unavailable). Use the current
private bucket outside the point-in-time snapshot; never construct the authority
from the candidate journal or cache its first result. The reader authenticates
the journal and binds its signed count to its canonical storage key. Recovery
checks this count/digest before writes and again before returning success.
An authentic older journal is refused before any write. Publication during
recovery withholds completion; keep the target quarantined and retry with the
new journal. The credential revoker must also use the scratch D1 binding.

This comparison establishes the newest **published** journal. It does not close
the interval between a source deletion and its scheduled journal publication,
nor the interval after the final comparison. The separate cutover procedure must
hold an authoritative source publication boundary before allowing the recovered
service to accept requests. A journal signature alone is never proof of freshness.
An empty source publishes a signed zero-record head; no journal means unavailable
authority, not permission to restore.

The private journal also carries each exact visibility control: operator hides
and restorations, community holds and their reviewed resolutions, and sponsor
problem withdrawals. The control and its journal entry commit together. Original
control IDs, versions, attribution and private rationale survive recovery; the
public moderation log and public faces do not acquire that rationale. Existing
immutable controls are backfilled before publication, at most 100 per attempt.
If more remain, that attempt publishes no new journal and the next tick continues.

Recovery checks all affected existing control histories before changing the
target and repeats their predecessor checks inside the replay transaction.
Conflicting identities or concurrent decisions refuse replay; they are never
overwritten by a backup. The original control version determines current
visibility even when historical backfill arrives later in journal order.
Controls for absent problems remain unapplied until those problems are restored.
After an initial restore has installed controls, apply a newer journal with
`applyDeletionJournal` on the same quarantined scratch binding. Do not ask the
log importer to overwrite an already controlled history. This handles visibility
decisions, not physical redaction, public artifact copying, cache purging, or
copies already downloaded by third parties.

Require the projection result to contain `inserted` before treating the problem
rebuild as complete; a `refused` projection result leaves work unfinished.
Large recovery is a host operation, not a Worker restore RPC. This remains a
problem-ledger restore, not whole-system SQL/account/private-state recovery.

## Local verification

```sh
node apps/wire/test/integration/backup-scheduler-real-bindings.mjs
node apps/wire/test/integration/backup-segments-real-bindings.mjs
```

This journey runs the production scheduler against real local Workerd, D1 and
R2. It verifies signature waits with a fixed prefix, conditional lease races,
expired-lease recovery, replay after publication, daily completion, private
storage isolation, failure continuation after lawful redaction, rejection of
corrupt progress, and the production scheduled entrypoint. A scheduling barrier
lets both contenders read the same real R2 etag; no R2 storage operation is
mocked. The segmented journey also exceeds both event and payload budgets,
replays an interrupted segment, proves missing/tampered segments fail, and passes
the assembled export through the unchanged deletion-safe importer running on the
Node host, with a current signed deletion journal and the separate real scratch D1.
It checks the restored event count, root, payload rows and successful projection
rebuilding before declaring recovery complete.
Neither journey certifies cloud cron delivery, bucket lifecycle policies or
full SQL recovery.
