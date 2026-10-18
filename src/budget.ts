// Read-response token budgets (D-053, D-385). The limits, notes, and hard-cap
// shape mirror the hosted /api/mcp/* routes in vibecompass-app
// (src/lib/mcp/response.ts and the context and feature routes), so a Local
// response sheds and caps the way the hosted one does.

export const CONTEXT_TOKEN_BUDGET = 2000;
export const FEATURE_TOKEN_BUDGET = 2000;
export const HARD_TOKEN_CAP = 2500;
const HARD_CHAR_CAP = HARD_TOKEN_CAP * 4;

export const RECENT_DECISION_LIMIT = 5;
export const FEATURE_DECISION_LIMIT = 20;
export const DECISION_LOG_MAX_LIMIT = 100;
export const DESCRIPTION_TRIM_CHARS = 500;

export const HARD_CAP_NOTE =
  'Response exceeded token budget and was truncated. Use scoped tools (get_feature_context, get_decision_log) for full data.';
export const CONTEXT_DECISIONS_SHED_NOTE =
  'Large project — call get_decision_log() for decisions, get_feature_context() for detail';
export const FEATURE_FILES_SHED_NOTE =
  'Truncated to fit token budget — use get_file_context() for file mappings';

export interface SheddingTier<T> {
  name: string;
  apply(data: T): T;
}

/**
 * Rough heuristic shared with hosted: 1 token ≈ 4 characters of compact JSON.
 */
export function estimateTokens(data: unknown): number {
  return Math.ceil((JSON.stringify(data) ?? '').length / 4);
}

/**
 * Apply tiers in order while the data is over budget. Tiers return new
 * objects, so data shared with a cached read model is never mutated.
 */
export function shedToBudget<T>(
  data: T,
  budget: number,
  tiers: Array<SheddingTier<T>>,
): { data: T; shed: string[] } {
  let current = data;
  const shed: string[] = [];

  for (const tier of tiers) {
    if (estimateTokens(current) <= budget) {
      break;
    }

    current = tier.apply(current);
    shed.push(tier.name);
  }

  return { data: current, shed };
}

/**
 * Last-resort cap applied after shedding: the response stays structured and
 * carries a preview plus a note pointing at scoped tools instead of a raw
 * sliced JSON string.
 */
export function applyHardCap(data: unknown): unknown {
  const json = JSON.stringify(data) ?? '';

  if (json.length > HARD_CHAR_CAP) {
    return {
      _truncated: true,
      _note: HARD_CAP_NOTE,
      _data_preview: json.slice(0, HARD_CHAR_CAP),
    };
  }

  return data;
}

/**
 * Move top-level note keys (`_`-prefixed) ahead of the payload. The hard cap
 * keeps only the first 10,000 characters, so a qualification serialized after
 * a large list would be cut from the preview.
 */
export function notesFirst(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }

  const entries = Object.entries(data);
  return Object.fromEntries([
    ...entries.filter(([key]) => key.startsWith('_')),
    ...entries.filter(([key]) => !key.startsWith('_')),
  ]);
}

/**
 * Shorten caller input echoed into a note, so an oversized argument cannot
 * crowd the note out of the budget.
 */
export function boundEcho(value: string, maxChars = 200): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

export function clampDecisionLimit(limit: number): number {
  return Math.min(
    Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20),
    DECISION_LOG_MAX_LIMIT,
  );
}

export function appendNote(existing: unknown, note: string): string {
  return typeof existing === 'string' && existing.length > 0
    ? `${existing} ${note}`
    : note;
}
