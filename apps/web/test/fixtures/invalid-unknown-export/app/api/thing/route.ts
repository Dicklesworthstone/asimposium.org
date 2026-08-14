// `formatThing` is not an HTTP method and not route segment config.
// Next.js rejects unrecognised exports from route files.
export type Thing = { id: string };

export function formatThing(thing: Thing): string {
  return thing.id;
}

export function GET(): Response {
  return Response.json({ ok: true });
}
