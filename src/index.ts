import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type SendableChannels,
} from "discord.js";
import {
  VoiceConnectionStatus,
  entersState,
  generateDependencyReport,
  joinVoiceChannel,
} from "@discordjs/voice";
import { TTS_ENGINES, config, isTtsEngine } from "./config.js";
import { VoiceSession } from "./session.js";
import { loadOutbursts } from "./noises.js";
import { warmTts, voiceChoices, engineUnavailable } from "./tts.js";
import {
  engineFor,
  setEffortFor,
  setEngineFor,
  setMaxCharsFor,
  setModelFor,
  setSpeakingIn,
  setVoiceFor,
  settingsFor,
  speakingIn,
  voiceFor,
} from "./prefs.js";
import { EFFORTS, MAX_REPLY_CHARS, MIN_REPLY_CHARS, MODELS, isEffort, isModelId } from "./models.js";

const sessions = new Map<string, VoiceSession>();

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join your voice channel and start listening for \"Hey Claude\"."),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Leave the voice channel and stop listening."),
  new SlashCommandBuilder()
    .setName("voice")
    .setDescription("Change the voice Claude answers in.")
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Start typing to search the available voices.")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("engine")
    .setDescription("Switch the text-to-speech engine. Resets the voice to that engine default.")
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Which engine speaks.")
        .setRequired(true)
        .addChoices(
          { name: "supertonic — fastest, 10 voices", value: "supertonic" },
          { name: "kokoro — warmer, 28 voices, slower", value: "kokoro" },
          { name: "piper — robotic, fixed voice", value: "piper" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("speak")
    .setDescription("Turn spoken answers on or off. Text replies keep working either way.")
    .addBooleanOption((option) =>
      option
        .setName("enabled")
        .setDescription("Leave this out to just flip it.")
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("Change the Claude model, its effort, or how long answers may be.")
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Which model answers.")
        .addChoices(
          ...Object.entries(MODELS).map(([value, info]) => ({
            name: info.label,
            value,
          })),
        ),
    )
    .addStringOption((option) =>
      option
        .setName("effort")
        .setDescription("How hard it thinks. Ignored by Haiku, which has no thinking.")
        .addChoices(...EFFORTS.map((value) => ({ name: value, value }))),
    )
    .addIntegerOption((option) =>
      option
        .setName("length")
        .setDescription(`Longest answer in characters (${MIN_REPLY_CHARS}-${MAX_REPLY_CHARS}).`)
        .setMinValue(MIN_REPLY_CHARS)
        .setMaxValue(MAX_REPLY_CHARS),
    ),
  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Forget the conversation so far and start fresh."),
].map((command) => command.toJSON());

async function registerCommands() {
  const rest = new REST().setToken(config.discordToken);
  const route = config.discordGuildId
    ? Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId)
    : Routes.applicationCommands(config.discordClientId);
  await rest.put(route, { body: commands });
  console.log(
    config.discordGuildId
      ? `Registered slash commands in guild ${config.discordGuildId}.`
      : "Registered global slash commands (may take up to an hour to appear).",
  );
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, (ready) => {
  console.log(generateDependencyReport());
  console.log(`Logged in as ${ready.user.tag}.`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    await handleVoiceAutocomplete(interaction).catch((err) =>
      console.error("[autocomplete]", err),
    );
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  try {
    switch (interaction.commandName) {
      case "join":
        await handleJoin(interaction);
        break;
      case "leave":
        await handleLeave(interaction);
        break;
      case "voice":
        await handleVoice(interaction);
        break;
      case "engine":
        await handleEngine(interaction);
        break;
      case "speak":
        await handleSpeak(interaction);
        break;
      case "model":
        await handleModel(interaction);
        break;
      case "reset":
        await handleReset(interaction);
        break;
    }
  } catch (err) {
    console.error("[command]", err);
    const message = { content: "Something went wrong.", flags: MessageFlags.Ephemeral } as const;
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(message).catch(() => undefined);
    } else {
      await interaction.reply(message).catch(() => undefined);
    }
  }
});

