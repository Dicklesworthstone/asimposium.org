/**
 * Shared W9.2 Secret/PII Canary & Lookalike Corpus (bead asimposiumorg-xka).
 *
 * Every secret/PII value below is strictly synthetic and non-live. Both the
 * Worker (`apps/wire/src/screening/credential-scan.ts` + `apps/wire/src/krater/cas.ts`)
 * and the Rust CLI (`cli/src/scrub.rs`) are evaluated against this exact corpus
 * and policy version so the two walls cannot drift.
 */

import { CREDENTIAL_SCAN_POLICY_VERSION } from "../../apps/wire/src/screening/credential-scan.ts";

export const W92_CORPUS_VERSION = "w9.2-canary-corpus-v1" as const;
export const W92_POLICY_VERSION = CREDENTIAL_SCAN_POLICY_VERSION;

export interface SecretCanaryVector {
  readonly id: string;
  readonly coarse_class:
    | "fellow-token"
    | "prefixed-grant"
    | "enrollment-secret"
    | "private-key"
    | "api-key"
    | "access-token"
    | "personal-address"
    | "benign-lookalike";
  /** "both" => ledger + artifact reject; "artifact-only" => artifact CAS rejects, ledger math prose allows; "clean" => neither rejects. */
  readonly wall: "both" | "artifact-only" | "clean";
  readonly payload: string;
  /** Exact synthetic canary substrings that must NEVER appear in any error response, public face, D1 table, FTS5 search, export, or OPS.2a diagnostic. */
  readonly forbidden_canaries: readonly string[];
  /** Whether --ack-false-positive is permitted in `asimp scrub`. */
  readonly ack_allowed: boolean;
}

const FELLOW_TOKEN = `asimp_ag_${"0123456789ABCDEFGHJKMNPQRS"}_${"K".repeat(43)}`;
const PREFIXED_GRANT = `asimp_op_${"m".repeat(32)}`;
const JOIN_SECRET = `v1.${"Z".repeat(43)}`;
const JOIN_URL = `https://a.asimposium.org/join/ASIMP-EN-CANARY012345#${JOIN_SECRET}`;
const FLOW_HANDLE = `flow_v1.${"f".repeat(43)}`;
const PEM_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE=\n-----END OPENSSH PRIVATE KEY-----";
const AWS_KEY = "AKIAW92CANARYTESTKEY";
const GOOGLE_KEY = `AIza${"G".repeat(35)}`;
const ANTHROPIC_KEY = `sk-ant-${"a".repeat(40)}`;
const STRIPE_KEY = `sk_live_${"s".repeat(24)}`;
const GITHUB_PAT = `ghp_${"g".repeat(36)}`;
const SLACK_TOKEN = `xoxb-${"1".repeat(12)}-${"2".repeat(12)}`;
const JWT_TOKEN = `eyJ${"h".repeat(12)}.eyJ${"p".repeat(12)}.${"s".repeat(16)}`;
const AUTHJS_COOKIE = `__Host-authjs.session-token=canary_cookie_${"c".repeat(24)}`;
const SERVICE_ENVELOPE = `asimp-service-envelope: {"claims":{"iss":"agora","sub":"usr_canary"},"signature":"${"e".repeat(32)}"}`;
const DB_URI_PASS = "canary_pg_pass_987654";
const DB_URI = `postgresql://researcher:${DB_URI_PASS}@db.example.invalid:5432/ledger`;
const ENV_SECRET = "canary_env_secret_777777";
const PERSONAL_EMAIL = "canary.researcher.w92@example.org";

