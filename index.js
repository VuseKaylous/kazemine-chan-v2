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
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');
const Database = require('better-sqlite3');
const http = require('http');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// ── Database ───────────────────────────────────────────────────────────────
const db = new Database('confessions.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS guilds (
    guild_id   TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    count      INTEGER DEFAULT 0
  )
`);

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

// ── HTTP server (website + webhook endpoint) ───────────────────────────────
const server = http.createServer(async (req, res) => {

  // Add CORS headers to every response
  res.setHeader('Access-Control-Allow-Origin', 'https://your-project.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Serve the confession website
  if (req.method === 'GET' && req.url === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // Handle confession submission from website
  if (req.method === 'POST' && req.url === '/confess') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { confession } = JSON.parse(body);

        if (!confession || confession.trim().length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Confession cannot be empty' }));
        }

        if (confession.length > 2000) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Confession too long (max 2000 characters)' }));
        }

        const guildId = process.env.GUILD_ID;
        const settings = getSettings(guildId);
        if (!settings?.channel_id) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'No confession channel set up for this server' }));
        }

        const confessionChannel = await client.channels.fetch(settings.channel_id);
        const count = incrementCount(guildId);

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`🔒 Anonymous Confession #${count}`)
          .setDescription(confession.trim())
          .setFooter({ text: 'Submitted via confession website' })
          .setTimestamp();

        await confessionChannel.send({ embeds: [embed] });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));

      } catch (err) {
        console.error('Confession error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Something went wrong' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(3000, () => {
  console.log('🌐 Website running on port 3000');
});

// ── Register slash commands ────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Set the confession channel (Admin only)')
    .addChannelOption((opt) =>
      opt.setName('channel')
        .setDescription('The channel where confessions will be posted')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('confess')
    .setDescription('Send an anonymous confession')
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    }
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
})();

// ── Discord interactions ───────────────────────────────────────────────────
client.once('clientReady', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {

    if (interaction.commandName === 'setup') {
      const channel = interaction.options.getChannel('channel');
      const guildId = interaction.guildId;

      const botMember = interaction.guild.members.cache.get(client.user.id);
      const perms = channel.permissionsFor(botMember);
      if (!perms.has(PermissionFlagsBits.SendMessages)) {
        return interaction.reply({
          content: `❌ I don't have permission to send messages in ${channel}.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const existing = getSettings(guildId);
      saveSettings(guildId, channel.id, existing?.count ?? 0);

      const setupEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('🔒 Anonymous Confessions')
        .setDescription(
          'This channel is now set up for anonymous confessions!\n\n' +
          'Use `/confess` or the confession website to post anonymously.'
        )
        .setTimestamp();

      await channel.send({ embeds: [setupEmbed] });

      return interaction.reply({
        content: `✅ Confession channel set to ${channel}!`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.commandName === 'confess') {
      const settings = getSettings(interaction.guildId);
      if (!settings?.channel_id) {
        return interaction.reply({
          content: '❌ No confession channel set up yet. Ask an admin to run `/setup` first.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId('confess_modal')
        .setTitle('Anonymous Confession');

      const confessionInput = new TextInputBuilder()
        .setCustomId('confession_text')
        .setLabel('Your confession')
        .setPlaceholder('Write your confession here...')
        .setStyle(TextInputStyle.Paragraph)
        .setMinLength(1)
        .setMaxLength(2000)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(confessionInput));
      return interaction.showModal(modal);
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === 'confess_modal') {
    const guildId = interaction.guildId;
    const settings = getSettings(guildId);
    const confessionText = interaction.fields.getTextInputValue('confession_text');

    await interaction.reply({
      content: '✅ Your confession has been posted anonymously!',
      flags: MessageFlags.Ephemeral,
    });

    try {
      const confessionChannel = await client.channels.fetch(settings.channel_id);
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

process.on('SIGINT', () => {
  db.close();
  console.log('✅ Database closed.');
  process.exit(0);
});

client.login(TOKEN);