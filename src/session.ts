import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import type {
  GuildMember,
  SendableChannels,
  VoiceBasedChannel,
} from "discord.js";
import prism from "prism-media";
import {
  ARMED_TIMEOUT_MS,
  DISCORD_SAMPLE_RATE,
  MIN_UTTERANCE_MS,
  OUTBURST_CHANCE,
  OUTBURST_TICK_MS,
  UTTERANCE_SILENCE_MS,
  WHISPER_SAMPLE_RATE,
} from "./config.js";
import { durationMs, resampleMono, stereoToMono } from "./audio.js";
import { transcribe } from "./stt.js";
import { synthesize } from "./tts.js";
import { Conversation } from "./claude.js";
import { fart, guttural } from "./noises.js";
import { findWake, isCancel } from "./wake.js";

/** The unprompted noises, picked from uniformly whenever the roll comes up. */
const OUTBURSTS = ["guttural", "fart", "i'm back"] as const;

interface SpeakerState {
  displayName: string;
  receiving: boolean;
  /** True between hearing the wake phrase and hearing the question. */
  armed: boolean;
  armedTimer?: NodeJS.Timeout;
}

export class VoiceSession {
  private readonly player: AudioPlayer;
  private readonly conversation = new Conversation();
  private readonly speakers = new Map<string, SpeakerState>();
  /** Serialises answering so two questions never talk over each other. */
  private chain: Promise<void> = Promise.resolve();
  private outburstTimer?: NodeJS.Timeout;
  private destroyed = false;

  constructor(
    private readonly connection: VoiceConnection,
    public readonly channel: VoiceBasedChannel,
    private readonly textChannel: SendableChannels | null,
  ) {
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this.connection.subscribe(this.player);

    this.player.on("error", (err) => console.error("[player]", err));
    this.connection.on("error", (err) => console.error("[voice]", err));
    this.connection.on(VoiceConnectionStatus.Disconnected, () => this.destroy());

    this.connection.receiver.speaking.on("start", (userId) => {
      this.onSpeakingStart(userId).catch((err) =>
        console.error("[receive]", err),
      );
    });

    this.outburstTimer = setInterval(
      () => this.rollOutburst(),
      OUTBURST_TICK_MS,
    );
  }

  /**
   * Every tick, a small chance of piping up unbidden. Nothing prompts this and
   * none of it reaches the conversation history — it is pure noise.
   */
  private rollOutburst() {
    if (this.destroyed) return;
    if (Math.random() >= OUTBURST_CHANCE) return;
    // Don't talk over an answer (or an earlier outburst) already in progress.
    if (this.player.state.status !== AudioPlayerStatus.Idle) return;

    const kind = OUTBURSTS[Math.floor(Math.random() * OUTBURSTS.length)];
    console.log(`[outburst] ${kind}`);

    this.chain = this.chain
      .then(() => this.speakOutburst(kind))
      .catch((err) => console.error("[outburst]", err));
  }

  private async speakOutburst(kind: (typeof OUTBURSTS)[number]) {
    if (this.destroyed) return;
    try {
      const pcm =
        kind === "fart"
          ? fart()
          : kind === "guttural"
            ? guttural()
            : await synthesize("I'm back.");
      await this.play(pcm);
    } catch (err) {
      console.error("[outburst]", err instanceof Error ? err.message : err);
    }
  }

  private async onSpeakingStart(userId: string) {
    if (this.destroyed) return;

    const member = await this.channel.guild.members
      .fetch(userId)
      .catch(() => null);
    if (!member || member.user.bot) return;

    const state = this.speakerState(userId, member);
    if (state.receiving) return; // already capturing this user
    state.receiving = true;

    const pcm = await this.capture(userId).catch((err) => {
      console.error("[capture]", err);
      return null;
    });
    state.receiving = false;

    if (!pcm || this.destroyed) return;
    await this.onUtterance(state, pcm);
  }

