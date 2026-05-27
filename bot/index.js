'use strict';

const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const { google } = require('googleapis');
const startKeepAlive = require('./keep-alive');
const hanteoHourlyCommand = require('./commands/hanteo-hourly');
const hanteoDailyCommand = require('./commands/hanteo-daily');
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
    { body: [hanteoHourlyCommand.data.toJSON(), hanteoDailyCommand.data.toJSON()] }
  );
  console.log('Slash commands registered.');

  // Bot client
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.commands = new Collection();
  client.commands.set(hanteoHourlyCommand.data.name, hanteoHourlyCommand);
  client.commands.set(hanteoDailyCommand.data.name, hanteoDailyCommand);

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
      if (!releaseDateRow[1] || releaseDateRow[1].toString().trim() === '') return;
  
      const rawDate = releaseDateRow[1].toString().trim();
      let release;
      if (rawDate.includes('/')) {
        const [m, d, y] = rawDate.split('/');
        release = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
      } else {
        const cleaned = rawDate.replace(/-/g, '');
        release = new Date(`${cleaned.slice(0,4)}-${cleaned.slice(4,6)}-${cleaned.slice(6,8)}`);
      }
      
      const now         = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
      const diffDays    = Math.floor((now - release) / 86400000);
      const dayNum      = diffDays + 1;
  
      if (dayNum < 1 || dayNum > 7) return;
  
      const channel = await client.channels.fetch(process.env.DISCORD_HANTEO_CHANNEL_ID);
      const reminder = await channel.send(`⏰ **Hanteo check reminder — D${dayNum}** — open Whosfan and log with \`/hanteo-hourly\``);
      setTimeout(() => reminder.delete().catch(() => {}), 55 * 60 * 1000);
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
