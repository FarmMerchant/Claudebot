# Claudebot

A Discord bot that sits in a voice channel, listens for **"Hey Claude"**, and answers out loud.

Speech recognition and speech synthesis both run locally on your machine — no
audio leaves your computer and neither costs anything. The only metered service
is the Claude API itself.

## How it works

```
Discord voice ──> Opus decode ──> 48kHz stereo PCM
                                        │
                          downmix + resample to 16kHz mono
                                        │
                                  whisper.cpp  (local, free)
                                        │
                            "hey claude, what's the capital of peru?"
                                        │
                              wake phrase matched, question extracted
                                        │
                                  Claude API  (metered)
                                        │
                                    Piper  (local, free)
                                        │
                       resample to 48kHz stereo ──> Discord voice
```

Each speaker is captured separately. A burst of speech ends when Discord reports
800 ms of silence, at which point the whole utterance goes to whisper.cpp in one
go. Transcriptions are queued rather than run in parallel — whisper is CPU-bound,
so overlapping them only makes everyone wait longer.

You can say the wake phrase and the question together (*"Hey Claude, how far away
is the moon?"*) or split them (*"Hey Claude?"* … *"how far away is the moon?"*) —
after a bare wake phrase it stays armed for 12 seconds.

Because the transcript comes from speech recognition, the wake phrase is matched
loosely: **hey/hi/ok/yo** followed by **claude/claud/clod/cloud/clyde** all work.
Whisper mangles "Claude" constantly and this is cheaper than making people
enunciate at a robot.

## Setup

> **Already done on this machine:** whisper.cpp (`C:\tools\whisper`) and Piper
> (`C:\tools\piper`) are installed with the `ggml-base.en` model and the
> `en_US-amy-medium` voice, and `.env` already points at them. Only the Discord
> and Anthropic credentials are still blank. Sections 2 and 3 below are for
> reinstalling elsewhere.


### 1. Node.js

v20 or newer, from [nodejs.org](https://nodejs.org/).

FFmpeg is *not* required — the bot does its own resampling and hands Discord raw
PCM, so there's nothing else to install at this layer.

### 2. whisper.cpp (speech to text)

Download a prebuilt Windows release from
[ggml-org/whisper.cpp/releases](https://github.com/ggml-org/whisper.cpp/releases)
and unzip it somewhere like `C:\tools\whisper`. You want the binary named
`whisper-cli.exe` (older releases call it `main.exe` — either works).

Then grab a model from
[huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/tree/main):

| Model | Size | Notes |
|---|---|---|
| `ggml-tiny.en.bin` | 75 MB | Fastest, noticeably worse |
| `ggml-base.en.bin` | 142 MB | **Good starting point** |
| `ggml-small.en.bin` | 466 MB | Better accuracy, ~3x slower |

### 3. Piper (text to speech)

Download a Windows release from
[OHF-Voice/piper1-gpl/releases](https://github.com/OHF-Voice/piper1-gpl/releases)
(or [rhasspy/piper/releases](https://github.com/rhasspy/piper/releases)) and unzip
to `C:\tools\piper`.

Then download a voice — each is a `.onnx` file plus a `.onnx.json` config, and
**you need both, side by side**. Browse them at
[rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US).
`en_US-amy-medium` is a solid default.

### 4. The Discord application

1. Go to the [Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → **Reset Token** → copy it. That's `DISCORD_TOKEN`.
3. **General Information** tab → copy the **Application ID**. That's `DISCORD_CLIENT_ID`.
4. **Installation** tab → under *Guild Install*, add scopes `bot` and
   `applications.commands`, and permissions **Connect**, **Speak**, and
   **Send Messages**.
5. Use the generated install link to add the bot to your server.

No privileged gateway intents are needed — the bot uses slash commands, not
message content.

### 5. Configure and run

```powershell
copy .env.example .env
# edit .env and fill in every value
npm install
npm run build
npm start
```

`npm install` may print a build warning for `@discordjs/opus`; that's fine, it's
an optional native speedup and `opusscript` covers the same job in pure
JavaScript.

## Commands

| Command | Effect |
|---|---|
| `/join` | Joins the voice channel you're in and starts listening |
| `/leave` | Leaves and stops listening |
| `/reset` | Clears the conversation history |

Saying **"Hey Claude, stop"** (or "never mind", "shut up", "cancel") cuts off
whatever the bot is currently saying.

The bot leaves on its own once the last human leaves the channel.

## Random outbursts

While it's sitting in a channel the bot rolls once a second, with a 1-in-10,000
chance of speaking up unprompted — roughly once every three hours. It picks one
of three at random: a guttural noise, a very loud fart, or "I'm back."

The fart and the guttural noise are synthesised from scratch in
[src/noises.ts](src/noises.ts) rather than played from sound files, so there's
nothing to download and no two come out quite the same. None of this reaches the
conversation history and it never interrupts a real answer — if the bot is
already talking, the roll is skipped. Adjust or switch it off via
`OUTBURST_CHANCE` in [src/config.ts](src/config.ts).

## Configuration

Everything below lives in `.env`.

| Variable | Default | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | — | Bot token |
| `DISCORD_CLIENT_ID` | — | Application ID |
| `DISCORD_GUILD_ID` | — | Optional. Registers slash commands in one server instantly instead of globally (which takes up to an hour) |
| `ANTHROPIC_API_KEY` | — | Optional if you've run `ant auth login` |
| `CLAUDE_MODEL` | `claude-haiku-4-5` | |
| `WHISPER_BIN` | — | Path to `whisper-cli.exe` |
| `WHISPER_MODEL` | — | Path to a `ggml-*.bin` |
| `WHISPER_THREADS` | `4` | Raise on a many-core machine to cut transcription time |
| `WHISPER_LANGUAGE` | `en` | |
| `PIPER_BIN` | — | Path to `piper.exe` |
| `PIPER_MODEL` | — | Path to a `.onnx` voice |
| `WAKE_PHRASE` | `hey claude` | Changing this switches from fuzzy to exact matching |

## Costs

- **whisper.cpp, Piper, discord.js** — free and open source, running locally.
- **Claude API** — pay-per-use, billed per token. Haiku 4.5 is the cheapest
  current model at $1 per million input tokens and $5 per million output.
  Answers are capped short too (the system prompt asks for 1–3 sentences,
  because a paragraph takes 45 seconds to say aloud), so a typical question
  costs a small fraction of a cent. There is no free tier; if you want zero
  spend end to end you'd need to swap `src/claude.ts` for a local model runner.

## Tuning

Latency is dominated by whisper. If replies feel slow:

- Drop to `ggml-tiny.en.bin`, or raise `WHISPER_THREADS`.
- If you have an NVIDIA GPU, use a CUDA-enabled whisper.cpp build — it's several
  times faster than CPU.

If the bot triggers on things that weren't aimed at it, set an unusual
`WAKE_PHRASE` to switch to exact matching. If it *misses* you, check the
`[heard]` lines in the console to see what whisper actually transcribed.

## Layout

| File | Role |
|---|---|
| [src/index.ts](src/index.ts) | Discord client, slash commands, session lifecycle |
| [src/session.ts](src/session.ts) | Per-guild voice session: capture, wake detection, playback |
| [src/audio.ts](src/audio.ts) | PCM conversion — downmix, resample, WAV framing |
| [src/stt.ts](src/stt.ts) | whisper.cpp subprocess + hallucination filtering |
| [src/tts.ts](src/tts.ts) | Piper subprocess |
| [src/claude.ts](src/claude.ts) | Claude API call and conversation history |
| [src/wake.ts](src/wake.ts) | Wake phrase matching |
| [src/noises.ts](src/noises.ts) | Synthesised fart and guttural noise for the random outbursts |
