/**
 * Short-lived (60s TTL), single-use Ed25519 capability tickets for private
 * sponsor workshop rooms on Stoa (Fable §11, S-6 host-only cookie isolation).
 *
 * The sponsor's Auth.js cookie stays strictly on asimposium.org (Agora).
 * Agora calls POST /v1/sponsors/workshop/room-ticket over the signed service
 * envelope; Stoa verifies live ownership and mints a 60s Ed25519 ticket.
 * The browser opens WS to a.asimposium.org/v1/workshop-room (zero cookies,
 * zero ticket in URL) and presents {"auth":"<ticket>"} as the first WS frame.
 * The HeraldRoom DO verifies the Ed25519 signature, consumes the nonce
 * atomically in DO storage (single-use), and rechecks live D1 ownership on
 * connect, nudge, and periodic alarm.
 */

import type { D1Database } from "@cloudflare/workers-types";
import {
  HERALD_ROOM_LIMITS,
  roomCursor,
  roomId,
  roomProblem,
} from "../../../../packages/contracts/src/herald-room-model.ts";
import { checkpointSigningKey, checkpointVerifyKeys } from "../krater/checkpoint-signing.ts";

const TICKET_DOMAIN_PREFIX = "ASIMPOSIUM-HERALD-WORKSHOP-TICKET-V1\n";
const MAX_TICKET_BYTES = 800;
const HEX32 = /^[0-9a-f]{32}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CLOCK_SKEW_SECONDS = 5;

export interface MintedWorkshopRoomTicket {
  readonly ticket: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly expMs: number;
}

export interface VerifiedWorkshopRoomTicket {
  readonly sponsorId: string;
  readonly fellowId: string;
  readonly problemId: string;
  readonly nonce: string;
  readonly expMs: number;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL.test(value)) return null;
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function randomNonceHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mint a 60s Ed25519 workshop room capability ticket. Returns null when the
 * Ed25519 signing key is absent or malformed (caller must fail closed with 503). */
export async function mintWorkshopRoomTicket(
  input: {
    readonly sponsorId: string;
    readonly fellowId: string;
    readonly problemId: string;
  },
  rawSigningKey: string | undefined,
  nowMs: number = Date.now(),
): Promise<MintedWorkshopRoomTicket | null> {
  if (!roomId(input.sponsorId) || !roomId(input.fellowId) || !roomProblem(input.problemId)) {
    return null;
  }
  const key = await checkpointSigningKey(rawSigningKey);
  if (key === null) return null;
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + HERALD_ROOM_LIMITS.workshopTicketTtlSeconds;
  const nonce = randomNonceHex();
  const payloadJson = JSON.stringify({
    v: 1,
    purpose: "herald-workshop-room",
    kid: key.kid,
    sponsor_id: input.sponsorId,
    fellow_id: input.fellowId,
    problem_id: input.problemId,
    nonce,
    iat,
    exp,
  });
  const payloadB64 = bytesToBase64Url(new TextEncoder().encode(payloadJson));
  const message = new TextEncoder().encode(`${TICKET_DOMAIN_PREFIX}${payloadB64}`);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, message),
  );
  const ticket = `${payloadB64}.${bytesToBase64Url(signature)}`;
  return {
    ticket,
    expiresAt: new Date(exp * 1000).toISOString(),
    nonce,
    expMs: exp * 1000,
  };
}

/** Verify an Ed25519 workshop room capability ticket cryptographically and
 * enforce the 60s TTL ceiling. Replay consumption is enforced separately in
 * DO durable storage so tickets are strictly single-use. */