async function handleJoin(interaction: ChatInputCommandInteraction) {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: "Use this in a server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    await interaction.reply({
      content: "Join a voice channel first, then run /join.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const permissions = voiceChannel.permissionsFor(interaction.guild.members.me!);
  if (!permissions?.has(["Connect", "Speak"])) {
    await interaction.reply({
      content: `I need Connect and Speak permissions in ${voiceChannel.name}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  sessions.get(interaction.guildId)?.destroy();

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    // Deafening ourselves would mean receiving no audio at all.
    selfDeaf: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    connection.destroy();
    console.error("[join]", err);
    await interaction.editReply("I couldn't connect to that voice channel.");
    return;
  }

  const textChannel =
    interaction.channel?.type === ChannelType.GuildText ||
    interaction.channel?.isThread()
      ? (interaction.channel as SendableChannels)
      : null;

  sessions.set(
    interaction.guildId,
    new VoiceSession(connection, voiceChannel, textChannel),
  );

  await interaction.editReply(
    `Listening in **${voiceChannel.name}**. Say "Hey Claude" followed by your question.`,
  );
}

async function handleLeave(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) return;
  const session = sessions.get(interaction.guildId);
  if (!session) {
    await interaction.reply({
      content: "I'm not in a voice channel here.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  session.destroy();
  sessions.delete(interaction.guildId);
  await interaction.reply("Left the voice channel.");
}

async function handleReset(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) return;
  const session = sessions.get(interaction.guildId);
  if (!session) {
    await interaction.reply({
      content: "I'm not in a voice channel here.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  session.resetConversation();
  await interaction.reply("Forgot the conversation so far.");
}

async function handleVoiceAutocomplete(interaction: AutocompleteInteraction) {
  if (interaction.commandName !== "voice") return;

  const typed = interaction.options.getFocused().toLowerCase();
  // The guild may have switched engines, so offer that engine's voices.
  const engine = interaction.guildId ? engineFor(interaction.guildId) : undefined;
  const matches = (await voiceChoices(engine)).filter(
    (choice) =>
      choice.id.includes(typed) || choice.label.toLowerCase().includes(typed),
  );

  // Discord rejects the response outright if it carries more than 25 entries.
  await interaction.respond(
    matches.slice(0, 25).map((choice) => ({ name: choice.label, value: choice.id })),
  );
}

async function handleVoice(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) return;

  const engine = engineFor(interaction.guildId);
  const choices = await voiceChoices(engine);
  if (choices.length === 0) {
    await interaction.reply({
      content: `Voice switching is not available on ${engine} — its voice is fixed at startup.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const wanted = interaction.options.getString("name", true);
  const match = choices.find((choice) => choice.id === wanted);
  if (!match) {
    await interaction.reply({
      content: `${wanted} is not a voice. Pick one from the list as you type.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  setVoiceFor(interaction.guildId, match.id);
  await interaction.reply(`Voice set to **${match.id}**.`);

  // Say something in the new voice so the change is audible, not just stated.
  const session = sessions.get(interaction.guildId);
  if (session && speakingIn(interaction.guildId)) {
    await session
      .say("Okay, this is what I sound like now.")
      .catch((err) => console.error("[voice]", err));
  }
}

async function handleSpeak(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) return;

  const requested = interaction.options.getBoolean("enabled") ?? undefined;
  const speaking = setSpeakingIn(interaction.guildId, requested);

  // Shut up mid-sentence rather than finishing the line we are on.
  if (!speaking) sessions.get(interaction.guildId)?.cancelPlayback();

  await interaction.reply(
    speaking
      ? `Speaking out loud again, in ${voiceFor(interaction.guildId)}.`
      : "Muted. I will still post answers as text.",
  );
}

async function handleEngine(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) return;

  const wanted = interaction.options.getString("name", true);
  if (!isTtsEngine(wanted)) {
    await interaction.reply({
      content: `Unknown engine. Pick one of: ${TTS_ENGINES.join(", ")}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Catch a missing SUPERTONIC_DIR or PIPER_BIN here, rather than letting
  // every answer from now on fail at synthesis time.
  const blocked = engineUnavailable(wanted);
  if (blocked) {
    await interaction.reply({
      content: `Cannot switch to ${wanted}: ${blocked}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (engineFor(interaction.guildId) === wanted) {
    await interaction.reply(`Already using **${wanted}**.`);
    return;
  }

  // Loading an engine for the first time takes a second or two, so take it
  // now with the interaction deferred instead of on the next question.
  await interaction.deferReply();
  const voice = setEngineFor(interaction.guildId, wanted);

  try {
    await warmTts(wanted);
  } catch (err) {
    console.error("[engine]", err);
    await interaction.editReply(
      `Switched to **${wanted}**, but it failed to load: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  await interaction.editReply(
    voice
      ? `Now speaking with **${wanted}**, voice reset to **${voice}**.`
      : `Now speaking with **${wanted}**.`,
  );

  const session = sessions.get(interaction.guildId);
  if (session && speakingIn(interaction.guildId)) {
    await session
      .say("Okay, this is what I sound like now.")
      .catch((err) => console.error("[engine]", err));
  }
}

async function handleModel(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) return;

  const name = interaction.options.getString("name");
  const effort = interaction.options.getString("effort");
  const length = interaction.options.getInteger("length");

  const changed: string[] = [];
  if (name && isModelId(name)) {
    setModelFor(interaction.guildId, name);
    changed.push(`model to **${name}**`);
  }
  if (effort && isEffort(effort)) {
    setEffortFor(interaction.guildId, effort);
    changed.push(`effort to **${effort}**`);
  }
  if (length !== null) {
    const applied = setMaxCharsFor(interaction.guildId, length);
    changed.push(`length to **${applied}** characters`);
  }

  const now = settingsFor(interaction.guildId);
  const lines = [
    changed.length > 0 ? `Set ${changed.join(", ")}.` : "Nothing changed.",
    `Currently **${MODELS[now.model].label}**, up to ${now.maxChars} characters.`,
    // Haiku has no thinking to spend effort on, so say so rather than let a
    // stored value look like it is doing something.
    MODELS[now.model].effort
      ? `Effort is ${now.effort}.`
      : `Effort (${now.effort}) is ignored — ${now.model} has no thinking.`,
  ];

  await interaction.reply(lines.join("\n"));
}

// Don't sit in an empty channel burning a voice connection.
client.on(Events.VoiceStateUpdate, (oldState) => {
  const guildId = oldState.guild.id;
  const session = sessions.get(guildId);
  if (!session) return;

  const channel = oldState.guild.channels.cache.get(session.channel.id);
  if (!channel?.isVoiceBased()) return;

  const humans = channel.members.filter((member) => !member.user.bot).size;
  if (humans === 0) {
    session.destroy();
    sessions.delete(guildId);
    console.log(`Left ${channel.name} — everyone else had gone.`);
  }
});

function shutdown() {
  for (const session of sessions.values()) session.destroy();
  sessions.clear();
  client.destroy().finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Decode the outburst sounds up front so any bad file is reported at startup
// rather than three hours later when the roll finally comes up.
await loadOutbursts();
// Loading the TTS weights takes a few seconds — do it before anyone can ask.
await warmTts();
await registerCommands();
await client.login(config.discordToken);
