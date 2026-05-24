'use strict';

const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const { google } = require('googleapis');
const startKeepAlive = require('./keep-alive');
const hanteoCommand  = require('./commands/hanteo');

startKeepAlive();

// Sheets client
async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function main() {
  const sheets = await getSheetsClient();

  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(
      process.env.DISCORD_APPLICATION_ID,
      process.env.DISCORD_GUILD_ID
    ),
    { body: [hanteoCommand.data.toJSON()] }
  );
  console.log('Slash commands registered.');

  // Bot client
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.commands = new Collection();
  client.commands.set(hanteoCommand.data.name, hanteoCommand);

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    try {
      await command.execute(interaction, sheets);
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: '❌ An error occurred.', ephemeral: true });
    }
  });

  client.once('ready', () => console.log(`Bot ready: ${client.user.tag}`));
  await client.login(process.env.DISCORD_BOT_TOKEN);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
