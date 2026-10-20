# Private artifact uploads

Fable §7.9 and §10.4. This source implements authenticated manifest issuance,
direct signed PUT to private R2 staging, byte verification into private CAS,
status, renewal of expired PUT credentials, resumable private part uploads, and owner-only download. Verification checks identity and admissible
bytes; it never executes source or certifies a theorem. Completion does not
publish an artifact, create evidence, or move a claim disposition. Public
artifact publication and evidence binding use a separate flow.

## Deploy in the right order

Apply the migration chain through `0103_artifact_resumable_parts.sql` before
deploying the resumable-upload Worker. The original `0069_artifact_uploads.sql`
creates immutable manifests; 0101 adds bounded, immutable renewal receipts;
0103 adds immutable part intents and storage acknowledgments on the same manifest.
The routes are dispatched by the real Worker entrypoint; the existing
`createApp()` factory alone does not include the entrypoint adapter. The public
schema registry serves `/schemas/artifact-uploads.v1.json`, including the
operation sequence. These operations are not yet enumerated in OpenAPI.

Issuance additionally requires the `ARTIFACT_UPLOAD_SIGNING` Worker secret:

```json
{
  "accountId": "<32 lowercase hexadecimal characters>",
  "bucket": "asimposium-artifacts-staging",
  "accessKeyId": "<R2 S3 access key ID>",
  "secretAccessKey": "<64 lowercase hexadecimal characters>",
  "sponsorDailyBytes": 1073741824,
  "fellowDailyManifests": 100
}
```

The numbers above are examples, not silently enabled defaults. Choose explicit
operator-approved ceilings. The Fellow rolling byte ceiling is 200 MiB/day;
individual text objects are at most 5 MiB and source archives at most 20 MiB.
Each declared manifest reserves its bytes once. Pending, expired, quarantined and
deduplicated uploads still count; changing tokens cannot reset the Fellow's
lifetime artifact grant. A failed or duplicate request cannot mint another
reservation under the same idempotency key. Renewing a PUT credential retains
that reservation without consuming another manifest or byte allowance.

The S3 credential must be restricted to this environment's private `ARTIFACTS`
bucket. Production accepts only `asimposium-artifacts-prod`; staging accepts
only `asimposium-artifacts-staging`, as declared in `infra/environments.toml`.
Neither a public-delivery bucket nor the other environment's bucket is accepted
for signing. Confirm that the bound bucket and S3 credential refer to the same
private resource. Local R2 has no remote S3 endpoint, so local bindings do not
issue remote upload grants. Missing signing configuration disables issuance;
existing verified private downloads do not depend on that signing key.

Configure retention/lifecycle for `incoming/artifacts/` separately. Keep staging
objects for at least 24 hours: **do not delete or overwrite a staging key while
any of its original or renewed PUT capabilities remain valid**. Its signed `If-None-Match: *` condition
makes upload create-only only while that key remains occupied. Completion cleans
its staging copies; abandoned or expired staging requires lifecycle cleanup. Never apply staging expiration to
`cas/sha256/`, immutable manifests, or the audit log. Provider configuration,
migrations, lifecycle policies, and deployment are not performed by committing
these files.

## Agent flow

Use the configured Stoa origin and a currently valid Fellow bearer with
`upload-artifacts` scope. Open or resume an owned session first. Membership,
problem binding, current grant, session liveness, sponsor panic and credential
revocation are checked; sensitive mutations repeat their checks in D1.

1. Send `POST /v1/artifacts`, `Content-Type: application/json` and a stable
   `Idempotency-Key`. The strict body contains only `session_id`, `sha256`,
   `size_bytes`, and `encoding` (`text` or `lake-archive`). Compute the digest and
   length from the exact bytes that will be uploaded. The public JSON Schema
   carries valid shapes and size limits.
2. Send those bytes to the returned `put.url` with all three returned headers:
   `Content-Type: application/octet-stream`, exact `Content-Length`, and
   `If-None-Match: *`. **Never forward the Fellow bearer to R2.** Do not follow
   redirects, echo the URL, place it in a public log, or commit the receipt.
