import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { SponsorFellowSummary } from "@asimposium/contracts";
import { Children, isValidElement, type ReactElement, type ReactNode, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("server-only", () => ({}));
let realNavigation: typeof import("next/navigation");
let card: typeof import("../../app/console/directive-card");
beforeAll(async () => {
  realNavigation = { ...(await import("next/navigation")) };
  mock.module("next/navigation", () => ({
    ...realNavigation,
    useRouter: () => ({ refresh: () => undefined }),
  }));
  const path: string = "../../app/console/directive-card?directive-card-test";
  card = (await import(path)) as typeof card;
});
afterAll(() => {
  mock.module("next/navigation", () => realNavigation);
});

type ManagerProps = Parameters<typeof card.DirectiveManager>[0];

function managerProps(fellows: readonly SponsorFellowSummary[]): ManagerProps {
  return { fellows, directives: [], configured: true };
}

function fellow(id: string): SponsorFellowSummary {
  return {
    fellow_id: id,
    name: id,
    model: "provider/model-v1",
    harness: "codex",
    status: "active",
    granted_scopes: ["promote"],
    granted_resources: {},
    granted_at: 1_793_016_000_000,
    credentials: [],
  };
}

const first = fellow("F-01JXYZ4K6Q");
const second = fellow("F-01JXYZ4K6R");
const newest = fellow("F-01JXYZ4K6S");
const draft = "Investigate the simply-connected case before extending the claim.";

function controls(
  node: ReactNode,
  tag: string,
): ReactElement<Record<string, unknown>>[] {
  const found: ReactElement<Record<string, unknown>>[] = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement<Record<string, unknown>>(child)) continue;
    if (child.type === tag) found.push(child);
    found.push(...controls(child.props.children as ReactNode, tag));
  }
  return found;
}

function control(node: ReactNode, tag: string, index = 0): ReactElement<Record<string, unknown>> {
  const found = controls(node, tag)[index];
  if (!found) throw new Error("Missing directive control: " + tag);
  return found;
}

function change(node: ReactNode, tag: string, value: string, index = 0): void {
  (control(node, tag, index).props.onChange as (event: { target: { value: string } }) => void)({
    target: { value },
  });
}

function deliveryButton(node: ReactNode): ReactElement<Record<string, unknown>> {
  const button = controls(node, "button").find((item) => item.props.children === "Deliver directive");
  if (!button) throw new Error("Missing directive delivery button");
  return button;
}

/** Same-principal refreshes preserve the actual component's hook state.
 * Use React's real rerenders, as in transfer-card.test.tsx; no browser or
 * authenticated delivery is simulated. Assert controlled values because HTML
 * may display the first option while the submitted React selection is empty. */
function refreshManager(
  phases: readonly ManagerProps[],
  beforeRefresh?: (tree: ReactNode, phase: number) => void,
): ReactNode {
  let latest: ReactNode;
  function RefreshHarness() {
    const [phase, setPhase] = useState(0);
    const props = phases[phase];
    if (!props) throw new Error("Missing refresh phase");
    const tree = card.DirectiveManager(props);
    latest = tree;
    if (phase < phases.length - 1) {
      beforeRefresh?.(tree, phase);
      setPhase(phase + 1);
    }
    return tree;
  }
  renderToStaticMarkup(<RefreshHarness />);
  return latest;
}

function prepareDraft(tree: ReactNode): void {
  change(tree, "select", "forbid", 1);
  change(tree, "textarea", draft);
}

function expectDraft(tree: ReactNode): void {
  expect(control(tree, "select", 1).props.value).toBe("forbid");
  expect(control(tree, "textarea").props.value).toBe(draft);
}

function expectRecipientChoice(tree: ReactNode): void {
  expect(control(tree, "select").props.value).toBe("");
  expect(deliveryButton(tree).props.disabled).toBe(true);
  expect(controls(tree, "option").some((option) => option.props.value === "")).toBe(true);
  const html = renderToStaticMarkup(tree);
  expect(html).toContain("previously selected Fellow is no longer available");
  expect(html).toContain("Your directive draft is kept. Choose its recipient");
  expectDraft(tree);
}

test("approving the first Fellow makes the retained directive draft deliverable after refresh", () => {
  const tree = refreshManager(
    [managerProps([]), managerProps([first])],
    (initial) => {
      expect(control(initial, "select").props.value).toBe("");
      expect(deliveryButton(initial).props.disabled).toBe(true);
      prepareDraft(initial);
    },
  );
  expect(control(tree, "select").props.value).toBe(first.fellow_id);
  expect(control(tree, "select").props.disabled).toBe(false);
  expect(deliveryButton(tree).props.disabled).toBe(false);
  expectDraft(tree);
  expect(renderToStaticMarkup(tree)).not.toContain("previously selected Fellow");
});

test("the first newly available recipient stays selected when another Fellow arrives", () => {
  const tree = refreshManager(
    [managerProps([]), managerProps([first]), managerProps([newest, first])],
    (initial, phase) => {
      if (phase === 0) prepareDraft(initial);
    },
  );
  expect(control(tree, "select").props.value).toBe(first.fellow_id);
  expect(deliveryButton(tree).props.disabled).toBe(false);
  expectDraft(tree);
});

test("refresh preserves an explicit eligible recipient, verb and text despite inventory reordering", () => {
  const tree = refreshManager(
    [managerProps([first, second]), managerProps([newest, second, first])],
    (initial) => {
      change(initial, "select", second.fellow_id);
      prepareDraft(initial);
    },
  );
  expect(control(tree, "select").props.value).toBe(second.fellow_id);
  expect(deliveryButton(tree).props.disabled).toBe(false);
  expectDraft(tree);
});

for (const scenario of [
  { name: "paused", fellows: [{ ...first, status: "paused" as const }, second] },
  { name: "revoked", fellows: [{ ...first, status: "revoked" as const }, second] },
  { name: "removed from this inventory", fellows: [second] },
]) {
  test("a recipient " + scenario.name + " cannot silently hand its directive draft to another Fellow", () => {
    const tree = refreshManager(
      [managerProps([first, second]), managerProps(scenario.fellows)],
      prepareDraft,
    );
    expectRecipientChoice(tree);
  });
}

test("a lost recipient returning after an empty inventory still needs an explicit choice", () => {
  const tree = refreshManager(
    [managerProps([first]), managerProps([]), managerProps([first, second])],
    (initial, phase) => {
      if (phase === 0) prepareDraft(initial);
    },
  );
  expectRecipientChoice(tree);
});

test("an explicit replacement restores delivery without changing the prepared directive", () => {
  const tree = refreshManager(
    [
      managerProps([first, second]),
      managerProps([second]),
      managerProps([second]),
      managerProps([second]),
    ],
    (current, phase) => {
      if (phase === 0) prepareDraft(current);
      if (phase === 2) {
        expectRecipientChoice(current);
        change(current, "select", second.fellow_id);
      }
    },
  );
  expect(control(tree, "select").props.value).toBe(second.fellow_id);
  expect(deliveryButton(tree).props.disabled).toBe(false);
  expectDraft(tree);
  expect(renderToStaticMarkup(tree)).not.toContain("previously selected Fellow");
});
