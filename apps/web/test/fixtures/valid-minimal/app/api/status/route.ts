export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET(): Response {
  return Response.json({ ok: true });
}

export function HEAD(): Response {
  return new Response(null, { status: 204 });
}