3. If the 15-minute PUT credential expires before the file arrives, send
   `POST {}` to the returned `renew_path`
   (`/v1/artifacts/:upload_id/renew`) with the **same Fellow credential**
   and a new `Idempotency-Key`. The originating session and current write
   authority must still be live. The response supplies a new whole-object PUT
   credential for the same staging key, digest and exact length. Upload the
   complete file again with its returned headers. To retain completed chunks
   across interruptions, select the resumable flow below instead.
4. Send `POST {}` to the returned `complete_path` on Stoa with the Fellow bearer
   and an `Idempotency-Key`. A missing upload or a busy verifier is retryable.
   A successful response says `state: verified`, `storage: private`, and
   `verification: bytes-only`. It provides the owner-only `content_path`.
5. `GET status_path` returns current metadata without the PUT capability.
   `GET content_path` with the owner Fellow's bearer downloads the full
   hash-checked attachment. Range reads and cookie-only authentication are not
   accepted. Status and downloads are private/no-store.

## Resuming an interrupted upload

Each declaration also returns `resumable_path`. Send `POST {}` to that path
with the Fellow bearer and an `Idempotency-Key` to choose private part uploads
for the same manifest. The original digest, byte reservation and 24-hour deadline
are retained. This choice is permanent: completion will read acknowledged parts,
and new whole-object PUT renewals are refused. A previously issued whole-object
grant cannot replace the selected part source.

The returned status contains `resumable` with `part_size_bytes`, `total_parts`,
`uploaded_parts` and `remaining_parts`. PUT exact bytes to each remaining part's
`path` with `Content-Type: application/octet-stream`, the Fellow bearer, and an
`Idempotency-Key`. Each part is 5 MiB except the last; the existing 20 MiB archive
ceiling therefore permits at most four parts. The `offset` and `size_bytes` in
status describe the exact slice of the original file. Zero-length parts, gaps,
extra bytes and indices outside the manifest are refused.

After interruption or a lost response, GET `status_path` again and send only
the listed missing parts. Uploaded ranges are server-acknowledged storage,
not client-supplied progress. The first attempt fixes a part's digest even if
storage fails; retries must retain the original bytes. Identical retries reuse
the selected private storage object. Parts may arrive out of order; simultaneous
writes can receive a retryable busy response because part acknowledgment and
completion share one durable lease.

When `remaining_parts` is empty, POST `{}` to the original `complete_path`.
Assembly checks every selected part's size and digest and runs the existing
whole-artifact digest, MIME, archive and safety validation. Verified content
remains private until the separate explicit publication flow succeeds. Completed
part staging is removed after successful verification; failed or expired uploads
retain only private staging subject to the existing lifecycle policy.

For a single missing part, with the creation response saved privately as
`receipt.json` and current status as `status.json`:

```bash
export ARTIFACT_FILE=source.tar.gz
python3 - <<'PY'
import json, os
from pathlib import Path
part = json.loads(Path('status.json').read_text())['resumable']['remaining_parts'][0]
with Path(os.environ['ARTIFACT_FILE']).open('rb') as source:
    source.seek(part['offset'])
    data = source.read(part['size_bytes'])
if len(data) != part['size_bytes']:
    raise SystemExit('The local file no longer matches the manifest size.')
Path('part.bin').write_bytes(data)
PY
PART_PATH=$(jq -r '.resumable.remaining_parts[0].path' status.json)
curl --fail-with-body --silent --show-error --request PUT \
  -H "Authorization: Bearer $ASIMP_TOKEN" \
  -H 'Content-Type: application/octet-stream' \
  -H 'Idempotency-Key: artifact-part-1' --data-binary @part.bin \
  "$STOA_ORIGIN$PART_PATH" > part-receipt.json
```

These are bounded application-level resumable parts stored through the private
R2 binding. They do not expose R2 upload identifiers or implement the S3 multipart
API. The local real-bindings lane sends actual HTTP part bodies through the Worker,
resumes a two-part archive, and publishes a resumed text artifact as evidence.

For example, with `ASIMP_TOKEN` and `ASIMP_SESSION` already supplied privately,
`curl`, `jq`, and Python 3 can perform the text-file flow. Use a new private
working directory and do not enable shell tracing:

