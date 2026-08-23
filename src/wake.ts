import { config } from "./config.js";

/**
 * Speech-to-text rarely spells "Claude" the way we do — it comes back as
 * "clod", "cloud", "claud", sometimes "clyde". Accept the near misses rather
 * than making people enunciate at a robot.
 */
const CLAUDE_VARIANTS = "claude|claud|clod|cloud|clode|clyde|klaude|klod|garmin|garmeen|jarvis";
const GREETING_VARIANTS = "hey|hay|hi|hey there|ok|okay|yo|a|uh";

function buildWakeRegex(): RegExp {
  // A custom WAKE_PHRASE is matched literally; the default gets the fuzzy treatment.
  if (config.wakePhrase !== "hey claude") {
    const escaped = config.wakePhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "gi");
  }
  return new RegExp(
    `\\b(?:${GREETING_VARIANTS})[,.]?\\s+(?:${CLAUDE_VARIANTS})\\b`,
    "gi",
  );
}

const WAKE_REGEX = buildWakeRegex();

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface WakeMatch {
  /** Everything the speaker said after the wake phrase. May be empty. */
  rest: string;
}

/**
 * Look for the wake phrase anywhere in an utterance. If it appears more than
 * once, the last one wins — people restart themselves mid-sentence.
 */
export function findWake(text: string): WakeMatch | null {
  const normalized = normalize(text);
  WAKE_REGEX.lastIndex = 0;

  let last: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = WAKE_REGEX.exec(normalized)) !== null) {
    last = match;
    if (WAKE_REGEX.lastIndex === match.index) WAKE_REGEX.lastIndex++;
  }

  if (!last) return null;
  return { rest: normalized.slice(last.index + last[0].length).trim() };
}

/** "hey claude, stop" / "hey claude never mind" cancels whatever is queued. */
export function isCancel(question: string): boolean {
  return /^(stop|shut up|be quiet|nevermind|never mind|cancel|forget it|peter)\b/.test(
    question.trim(),
  );
}
