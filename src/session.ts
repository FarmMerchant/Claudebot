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
  FOLLOW_UP_WINDOW_MS,
  DISCORD_SAMPLE_RATE,
  MIN_UTTERANCE_MS,
  OUTBURST_CHANCE,
  OUTBURST_TICK_MS,
  UTTERANCE_SILENCE_MS,
  WHISPER_SAMPLE_RATE,
} from "./config.js";
import { durationMs, resampleMono, stereoToMono } from "./audio.js";
import { transcribe } from "./stt.js";
import { synthesize, synthesizeStream } from "./tts.js";
import { Conversation } from "./claude.js";
import { randomOutburst } from "./noises.js";
import { findWake, isCancel, looksLikeQuestion } from "./wake.js";
import {
  engineFor,
  followUpsIn,
  settingsFor,
  speakingIn,
  voiceFor,
} from "./prefs.js";

/**
 * prism exposes decoding only as a Transform, but the per-packet method is
 * right there and is what the Transform itself calls. Reaching for it is what
 * lets us skip a bad packet instead of losing the stream.
 */
function decodePacket(decoder: prism.opus.Decoder, packet: Buffer): Buffer {
  return (decoder as unknown as { _decode(buffer: Buffer): Buffer })._decode(packet);
}

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
  /**
   * Bumped by cancelPlayback. Speech loops capture it and stop the moment it
   * moves — stopping the player alone only ends the sentence being spoken,
   * and the next one starts immediately after.
   */
  private speechGeneration = 0;
  private yapping = false;
  /** When the bot last finished speaking, for the follow-up window. */
  private lastSpokeAt = 0;
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

    this.chain = this.chain
      .then(() => this.speakOutburst())
      .catch((err) => console.error("[outburst]", err));
  }

  private async speakOutburst() {
    if (this.destroyed) return;
    try {
      const sound = await randomOutburst();
      if (!sound || this.destroyed) return;

      console.log(`[outburst] ${sound.name}`);
      await this.play(sound.pcm);
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
      let dropped = 0;

      // Decode packet by packet instead of piping through the Transform.
      // prism turns a single undecodable packet into a stream error, which
      // would throw away the whole utterance — and opusscript (the pure-JS
      // fallback we are on, because @discordjs/opus cannot build here)
      // rejects packets libopus would accept. Losing someone's question to
      // one bad packet is far worse than losing 20 ms of audio.
      opus.on("data", (packet: Buffer) => {
        try {
          chunks.push(decodePacket(decoder, packet));
        } catch {
          dropped++;
        }
      });

      opus.once("end", () => {
        decoder.destroy();
        if (dropped > 0) {
          console.warn(`[capture] skipped ${dropped} undecodable packet(s)`);
        }
        resolve(Buffer.concat(chunks));
      });

      // A failure of the subscription itself is still fatal.
      opus.once("error", (err) => {
        decoder.destroy();
        reject(err);
      });
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
    } else if (this.withinFollowUp() && looksLikeQuestion(text)) {
      // It just finished talking and someone asked something. Making people
      // re-say the wake phrase for every follow-up is the single most
      // annoying thing a voice assistant does.
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

  /** Still inside the grace period after the bot last spoke. */
  private withinFollowUp(): boolean {
    if (FOLLOW_UP_WINDOW_MS <= 0) return false;
    if (!followUpsIn(this.guildId)) return false;
    return Date.now() - this.lastSpokeAt < FOLLOW_UP_WINDOW_MS;
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
      reply = await this.conversation.ask(speaker, question, settingsFor(this.guildId));
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

    // Muted with /speak: the text reply above still went out, which is the
    // whole point — the answer is not lost, just not read aloud.
    if (!speakingIn(this.guildId)) return;

    try {
      await this.playStream(
        synthesizeStream(engineFor(this.guildId), reply, voiceFor(this.guildId)),
      );
    } catch (err) {
      console.error("[tts]", err instanceof Error ? err.message : err);
    }
  }

  /**
   * Play chunks as they are rendered, starting the next one generating
   * before blocking on the current one. Time to first word becomes one
   * sentence of synthesis instead of the whole answer.
   */
  private async playStream(chunks: AsyncGenerator<Buffer>) {
    const iterator = chunks[Symbol.asyncIterator]();
    const generation = this.speechGeneration;
    let pending = iterator.next();

    try {
      while (!this.destroyed && generation === this.speechGeneration) {
        const { value, done } = await pending;
        if (done) break;
        pending = iterator.next();
        await this.play(value);
      }
    } finally {
      // Only real speech opens the follow-up window — an outburst also goes
      // through play(), and a fart is not an invitation to ask something.
      this.markSpoken();
      // Leaving early (destroyed, or a playback error) must not strand the
      // generator mid-sentence with work still queued behind it.
      await iterator.return?.(undefined).catch(() => undefined);
    }
  }

  private markSpoken() {
    this.lastSpokeAt = Date.now();
  }

  private async play(pcm: Buffer) {
    const resource = createAudioResource(Readable.from(pcm), {
      inputType: StreamType.Raw,
    });
    this.player.play(resource);
    await entersState(this.player, AudioPlayerStatus.Playing, 10_000);
    await entersState(this.player, AudioPlayerStatus.Idle, 10 * 60_000);
  }

  get guildId(): string {
    return this.channel.guild.id;
  }

  /**
   * Speak one line right now, outside the conversation — used by /voice,
   * /engine and /yap. Queued behind whatever is already talking so it never
   * overlaps an answer.
   */
  async say(text: string): Promise<void> {
    this.chain = this.chain
      .then(() =>
        this.playStream(
          synthesizeStream(engineFor(this.guildId), text, voiceFor(this.guildId)),
        ),
      )
      .catch((err) => console.error("[say]", err));
    await this.chain;
  }

  get isYapping(): boolean {
    return this.yapping;
  }

  /**
   * Talk continuously until told to stop. Each cycle is a fresh Claude call
   * plus a synthesis pass, so this bills for as long as it runs — every exit
   * path below matters.
   */
  startYapping(speaker: string, topic: string | null): void {
    if (this.yapping) return;
    this.yapping = true;
    void this.yapLoop(speaker, topic).catch((err) => {
      console.error("[yap]", err);
      this.yapping = false;
    });
  }

  stopYapping(): void {
    this.yapping = false;
    this.cancelPlayback();
  }

  private async yapLoop(speaker: string, topic: string | null) {
    // cancelPlayback bumps this, which is how "Hey Claude, stop" ends the
    // monologue rather than just cutting the sentence in flight.
    const generation = this.speechGeneration;
    const running = () =>
      this.yapping && !this.destroyed && generation === this.speechGeneration;

    let turn = 0;
    while (running()) {
      const prompt =
        turn === 0
          ? `Start talking${topic ? ` about ${topic}` : ""} and just keep going. Do not ask what I want or wait for a reply — this is a monologue.`
          : "Keep going. Same monologue, next bit. Do not wrap up and do not ask a question.";

      let line: string;
      try {
        line = await this.conversation.ask(speaker, prompt, settingsFor(this.guildId));
      } catch (err) {
        console.error("[yap]", err);
        this.yapping = false;
        return;
      }

      // The stop could have landed while Claude was thinking.
      if (!running()) return;

      turn++;
      console.log(`[yap] turn ${turn}: ${line}`);
      await this.say(line);
    }
  }

  /** "Hey Claude, stop" — kill the current line, the queued sentences, and any yapping. */
  cancelPlayback() {
    this.speechGeneration++;
    this.yapping = false;
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