  /**
   * Collect everything a user says until they go quiet, decoded to 48 kHz
   * stereo PCM. Discord ends the subscription for us after the silence window.
   */
  private capture(userId: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const opus = this.connection.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: UTTERANCE_SILENCE_MS,
        },
      });
      const decoder = new prism.opus.Decoder({
        rate: DISCORD_SAMPLE_RATE,
        channels: 2,
        frameSize: 960,
      });

      const chunks: Buffer[] = [];
      const stream = opus.pipe(decoder);

      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.once("end", () => resolve(Buffer.concat(chunks)));
      stream.once("error", reject);
    });
  }

  private async onUtterance(state: SpeakerState, stereo: Buffer) {
    if (durationMs(stereo, DISCORD_SAMPLE_RATE, 2) < MIN_UTTERANCE_MS) return;

    const mono16k = resampleMono(
      stereoToMono(stereo),
      DISCORD_SAMPLE_RATE,
      WHISPER_SAMPLE_RATE,
    );

    let text: string;
    try {
      text = await transcribe(mono16k);
    } catch (err) {
      console.error("[stt]", err instanceof Error ? err.message : err);
      return;
    }

    if (!text || this.destroyed) return;
    console.log(`[heard] ${state.displayName}: ${text}`);

    let question: string;

    if (state.armed) {
      // They said the wake phrase last time and nothing else — this is the question.
      this.disarm(state);
      question = text;
    } else {
      const wake = findWake(text);
      if (!wake) return;

      if (!wake.rest) {
        // Bare "Hey Claude" — wait a beat for the question to follow.
        state.armed = true;
        state.armedTimer = setTimeout(
          () => this.disarm(state),
          ARMED_TIMEOUT_MS,
        );
        return;
      }
      question = wake.rest;
    }

    if (isCancel(question)) {
      this.cancelPlayback();
      return;
    }

    this.enqueue(state.displayName, question);
  }

  private speakerState(userId: string, member: GuildMember): SpeakerState {
    let state = this.speakers.get(userId);
    if (!state) {
      state = { displayName: member.displayName, receiving: false, armed: false };
      this.speakers.set(userId, state);
    }
    state.displayName = member.displayName;
    return state;
  }

  private disarm(state: SpeakerState) {
    state.armed = false;
    if (state.armedTimer) {
      clearTimeout(state.armedTimer);
      state.armedTimer = undefined;
    }
  }

  private enqueue(speaker: string, question: string) {
    console.log(`[ask] ${speaker}: ${question}`);
    this.chain = this.chain
      .then(() => this.answer(speaker, question))
      .catch((err) => console.error("[answer]", err));
  }

  private async answer(speaker: string, question: string) {
    if (this.destroyed) return;

    let reply: string;
    try {
      reply = await this.conversation.ask(speaker, question);
    } catch (err) {
      console.error("[claude]", err);
      reply = "Sorry, I couldn't reach my brain just then. Try again?";
    }

    if (this.destroyed) return;
    console.log(`[reply] ${reply}`);

    void this.textChannel
      ?.send({
        content: `**${speaker}:** ${question}\n**Claude:** ${reply}`,
        allowedMentions: { parse: [] },
      })
      .catch(() => undefined);

    try {
      await this.play(await synthesize(reply));
    } catch (err) {
      console.error("[tts]", err instanceof Error ? err.message : err);
    }
  }

  private async play(pcm: Buffer) {
    const resource = createAudioResource(Readable.from(pcm), {
      inputType: StreamType.Raw,
    });
    this.player.play(resource);
    await entersState(this.player, AudioPlayerStatus.Playing, 10_000);
    await entersState(this.player, AudioPlayerStatus.Idle, 10 * 60_000);
  }

  cancelPlayback() {
    this.player.stop(true);
  }

  resetConversation() {
    this.conversation.reset();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.outburstTimer) {
      clearInterval(this.outburstTimer);
      this.outburstTimer = undefined;
    }

    for (const state of this.speakers.values()) this.disarm(state);
    this.speakers.clear();

    this.player.stop(true);
    try {
      this.connection.destroy();
    } catch {
      // already torn down
    }
  }
}
