import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type {
  SponsorFellowSummary,
  SponsorFellowTransferManifest,
  SponsorFellowTransferSummary,
} from "@asimposium/contracts";
import { Children, isValidElement, type ReactElement, type ReactNode, useState } from "react";
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

type ManagerProps = Parameters<typeof card.TransferManager>[0];

function managerProps(fellows: readonly SponsorFellowSummary[]): ManagerProps {
  return {
    sponsorId: "usr_receiver",
    recoveryOwner: "a".repeat(64),
    fellows,
    incoming: [],
    outgoing: [],
    loaded: true,
    rebinds: [],
    rebindsLoaded: true,
    configured: true,
  };
}

function eligibleFellow(id: string): SponsorFellowSummary {
  return {
    fellow_id: id,
    name: "redshift",
    model: "provider/model-v1",
    harness: "codex",
    status: "paused",
    granted_scopes: ["promote"],
    granted_resources: {},
    granted_at: manifest.fellow_created_at,
    credentials: [],
  };
}

function control(
  node: ReactNode,
  tag: string,
  inputType?: string,
): ReactElement<Record<string, unknown>> | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<Record<string, unknown>>(child)) continue;
    if (child.type === tag && (inputType === undefined || child.props.type === inputType))
      return child;
    const found = control(child.props.children as ReactNode, tag, inputType);
    if (found) return found;
  }
  return undefined;
}

/** Use React's real hook rerenders with updated props while retaining the
 * manager's state in this harness. This does not simulate a browser: assertions
 * inspect controlled values, because HTML can visually select the first option
 * even when the submitted React value is stale. */
function refreshManager(
  phases: readonly ManagerProps[],
  beforeRefresh?: (tree: ReactNode) => void,
): ReactNode {
  let latest: ReactNode;
  function RefreshHarness() {
    const [phase, setPhase] = useState(0);
    const props = phases[phase];
    if (!props) throw new Error("Missing refresh phase");
    // Sharing this component's hook lifetime models a same-principal refresh,
    // which preserves TransferManager rather than mounting a fresh instance.
    const tree = card.TransferManager(props);
    latest = tree;
    if (phase < phases.length - 1) {
      if (phase === 0) beforeRefresh?.(tree);
      setPhase(phase + 1);
    }
    return tree;
  }
  renderToStaticMarkup(<RefreshHarness />);
  return latest;
}

function chooseAndConfirm(tree: ReactNode, fellowId: string) {
  const form = control(tree, "form");
  const select = control(form, "select");
  const confirmation = control(form, "input", "checkbox");
  if (!select || !confirmation) throw new Error("Offer controls are missing");
  (select.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: fellowId },
  });
  (confirmation.props.onChange as (event: { target: { checked: boolean } }) => void)({
    target: { checked: true },
  });
}

test("accepting the first Fellow refreshes the new-offer value from empty to its eligible identity", () => {
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
  const tree = refreshManager([
    { ...managerProps([]), incoming: [transfer] },
    {
      ...managerProps([eligibleFellow(manifest.fellow_id)]),
      incoming: [{ ...transfer, status: "accepted", resolved_at: manifest.fellow_created_at + 1 }],
    },
  ]);
  const form = control(tree, "form");
  expect(control(form, "select")?.props.value).toBe(manifest.fellow_id);
  expect(control(form, "input", "checkbox")?.props.checked).toBe(false);
});

test("removing the selected Fellow replaces the submitted value and clears its prior confirmation", () => {
  const first = eligibleFellow(manifest.fellow_id);
  const removed = eligibleFellow("F-01JXYZ4K6R");
  const tree = refreshManager(
    [managerProps([first, removed]), managerProps([first])],
    (initial) => chooseAndConfirm(initial, removed.fellow_id),
  );
  const form = control(tree, "form");
  expect(control(form, "select")?.props.value).toBe(first.fellow_id);
  expect(control(form, "input", "checkbox")?.props.checked).toBe(false);
});

test("losing all eligible Fellows removes the offer form and cannot revive old confirmation", () => {
  const first = eligibleFellow(manifest.fellow_id);
  const unavailable = refreshManager(
    [managerProps([first]), managerProps([])],
    (initial) => chooseAndConfirm(initial, first.fellow_id),
  );
  expect(control(unavailable, "form")).toBeUndefined();
  const returned = refreshManager(
    [managerProps([first]), managerProps([]), managerProps([first])],
    (initial) => chooseAndConfirm(initial, first.fellow_id),
  );
  const form = control(returned, "form");
  expect(control(form, "select")?.props.value).toBe(first.fellow_id);
  expect(control(form, "input", "checkbox")?.props.checked).toBe(false);
});
