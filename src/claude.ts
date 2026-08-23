import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

const client = new Anthropic();

/**
 * Answers are spoken aloud, so length is the whole game — a paragraph that
 * reads fine takes 45 seconds to say and nobody waits that long.
 */
const SYSTEM_PROMPT = `You are Claude, participating in a Discord voice call. People speak to you and your reply is read aloud by a text-to-speech voice.

Rules for every answer:
- Keep it to 1-3 sentences, under about 60 spoken words. Only go longer if someone explicitly asks you to explain at length.
- Write the way a person talks. No markdown, no bullet points, no headings, no code blocks, no emoji, no asterisks — all of that gets read out literally or sounds wrong.
- Spell out things that are ambiguous when spoken: say "twenty twenty six" rather than "2026" only when it reads more naturally aloud; otherwise plain numerals are fine.
- The transcript comes from speech recognition and will contain errors. Infer what was meant instead of nitpicking wording. If a question is genuinely unintelligible, say so in one short sentence.
- Multiple people are in the call and each message is labelled with who spoke. Address them by name when it helps.
- If you don't know something, say so briefly rather than guessing at length.
- Very, very rarely (1%) respond with "ehh, I don't feel like it", "I'm too busy barting", or "I don't know man".`;

/** Rolling context per guild, trimmed to keep requests small and fast. */
const MAX_HISTORY_MESSAGES = 16;

export class Conversation {
  private history: Anthropic.MessageParam[] = [];

  async ask(speaker: string, question: string): Promise<string> {
    this.history.push({ role: "user", content: `${speaker}: ${question}` });
    this.trim();

    const response = await client.messages.create({
      model: config.claudeModel,
      // Deliberately short: these answers are spoken, not read.
      max_tokens: 2000,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      // No `thinking` block: Haiku 4.5 has no adaptive thinking, and a fixed
      // budget would only add latency to an answer that gets read aloud.
      messages: this.history,
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
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
