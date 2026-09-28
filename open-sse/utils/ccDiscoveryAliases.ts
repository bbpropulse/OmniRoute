/**
 * Claude Code discovery aliases (`claude/<id>` mirror entries).
 *
 * Claude Code's gateway model discovery only lists models whose id begins with
 * `claude` or `anthropic` — any other provider prefix (`kimi/…`, `gemini-cli/…`,
 * combo names, etc.) is invisible to it even when the underlying model is fully
 * routable through OmniRoute. To make every enabled model reachable from Claude
 * Code without renaming anything in the real catalog, this module synthesizes a
 * mirror entry for each eligible model:
 *
 *     claude/<original-id>            e.g. claude/kimi/kimi-k2.6
 *     claude/combo/<combo-name>       for owned_by:"combo" entries
 *
 * The mirror entry keeps every field from the original (translated by the
 * existing model-id handling once the request lands, same as `no-think/…` and
 * the effort-variant aliases), only overriding `id`, `root` (back-pointer to the
 * real id), and `display_name`, plus Desktop's family compatibility metadata.
 * Desktop requires a recognizable Claude family even when the id starts with
 * `claude/`; its documented `anthropic_family_tier` field supports opaque aliases.
 * This mirrors the structure of
 * `claudeEffortVariants.ts` and `noThinkingAlias.ts`: pure synthesis over the
 * already key-filtered catalog list, no I/O, no mutation of the input array.
 *
 * Never aliased:
 *  - ids that already start with `claude` or `anthropic` (with or without a
 *    following `/`, case-insensitive) — would double-prefix or shadow the base id.
 *  - `no-think/…` aliases and reasoning-effort variants (`-low`/`-medium`/`-high`/
 *    `-xhigh` suffix) — v1 only mirrors base ids; effort/no-think discovery is a
 *    separate concern.
 *  - entries the caller's `isEnabled` predicate rejects.
 */

export const CC_DISCOVERY_PREFIX = "claude/";
export const CC_DISCOVERY_COMBO_PREFIX = "claude/combo/";

// Ids that already live under the claude/anthropic namespace — never re-mirror them.
const ALREADY_CLAUDE_RE = /^(?:claude|anthropic)(?:\/|$)/i;
// Ids that already carry a reasoning-effort suffix — v1 only mirrors base ids.
const CLAUDE_EFFORT_SUFFIX_RE = /-(?:xhigh|max|high|medium|low)$/i;
const NO_THINKING_PREFIX = "no-think/";
// Built-in `auto`/`auto/*` combos are synthesized by createBuiltinAutoCombo, NOT
// stored in the DB combos table — the request-path resolver (getComboByName) can't
// find them, so mirroring them would advertise a `claude/combo/auto/*` id that the
// request path rejects. Skip them; DB-defined combos (arbitrary names) still mirror.
const BUILTIN_AUTO_COMBO_RE = /^auto(?:\/|$)/;

interface CcDiscoveryCatalogEntry {
  id?: unknown;
  owned_by?: unknown;
  name?: unknown;
  root?: unknown;
  [key: string]: unknown;
}

/**
 * Append `claude/<id>` (or `claude/combo/<id>` for combos) discovery-mirror
 * entries for every eligible model. Returns the original array reference
 * unchanged when nothing is eligible (no allocation in the common case).
 *
 * `isEnabled` is caller-supplied so this module stays free of feature-flag /
 * gate lookups — it only knows how to synthesize the mirror shape.
 */
/**
 * Ids the mirror must never cover: already claude/anthropic (would double-prefix
 * or shadow the base id), `no-think/…` aliases, and reasoning-effort variants —
 * v1 mirrors base ids only.
 */
function isMirrorableId(id: string): boolean {
  if (id.length === 0) return false;
  if (ALREADY_CLAUDE_RE.test(id)) return false;
  if (id.startsWith(NO_THINKING_PREFIX)) return false;
  return !CLAUDE_EFFORT_SUFFIX_RE.test(id);
}

/** Strip a `<provider>/` prefix to get the bare model name, matching the convention in
 * claudeEffortVariants.ts / noThinkingAlias.ts. */
function bareModelName(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

const CLAUDE_FAMILY_TIERS = new Set(["haiku", "sonnet", "opus", "fable", "mythos"]);

function desktopFamilyTier(model: CcDiscoveryCatalogEntry, id: string): string {
  const declaredTier = model.anthropic_family_tier;
  if (typeof declaredTier === "string" && CLAUDE_FAMILY_TIERS.has(declaredTier)) {
    return declaredTier;
  }
  const nativeFamily = /^claude-(haiku|sonnet|opus|fable|mythos)(?:-|$)/i.exec(bareModelName(id));
  // A picker compatibility tier for opted-in non-Claude aliases, not the actual
  // provider or model identity. Preserve owned_by, display_name and token limits.
  return nativeFamily?.[1].toLowerCase() ?? "sonnet";
}

export function appendCcDiscoveryAliases<T extends CcDiscoveryCatalogEntry>(
  models: T[],
  isEnabled: (entry: T) => boolean
): T[] {
  if (!Array.isArray(models)) return models;

  const aliases: T[] = [];
  for (const model of models) {
    const id = model.id;
    if (typeof id !== "string" || !isMirrorableId(id)) continue;
    if (!isEnabled(model)) continue;

    const isCombo = model.owned_by === "combo";
    // Skip built-in auto combos — advertised-but-unroutable (see the regex above).
    if (isCombo && BUILTIN_AUTO_COMBO_RE.test(id)) continue;
    const aliasId = isCombo ? `${CC_DISCOVERY_COMBO_PREFIX}${id}` : `${CC_DISCOVERY_PREFIX}${id}`;
    const label = typeof model.name === "string" && model.name ? model.name : id;

    aliases.push({
      ...model,
      id: aliasId,
      // Combo names may legally contain "/" (comboNameSchema allows it), so a combo's
      // root must stay the full name verbatim — only real provider-qualified ids get
      // the "/" stripped down to the bare model name.
      root: isCombo ? id : bareModelName(id),
      display_name: `${label} (OmniRoute)`,
      // https://claude.com/docs/third-party/claude-desktop/gateway#models
      anthropic_family_tier: desktopFamilyTier(model, id),
      // A discovery mirror must not take over the user's native tier default.
      is_family_default: false,
    } as T);
  }

  return aliases.length > 0 ? [...models, ...aliases] : models;
}
