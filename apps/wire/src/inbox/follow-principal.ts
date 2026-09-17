/** Only the enrollment credential authority can name a Fellow on Stoa.
 * Sponsor IDs, token-shaped strings, and browser cookies are not credentials.
 * A future sponsor follow surface must verify the signed service envelope;
 * it must not add an identity-header shortcut here. */
export interface FollowCredentialAuthority {
  credentialBinding(token: string): Promise<{ readonly fellowId: string } | undefined>;
}

export async function authenticatedFollowPrincipal(
  request: Request,
  authority: FollowCredentialAuthority,
): Promise<string | undefined> {
  const header = request.headers.get("authorization");
  if (header === null) return undefined;
  // Comma-joined duplicate Authorization values must not become one token.
  const match = /^Bearer[\t ]+([^\s,]+)$/i.exec(header.trim());
  const token = match?.[1];
  if (token === undefined) return undefined;
  const binding = await authority.credentialBinding(token);
  return binding?.fellowId;
}
