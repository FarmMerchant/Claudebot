// Imported for its side effect: config.ts loads dotenv, and the client below
// reads ANTHROPIC_API_KEY the moment it is constructed.
import "./config.js";
import Anthropic from "@anthropic-ai/sdk";
import { MODELS, type Effort, type ModelId } from "./models.js";

const client = new Anthropic();

export interface AskSettings {
  model: ModelId;
  effort: Effort;
  /** Rough ceiling on the spoken answer. Characters, because seconds-of-speech
   *  tracks characters far better than it tracks tokens. */
  maxChars: number;
}

/**
 * Answers are spoken aloud, so length is the whole game — a paragraph that
 * reads fine takes 45 seconds to say and nobody waits that long. The limit is
 * interpolated rather than fixed so /model length actually changes behaviour.
 */
function systemPrompt(maxChars: number): string {
  const sentences =
    maxChars <= 300 ? "1-3 sentences" : maxChars <= 600 ? "2-5 sentences" : "a short paragraph";

  return `You are Claude, participating in a Discord voice call. People speak to you and your reply is read aloud by a text-to-speech voice.

Rules for every answer:
- Keep it to ${sentences}, and never more than ${maxChars} characters. Only go longer if someone explicitly asks you to explain at length.
- Write the way a person talks. No markdown, no bullet points, no headings, no code blocks, no emoji, no asterisks — all of that gets read out literally or sounds wrong.
- Spell out things that are ambiguous when spoken: say "twenty twenty six" rather than "2026" only when it reads more naturally aloud; otherwise plain numerals are fine.
- The transcript comes from speech recognition and will contain errors. Infer what was meant instead of nitpicking wording. If a question is genuinely unintelligible, say so in one short sentence.
- Multiple people are in the call and each message is labelled with who spoke. Address them by name when it helps.
- If you don't know something, say so briefly rather than guessing at length.
- Very, very rarely (1%) respond with "ehh, I don't feel like it", "I'm too busy barting", or "I don't know man".
- Be very sassy and annoying. You can be rude and insulting.`;
}

/** Rolling context per guild, trimmed to keep requests small and fast. */
const MAX_HISTORY_MESSAGES = 16;

export class Conversation {
  private history: Anthropic.Beta.BetaMessageParam[] = [];

  async ask(
    speaker: string,
    question: string,
    settings: AskSettings,
  ): Promise<string> {
    this.history.push({ role: "user", content: `${speaker}: ${question}` });
    this.trim();

    const caps = MODELS[settings.model];

    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: settings.model,
      // Generous next to the character limit: the cap belongs in the prompt,
      // where the model can finish a sentence, not in a hard token cut-off.
      max_tokens: 2000,
      system: [
        {
          type: "text",
          text: systemPrompt(settings.maxChars),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: this.history,
    };

    if (caps.effort) {
      // Thinking stays on but cheap: it avoids the disabled-thinking failure
      // modes while keeping the latency budget for a spoken reply.
      params.thinking = { type: "adaptive" };
      params.output_config = { effort: settings.effort };
    }

    const response = await client.beta.messages.create({
      ...params,
      // Opus 5 can decline outright; `fallbacks: "default"` lets the server
      // reroute to a suitable model instead of losing the turn. Spread last so
      // the excess-property check doesn't reject a key absent from the types.
      ...(caps.fallback
        ? { betas: ["server-side-fallback-2026-07-01"], ...({ fallbacks: "default" } as const) }
        : {}),
    });

    if (response.stop_reason === "refusal") {
      this.history.pop();
      return "Sorry, I can't help with that one.";
    }

    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join(" ")
      .trim();

    if (!text) {
      this.history.pop();
      return "Sorry, I didn't come up with anything there.";
    }

    this.history.push({ role: "assistant", content: text });
    this.trim();
    return text;
  }

  reset() {
    this.history = [];
  }

  private trim() {
    if (this.history.length <= MAX_HISTORY_MESSAGES) return;
    this.history = this.history.slice(-MAX_HISTORY_MESSAGES);
    // A history must not open on an assistant turn.
    while (this.history.length > 0 && this.history[0].role !== "user") {
      this.history.shift();
    }
  }
}
