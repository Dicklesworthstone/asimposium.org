#!/usr/bin/env python3
"""
Race-safe POSIX openat/O_NOFOLLOW operator archival tool for e2e/artifacts
(bead asimposiumorg-rc-artifact-archival-e2e-shims-luqx / Rule 1).

Properties:
- Atomically acquires e2e/.artifact-maintenance fence via dir_fd mkdir (fails
  closed with MAINTENANCE_FENCE_ALREADY_PRESENT if already present).
- Verifies zero current-epoch open writer leases under
  e2e/.artifact-writer-leases/dev-<dev>-ino-<ino>/ (fails closed with
  OPEN_WRITER_LEASE_PRESENT or LEASE_REGISTRY_MALFORMED).
- Traverses e2e/artifacts strictly via POSIX dir_fd + O_NOFOLLOW + fstat,
  refusing any symlink (SYMLINK_TRAVERSAL_REFUSED) or special node
  (SPECIAL_NODE_REFUSED).
- Skips .sbh-protect protected directories (e.g. retained Chromium 1254 cache)
  unless --include-protected is explicitly supplied.
- Writes a deterministic .tar.gz archive + <dest>.sha256.json manifest strictly
  OUTSIDE e2e/artifacts, then re-reads and verifies every member's SHA-256.
- NEVER deletes any artifact file or run directory (AGENTS.md Rule 1). Emits
  the verified operator-approval cleanup plan for explicit human sign-off.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import stat
import sys
import tarfile
import time
from pathlib import Path


O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)


class ArchivalError(Exception):
    def __init__(self, code: str, message: str, exit_code: int = 1) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code


def emit(status: str, code: str, extra: dict | None = None) -> None:
    payload: dict = {
        "facility": "OPS.artifact-archival",
        "status": status,
        "code": code,
    }
    if extra:
        payload.update(extra)
    print(json.dumps(payload, sort_keys=True))


def open_dir_nofollow(path: str, dir_fd: int | None = None) -> int:
    try:
        fd = os.open(path, os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW, dir_fd=dir_fd)
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
            raise ArchivalError("SYMLINK_TRAVERSAL_REFUSED", "Refused symlink or non-directory traversal.", 1) from exc
        raise ArchivalError("PATH_OPEN_FAILED", f"Could not open directory safely: errno={exc.errno}", 78) from exc
    st = os.fstat(fd)
    if not stat.S_ISDIR(st.st_mode):
        os.close(fd)
        raise ArchivalError("SPECIAL_NODE_REFUSED", "Target is not a regular directory.", 1)
    return fd


def check_writer_leases(e2e_fd: int, epoch_name: str) -> dict:
    try:
        leases_root_st = os.lstat(".artifact-writer-leases", dir_fd=e2e_fd)
    except FileNotFoundError:
        return {"epoch": epoch_name, "checked_leases": 0, "open_leases": 0}
    if stat.S_ISLNK(leases_root_st.st_mode) or not stat.S_ISDIR(leases_root_st.st_mode):
        raise ArchivalError("LEASE_REGISTRY_MALFORMED", "Lease registry root is not a real directory.", 78)

    leases_root_fd = open_dir_nofollow(".artifact-writer-leases", dir_fd=e2e_fd)
    try:
        try:
            epoch_st = os.lstat(epoch_name, dir_fd=leases_root_fd)
        except FileNotFoundError:
            return {"epoch": epoch_name, "checked_leases": 0, "open_leases": 0}
        if stat.S_ISLNK(epoch_st.st_mode) or not stat.S_ISDIR(epoch_st.st_mode):
            raise ArchivalError("LEASE_REGISTRY_MALFORMED", "Current-epoch lease node is not a real directory.", 78)

        epoch_fd = open_dir_nofollow(epoch_name, dir_fd=leases_root_fd)
        try:
            checked = 0
            open_count = 0
            for entry in sorted(os.listdir(epoch_fd)):
                st = os.lstat(entry, dir_fd=epoch_fd)
                if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
                    raise ArchivalError("LEASE_REGISTRY_MALFORMED", "Malformed non-directory entry in writer lease epoch.", 78)
                checked += 1
                lease_fd = open_dir_nofollow(entry, dir_fd=epoch_fd)
                try:
                    try:
                        closed_st = os.lstat("closed", dir_fd=lease_fd)
                        if stat.S_ISLNK(closed_st.st_mode) or not (stat.S_ISDIR(closed_st.st_mode) or stat.S_ISREG(closed_st.st_mode)):
                            raise ArchivalError("LEASE_REGISTRY_MALFORMED", "Invalid closed marker in writer lease.", 78)
                    except FileNotFoundError:
                        open_count += 1
                finally:
                    os.close(lease_fd)
            if open_count > 0:
                raise ArchivalError(
                    "OPEN_WRITER_LEASE_PRESENT",
                    f"Refusing archival: {open_count} current-epoch writer lease(s) remain open.",
                    78,
                )
            return {"epoch": epoch_name, "checked_leases": checked, "open_leases": 0}
        finally:
            os.close(epoch_fd)
    finally:
        os.close(leases_root_fd)


def has_sbh_protect(run_fd: int) -> bool:
    try:
        st = os.lstat(".sbh-protect", dir_fd=run_fd)
        return stat.S_ISREG(st.st_mode) and not stat.S_ISLNK(st.st_mode)
    except FileNotFoundError:
        return False


def walk_run_dir(
    dir_fd: int,
    rel_prefix: str,
    tar: tarfile.TarFile | None,
    file_hashes: dict[str, str],
    stats: dict[str, int],
) -> None:
    entries = sorted(os.listdir(dir_fd))
    for name in entries:
        if name in (".", "..") or "/" in name or "\x00" in name:
            raise ArchivalError("UNSAFE_PATH_COMPONENT", "Unsafe directory entry encountered.", 1)
        st = os.lstat(name, dir_fd=dir_fd)
        rel_path = f"{rel_prefix}/{name}"
        if stat.S_ISLNK(st.st_mode):
            raise ArchivalError(
                "SYMLINK_TRAVERSAL_REFUSED",
                f"Refused symlink inside artifact tree at {rel_path}.",
                1,
            )
        if stat.S_ISDIR(st.st_mode):
            child_fd = open_dir_nofollow(name, dir_fd=dir_fd)
            try:
                child_st = os.fstat(child_fd)
                if child_st.st_dev != st.st_dev or child_st.st_ino != st.st_ino:
                    raise ArchivalError("FILESYSTEM_DRIFT_DETECTED", "Directory inode changed during traversal.", 1)
                stats["dir_count"] += 1
                if tar is not None:
                    info = tarfile.TarInfo(name=rel_path)
                    info.type = tarfile.DIRTYPE
                    info.mode = 0o755
                    info.mtime = int(child_st.st_mtime)
                    tar.addfile(info)
                walk_run_dir(child_fd, rel_path, tar, file_hashes, stats)
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(st.st_mode):
            try:
                file_fd = os.open(name, os.O_RDONLY | O_NOFOLLOW, dir_fd=dir_fd)
            except OSError as exc:
                raise ArchivalError("SYMLINK_TRAVERSAL_REFUSED", f"Refused file open with O_NOFOLLOW: errno={exc.errno}", 1) from exc
            try:
                file_st = os.fstat(file_fd)
                if not stat.S_ISREG(file_st.st_mode):
                    raise ArchivalError("SPECIAL_NODE_REFUSED", f"Non-regular file encountered at {rel_path}.", 1)
                if file_st.st_dev != st.st_dev or file_st.st_ino != st.st_ino:
                    raise ArchivalError("FILESYSTEM_DRIFT_DETECTED", "File inode changed during open.", 1)
                hasher = hashlib.sha256()
                total = 0
                while True:
                    chunk = os.read(file_fd, 65536)
                    if not chunk:
                        break
                    hasher.update(chunk)
                    total += len(chunk)
                digest = hasher.hexdigest()
                file_hashes[rel_path] = digest
                stats["file_count"] += 1
                stats["total_bytes"] += total
                if tar is not None:
                    # Stream directly from the already-verified O_NOFOLLOW file descriptor
                    # in O(1) RAM instead of buffering full artifact files in memory.
                    if total != file_st.st_size:
                        raise ArchivalError(
                            "FILESYSTEM_DRIFT_DETECTED",
                            f"File size changed while reading {rel_path}.",
                            1,
                        )
                    os.lseek(file_fd, 0, os.SEEK_SET)
                    dup_fd = os.dup(file_fd)
                    with os.fdopen(dup_fd, "rb", buffering=65536) as stream:
                        info = tarfile.TarInfo(name=rel_path)
                        info.type = tarfile.REGTYPE
                        info.size = total
                        info.mode = 0o644
                        info.mtime = int(file_st.st_mtime)
                        tar.addfile(info, stream)
            finally:
                os.close(file_fd)
        else:
            raise ArchivalError(
                "SPECIAL_NODE_REFUSED",
                f"Refused special filesystem node at {rel_path}.",
                1,
            )


def verify_archive_integrity(archive_path: Path, expected_hashes: dict[str, str]) -> str:
    archive_hasher = hashlib.sha256()
    with archive_path.open("rb") as fh:
        while True:
            block = fh.read(65536)
            if not block:
                break
            archive_hasher.update(block)
    archive_sha256 = archive_hasher.hexdigest()

    observed: dict[str, str] = {}
    with tarfile.open(archive_path, "r:gz") as tar:
        for member in tar.getmembers():
            if member.issym() or member.islnk():
                raise ArchivalError("ARCHIVE_VERIFICATION_FAILED", "Unexpected link inside archive.", 1)
            if member.isfile():
                extracted = tar.extractfile(member)
                if extracted is None:
                    raise ArchivalError("ARCHIVE_VERIFICATION_FAILED", f"Could not extract {member.name}.", 1)
                h = hashlib.sha256()
                while True:
                    block = extracted.read(65536)
                    if not block:
                        break
                    h.update(block)
                observed[member.name] = h.hexdigest()

    if observed != expected_hashes:
        raise ArchivalError(
            "ARCHIVE_VERIFICATION_FAILED",
            "Archive member SHA-256 verification did not match source manifest.",
            1,
        )
    return archive_sha256


def run_archival(args: argparse.Namespace) -> int:
    repo_root = Path(args.root).resolve()
    e2e_dir = repo_root / "e2e"
    if not e2e_dir.is_dir():
        raise ArchivalError("E2E_ROOT_MISSING", "e2e/ directory not found under root.", 78)

    dest_path: Path | None = None
    if not args.dry_run:
        if not args.dest:
            raise ArchivalError("ARCHIVE_DEST_REQUIRED", "--dest <path.tar.gz> is required unless --dry-run is set.", 64)
        dest_path = Path(args.dest).resolve()
        artifacts_real = (e2e_dir / "artifacts").resolve()
        if dest_path == artifacts_real or artifacts_real in dest_path.parents:
            raise ArchivalError(
                "ARCHIVE_DEST_INSIDE_ARTIFACTS",
                "Archive destination must lie strictly outside e2e/artifacts.",
                64,
            )
        if dest_path.exists() or dest_path.is_symlink():
            raise ArchivalError(
                "ARCHIVE_DEST_ALREADY_EXISTS",
                "Refusing to overwrite an existing archive destination.",
                64,
            )

    e2e_fd = open_dir_nofollow(str(e2e_dir))
    fence_acquired = False
    try:
        # 1. Atomically acquire e2e/.artifact-maintenance fence.
        try:
            os.mkdir(".artifact-maintenance", 0o700, dir_fd=e2e_fd)
            fence_acquired = True
        except FileExistsError as exc:
            raise ArchivalError(
                "MAINTENANCE_FENCE_ALREADY_PRESENT",
                "e2e/.artifact-maintenance fence already exists; another maintenance operation or unclosed hold is active.",
                78,
            ) from exc

        # 2. Pin physical artifact root identity (dev:ino) and verify zero open writer leases.
        artifacts_fd = open_dir_nofollow("artifacts", dir_fd=e2e_fd)
        try:
            art_st = os.fstat(artifacts_fd)
            epoch_name = f"dev-{art_st.st_dev}-ino-{art_st.st_ino}"
            lease_summary = check_writer_leases(e2e_fd, epoch_name)

            now_epoch = time.time()
            cutoff_epoch = now_epoch - (float(args.older_than_days) * 86400.0)

            selected_runs: list[str] = []
            skipped_protected: list[str] = []
            skipped_recent: list[str] = []

            for entry in sorted(os.listdir(artifacts_fd)):
                if entry in (".", ".."):
                    continue
                st = os.lstat(entry, dir_fd=artifacts_fd)
                if stat.S_ISLNK(st.st_mode):
                    raise ArchivalError(
                        "SYMLINK_TRAVERSAL_REFUSED",
                        f"Refused top-level symlink in e2e/artifacts: {entry}.",
                        1,
                    )
                if not stat.S_ISDIR(st.st_mode):
                    raise ArchivalError(
                        "SPECIAL_NODE_REFUSED",
                        f"Refused non-directory top-level node in e2e/artifacts: {entry}.",
                        1,
                    )
                run_fd = open_dir_nofollow(entry, dir_fd=artifacts_fd)
                try:
                    run_st = os.fstat(run_fd)
                    if not args.include_protected and has_sbh_protect(run_fd):
                        skipped_protected.append(entry)
                        continue
                    if args.older_than_days > 0 and run_st.st_mtime > cutoff_epoch:
                        skipped_recent.append(entry)
                        continue
                    selected_runs.append(entry)
                finally:
                    os.close(run_fd)

            file_hashes: dict[str, str] = {}
            stats = {"dir_count": 0, "file_count": 0, "total_bytes": 0}
            archive_sha256: str | None = None
            manifest_path: Path | None = None

            if args.dry_run:
                for run_name in selected_runs:
                    run_fd = open_dir_nofollow(run_name, dir_fd=artifacts_fd)
                    try:
                        stats["dir_count"] += 1
                        walk_run_dir(run_fd, run_name, None, file_hashes, stats)
                    finally:
                        os.close(run_fd)
            else:
                assert dest_path is not None
                dest_path.parent.mkdir(parents=True, exist_ok=True)
                with tarfile.open(dest_path, "w:gz") as tar:
                    for run_name in selected_runs:
                        run_fd = open_dir_nofollow(run_name, dir_fd=artifacts_fd)
                        try:
                            run_st = os.fstat(run_fd)
                            stats["dir_count"] += 1
                            info = tarfile.TarInfo(name=run_name)
                            info.type = tarfile.DIRTYPE
                            info.mode = 0o755
                            info.mtime = int(run_st.st_mtime)
                            tar.addfile(info)
                            walk_run_dir(run_fd, run_name, tar, file_hashes, stats)
                        finally:
                            os.close(run_fd)

                # Re-verify artifact root physical identity did not shift mid-archive.
                art_st_after = os.fstat(artifacts_fd)
                if art_st_after.st_dev != art_st.st_dev or art_st_after.st_ino != art_st.st_ino:
                    raise ArchivalError("FILESYSTEM_DRIFT_DETECTED", "Artifact root identity changed during archival.", 1)

                archive_sha256 = verify_archive_integrity(dest_path, file_hashes)
                manifest_path = Path(f"{dest_path}.sha256.json")
                manifest = {
                    "schema_version": 1,
                    "epoch": epoch_name,
                    "created_at_unix": int(now_epoch),
                    "older_than_days": args.older_than_days,
                    "archive_sha256": archive_sha256,
                    "archive_bytes": dest_path.stat().st_size,
                    "selected_run_count": len(selected_runs),
                    "selected_runs": selected_runs,
                    "skipped_protected_count": len(skipped_protected),
                    "skipped_recent_count": len(skipped_recent),
                    "file_count": stats["file_count"],
                    "dir_count": stats["dir_count"],
                    "source_bytes": stats["total_bytes"],
                    "deleted_files": 0,
                    "rule_1_notice": "No source files were deleted. Operator must explicitly approve and run cleanup separately after verifying the archive.",
                    "files_sha256": file_hashes,
                }
                manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

            emit(
                "pass",
                "ARTIFACT_ARCHIVAL_DRY_RUN_OK" if args.dry_run else "ARTIFACT_ARCHIVAL_VERIFIED_NO_DELETE",
                {
                    "epoch": epoch_name,
                    "checked_leases": lease_summary["checked_leases"],
                    "selected_run_count": len(selected_runs),
                    "skipped_protected_count": len(skipped_protected),
                    "skipped_recent_count": len(skipped_recent),
                    "file_count": stats["file_count"],
                    "source_bytes": stats["total_bytes"],
                    "deleted_files": 0,
                    **({"archive_sha256": archive_sha256} if archive_sha256 else {}),
                },
            )
            return 0
        finally:
            os.close(artifacts_fd)
    finally:
        if fence_acquired:
            try:
                os.rmdir(".artifact-maintenance", dir_fd=e2e_fd)
            except OSError:
                pass
        os.close(e2e_fd)


def main() -> int:
    parser = argparse.ArgumentParser(description="Race-safe POSIX openat/O_NOFOLLOW e2e/artifacts archival tool.")
    parser.add_argument("--root", required=True, help="Repository root containing e2e/artifacts")
    parser.add_argument("--dest", default="", help="Destination .tar.gz path strictly outside e2e/artifacts")
    parser.add_argument("--older-than-days", type=float, default=7.0, help="Archive closed runs older than N days")
    parser.add_argument("--dry-run", action="store_true", help="Acquire fence, verify leases & tree via openat/O_NOFOLLOW, report plan without writing")
    parser.add_argument("--include-protected", action="store_true", help="Include directories carrying .sbh-protect (default: skip)")
    args = parser.parse_args()

    try:
        return run_archival(args)
    except ArchivalError as err:
        emit("blocked" if err.exit_code == 78 else "fail", err.code, {"detail": err.message, "deleted_files": 0})
        return err.exit_code


if __name__ == "__main__":
    sys.exit(main())
