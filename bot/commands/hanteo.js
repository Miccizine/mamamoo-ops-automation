'use strict';
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('hanteo')
    .setDescription('Log Hanteo daily sales')
    .addStringOption(o => o.setName('artist').setDescription('Artist name').setRequired(true)
      .addChoices(
        { name: 'MAMAMOO',  value: 'MAMAMOO'  },
        { name: 'Solar',    value: 'Solar'     },
        { name: 'Moonbyul', value: 'Moonbyul'  },
        { name: 'Wheein',   value: 'Wheein'    },
        { name: 'Hwasa',    value: 'Hwasa'     },
      ))
    .addStringOption(o => o.setName('album').setDescription('Album name').setRequired(true))
    .addIntegerOption(o => o.setName('day').setDescription('Sales day number (e.g. 1, 2, 3)').setRequired(true))
    .addStringOption(o => o.setName('timestamp').setDescription('Chart timestamp e.g. 250826 — 1820 KST').setRequired(true))
    .addStringOption(o => o.setName('versions').setDescription('One version per line: VersionName | #rank | copies').setRequired(true)),

  async execute(interaction, sheets) {
    const artist    = interaction.options.getString('artist');
    const album     = interaction.options.getString('album');
    const day       = interaction.options.getInteger('day');
    const timestamp = interaction.options.getString('timestamp');
    const versionsRaw = interaction.options.getString('versions');

    // Parse versions — each line: "VersionName | #rank | copies"
    const lines = versionsRaw.split('\n').map(l => l.trim()).filter(Boolean);
    const versions = [];
    let total = 0;
    let parseError = false;

    for (const line of lines) {
      const parts = line.split('|').map(p => p.trim());
      if (parts.length < 3) { parseError = true; break; }
      const [name, rank, copiesStr] = parts;
      const copies = parseInt(copiesStr.replace(/,/g, ''), 10);
      if (isNaN(copies)) { parseError = true; break; }
      total += copies;
      versions.push({ name, rank, copies });
    }

    if (parseError || versions.length === 0) {
      await interaction.reply({
        content: '❌ Could not parse versions. Format each line as: `Version Name | #rank | copies`',
        ephemeral: true,
      });
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

    await interaction.reply({ content: '✅ Posted and logged.', ephemeral: true });
  },
};
