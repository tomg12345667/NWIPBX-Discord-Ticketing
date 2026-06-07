const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  AttachmentBuilder,
} = require("discord.js");

require("dotenv").config();

// ─── Config ───────────────────────────────────────────────────────────────────
const STAFF_ROLE_1        = "1470145227929944376";
const STAFF_ROLE_2        = "1470179326858231818";
const TRANSCRIPT_CHANNEL  = "1470145229771505923";
const TICKET_CATEGORY_ID  = process.env.TICKET_CATEGORY_ID || null;
const OWNER_EXTENSIONS    = Array.from({ length: 21 }, (_, i) => 1000 + i); // 1000–1020

// In-memory ticket registry: channelId → { ticketNumber, openerId, ext, callerId }
const ticketRegistry = new Map();
let ticketCounter = 1;

// ─── Client ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isStaffMember(member) {
  return member.roles.cache.has(STAFF_ROLE_1) || member.roles.cache.has(STAFF_ROLE_2);
}

async function createTicketChannel(guild, opener, { ext, callerId, voicemail, features }) {
  const ticketNumber = ticketCounter++;
  const permissionOverwrites = [
    { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: opener.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    {
      id: STAFF_ROLE_1,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages],
    },
    {
      id: STAFF_ROLE_2,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages],
    },
  ];

  const channelOptions = {
    name: `📱new-line-${opener.username}`,
    type: ChannelType.GuildText,
    permissionOverwrites,
    topic: `Ticket #${ticketNumber} | ${opener.tag} | Ext: ${ext ?? "N/A"} | Caller: ${callerId ?? "N/A"}`,
  };
  if (TICKET_CATEGORY_ID) channelOptions.parent = TICKET_CATEGORY_ID;

  const channel = await guild.channels.create(channelOptions);

  ticketRegistry.set(channel.id, {
    ticketNumber,
    openerId: opener.id,
    openerTag: opener.tag,
    ext: ext ?? "N/A",
    callerId: callerId ?? "N/A",
    voicemail: voicemail ?? "N/A",
    features: features || "None provided",
    openedAt: new Date(),
  });

  const embed = new EmbedBuilder()
    .setTitle(`📞 Ticket #${ticketNumber}`)
    .setColor(0x5865f2)
    .setThumbnail(opener.displayAvatarURL({ dynamic: true }))
    .addFields(
      { name: "👤 Opened By", value: `<@${opener.id}>`, inline: true },
      { name: "🎫 Ticket #", value: `\`${ticketNumber}\``, inline: true },
      { name: "🔢 Extension", value: `\`${ext ?? "N/A"}\``, inline: true },
      { name: "📋 Caller ID", value: callerId ?? "N/A", inline: true },
      { name: "📬 Voicemail?", value: voicemail ?? "N/A", inline: true },
      { name: "⭐ Additional Features", value: features || "*None provided*", inline: false }
    )
    .setFooter({ text: "Staff: use ?close <reason> to close this ticket" })
    .setTimestamp();

  await channel.send({
    content: `<@${opener.id}> <@&${STAFF_ROLE_1}> <@&${STAFF_ROLE_2}>`,
    embeds: [embed],
  });

  return { channel, ticketNumber };
}

// ─── Transcript Generator ─────────────────────────────────────────────────────

