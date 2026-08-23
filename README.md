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
                            Supertonic TTS  (local, free)
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

### 3. Text to speech

Three engines, chosen with `TTS_ENGINE`:

| Engine | Real-time factor | Notes |
|---|---|---|
| `supertonic` (default) | ~0.06x | Fastest by a wide margin, 10 preset voices. Needs a ~255 MB asset download |
| `kokoro` | ~0.4x | 28 voices, graded A-F. Weights download automatically |
| `piper` | ~0.1x | Robotic. Needs a real install |

**Supertonic** needs its models fetched once from
[huggingface.co/Supertone/supertonic](https://huggingface.co/Supertone/supertonic)
into the folder `SUPERTONIC_DIR` points at — `onnx/` (four `.onnx` files plus
`tts.json` and `unicode_indexer.json`) and `voice_styles/` (`F1`-`F5`, `M1`-`M5`).
The inference helper is vendored from their MIT-licensed Node example in
[src/vendor/](src/vendor/), because the `supertonic` package on npm is a
627-byte placeholder. The model weights are OpenRAIL-M licensed.

`SUPERTONIC_STEPS` trades quality for speed: 2 is fastest, 8 is their default,
4 is the middle setting used here. Output is peak-normalised on the way out,
since Supertonic renders about a third as loud as Kokoro.

**Kokoro** needs nothing installed — an 82M-parameter Apache-2.0 model whose
weights come down from Hugging Face on first run (~311 MB, cached inside
`node_modules`) and whose 28 voices ship inside the npm package.

Pick a voice by listening to it:

```powershell
npm run voices                                  # list the live engine's voices
npm run say -- "the quick brown fox" M3         # writes sample.wav
```

Then set `SUPERTONIC_VOICE` or `KOKORO_VOICE` in `.env`, or switch live with
`/voice`. Kokoro's best-graded voices are `af_heart` (A) and `af_bella` (A-).

**Piper** is the original engine — around ten times faster than Kokoro but
noticeably robotic. It needs a Windows release from
[OHF-Voice/piper1-gpl/releases](https://github.com/OHF-Voice/piper1-gpl/releases)
unzipped to `C:	oolspiper`, plus a voice (a `.onnx` file **and** its
`.onnx.json`, side by side) from
[rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US).

> **Version pin:** `onnxruntime-node` must stay at the version
> `@huggingface/transformers` depends on (currently 1.21.0). Two copies at
> different versions in one process fail with "The requested API version
> [27] is not available" — native addons are process-global.
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
| `/engine <name>` | Switches between `supertonic`, `kokoro` and `piper` live. Resets the voice to that engine default and loads its weights before replying |
| `/voice <name>` | Switches the voice within the current engine. Start typing to search; Kokoro voices are sorted best-graded first |
| `/speak [enabled]` | Turns spoken answers on or off. Omit the argument to just flip it |
| `/model [name] [effort] [length]` | Switches model, thinking effort, or the answer length cap (100-1000 characters). Every option is optional; a bare `/model` reports the current settings |
| `/reset` | Clears the conversation history |

`/engine`, `/voice`, `/speak` and `/model` are per-server and live in memory only — a restart puts
both back to what `.env` says, which is where a permanent choice belongs.
While muted the bot still answers in the text channel and still plays random
outbursts; `/speak` governs the AI voice, not the sound effects.

Saying **"Hey Claude, stop"** (or "never mind", "shut up", "cancel") cuts off
whatever the bot is currently saying.

The bot leaves on its own once the last human leaves the channel.

## Random outbursts

While it's sitting in a channel the bot rolls once a second, with a 1-in-10,000
chance of speaking up unprompted — roughly once every three hours. It then picks
one of the sound files in `OUTBURST_SOUNDS_DIR` at random and plays it.

The pool is just that folder: drop a `.wav` in, restart, and it joins the
rotation — no code change. [src/noises.ts](src/noises.ts) decodes every file
once at startup and holds it in memory as 48 kHz stereo, so playback is
instant. Mono, 8/16/24/32-bit and float WAVs all work, and anything at another
sample rate is resampled on load. A file that is empty or unreadable is skipped
with a warning at startup rather than taking the bot down, so watch the log for
`loaded N of M .wav files` after `npm start`.

None of this reaches the conversation history and it never interrupts a real
answer — if the bot is already talking, the roll is skipped. Adjust the odds or
switch it off via `OUTBURST_CHANCE` in [src/config.ts](src/config.ts).

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
| `TTS_ENGINE` | `supertonic` | `supertonic` (fastest), `kokoro` (most voices) or `piper` (robotic) |
| `SUPERTONIC_DIR` | — | Folder holding `onnx/` and `voice_styles/`. Required when `TTS_ENGINE=supertonic` |
| `SUPERTONIC_VOICE` | `F1` | `F1`-`F5` or `M1`-`M5` |
| `SUPERTONIC_STEPS` | `4` | Diffusion steps. 2 fastest, 8 best |
| `SUPERTONIC_SPEED` | `1.05` | Speaking rate multiplier |
| `KOKORO_VOICE` | `af_heart` | One of the 28 voices — see `npm run voices` |
| `KOKORO_DTYPE` | `fp32` | `fp32`, `fp16`, `q8`, `q4`, `q4f16`. Counter-intuitively fp32 is the fastest on a desktop CPU |
| `KOKORO_SPEED` | `1` | Speaking rate multiplier |
| `PIPER_BIN` | — | Path to `piper.exe`. Only required when `TTS_ENGINE=piper` |
| `PIPER_MODEL` | — | Path to a `.onnx` voice. Only required when `TTS_ENGINE=piper` |
| `WAKE_PHRASE` | `hey claude` | Changing this switches from fuzzy to exact matching |
| `OUTBURST_SOUNDS_DIR` | — | Folder of `.wav` files for the random outbursts. Unset disables them |

## Costs

- **whisper.cpp, Supertonic, Kokoro, Piper, discord.js** — free and open
  source, running locally. Both neural voices are a one-off weights download
  and cost nothing per use.
- **Claude API** — pay-per-use, billed per token. Haiku 4.5 is the cheapest
  current model at $1 per million input tokens and $5 per million output.
  Answers are capped short too (the system prompt asks for 1–3 sentences,
  because a paragraph takes 45 seconds to say aloud), so a typical question
  costs a small fraction of a cent. There is no free tier; if you want zero
  spend end to end you'd need to swap `src/claude.ts` for a local model runner.

## Tuning

Latency splits between whisper, Claude and TTS. Speech is synthesised one
sentence at a time and played while the next is still rendering, so the bot
starts talking after the first sentence rather than the whole answer. On a
three-sentence answer that is 382 ms to first audio with Supertonic, against
2.8 seconds for whole-answer Kokoro. If replies still feel slow:

- `SUPERTONIC_STEPS=2` shaves off a little more at some cost in quality.

- `/model name:claude-haiku-4-5` is the fastest model, roughly 0.7s against
  Opus 5's 2s. `/model effort:low` matters only on Sonnet and Opus.
- `TTS_ENGINE=piper` trades the voice quality back for roughly 10x the speed.
- `WHISPER_THREADS` should be around half your core count; the default of 4 is
  conservative for a desktop.
- A smaller whisper model (`ggml-tiny.en`) cuts transcription time at a real
  cost in accuracy, which the wake-phrase matcher then has to absorb.
- `UTTERANCE_SILENCE_MS` in [src/config.ts](src/config.ts) is a fixed 800 ms
  added to every question — the bot cannot know you have stopped talking until
  you have been quiet that long. Lowering it to 600 is noticeable, but starts
  cutting people off mid-sentence.
