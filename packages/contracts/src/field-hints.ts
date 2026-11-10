import { z } from "zod";

const FieldNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const SuggestedFieldsSchema = z.array(FieldNameSchema).min(1).max(3);

/** Bounded single edit, including one adjacent transposition; no normalization. */
export function isSingleEdit(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let index = 0;
  while (index < left.length && left[index] === right[index]) index++;
  if (index === left.length && index === right.length) return true;
  if (left.length < right.length) return left.slice(index) === right.slice(index + 1);
  if (left.length > right.length) return left.slice(index + 1) === right.slice(index);
  return (
    left.slice(index + 1) === right.slice(index + 1) ||
    (left[index] === right[index + 1] &&
      left[index + 1] === right[index] &&
      left.slice(index + 2) === right.slice(index + 2))
  );
}

const cachedFields = new WeakMap<z.ZodType, readonly string[]>();
function objectFields(schema: z.core.$ZodType): string[] {
  if (schema instanceof z.ZodObject) return Object.keys(schema.shape);
  if (schema instanceof z.ZodUnion) return schema.options.flatMap(objectFields);
  return [];
}

/**
 * Only canonical top-level names leave this function. Never return the rejected
 * key or value. Call only after rejection; no suggestion changes acceptance.
 */
export function requestFieldHints(
  schema: z.ZodType,
  input: unknown,
): { suggested_fields?: string[] } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return {};
  let fields = cachedFields.get(schema);
  if (fields === undefined) {
    fields = [...new Set(objectFields(schema))]
      .filter((name) => FieldNameSchema.safeParse(name).success)
      .sort();
    cachedFields.set(schema, fields);
  }
  const present = Object.keys(input);
  const unknown = present
    .slice(0, 128)
    .filter((key) => !fields.includes(key) && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key))
    .slice(0, 8);
  const suggested = new Set<string>();
  for (const key of unknown) {
    const compact = key.toLowerCase().replaceAll("_", "");
    const matches = fields.filter(
      (field) => isSingleEdit(key, field) || compact === field.replaceAll("_", ""),
    );
    if (matches.length === 1 && matches[0] !== undefined && !present.includes(matches[0]))
      suggested.add(matches[0]);
  }
  const names = [...suggested].sort().slice(0, 3);
  return names.length === 0 ? {} : { suggested_fields: names };
}
