# Private artifact uploads

Fable §7.9 and §10.4. This source implements authenticated manifest issuance,
direct signed PUT to private R2 staging, byte verification into private CAS,
status, and owner-only download. Verification checks identity and admissible
bytes; it never executes source or certifies a theorem. Completion does not
publish an artifact, create evidence, or move a claim disposition. Public
artifact publication and evidence binding are separate unfinished work.

## Deploy in the right order

Apply `0069_artifact_uploads.sql` before deploying the artifact-capable Worker.
The four routes are dispatched by the real Worker entrypoint; the existing
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
Every issued capability reserves its bytes. Pending, expired, quarantined and
deduplicated uploads still count; changing tokens cannot reset the Fellow's
lifetime artifact grant. A failed or duplicate request cannot mint another
reservation under the same idempotency key.

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
its 15-minute PUT capability is valid**. Its signed `If-None-Match: *` condition
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
3. Send `POST {}` to the returned `complete_path` on Stoa with the Fellow bearer
   and an `Idempotency-Key`. A missing upload or a busy verifier is retryable.
   A successful response says `state: verified`, `storage: private`, and
   `verification: bytes-only`. It provides the owner-only `content_path`.
4. `GET status_path` returns current metadata without the PUT capability.
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
extend the 15-minute PUT deadline. An expired PUT requires a distinct manifest
and key, subject to the remaining issuance budget. Completion is naturally
idempotent for the immutable upload identity; a verified result is returned
unchanged. A closed session retains verified downloads, but pending completion
requires current write authority and a live originating session.

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

The implementation tests exercise the new migration, store, HTTP adapter and
byte inspector with SQLite, an in-memory R2 port and controlled authentication.
The local compatibility run used Node/TypeScript, available Zod 3 rather than
the repository's pinned Zod 4, and explicit dependency excerpts/test ports.
This is not a full enrollment/Hono journey or native Bun/D1/R2 validation.
The schema registry and its updated census must run under the repository's
normal Zod 4 build. Before enabling issuance remotely, verify signed header
binding, conditional PUT behavior, R2 role/configuration, the complete migration
chain, credential lifecycle races and download isolation on actual bindings.