export async function verifyWorkshopRoomTicket(
  ticket: string,
  keys: { readonly signingKey?: string; readonly verifyKeys?: string },
  nowMs: number = Date.now(),
): Promise<VerifiedWorkshopRoomTicket | null> {
  if (typeof ticket !== "string" || ticket.length === 0 || ticket.length > MAX_TICKET_BYTES) {
    return null;
  }
  const dot = ticket.indexOf(".");
  if (dot <= 0 || dot !== ticket.lastIndexOf(".")) return null;
  const payloadB64 = ticket.slice(0, dot);
  const sigB64 = ticket.slice(dot + 1);
  const payloadBytes = base64UrlToBytes(payloadB64);
  const sigBytes = base64UrlToBytes(sigB64);
  if (payloadBytes === null || sigBytes === null || sigBytes.byteLength !== 64) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  const ttl = HERALD_ROOM_LIMITS.workshopTicketTtlSeconds;
  const nowSec = Math.floor(nowMs / 1000);
  if (
    p.v !== 1 ||
    p.purpose !== "herald-workshop-room" ||
    typeof p.kid !== "string" ||
    !roomId(p.sponsor_id) ||
    !roomId(p.fellow_id) ||
    !roomProblem(p.problem_id) ||
    typeof p.nonce !== "string" ||
    !HEX32.test(p.nonce) ||
    typeof p.iat !== "number" ||
    typeof p.exp !== "number" ||
    !Number.isSafeInteger(p.iat) ||
    !Number.isSafeInteger(p.exp) ||
    p.exp <= p.iat ||
    p.exp - p.iat > ttl ||
    // Expiry is exclusive, matching eviction of the durable replay record.
    nowSec >= p.exp ||
    nowSec < p.iat - CLOCK_SKEW_SECONDS
  ) {
    return null;
  }

  const candidatePubHexes: string[] = [];
  const activeKey = await checkpointSigningKey(keys.signingKey);
  if (activeKey !== null && activeKey.kid === p.kid) {
    candidatePubHexes.push(activeKey.publicKeyHex);
  }
  for (const verify of checkpointVerifyKeys(keys.verifyKeys)) {
    if (verify.kid === p.kid && !candidatePubHexes.includes(verify.publicKeyHex)) {
      candidatePubHexes.push(verify.publicKeyHex);
    }
  }
  if (candidatePubHexes.length === 0) return null;

  const message = new TextEncoder().encode(`${TICKET_DOMAIN_PREFIX}${payloadB64}`);
  for (const pubHex of candidatePubHexes) {
    try {
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        hexToBytes(pubHex),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const valid = await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, sigBytes, message);
      if (valid) {
        return {
          sponsorId: p.sponsor_id,
          fellowId: p.fellow_id,
          problemId: p.problem_id,
          nonce: p.nonce,
          expMs: p.exp * 1000,
        };
      }
    } catch {
      // Try next candidate key for the same kid, if any.
    }
  }
  return null;
}

/** Authoritative live workshop room authorization + head cursor read.
 * Refuses transferred, revoked, compromised, archived Fellows, suspended or
 * tombstoned sponsors, and erased private drafts. Never loads draft bodies. */
export async function liveWorkshopRoomHead(
  db: D1Database,
  sponsorId: string,
  fellowId: string,
  problemId: string,
): Promise<{ readonly cursor: number } | null> {
  if (!roomId(sponsorId) || !roomId(fellowId) || !roomProblem(problemId)) return null;
  const row = await db
    .prepare(
      `SELECT f.fellow_id,
              (SELECT COALESCE(MAX(w.workshop_seq), 0)
               FROM workshop_objects w
               WHERE w.fellow_id = f.fellow_id AND w.problem_id = p.id) AS workshop_cursor
       FROM enrollment_fellows f
       JOIN sponsors s ON s.sponsor_id = f.sponsor_id AND s.tombstoned_at IS NULL
       JOIN problems p ON p.id = ?
       WHERE f.fellow_id = ? AND f.sponsor_id = ?
         AND f.status NOT IN ('revoked', 'compromised', 'archived')
         AND (
           p.status <> 'private-draft'
           OR p.sponsor_id = s.sponsor_id
           OR EXISTS (
             SELECT 1 FROM problem_memberships pm
             WHERE pm.problem_id = p.id AND pm.fellow_id = f.fellow_id
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM sponsor_suspension_events se WHERE se.sponsor_id = s.sponsor_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM private_draft_erasures e WHERE e.problem_id = p.id
         )`,
    )
    .bind(problemId, fellowId, sponsorId)
    .first<{ fellow_id: string; workshop_cursor: number }>();
  if (row === null || row === undefined || !roomCursor(row.workshop_cursor)) return null;
  return { cursor: row.workshop_cursor };
}
