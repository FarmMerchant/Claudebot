import { config } from "./config.js";

/**
 * Speech-to-text rarely spells "Claude" the way we do — it comes back as
 * "clod", "cloud", "claud", sometimes "clyde". Accept the near misses rather
 * than making people enunciate at a robot.
 *
 * The names are split by how risky they are on their own. "claude" in the
 * middle of a sentence is almost certainly the bot; "cloud" and "moose" are
 * ordinary words, so those only count with a greeting in front of them.
 * Without that split, "the cloud is down" wakes the bot.
 */
const NAME_DISTINCTIVE =
  "claude|claud|clode|klaude|clyde|claudia|claudio|jarvis|garmin|garmeen|mivimoose|mivamoose|mivamoos";
const NAME_AMBIGUOUS = "cloud|clod|klod|moose|clawed|cod|glod";
// Note the absence of a bare "a": with ambiguous names allowed, "a moose"
// and "a cloud" would both wake the bot mid-conversation.
const GREETING_VARIANTS = "hey|hay|hi|hello|yo|ok|okay|um|uh|excuse me|sorry";

const ALL_NAMES = `${NAME_DISTINCTIVE}|${NAME_AMBIGUOUS}`;

function buildWakeRegex(): RegExp {
  // A custom WAKE_PHRASE is matched literally; the default gets the fuzzy treatment.
  if (config.wakePhrase !== "hey claude") {
    const escaped = config.wakePhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "gi");
  }

  return new RegExp(
    // Greeting plus any spelling of the name, or a distinctive name by itself.
    `(?:\\b(?:${GREETING_VARIANTS})\\s+(?:${ALL_NAMES})\\b)|(?:\\b(?:${NAME_DISTINCTIVE})\\b)`,
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

  const rest = normalized.slice(last.index + last[0].length).trim();
  // "what do you think claude" puts the name last. Falling back to whatever
  // came before it beats arming and waiting for a question already asked.
  if (!rest) {
    const before = normalized.slice(0, last.index).trim();
    if (looksLikeQuestion(before)) return { rest: before };
  }
  return { rest };
}

/**
 * Openers that mean a question is coming. Used for the follow-up window: for a
 * short spell after the bot has spoken, anything question-shaped is treated as
 * aimed at it, no wake phrase needed.
 */
const QUESTION_OPENERS =
  /^(what|whats|what's|who|whos|who's|when|where|why|how|hows|how's|which|whose|can|could|can't|cant|would|will|should|shall|do|does|did|is|are|am|was|were|has|have|had|tell me|explain|describe|define|give me|list|name|any idea|got any)\b/;

/** Question-shaped: a question mark, or an opener plus something after it. */
export function looksLikeQuestion(text: string): boolean {
  if (/\?\s*$/.test(text.trim())) return true;

  const normalized = normalize(text);
  // A bare "what" is a person reacting, not asking the bot something.
  if (normalized.split(" ").length < 3) return false;
  return QUESTION_OPENERS.test(normalized);
}

/** "hey claude, stop" / "hey claude never mind" cancels whatever is queued. */
export function isCancel(question: string): boolean {
  return /^(stop|shut up|be quiet|nevermind|never mind|cancel|forget it|peter|peter out|abort|enough|quiet)\b/.test(
    question.trim(),
  );
}
