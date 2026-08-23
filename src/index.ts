import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type SendableChannels,
} from "discord.js";
import {
  VoiceConnectionStatus,
  entersState,
  generateDependencyReport,
  joinVoiceChannel,
} from "@discordjs/voice";
import { config } from "./config.js";
import { VoiceSession } from "./session.js";
import { loadOutbursts } from "./noises.js";

const sessions = new Map<string, VoiceSession>();

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join your voice channel and start listening for \"Hey Claude\"."),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Leave the voice channel and stop listening."),
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
  if (!interaction.isChatInputCommand()) return;
  try {
    switch (interaction.commandName) {
      case "join":
        await handleJoin(interaction);
        break;
      case "leave":
        await handleLeave(interaction);
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
await registerCommands();
await client.login(config.discordToken);
