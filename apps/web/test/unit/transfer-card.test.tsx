import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type {
  SponsorFellowTransferManifest,
  SponsorFellowTransferSummary,
} from "@asimposium/contracts";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("server-only", () => ({}));
let realNavigation: typeof import("next/navigation");
let card: typeof import("../../app/console/transfer-card");
beforeAll(async () => {
  realNavigation = { ...(await import("next/navigation")) };
  mock.module("next/navigation", () => ({
    ...realNavigation,
    useRouter: () => ({ refresh: () => undefined }),
  }));
  const path: string = "../../app/console/transfer-card?transfer-card-test";
  card = (await import(path)) as typeof card;
});
afterAll(() => {
  mock.module("next/navigation", () => realNavigation);
});

const manifest: SponsorFellowTransferManifest = {
  fellow_id: "F-01JXYZ4K6Q",
  name: "redshift",
  model: "provider/model-v1",
  harness: "codex",
  fellow_created_at: 1_793_016_000_000,
  status: "paused",
  open_problem_memberships: ["P-ALPHA", "P-BETA"],
  directive_disclosure_status: "unresolved",
  pre_transfer_directive_count: 3,
  private_workshop_access_moves: true,
  historical_directive_bodies_disclosed: false,
  credential_rotation_required: true,
  public_attribution_immutable: true,
};

test("the transfer manifest exposes concrete memberships, prior influence and credential consequences before acceptance", () => {
  const html = renderToStaticMarkup(<card.TransferManifest manifest={manifest} />);
  for (const detail of [
    "P-ALPHA, P-BETA",
    "paused",
    "3 prior sponsor directives",
    "influence is unresolved",
    "cannot attest on the previous sponsor",
    "revokes all existing credentials",
    "private workshop access to the receiving sponsor",
    "public attribution stays unchanged",
  ])
    expect(html).toContain(detail);
  expect(html).not.toContain("authIssuedAt");
  expect(html).not.toContain("rebind_url");
});

test("each recorded disclosure state is distinguished without guessing scientific clearance", () => {
  const states = {
    no_directives: "No prior directive influence is recorded",
    attested_no_material_influence: "prior sponsor recorded no material undisclosed influence",
    disclosed: "influence has a recorded disclosure",
    unresolved: "influence is unresolved",
  } as const;
  for (const [status, phrase] of Object.entries(states)) {
    const html = renderToStaticMarkup(
      <card.TransferManifest
        manifest={{
          ...manifest,
          directive_disclosure_status:
            status as SponsorFellowTransferManifest["directive_disclosure_status"],
        }}
      />,
    );
    expect(html).toContain(phrase);
    expect(html).not.toContain("scientifically verified");
    expect(html).not.toContain("automatic approval");
  }
});

test("incoming offers require explicit manifest review and cannot mutate before browser recovery is ready", () => {
  const transfer: SponsorFellowTransferSummary = {
    transfer_id: `TRF-${"0".repeat(26)}`,
    fellow_id: manifest.fellow_id,
    source_sponsor_id: "usr_sender",
    target_sponsor_id: "usr_receiver",
    status: "pending",
    created_at: manifest.fellow_created_at,
    expires_at: manifest.fellow_created_at + 86_400_000,
    resolved_at: null,
    manifest,
  };
  const html = renderToStaticMarkup(
    <card.TransferManager
      sponsorId="usr_receiver"
      recoveryOwner={"a".repeat(64)}
      fellows={[]}
      incoming={[transfer]}
      outgoing={[]}
      loaded
      rebinds={[]}
      rebindsLoaded
      configured
    />,
  );
  expect(html).toContain("I reviewed this Fellow");
  expect(html).toContain(
    "memberships, prior directive disclosure, private access and credential changes",
  );
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Accept transfer<\/button>/);
  expect(html).toContain("P-ALPHA, P-BETA");
  expect(html).not.toContain("data-rebind-url");
});