async function generateTranscript(channel, ticketData, reason, closedBy) {
  // Fetch all messages
  const messages = [];
  let lastId;
  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;
    messages.push(...batch.values());
    lastId = batch.last().id;
    if (batch.size < 100) break;
  }
  messages.reverse();

  const rows = messages.map((msg) => {
    const time = new Date(msg.createdTimestamp).toLocaleString();
    const author = msg.author.tag;
    const avatar = msg.author.displayAvatarURL({ format: "png", size: 32 });
    const isBot = msg.author.bot;
    const content = msg.content
      ? msg.content.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      : "";
    const embeds = msg.embeds.map(e =>
      `<div class="embed"><strong>${e.title ?? ""}</strong><p>${e.description ?? ""}</p></div>`
    ).join("");
    const attachments = [...msg.attachments.values()].map(a =>
      `<a href="${a.url}" target="_blank">📎 ${a.name}</a>`
    ).join(" ");

    return `
      <div class="message ${isBot ? "bot" : ""}">
        <img class="avatar" src="${avatar}" alt="" />
        <div class="content">
          <span class="author">${author}</span>
          <span class="time">${time}</span>
          <div class="text">${content}${embeds}${attachments}</div>
        </div>
      </div>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Ticket #${ticketData.ticketNumber} Transcript</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #313338; color: #dbdee1; font-family: "gg sans","Helvetica Neue",Helvetica,Arial,sans-serif; font-size: 14px; }
  .header { background: #1e1f22; padding: 20px 24px; border-bottom: 1px solid #1a1b1e; display: flex; align-items: center; gap: 16px; }
  .header h1 { font-size: 20px; color: #fff; }
  .header .meta { font-size: 12px; color: #949ba4; margin-top: 4px; }
  .info-bar { background: #2b2d31; padding: 12px 24px; display: flex; gap: 32px; flex-wrap: wrap; border-bottom: 1px solid #1a1b1e; }
  .info-item { display: flex; flex-direction: column; }
  .info-item .label { font-size: 11px; text-transform: uppercase; font-weight: 700; color: #949ba4; letter-spacing: .5px; }
  .info-item .value { font-size: 14px; color: #dbdee1; margin-top: 2px; }
  .messages { padding: 16px 24px; }
  .message { display: flex; gap: 12px; padding: 4px 0 4px 0; margin: 2px 0; border-radius: 4px; }
  .message:hover { background: #2e3035; }
  .message.bot .author { color: #5865f2; }
  .avatar { width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0; margin-top: 2px; }
  .content { flex: 1; min-width: 0; }
  .author { font-weight: 600; color: #fff; margin-right: 8px; }
  .time { font-size: 11px; color: #949ba4; }
  .text { margin-top: 2px; line-height: 1.5; word-break: break-word; white-space: pre-wrap; }
  .embed { background: #2b2d31; border-left: 4px solid #5865f2; border-radius: 4px; padding: 10px 12px; margin-top: 6px; }
  .embed strong { color: #fff; display: block; margin-bottom: 4px; }
  a { color: #00a8fc; }
  .close-info { background: #2b2d31; border: 1px solid #ed4245; border-radius: 8px; padding: 16px 24px; margin: 16px 24px; }
  .close-info h3 { color: #ed4245; margin-bottom: 8px; }
  .close-info p { color: #dbdee1; line-height: 1.6; }
  .footer { text-align: center; padding: 20px; color: #949ba4; font-size: 12px; border-top: 1px solid #1a1b1e; margin-top: 16px; }
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>📋 Ticket #${ticketData.ticketNumber} Transcript</h1>
    <div class="meta">Opened by ${ticketData.openerTag} · Closed by ${closedBy} · ${new Date().toLocaleString()}</div>
  </div>
</div>
<div class="info-bar">
  <div class="info-item"><span class="label">Opener</span><span class="value">${ticketData.openerTag}</span></div>
  <div class="info-item"><span class="label">Extension</span><span class="value">${ticketData.ext}</span></div>
  <div class="info-item"><span class="label">Caller ID</span><span class="value">${ticketData.callerId}</span></div>
  <div class="info-item"><span class="label">Voicemail</span><span class="value">${ticketData.voicemail}</span></div>
  <div class="info-item"><span class="label">Opened At</span><span class="value">${new Date(ticketData.openedAt).toLocaleString()}</span></div>
  <div class="info-item"><span class="label">Channel</span><span class="value">#${channel.name}</span></div>
</div>
<div class="close-info">
  <h3>🔒 Close Reason</h3>
  <p>${reason.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</p>
</div>
<div class="messages">
${rows}
</div>
<div class="footer">Generated by Ticket Bot · ${new Date().toUTCString()}</div>
</body>
</html>`;

  return Buffer.from(html, "utf-8");
}

// ─── Close Ticket ─────────────────────────────────────────────────────────────

async function handleCloseTicket(interaction, reason) {
  const channel = interaction.channel;
  const ticketData = ticketRegistry.get(channel.id);

  await interaction.update({ content: "⏳ Generating transcript and closing...", components: [], embeds: [] });

  // Generate transcript
  let transcriptBuffer;
  try {
    transcriptBuffer = await generateTranscript(channel, ticketData ?? {
      ticketNumber: "?", openerTag: "Unknown", ext: "N/A",
      callerId: "N/A", voicemail: "N/A", features: "N/A", openedAt: new Date(),
    }, reason, interaction.user.tag);
  } catch (err) {
    console.error("Transcript generation failed:", err);
  }

  const attachment = transcriptBuffer
    ? new AttachmentBuilder(transcriptBuffer, { name: `transcript-ticket-${ticketData?.ticketNumber ?? channel.id}.html` })
    : null;

  const closeEmbed = new EmbedBuilder()
    .setTitle("🔒 Ticket Closed")
    .setColor(0xed4245)
    .addFields(
      { name: "Closed By", value: interaction.user.tag, inline: true },
      { name: "Reason", value: reason, inline: true },
      { name: "Ticket", value: `#${ticketData?.ticketNumber ?? "?"}`, inline: true },
    )
    .setTimestamp();

  // Post to transcript channel
  try {
    const transcriptChannel = await interaction.guild.channels.fetch(TRANSCRIPT_CHANNEL);
    if (transcriptChannel && attachment) {
      await transcriptChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`📋 Transcript — Ticket #${ticketData?.ticketNumber ?? "?"}`)
            .setColor(0x5865f2)
            .addFields(
              { name: "Opened By", value: ticketData ? `<@${ticketData.openerId}>` : "Unknown", inline: true },
              { name: "Closed By", value: `<@${interaction.user.id}>`, inline: true },
              { name: "Reason", value: reason, inline: false },
            )
            .setTimestamp(),
        ],
        files: [attachment],
      });
    }
  } catch (err) {
    console.error("Failed to post to transcript channel:", err);
  }

  // DM the opener
  if (ticketData) {
    try {
      const opener = await client.users.fetch(ticketData.openerId);
      const dmAttachment = transcriptBuffer
        ? new AttachmentBuilder(transcriptBuffer, { name: `transcript-ticket-${ticketData.ticketNumber}.html` })
        : null;
      await opener.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`📋 Your Ticket #${ticketData.ticketNumber} Has Been Closed`)
            .setColor(0xed4245)
            .setDescription(`Your ticket has been closed.\n\n**Reason:** ${reason}\n\nYour transcript is attached below.`)
            .setTimestamp(),
        ],
        ...(dmAttachment ? { files: [dmAttachment] } : {}),
      });
    } catch (err) {
      console.warn("Could not DM opener (DMs may be closed):", err.message);
    }
  }

  // Post close embed in channel, then delete after 5s
  await channel.send({ embeds: [closeEmbed] });
  ticketRegistry.delete(channel.id);

  setTimeout(async () => {
    try { await channel.delete(`Closed by ${interaction.user.tag}: ${reason}`); }
    catch (e) { console.error("Failed to delete channel:", e); }
  }, 5000);
}

