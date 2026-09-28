import { z } from "zod";

const allowlistSchema = z
  .string()
  .max(65536)
  .transform((value) => value.split(",").map((id) => id.trim()))
  .pipe(
    z
      .array(
        z
          .string()
          .min(1)
          .max(512)
          .regex(/^[^\s*,/]+(?:\/[^\s*,/]+)*$/)
      )
      .max(256)
  );

/**
 * Limit discovery after key permissions and generated variants. Only entries
 * already present can survive; configuring an ID never grants access to it.
 * Provider aliases share an identity, but model suffixes remain exact.
 */
export function filterCatalogByAllowlist<T extends Record<string, unknown>>(
  models: T[],
  rawAllowlist: string | undefined,
  aliasToProviderId: Record<string, string>
): T[] {
  if (rawAllowlist === undefined) return models;
  const parsed = allowlistSchema.safeParse(rawAllowlist);
  if (!parsed.success) return [];

  const identity = (id: string): string => {
    const slash = id.indexOf("/");
    if (slash < 0) return id;
    const prefix = id.slice(0, slash);
    const provider = Object.hasOwn(aliasToProviderId, prefix) ? aliasToProviderId[prefix] : prefix;
    return `${provider}${id.slice(slash)}`;
  };

  const available = new Map<string, T>();
  for (const model of models) {
    if (typeof model.id !== "string") continue;
    const key = identity(model.id);
    if (!available.has(key)) available.set(key, model);
  }

  const result: T[] = [];
  for (const id of parsed.data) {
    const key = identity(id);
    const model = available.get(key);
    if (!model) continue;
    result.push({ ...model, id });
    available.delete(key);
  }
  return result;
}
