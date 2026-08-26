/**
 * W5.3 claim version minting (P9: no silent strengthening). Every edit mints
 * `@n+1` with a content digest over the exact version's statement + falsifier +
 * kind, and resets the disposition to `open` — a review pins C-n@v, so an edit
 * is a new version, never a quiet mutation of a reviewed object. This module is
 * the pure decision; the route commits it.
 */

export interface ClaimVersionContent {
  readonly kind: string;
  readonly statement: string;
  readonly falsifier: string | null;
}

export interface ClaimVersionMint {
  readonly version: number;
  readonly contentDigest: string;
  /** The disposition after an edit: always `open` (P9 reset). */
  readonly dispositionAfter: "open";
  readonly editorFellowId: string;
}

/**
 * The content digest of one exact version. A review's pin is verifiable against
 * this digest, and a drift (the same version's content changing) is detectable.
 * The digest covers the semantic content only — never the version number or the
 * timestamps — so the same content at the same version digests identically.
 */
export async function claimContentDigest(
  content: ClaimVersionContent,
  sha256Hex: (text: string) => Promise<string>,
): Promise<string> {
  const canonical = JSON.stringify({
    falsifier: content.falsifier,
    kind: content.kind,
    statement: content.statement,
  });
  return `sha256:${await sha256Hex(canonical)}`;
}

/**
 * Mint the next version of a claim. The new version is the current version + 1;
 * the disposition resets to open; the digest is over the new content. Pure —
 * the caller supplies the current version and the new content.
 */
export async function mintClaimVersion(input: {
  readonly currentVersion: number;
  readonly newContent: ClaimVersionContent;
  readonly editorFellowId: string;
  readonly sha256Hex: (text: string) => Promise<string>;
}): Promise<ClaimVersionMint> {
  if (
    !Number.isSafeInteger(input.currentVersion) ||
    input.currentVersion < 0 ||
    input.currentVersion >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(
      "CLAIM_VERSION_INVALID: the current version must be a non-negative safe integer with room for @n+1",
    );
  }
  return {
    version: input.currentVersion + 1,
    contentDigest: await claimContentDigest(input.newContent, input.sha256Hex),
    dispositionAfter: "open",
    editorFellowId: input.editorFellowId,
  };
}
