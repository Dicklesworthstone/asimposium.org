/**
 * Served texts are imported as text rather than read from disk, because the primary consumer is a
 * Cloudflare Worker (`apps/wire`) with no filesystem, and because bundling the bytes is what makes
 * the digest in `registry.ts` describe the thing that is actually served.
 */

declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.txt" {
  const content: string;
  export default content;
}
