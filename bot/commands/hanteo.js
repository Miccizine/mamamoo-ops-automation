'use strict';
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
  .setName('hanteo')
  .setDescription('Log Hanteo daily sales')
  .addIntegerOption(o => o.setName('day').setDescription('Sales day number (e.g. 1, 2, 3)').setRequired(true))
  .addStringOption(o => o.setName('timestamp').setDescription('Chart timestamp e.g. 250826 — 1820 KST').setRequired(true))
  .addStringOption(o => o.setName('numbers').setDescription('Rank,copies per version in order e.g. 3,10000,5,8000,-,500').setRequired(true)),

  async execute(interaction, sheets) {
    await interaction.deferReply({ ephemeral: true });

    const { getSheetData } = require('../../src/helpers');
    
    // Read Config
    const configData = await getSheetData(sheets, 'Config');
    const cfg = {};
    for (const row of configData) cfg[row[0]] = row[1] || '';
    
    if (cfg['COMEBACK_MODE'] !== 'ON') {
      await interaction.editReply({ content: '❌ Comeback mode is not active.' });
      return;
    }
    
    const artist    = cfg['COMEBACK_ARTIST'];
    const album     = cfg['COMEBACK_ALBUM'];
    const versNames = cfg['COMEBACK_VERSIONS'].split(',').map(v => v.trim()).filter(Boolean);
    
    if (!artist || !album || versNames.length === 0) {
      await interaction.editReply({ content: '❌ COMEBACK_ARTIST, COMEBACK_ALBUM, or COMEBACK_VERSIONS not set in Config.' });
      return;
    }
    
    const day       = interaction.options.getInteger('day');
    const timestamp = interaction.options.getString('timestamp');
    const numbersRaw = interaction.options.getString('numbers');
    
    const parts = numbersRaw.split(',').map(p => p.trim());
    if (parts.length !== versNames.length * 2) {
      await interaction.editReply({ content: `❌ Expected ${versNames.length * 2} values (rank,copies per version), got ${parts.length}.` });
      return;
    }
    
    const versions = [];
    let total = 0;
    let parseError = false;
    
    for (let i = 0; i < versNames.length; i++) {
      const rank    = parts[i * 2];
      const copies  = parseInt(parts[i * 2 + 1].replace(/,/g, ''), 10);
      if (isNaN(copies)) { parseError = true; break; }
      total += copies;
      versions.push({ name: versNames[i], rank: rank === '-' ? '#-' : `#${rank}`, copies });
    }
    
    if (parseError || versions.length === 0) {
      await interaction.editReply({ content: '❌ Could not parse numbers. Format: rank,copies,rank,copies,...' });
      return;
    }

    // Build post
    const memberTags = {
      MAMAMOO:  { tags: '#MAMAMOO #마마무', label: '@RBW_MAMAMOO' },
      Solar:    { tags: '#SOLAR #솔라',     label: '@RBW_MAMAMOO' },
      Moonbyul: { tags: '#MOONBYUL #문별',  label: '@RBW_MAMAMOO' },
      Wheein:   { tags: '#WHEEIN #휘인',    label: '@WheeIn_0fficial' },
      Hwasa:    { tags: '#HWASA #화사',     label: '@OfficialPnation' },
    };
    const tag = memberTags[artist];

    const versionLines = versions.map(v =>
      `${v.name} — ${v.rank} | ${v.copies.toLocaleString('en-US')} copies`
    ).join('\n');

    const post = [
      `Hanteo Daily — ${artist} '${album}'`,
      ``,
      `D${day} (${timestamp})`,
      ``,
      versionLines,
      ``,
      `Total: ${total.toLocaleString('en-US')} copies`,
      ``,
      tag.tags,
      tag.label,
    ].join('\n');

    // Send to Hanteo channel
    const channel = await interaction.client.channels.fetch(process.env.DISCORD_HANTEO_CHANNEL_ID);
    await channel.send(post);

    // Log to sheet
    const { getPHTTimestamp, appendSheetRow } = require('../../src/helpers');
    const today = getPHTTimestamp().split(' ')[0].replace(/-/g, '');

    for (const v of versions) {
      await appendSheetRow(sheets, 'Hanteo Tracker', [
        today,
        artist,
        album,
        `D${day}`,
        v.name,
        v.rank,
        v.copies,
        total,
        timestamp,
      ]);
    }

    // Log cumulative to Physical Sales Log
    await appendSheetRow(sheets, 'Physical Sales Log', [
      new Date().toLocaleString('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(',', ''),
      album,
      'Hanteo',
      total,
      '', // Cumulative — manual or future calculation
    ]);

    await interaction.editReply({ content: '✅ Posted and logged.' });
  },
};
