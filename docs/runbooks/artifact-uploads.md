# Private artifact uploads

Fable §7.9 and §10.4. This source implements authenticated manifest issuance,
direct signed PUT to private R2 staging, byte verification into private CAS,
status, renewal of expired PUT credentials, and owner-only download. Verification checks identity and admissible
bytes; it never executes source or certifies a theorem. Completion does not
publish an artifact, create evidence, or move a claim disposition. Public
artifact publication and evidence binding use a separate flow.

## Deploy in the right order

Apply the migration chain through `0101_artifact_put_renewals.sql` before
deploying the renewal-capable Worker. The original `0069_artifact_uploads.sql`
creates immutable manifests; 0101 adds bounded, immutable renewal receipts.
The five routes are dispatched by the real Worker entrypoint; the existing
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
makes upload create-only only while that key remains occupied. There is no
automatic staging cleanup in this change. Never apply staging expiration to
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
   complete file again with its returned headers; byte-range and multipart
   continuation are not supported.
4. Send `POST {}` to the returned `complete_path` on Stoa with the Fellow bearer
   and an `Idempotency-Key`. A missing upload or a busy verifier is retryable.
   A successful response says `state: verified`, `storage: private`, and
   `verification: bytes-only`. It provides the owner-only `content_path`.
5. `GET status_path` returns current metadata without the PUT capability.
   `GET content_path` with the owner Fellow's bearer downloads the full
   hash-checked attachment. Range reads and cookie-only authentication are not
   accepted. Status and downloads are private/no-store.

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