// ─── Interaction Handler ──────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  console.log(`[interaction] type=${interaction.type} customId=${interaction.customId ?? "n/a"} user=${interaction.user.tag}`);

  try {

    // ── Open Ticket Button ──
    if (interaction.isButton() && interaction.customId === "open_ticket") {
      const modal = new ModalBuilder().setCustomId("ticket_form").setTitle("📞 Open a New Ticket");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("extension").setLabel("Extension Number")
            .setPlaceholder("e.g. 1025  (1000–1020 reserved for Owner)")
            .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(6)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("caller_id").setLabel("Caller ID")
            .setPlaceholder("Your name or number")
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("voicemail").setLabel("Voicemail?")
            .setPlaceholder("Yes / No — and any message if applicable")
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("features").setLabel("Any Additional Features / Notes?")
            .setPlaceholder("Describe anything else you need...")
            .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
        ),
      );
      await interaction.showModal(modal);
      return;
    }

    // ── Ticket Form Submit ──
    if (interaction.isModalSubmit() && interaction.customId === "ticket_form") {
      const extension = interaction.fields.getTextInputValue("extension").trim();
      const callerId  = interaction.fields.getTextInputValue("caller_id").trim();
      const voicemail = interaction.fields.getTextInputValue("voicemail").trim();
      const features  = interaction.fields.getTextInputValue("features").trim();

      const extNum = parseInt(extension, 10);
      if (isNaN(extNum))
        return interaction.reply({ content: "❌ Extension must be a number.", ephemeral: true });
      if (OWNER_EXTENSIONS.includes(extNum))
        return interaction.reply({ content: "❌ Extensions **1000–1020** are reserved for the Owner.", ephemeral: true });

      await interaction.deferReply({ ephemeral: true });
      try {
        const { channel, ticketNumber } = await createTicketChannel(
          interaction.guild, interaction.user,
          { ext: extNum, callerId, voicemail, features }
        );
        await interaction.editReply({ content: `✅ Ticket #${ticketNumber} created: ${channel}` });
      } catch (err) {
        console.error("Error creating ticket:", err);
        await interaction.editReply({ content: "❌ Failed to create your ticket. Please contact a staff member." });
      }
      return;
    }

    // ── Confirm Close Button ──
    if (interaction.isButton() && interaction.customId.startsWith("confirm_close:")) {
      const reason = interaction.customId.split(":").slice(1).join(":");
      await handleCloseTicket(interaction, reason);
      return;
    }

    // ── Edit Close Reason Button ──
    if (interaction.isButton() && interaction.customId.startsWith("edit_reason:")) {
      const currentReason = interaction.customId.split(":").slice(1).join(":");
      const modal = new ModalBuilder().setCustomId("edit_reason_modal").setTitle("✏️ Edit Close Reason");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("new_reason").setLabel("New Close Reason")
            .setStyle(TextInputStyle.Paragraph).setRequired(true)
            .setValue(currentReason).setMaxLength(500)
        )
      );
      await interaction.showModal(modal);
      return;
    }

    // ── Edit Reason Modal Submit ──
    if (interaction.isModalSubmit() && interaction.customId === "edit_reason_modal") {
      const newReason = interaction.fields.getTextInputValue("new_reason").trim();
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`confirm_close:${newReason}`).setLabel("✅ Confirm Close").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`edit_reason:${newReason}`).setLabel("✏️ Edit Reason").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("cancel_close").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary),
      );
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle("🔒 Close Ticket Request")
            .setColor(0xed4245)
            .setDescription(`**Reason:** ${newReason}`)
            .setFooter({ text: "This channel will be deleted after closing." })
            .setTimestamp(),
        ],
        components: [confirmRow],
      });
      return;
    }

    // ── Cancel Close Button ──
    if (interaction.isButton() && interaction.customId === "cancel_close") {
      await interaction.update({ content: "❌ Close request cancelled.", embeds: [], components: [] });
      return;
    }

  } catch (err) {
    console.error("[interactionCreate error]", err);
  }
});

