/**
 * Generated JSON Schemas are bundled as exact text. The Worker serves these
 * bytes directly, so the public repair URL and the drift-checked artifact are
 * one representation rather than two independently serialized copies.
 */
declare module "*.schema.json" {
  const content: string;
  export default content;
}
