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

function catalogIdentity(id: string, aliasToProviderId: Record<string, string>): string {
  const slash = id.indexOf("/");
  if (slash < 0) return id;
  const prefix = id.slice(0, slash);
  const provider = Object.hasOwn(aliasToProviderId, prefix) ? aliasToProviderId[prefix] : prefix;
  return `${provider}${id.slice(slash)}`;
}

/**
 * Preserve configured 5.5 Max picker IDs as compatibility aliases of an already
 * visible native Claude/Anthropic base. Keep the base's real capability tiers:
 * dispatch still applies the provider's normal effort normalization. This does
 * not enable Max on a model or synthesize models missing from the caller's list.
 */
export function appendConfiguredClaudeEffortAliases<T extends Record<string, unknown>>(
  models: T[],
  rawAllowlist: string | undefined,
  aliasToProviderId: Record<string, string>
): T[] {
  if (rawAllowlist === undefined) return models;
  const parsed = allowlistSchema.safeParse(rawAllowlist);
  if (!parsed.success) return models;

  const available = new Map<string, T>();
  for (const model of models) {
    if (typeof model.id !== "string") continue;
    const key = catalogIdentity(model.id, aliasToProviderId);
    if (!available.has(key)) available.set(key, model);
  }

  const variants: T[] = [];
  for (const id of parsed.data) {
    const key = catalogIdentity(id, aliasToProviderId);
    if (!/^(?:claude|anthropic)\/claude-(?:opus|sonnet|haiku)-5-5-max$/.test(key)) continue;
    if (available.has(key)) continue;
    const base = available.get(key.slice(0, -"-max".length));
    if (!base || base.owned_by === "combo") continue;
    const bareName = key.slice(key.indexOf("/") + 1, -"-max".length);
    const baseRoot = typeof base.root === "string" && base.root ? base.root : bareName;
    const variant = {
      ...base,
      id,
      root: `${baseRoot}-max`,
      ...(typeof base.name === "string" && base.name ? { name: `${base.name} (Max)` } : {}),
    };
    variants.push(variant);
    available.set(key, variant);
  }
  return variants.length > 0 ? [...models, ...variants] : models;
}

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

  const available = new Map<string, T>();
  for (const model of models) {
    if (typeof model.id !== "string") continue;
    const key = catalogIdentity(model.id, aliasToProviderId);
    if (!available.has(key)) available.set(key, model);
  }

  const result: T[] = [];
  for (const id of parsed.data) {
    const key = catalogIdentity(id, aliasToProviderId);
    const model = available.get(key);
    if (!model) continue;
    result.push({ ...model, id });
    available.delete(key);
  }
  return result;
}
