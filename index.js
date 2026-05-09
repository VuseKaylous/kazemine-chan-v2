require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// ── In-memory store (replace with a DB like SQLite for persistence) ────────
const guildSettings = new Map(); // guildId → { channelId, count }

// ── 1. Register slash commands ─────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Set the confession channel (Admin only)')
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('The channel where confessions will be posted')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) // 👈 admins only
    .toJSON(),

  new SlashCommandBuilder()
    .setName('confess')
    .setDescription('Send an anonymous confession')
    .addStringOption((opt) =>
      opt
        .setName('message')
        .setDescription('Your confession (no one will know it was you)')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(1000)
    )
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`✅ Commands registered for guild ${GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('✅ Commands registered globally');
    }
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
})();

// ── 2. Handle interactions ─────────────────────────────────────────────────
client.once('clientReady', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ── /setup ───────────────────────────────────────────────────────────────
  if (interaction.commandName === 'setup') {
    const channel = interaction.options.getChannel('channel');
    const guildId = interaction.guildId;

    // Verify the bot can send messages in the chosen channel
    const botMember = interaction.guild.members.cache.get(client.user.id);
    const perms = channel.permissionsFor(botMember);
    if (!perms.has(PermissionFlagsBits.SendMessages)) {
      return interaction.reply({
        content: `❌ I don't have permission to send messages in ${channel}. Please fix my permissions and try again.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Save the setting for this guild
    const existing = guildSettings.get(guildId) || { count: 0 };
    guildSettings.set(guildId, { channelId: channel.id, count: existing.count });

    // Post a welcome message in the confession channel
    const setupEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🔒 Anonymous Confessions')
      .setDescription(
        'This channel is now set up for anonymous confessions!\n\n' +
        'Use `/confess` anywhere in the server to post anonymously.\n' +
        'Your identity will never be revealed.'
      )
      .setTimestamp();

    await channel.send({ embeds: [setupEmbed] });

    return interaction.reply({
      content: `✅ Confession channel set to ${channel}! Members can now use \`/confess\` anywhere.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── /confess ─────────────────────────────────────────────────────────────
  if (interaction.commandName === 'confess') {
    const guildId = interaction.guildId;
    const settings = guildSettings.get(guildId);

    // Guard: setup not done yet
    if (!settings?.channelId) {
      return interaction.reply({
        content: '❌ No confession channel has been set up yet. Ask an admin to run `/setup` first.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const confessionText = interaction.options.getString('message');

    // Confirm to the user immediately (only they see this)
    await interaction.reply({
      content: '✅ Your confession has been posted anonymously!',
      flags: MessageFlags.Ephemeral,
    });

    try {
      const confessionChannel = await client.channels.fetch(settings.channelId);
      if (!confessionChannel) {
        return interaction.followUp({
          content: '❌ Confession channel not found. Ask an admin to run `/setup` again.',
          flags: MessageFlags.Ephemeral,
        });
      }

      settings.count++;

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`🔒 Anonymous Confession #${settings.count}`)
        .setDescription(confessionText)
        .setFooter({ text: 'Use /confess to share your own!' })
        .setTimestamp();

      await confessionChannel.send({ embeds: [embed] });

    } catch (err) {
      console.error(err);
      await interaction.followUp({
        content: '❌ Something went wrong. Please try again.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }
});

client.login(TOKEN);
