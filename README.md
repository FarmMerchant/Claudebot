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
                              Kokoro TTS  (local, free)
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
loosely. **hey/hi/hello/yo/ok/uh/excuse me** followed by any of
**claude/claud/clod/cloud/clyde/cod/moose/garmin/jarvis** all work, and the
distinctive spellings also wake it with no greeting at all — *"Claude, what time
is it?"* or *"what do you think, Claude?"*. The ordinary English words in that
list (cloud, moose, cod, clod) need a greeting in front, or *"the cloud is down"*
would set it off mid-conversation.

**Follow-ups need no wake phrase at all.** For 15 seconds after the bot finishes
speaking, anything question-shaped is treated as aimed at it — so *"and how big
is it?"* just works. Question-shaped means a question mark or an opener like
what/how/can/tell me, and at least three words, so *"yeah nice one"* and *"what"*
do not trigger it. Turn it off per server with `/followup`, or set `FOLLOW_UP_WINDOW_MS` to 0 in
[src/config.ts](src/config.ts) to change the window length or disable it everywhere.

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

Four engines, chosen with `TTS_ENGINE` and switchable live with `/engine`:

| Engine | Real-time factor | Notes |
|---|---|---|
| `kokoro` (default) | ~0.4x | 28 voices graded A-F, warmer. Weights download automatically |
| `supertonic` | ~0.06x | Fastest by a wide margin, 10 preset voices. Needs a ~255 MB asset download |
| `fish` | GPU-bound | Clones a voice from a short recording. Needs a Python sidecar |
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

**Fish Audio** (OpenAudio S1-mini) is the only engine here that clones a voice.
It is also the only one that is not in-process: fish-speech is Python, so it
runs as a local sidecar and the bot talks to it over HTTP. Audio still never
leaves the machine.

It is not installed by default, and this machine has no Python at all — the
`python.exe` on PATH is the Microsoft Store stub. Full setup:

1. Install Python **3.12** — with the Python install manager already present,
   that is `py install 3.12`; otherwise grab it from
   [python.org](https://www.python.org/downloads/). It sits alongside any
   newer version you have. The version matters: fish-speech pins
   `torch==2.8.0`, which ships Windows wheels for CPython 3.9-3.13 only. On
   3.14 the install fails with *no matching distribution for torch==2.8.0*,
   and `py -3.12` fails first with *no runtime installed that matches 3.12*.
2. `git clone https://github.com/fishaudio/fish-speech && cd fish-speech`
   (cloning it inside this repo is fine — `fish-speech/` is gitignored.)
3. Create the venv with that interpreter specifically, and install PyTorch
   **with CUDA** first — the CPU build is far too slow to be usable here, and
   installing it first stops `pip install -e .` pulling the CPU one:
   ```powershell
   py -3.12 -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu126
   pip install -e .
   ```
   The `cu126` index is deliberate — `cu121` and `cu124` never got torch 2.8.0.
   If `Activate.ps1` is blocked by the execution policy, either run
   `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` first, or skip
   activation and call `.\.venv\Scripts\python.exe` directly.
4. The weights are **gated**, so accept the licence first: sign in to Hugging
   Face and click *Agree and access repository* on
   [fishaudio/openaudio-s1-mini](https://huggingface.co/fishaudio/openaudio-s1-mini).
   Gating is automatic, so access is instant. Then make a **read** token at
   [settings/tokens](https://huggingface.co/settings/tokens), log in, and
   fetch it (CC-BY-NC-SA, non-commercial):
   ```powershell
   hf auth login
   hf download fishaudio/openaudio-s1-mini --local-dir checkpoints/openaudio-s1-mini
   ```
   Without the licence step the download fails with *401 ... Cannot access
   gated repo*. Use `hf`, not `huggingface-cli` — the latter is deprecated.
5. Start the server, and leave it running alongside the bot:
   ```powershell
   python tools/api_server.py --llama-checkpoint-path checkpoints/openaudio-s1-mini --decoder-checkpoint-path checkpoints/openaudio-s1-mini/codec.pth --listen 127.0.0.1:8080
   ```

Then `/engine fish`. If the sidecar is not running the switch is refused and
the bot stays on the engine it was using.

To clone a voice, put `<name>.wav` (10-30 seconds of clean speech) in
`FISH_VOICES_DIR` with a `<name>.txt` next to it containing exactly what is
said in that clip. The transcript matters — a wrong one measurably degrades
the clone. Each `.wav` then shows up as a voice in `/voice`.

> **Hardware note:** S1-mini is 0.5B parameters and wants ~4 GB of VRAM. A
> GTX 1650 has exactly 4 GB, so this will be tight, and it will be far slower
> than Supertonic — seconds per sentence rather than a fifth of a second.
> Cloning is the reason to use it, not speed.

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
| `/personality [description] [reset]` | Rewrites how Claude behaves, e.g. `/personality description:Nice and respectful`. Bare shows the current one; `reset:true` restores the default. Clears the history so the old character does not bleed through |
| `/yap [topic]` | Talks continuously until stopped. Run it again, say **"Hey Claude, stop"**, or `/leave`. Each cycle is a fresh Claude call, so it bills for as long as it runs |
| `/followup [enabled]` | Turns the no-wake-phrase follow-up window on or off. Omit the option to flip it |
| `/reset` | Clears the conversation history |

`/engine`, `/voice`, `/speak` and `/model` are per-server and live in memory only — a restart puts
both back to what `.env` says, which is where a permanent choice belongs.
While muted the bot still answers in the text channel and still plays random
outbursts; `/speak` governs the AI voice, not the sound effects.

Saying **"Hey Claude, stop"** (or "never mind", "shut up", "cancel") cuts off
whatever the bot is currently saying — the sentence in flight, every sentence
still queued behind it, and any `/yap` monologue in progress.

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
| `FISH_URL` | `http://127.0.0.1:8080` | Where the fish-speech sidecar is listening |
| `FISH_VOICES_DIR` | — | Folder of `<name>.wav` + `<name>.txt` reference clips |
| `FISH_REFERENCE_ID` | — | A reference saved server-side, used when no clip is picked |
| `KOKORO_VOICE` | `af_heart` | One of the 28 voices — see `npm run voices` |
| `KOKORO_DTYPE` | `fp32` | `fp32`, `fp16`, `q8`, `q4`, `q4f16`. Counter-intuitively fp32 is the fastest on a desktop CPU |
| `KOKORO_SPEED` | `1` | Speaking rate multiplier |
| `PIPER_BIN` | — | Path to `piper.exe`. Only required when `TTS_ENGINE=piper` |
| `PIPER_MODEL` | — | Path to a `.onnx` voice. Only required when `TTS_ENGINE=piper` |
| `WAKE_PHRASE` | `hey claude` | Changing this switches from fuzzy to exact matching |
| `PERSONALITY` | sassy and annoying | Default character, up to 500 characters. `/personality` overrides it per server |
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
