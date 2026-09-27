#!/usr/bin/env python3
"""Regenerate the artifact presigned-PUT vectors with botocore's SigV4 signer.

apps/wire/test/unit/artifact-presign.test.ts checks the Worker's signer
against these URLs byte for byte. botocore is an independent implementation,
so agreement is evidence the signing is standard SigV4 query auth rather
than a self-consistent private scheme. It is not evidence that R2 accepts
the PUT; that needs the staging run (asimposiumorg-rs5n).

Usage: python3 scripts/artifact-presign-vectors.py > apps/wire/test/fixtures/artifact-presign.botocore.json
Requires botocore (tested with 1.40.72). All credentials are placeholders.
"""

import datetime
import json
from unittest import mock

import botocore
from botocore.auth import S3SigV4QueryAuth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

CASES = [
    # id, account, bucket, access key id, secret, upload id, size, signing instant
    ("baseline", "a" * 32, "asimp-private", "b" * 32, "c" * 64, "AU-" + "d" * 32, 1234, "2026-09-17T12:00:00Z"),
    ("one-byte", "0123456789abcdef0123456789abcdef", "asimp-private", "AKIAEXAMPLEKEY0001", "0" * 64, "AU-" + "0" * 32, 1, "2026-01-01T00:00:00Z"),
    ("max-size", "f" * 32, "asimp-staging-private", "Z" * 128, "9" * 64, "AU-" + "f" * 32, 20 * 1024 * 1024, "2026-12-31T23:59:59Z"),
    ("mixed", "1f2e3d4c5b6a79881f2e3d4c5b6a7988", "b-2", "abcDEF0123456789", "0123456789abcdef" * 4, "AU-0123456789abcdef0123456789abcdef", 65536, "2027-02-28T08:15:30Z"),
]


def sign(account, bucket, key_id, secret, upload_id, size, iso):
    url = f"https://{account}.r2.cloudflarestorage.com/{bucket}/incoming/artifacts/{upload_id}"
    request = AWSRequest(
        method="PUT",
        url=url,
        headers={
            "content-length": str(size),
            "content-type": "application/octet-stream",
            "if-none-match": "*",
        },
    )
    at = datetime.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ")
    with mock.patch("botocore.auth.get_current_datetime", return_value=at):
        S3SigV4QueryAuth(Credentials(key_id, secret), "s3", "auto", expires=900).add_auth(request)
    return request.url


vectors = []
for case_id, account, bucket, key_id, secret, upload_id, size, iso in CASES:
    vectors.append(
        {
            "id": case_id,
            "config": {"accountId": account, "bucket": bucket, "accessKeyId": key_id, "secretAccessKey": secret},
            "upload_id": upload_id,
            "size": size,
            "signed_at": iso,
            "url": sign(account, bucket, key_id, secret, upload_id, size, iso),
        }
    )
print(json.dumps({"generator": f"botocore {botocore.__version__} S3SigV4QueryAuth", "vectors": vectors}, indent=2))
