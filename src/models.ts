/**
 * The models /model can switch between, and what each one accepts.
 *
 * The request shape is not the same across families and getting it wrong is a
 * 400, not a warning: `output_config.effort` and adaptive thinking arrived with
 * the 4.6+ generation and Haiku 4.5 rejects both, while server-side refusal
 * fallbacks are an Opus 5 feature. Everything the request builder needs to know
 * lives in this table rather than in scattered string comparisons.
 */

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

interface ModelInfo {
  label: string;
  /** Accepts `thinking: {type:"adaptive"}` and `output_config.effort`. */
  effort: boolean;
  /** Can return stop_reason "refusal", so server-side fallbacks are worth it. */
  fallback: boolean;
}

export const MODELS = {
  "claude-haiku-4-5": {
    label: "Haiku 4.5 — fastest, cheapest, no thinking",
    effort: false,
    fallback: false,
  },
  "claude-sonnet-5": {
    label: "Sonnet 5 — balanced, supports effort",
    effort: true,
    fallback: false,
  },
  "claude-opus-5": {
    label: "Opus 5 — most capable, slowest",
    effort: true,
    fallback: true,
  },
} as const satisfies Record<string, ModelInfo>;

export type ModelId = keyof typeof MODELS;

export function isModelId(value: string): value is ModelId {
  return Object.hasOwn(MODELS, value);
}

export function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

/** Spoken answers are capped by characters, not tokens — see /model length. */
export const MIN_REPLY_CHARS = 100;
export const MAX_REPLY_CHARS = 1000;
export const DEFAULT_REPLY_CHARS = 300;
