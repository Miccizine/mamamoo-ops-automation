'use strict';

const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const { google } = require('googleapis');
const startKeepAlive = require('./keep-alive');
const hanteoCommand  = require('./commands/hanteo');
const { getComebackMode, getSheetData } = require('../src/helpers');
const { CronJob } = require('cron');

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
        const msg = { content: '❌ An error occurred.' };
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(msg);
        } else {
          await interaction.reply({ ...msg, ephemeral: true });
        }
      }
    });

  client.once('clientReady', () => console.log(`Bot ready: ${client.user.tag}`));
  new CronJob('0 10-23 * * *', async () => {
    try {
      const sheetsClient = await getSheetsClient();
      const isComeback   = await getComebackMode(sheetsClient);
      if (!isComeback) return;
  
      const configData     = await getSheetData(sheetsClient, 'Config');
      const releaseDateRow = configData.find(r => r[0] === 'COMEBACK_RELEASE_DATE');
      if (!releaseDateRow) return;
  
      const releaseDate = releaseDateRow[1].toString().replace(/-/g, '');
      const release     = new Date(`${releaseDate.slice(0,4)}-${releaseDate.slice(4,6)}-${releaseDate.slice(6,8)}`);
      const now         = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
      const diffDays    = Math.floor((now - release) / 86400000);
      const dayNum      = diffDays + 1;
  
      if (dayNum < 1 || dayNum > 7) return;
  
      const channel = await client.channels.fetch(process.env.DISCORD_HANTEO_CHANNEL_ID);
      await channel.send(`⏰ **Hanteo check reminder — D${dayNum}** — open Whosfan and log with \`/hanteo\``);
    } catch (e) {
      console.error('Reminder error:', e.message);
    }
  }, null, true, 'Asia/Seoul');
  await client.login(process.env.DISCORD_BOT_TOKEN);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