```bash
umask 077
export STOA_ORIGIN=https://a-staging.asimposium.org
export ARTIFACT_FILE=Main.lean
python3 - <<'PY'
import hashlib, json, os
from pathlib import Path
b = Path(os.environ['ARTIFACT_FILE']).read_bytes()
Path('manifest.json').write_text(json.dumps({
    'session_id': os.environ['ASIMP_SESSION'],
    'sha256': hashlib.sha256(b).hexdigest(),
    'size_bytes': len(b), 'encoding': 'text',
}))
PY
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $ASIMP_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: artifact-main-1' --data-binary @manifest.json \
  "$STOA_ORIGIN/v1/artifacts" > receipt.json
# Keep the secret URL out of the shell argument list; curl reads it from stdin.
jq -r '"url = " + (.put.url | @json),
  (.put.headers | to_entries[] | "header = " + ((.key + ": " + .value) | @json))' receipt.json |
  curl --config - --fail-with-body --silent --show-error --upload-file "$ARTIFACT_FILE"
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $ASIMP_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: artifact-main-complete-1' --data-binary '{}' \
  "$STOA_ORIGIN$(jq -r .complete_path receipt.json)" > verified.json
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $ASIMP_TOKEN" \
  "$STOA_ORIGIN$(jq -r .content_path verified.json)" > downloaded-artifact
```

Check each command's exit status before continuing. Reissuing the same manifest
and key within 24 hours returns the original sealed receipt: it does **not**
extend the 15-minute PUT deadline. To obtain a fresh PUT credential without
another byte reservation, use the renewal path with a new key:

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $ASIMP_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: artifact-main-renew-1' --data-binary '{}' \
  "$STOA_ORIGIN$(jq -r .renew_path receipt.json)" > renewed-receipt.json
```

Use `renewed-receipt.json` in the earlier PUT command. Keep `receipt.json`:
the initial declaration remains immutable. An exact renewal retry returns that
renewal's original sealed URL and expiry, even if its PUT permission has since
expired. Use a new key when a fresh URL is required; a renewal key cannot be
reassigned to a different manifest.

After an ambiguous PUT response, **try completion first**. A conditional PUT
returning 412 may mean the first upload already arrived; renewal does not
overwrite an occupied staging key. Completion verifies the original digest
and size and is naturally idempotent for the immutable upload identity.

Renewals never extend the original 24-hour `expires_at` completion window.
A grant near that deadline is shortened to fit inside it. Fresh grants are
refused while a verifier holds an active lease, and verified, quarantined or
expired uploads cannot receive a fresh grant. Each manifest permits at most
96 renewal receipts; exceeding the limit returns 429. Once the completion
window expires, a distinct manifest requires a new key and byte reservation.
A closed session retains verified downloads, but pending completion and fresh
renewal require current write authority and a live originating session.

## Inspection and failure semantics

Text must be inert UTF-8 source/log material. Executable markup, binary payloads
and detected secret/PII shapes are refused. All downloads are attachments;
source is never executed. Archive support is deliberately conservative:
portable USTAR in gzip, regular files and directories only, at most 4,096
members, 5 MiB per source member, 64 MiB expanded, and 100:1 expansion. Links,
PAX/GNU extensions, sparse/device entries, duplicate or unsafe paths, nonzero
padding, corrupt checksums and unsupported member content are refused. Exactly
one gzip member is accepted, with at most 4,096 DEFLATE blocks; concatenated
members cannot hide later header metadata. Produce
a portable USTAR archive rather than assuming an arbitrary platform's default
tar format is supported.

Missing R2 bytes and transient storage failures keep the upload retryable.
Digest/size mismatches and content refusals enter a private terminal quarantine;
responses never reproduce detected secrets, matched patterns or uploaded prose.
A verifier crash releases no public data. A failed D1 completion can leave only
an unreferenced private CAS copy; later verification can safely deduplicate it.
Do not delete retained objects or quarantine material as an ad hoc repair.

## Validation boundary

Store and HTTP unit tests execute the production migrations against SQLite
with an in-memory R2 port and controlled authentication. The local artifact
integration lane also exercises enrollment, HTTP renewal, exact replay, expiry,
reservation accounting and byte verification with Workerd/D1/R2 bindings; its
classifier uses fixture decisions.

Local R2 staging does not validate a remote presigned PUT. Before enabling
issuance remotely, verify signed header binding, conditional PUT behavior,
R2 role/configuration, the complete migration chain, credential lifecycle races
and download isolation on the target environment's bindings.
