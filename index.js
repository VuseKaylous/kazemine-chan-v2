const http = require('http');
http.createServer((req, res) => res.end('Bot is alive!')).listen(3000, () => {
  console.log('⚡ Keep-alive server running on port 3000');
});

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
const Database = require('better-sqlite3');

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// ── Database setup ─────────────────────────────────────────────────────────
const db = new Database('confessions.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS guilds (
    guild_id   TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    count      INTEGER DEFAULT 0
  )
`);

// Helper functions
const getGuild = db.prepare('SELECT * FROM guilds WHERE guild_id = ?');
const upsertGuild = db.prepare(`
  INSERT INTO guilds (guild_id, channel_id, count)
  VALUES (@guild_id, @channel_id, @count)
  ON CONFLICT(guild_id) DO UPDATE SET
    channel_id = excluded.channel_id,
    count      = excluded.count
`);

function getSettings(guildId) {
  return getGuild.get(guildId) ?? null;
}

function saveSettings(guildId, channelId, count = 0) {
  upsertGuild.run({ guild_id: guildId, channel_id: channelId, count });
}

function incrementCount(guildId) {
  const row = getGuild.get(guildId);
  const newCount = (row?.count ?? 0) + 1;
  db.prepare('UPDATE guilds SET count = ? WHERE guild_id = ?').run(newCount, guildId);
  return newCount;
}

// ── Register slash commands ────────────────────────────────────────────────
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
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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

// ── Handle interactions ────────────────────────────────────────────────────
client.once('clientReady', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ── /setup ───────────────────────────────────────────────────────────────
  if (interaction.commandName === 'setup') {
    const channel = interaction.options.getChannel('channel');
    const guildId = interaction.guildId;

    // Check bot permissions in chosen channel
    const botMember = interaction.guild.members.cache.get(client.user.id);
    const perms = channel.permissionsFor(botMember);
    if (!perms.has(PermissionFlagsBits.SendMessages)) {
      return interaction.reply({
        content: `❌ I don't have permission to send messages in ${channel}. Please fix my permissions and try again.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Preserve existing count if reconfiguring
    const existing = getSettings(guildId);
    saveSettings(guildId, channel.id, existing?.count ?? 0);

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
    const settings = getSettings(guildId);

    if (!settings?.channel_id) {
      return interaction.reply({
        content: '❌ No confession channel has been set up yet. Ask an admin to run `/setup` first.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const confessionText = interaction.options.getString('message');

    await interaction.reply({
      content: '✅ Your confession has been posted anonymously!',
      flags: MessageFlags.Ephemeral,
    });

    try {
      const confessionChannel = await client.channels.fetch(settings.channel_id);
      if (!confessionChannel) {
        return interaction.followUp({
          content: '❌ Confession channel not found. Ask an admin to run `/setup` again.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const count = incrementCount(guildId);

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`🔒 Anonymous Confession #${count}`)
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

// Graceful shutdown — closes DB connection cleanly
process.on('SIGINT', () => {
  db.close();
  console.log('✅ Database closed. Shutting down.');
  process.exit(0);
});

client.login(TOKEN);