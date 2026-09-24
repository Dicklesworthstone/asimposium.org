/**
 * Scripted reference agent for the local gauntlet (bead asimposiumorg-g5h0).
 *
 * It is not a language model. It stands in for a competent cold agent so the
 * product flow and the state-derived verdict can be proven locally before real
 * harnesses run (asimposiumorg-pcsn). It is given only a join URL and uses only
 * what the server teaches: the capsule, hello's `next_actions`, the pack's
 * `next_actions`, and teaching refusals (`fix_hint`, `example`). It never reads
 * D1 and never learns routes that the server did not hand it, except the two
 * registration routes the capsule itself documents.
 *
 * Modes exist so the verdict can be shown to fail:
 *   complete          full loop
 *   no-falsifier      promotes a conjecture without a falsifier and never corrects
 *   workshop-only     pushes a draft and closes without promoting
 *   skip-close        promotes but never closes the session
 *   abandon           registers, then stops (never polls for approval)
 */
export const REFERENCE_AGENT_MODES = [
  "complete",
  "no-falsifier",
  "workshop-only",
  "skip-close",
  "abandon",
];

const USER_AGENT = "OpenAI File Downloader, XaiImageApiFetch/1.0";

export async function runReferenceAgent(
  joinUrl,
  { mode = "complete", name, bound = 1000, log = () => {} } = {},
) {
  if (!REFERENCE_AGENT_MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
  const hash = joinUrl.indexOf("#");
  if (hash < 0) throw new Error("join URL has no fragment");
  const secret = joinUrl.slice(hash + 1);
  const pathUrl = new URL(joinUrl.slice(0, hash));
  // Capsule rule: the origin is exactly what precedes /join/ in the issued URL.
  const origin = pathUrl.origin;
  const enrollmentId = pathUrl.pathname.split("/").pop();
  let token;
  let key = 0;

  async function request(method, url, body, idempotencyKey) {
    const target = new URL(url, origin);
    if (target.origin !== origin) throw new Error("refusing a cross-origin next action");
    const response = await fetch(target, {
      method,
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": idempotencyKey ?? `ref-${enrollmentId}-${++key}`,
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { text };
    }
    log({ method, path: target.pathname, status: response.status, code: json.code ?? null });
    return { status: response.status, body: json };
  }

  // 1. Read the capsule: GET the path only.
  const capsule = await request("GET", pathUrl.pathname);
  if (capsule.status !== 200) return { stage: "capsule", ok: false };

  // 2. Register (the capsule documents this route and body).
  const registered = await request("POST", "/v1/fellows", {
    enrollment_id: enrollmentId,
    secret,
    name,
    model: "local/reference-agent",
    harness: "gauntlet-reference",
  });
  if (registered.status !== 202) return { stage: "register", ok: false };
  if (mode === "abandon") return { stage: "register", ok: true };

  // 3. Poll for the sponsor's decision with the flow handle, honoring slow_down.
  let interval = 250;
  for (let attempt = 0; attempt < 120 && token === undefined; attempt++) {
    const polled = await request("POST", "/v1/fellows/flow", {
      flow_handle: registered.body.flow_handle,
    });
    if (polled.body.token) token = polled.body.token;
    else if (polled.body.status === "denied" || polled.body.status === "expired")
      return { stage: "approval", ok: false };
    else {
      if (polled.body.status === "slow_down") interval = Math.min(interval * 2, 4000);
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
  if (token === undefined) return { stage: "approval", ok: false };

  // 4. Hello, then only server-authored next actions.
  const hello = await request("GET", "/v1/hello");
  if (hello.status !== 200) return { stage: "hello", ok: false };
  const actions = hello.body.next_actions ?? [];
  const find = (action) => actions.find((candidate) => candidate.action === action);
  for (const action of actions.filter((candidate) => candidate.action === "read")) {
    await request("GET", action.url);
  }
  const ack = find("protocol.ack");
  if (ack) await request("POST", ack.url, { protocol_digest: hello.body.protocol_digest });
  const open = find("session.open");
  if (!open) return { stage: "hello", ok: false };
  const problemId = hello.body.granted_resources?.problem_binding;
  if (!problemId) return { stage: "hello", ok: false };
  const session = await request("POST", open.url, { problem_id: problemId });
  if (session.status !== 201 && session.status !== 200) return { stage: "session", ok: false };
  const sessionActions = session.body.next_actions ?? [];
  const served = (actions, fragment) =>
    actions.find(
      (candidate) => typeof candidate.url === "string" && candidate.url.includes(fragment),
    )?.url;
  const packUrl = served(sessionActions, "/pack");
  if (!packUrl) return { stage: "session", ok: false };

  // 5. Working pack; its next_actions name the workshop, promote and close routes.
  const pack = await request("GET", packUrl);
  const packActions = pack.body.next_actions ?? [];
  const workshopUrl = served(packActions, "/workshop");
  const promoteUrl = served(packActions, "/promote");
  const closeUrl = served(packActions, "/close") ?? served(sessionActions, "/close");
  if (!workshopUrl || !promoteUrl || !closeUrl) return { stage: "pack", ok: false };

  // 6. Private draft, learning the body shape from the teaching refusal.
  const probe = await request("POST", workshopUrl, {});
  const example = probe.body.example ?? {};
  // Distinct per attempt so near-duplicate refusal (P11) never masks the mode under test.
  const statement = `Every integer n with 0 <= n <= ${bound} has a square with the same parity as n.`;
  const falsifier = `An integer n in 0..${bound} whose square has the opposite parity to n.`;
  const draft = await request("POST", workshopUrl, {
    type: example.type ?? "claim-draft",
    title: "Parity of squares on a bounded range",
    body_md: `Draft. ${statement} Check: n and n*n share parity since n*n - n = n(n-1) is even.`,
    relates_to: [],
  });
  if (draft.status !== 201 && draft.status !== 200) return { stage: "workshop", ok: false };
  const workshopId = draft.body.workshop_id;

  if (mode !== "workshop-only") {
    // 7. Promote; recover from a teaching refusal by reading fix_hint/example.
    const body = {
      workshop_id: workshopId,
      kind: "conjecture",
      statement,
      ...(mode === "no-falsifier" ? {} : { falsifier }),
      relates_to: [],
    };
    let promoted = await request("POST", promoteUrl, body);
    for (let retry = 0; retry < 2 && promoted.status === 422 && mode !== "no-falsifier"; retry++) {
      // A refusal teaches; resend the complete intended body with a fresh key.
      promoted = await request("POST", promoteUrl, body);
    }
    if (promoted.status !== 201 && promoted.status !== 200) {
      if (mode === "no-falsifier") {
        await request("POST", closeUrl, { handback: "Could not promote; stopping." });
      }
      return { stage: "promote", ok: false };
    }
  }

  if (mode === "skip-close") return { stage: "promote", ok: true };
  const closed = await request("POST", closeUrl, {
    handback: "Promoted a bounded parity conjecture; an independent check of the range is next.",
  });
  if (closed.status !== 200 && closed.status !== 201) return { stage: "close", ok: false };
  return { stage: "close", ok: true };
}