function jsonUnicodeEscape(value: string): string {
  return Array.from(value, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
}

export const W92_CANARY_VECTORS: readonly SecretCanaryVector[] = Object.freeze([
  {
    id: "canary-fellow-token",
    coarse_class: "fellow-token",
    wall: "both",
    payload: `Verification note with leaked bearer ${FELLOW_TOKEN} in prose.`,
    forbidden_canaries: [FELLOW_TOKEN, "K".repeat(20)],
    ack_allowed: false,
  },
  {
    id: "canary-prefixed-grant",
    coarse_class: "prefixed-grant",
    wall: "both",
    payload: `Operator grant leak ${PREFIXED_GRANT} inside draft.`,
    forbidden_canaries: [PREFIXED_GRANT],
    ack_allowed: false,
  },
  {
    id: "canary-join-fragment-url",
    coarse_class: "enrollment-secret",
    wall: "both",
    payload: `Copied join URL ${JOIN_URL} accidentally.`,
    forbidden_canaries: [JOIN_SECRET, "Z".repeat(20)],
    ack_allowed: false,
  },
  {
    id: "canary-bare-enrollment-secret",
    coarse_class: "enrollment-secret",
    wall: "both",
    payload: `Astral prefix 𝔽 ${JOIN_SECRET} on line 1.`,
    forbidden_canaries: [JOIN_SECRET],
    ack_allowed: false,
  },
  {
    id: "canary-flow-handle",
    coarse_class: "prefixed-grant",
    wall: "both",
    payload: `Device poll handle ${FLOW_HANDLE} pasted into scratch.`,
    forbidden_canaries: [FLOW_HANDLE],
    ack_allowed: false,
  },
  {
    id: "canary-pem-private-key",
    coarse_class: "private-key",
    wall: "both",
    payload: `Attached key:\n${PEM_KEY}`,
    forbidden_canaries: ["BEGIN OPENSSH PRIVATE KEY", "b3BlbnNzaC1rZXktdjE="],
    ack_allowed: false,
  },
  {
    id: "canary-aws-api-key",
    coarse_class: "api-key",
    wall: "both",
    payload: `Cloud key ${AWS_KEY} left in computation script.`,
    forbidden_canaries: [AWS_KEY],
    ack_allowed: true,
  },
  {
    id: "canary-google-api-key",
    coarse_class: "api-key",
    wall: "both",
    payload: `Client config ${GOOGLE_KEY} exported.`,
    forbidden_canaries: [GOOGLE_KEY],
    ack_allowed: true,
  },
  {
    id: "canary-anthropic-api-key",
    coarse_class: "api-key",
    wall: "both",
    payload: `Harness key ${ANTHROPIC_KEY} echoed.`,
    forbidden_canaries: [ANTHROPIC_KEY],
    ack_allowed: true,
  },
  {
    id: "canary-stripe-live-key",
    coarse_class: "api-key",
    wall: "both",
    payload: `Billing key ${STRIPE_KEY} leaked.`,
    forbidden_canaries: [STRIPE_KEY],
    ack_allowed: true,
  },
  {
    id: "canary-github-pat",
    coarse_class: "access-token",
    wall: "both",
    payload: `Repo token ${GITHUB_PAT} inside log.`,
    forbidden_canaries: [GITHUB_PAT],
    ack_allowed: true,
  },
  {
    id: "canary-slack-token",
    coarse_class: "access-token",
    wall: "both",
    payload: `Webhook bot ${SLACK_TOKEN} copied.`,
    forbidden_canaries: [SLACK_TOKEN],
    ack_allowed: true,
  },
  {
    id: "canary-jwt-oauth",
    coarse_class: "access-token",
    wall: "both",
    payload: `OAuth bearer ${JWT_TOKEN} pasted.`,
    forbidden_canaries: [JWT_TOKEN],
    ack_allowed: true,
  },
  {
    id: "canary-authjs-session-cookie",
    coarse_class: "access-token",
    wall: "both",
    payload: `Cookie: ${AUTHJS_COOKIE}; Path=/`,
    forbidden_canaries: [AUTHJS_COOKIE, `canary_cookie_${"c".repeat(24)}`],
    ack_allowed: true,
  },
  {
    id: "canary-service-envelope-header",
    coarse_class: "access-token",
    wall: "both",
    payload: `Forwarded header\n${SERVICE_ENVELOPE}`,
    forbidden_canaries: [SERVICE_ENVELOPE, "e".repeat(24)],
    ack_allowed: true,
  },
  {
    id: "canary-connection-uri",
    coarse_class: "access-token",
    wall: "both",
    payload: `Database URL ${DB_URI}`,
    forbidden_canaries: [DB_URI_PASS, DB_URI],
    ack_allowed: true,
  },
  {
    id: "canary-dotenv-assignment",
    coarse_class: "access-token",
    wall: "both",
    payload: `DB_PASSWORD="${ENV_SECRET}"`,
    forbidden_canaries: [ENV_SECRET],
    ack_allowed: true,
  },
  {
    id: "canary-json-escaped-key-and-shadow",
    coarse_class: "access-token",
    wall: "both",
    payload: `{"${jsonUnicodeEscape("DB_PASSWORD")}":"${jsonUnicodeEscape(ENV_SECRET)}","payload":"${jsonUnicodeEscape(GITHUB_PAT)}","payload":"clean"}`,
    forbidden_canaries: [ENV_SECRET, GITHUB_PAT],
    ack_allowed: true,
  },
  {
    id: "canary-artifact-personal-email",
    coarse_class: "personal-address",
    wall: "artifact-only",
    payload: `Author correspondence: ${PERSONAL_EMAIL} (artifact dataset header).`,
    forbidden_canaries: [PERSONAL_EMAIL],
    ack_allowed: true,
  },
  {
    id: "benign-lean-at-syntax-ledger-clean",
    coarse_class: "personal-address",
    wall: "artifact-only",
    payload: "theorem sum_bound (h : n > 0) : n >= 1 := by rw [h@Nat.succ_le]; exact h",
    forbidden_canaries: [],
    ack_allowed: true,
  },
  {
    id: "benign-math-lean-lookalike",
    coarse_class: "benign-lookalike",
    wall: "clean",
    payload: [
      "theorem sum_bound (h : n > 0) : n >= 1 := by exact Nat.succ_le_of_lt h",
      "Let sk-1 = s_k - 1 and let AKIA be the finite incidence algebra over F_q.",
      "The prefix asimp_ag_ names Fellow credentials; __Host-authjs.session-token is host-only.",
      "Header asimp-service-envelope authenticates sponsor calls; DB_PASSWORD=$" + "{DB_PASSWORD}",
      "Protocol v1.2, workflow_v1.0000000000000000000000000000000000000000000 and token_count = 42.",
      'Placeholders: DB_PASSWORD="<redacted>" API_KEY=process.env.API_KEY',
    ].join("\n"),
    forbidden_canaries: [],
    ack_allowed: true,
  },
]);