// ─── Message Commands ─────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("?")) return;

  const member = message.member;
  const isStaff = isStaffMember(member);

  // ── ?sendpanel [channel id] ──
  if (message.content.startsWith("?sendpanel")) {
    if (!isStaff) return message.reply("❌ Only staff can deploy the ticket panel.");

    const arg = message.content.slice("?sendpanel".length).trim();
    const channelIdArg = arg.replace(/^<#(\d+)>$/, "$1");
    let targetChannel = message.channel;

    if (channelIdArg) {
      try {
        const fetched = await message.guild.channels.fetch(channelIdArg);
        if (!fetched || !fetched.isTextBased()) return message.reply("❌ Could not find a text channel with that ID.");
        targetChannel = fetched;
      } catch {
        return message.reply("❌ Invalid channel ID.");
      }
    }

    const embed = new EmbedBuilder()
      .setTitle("📞 Support Ticket System")
      .setDescription(
        "Need help? Click the button below to open a new support ticket.\n\n" +
        "**You'll be asked for:**\n• 🔢 Extension number\n• 📋 Caller ID\n• 📬 Voicemail preference\n• ⭐ Any additional features or notes\n\n" +
        "*Extensions 1000–1020 are reserved for the Owner.*"
      )
      .setColor(0x5865f2)
      .setFooter({ text: "Our staff will be with you shortly." })
      .setTimestamp();

    await targetChannel.send({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("open_ticket").setLabel("🎫 Open Ticket").setStyle(ButtonStyle.Primary)
      )],
    });

    if (targetChannel.id !== message.channel.id)
      await message.reply({ content: `✅ Panel sent to ${targetChannel}.`, allowedMentions: { parse: [] } });
    await message.delete().catch(() => {});
    return;
  }

  // ── ?close [reason] ──
  if (message.content.startsWith("?close")) {
    if (!isStaff) return message.reply("❌ Only staff can close tickets.");

    const reason = message.content.slice("?close".length).trim() || "No reason provided";

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`confirm_close:${reason}`).setLabel("✅ Confirm Close").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`edit_reason:${reason}`).setLabel("✏️ Edit Reason").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("cancel_close").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary),
    );

    await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("🔒 Close Ticket Request")
          .setColor(0xed4245)
          .setDescription(`**${message.author.tag}** has requested to close this ticket.\n\n**Reason:** ${reason}`)
          .setFooter({ text: "This channel will be deleted after closing." })
          .setTimestamp(),
      ],
      components: [confirmRow],
    });
    return;
  }

  // ── ?reopen <ticket number> ──
  if (message.content.startsWith("?reopen")) {
    if (!isStaff) return message.reply("❌ Only staff can reopen tickets.");

    const arg = message.content.slice("?reopen".length).trim();
    const ticketNum = parseInt(arg, 10);
    if (isNaN(ticketNum)) return message.reply("❌ Usage: `?reopen <ticket number>`");

    // Find the channel by ticket number
    const entry = [...ticketRegistry.entries()].find(([, v]) => v.ticketNumber === ticketNum);
    if (entry) {
      const [channelId] = entry;
      return message.reply(`❌ Ticket #${ticketNum} is still open: <#${channelId}>`);
    }

    // Ticket is closed — create a new one with the same number noted
    return message.reply(
      `⚠️ Ticket #${ticketNum} has already been closed and its channel deleted.\n` +
      `To manually open a new ticket for a user, use \`?manualopen @user\`.`
    );
  }

  // ── ?manualopen <@user or user id> ──
  if (message.content.startsWith("?manualopen")) {
    if (!isStaff) return message.reply("❌ Only staff can manually open tickets.");

    const arg = message.content.slice("?manualopen".length).trim();
    const userIdMatch = arg.match(/^<@!?(\d+)>$/) || arg.match(/^(\d+)$/);
    if (!userIdMatch) return message.reply("❌ Usage: `?manualopen @user` or `?manualopen <user id>`");

    const userId = userIdMatch[1];
    let targetUser;
    try {
      targetUser = await client.users.fetch(userId);
    } catch {
      return message.reply("❌ Could not find that user.");
    }

    const targetMember = await message.guild.members.fetch(userId).catch(() => null);
    if (!targetMember) return message.reply("❌ That user is not in this server.");

    try {
      const { channel, ticketNumber } = await createTicketChannel(
        message.guild, targetUser,
        { ext: null, callerId: null, voicemail: null, features: `Manually opened by ${message.author.tag}` }
      );
      await message.reply({ content: `✅ Ticket #${ticketNumber} manually opened for <@${userId}>: ${channel}`, allowedMentions: { parse: [] } });
    } catch (err) {
      console.error("Error in ?manualopen:", err);
      await message.reply("❌ Failed to create the ticket channel.");
    }
    return;
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(process.env.BOT_TOKEN);
