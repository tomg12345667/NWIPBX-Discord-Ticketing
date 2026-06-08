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
} = require("discord.js");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

// ─── Config ───────────────────────────────────────────────────────────────────
const STAFF_ROLE_1       = "1470145227929944376";
const STAFF_ROLE_2       = "1470179326858231818";
const TRANSCRIPT_CHANNEL = "1470145229771505923";
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || null;
const OWNER_EXTENSIONS   = Array.from({ length: 21 }, (_, i) => 1000 + i); // 1000–1020
const ADMIN_ROLE         = process.env.ADMIN_ROLE_ID || STAFF_ROLE_1; // fallback to staff role 1

// ─── Counter persistence ──────────────────────────────────────────────────────
const COUNTER_FILE = path.join(__dirname, "counter.json");

function loadCounter() {
  try {
    if (fs.existsSync(COUNTER_FILE)) {
      const data = JSON.parse(fs.readFileSync(COUNTER_FILE, "utf-8"));
      return data.counter ?? 1;
    }
  } catch {}
  return 1;
}

function saveCounter(val) {
  fs.writeFileSync(COUNTER_FILE, JSON.stringify({ counter: val }), "utf-8");
}

let ticketCounter = loadCounter();

// ─── Form config (editable via ?editform) ─────────────────────────────────────
const FORM_FILE = path.join(__dirname, "form.json");

const DEFAULT_FORM = {
  line: {
    title: "📞 Open a New Line Ticket",
    fields: [
      { id: "extension", label: "Extension Number", placeholder: "e.g. 1025  (1000–1020 reserved for Owner)", required: true },
      { id: "caller_id", label: "Caller ID", placeholder: "Your name or number", required: true },
      { id: "voicemail", label: "Voicemail?", placeholder: "Yes / No — and any message if applicable", required: true },
      { id: "features",  label: "Any Additional Features / Notes?", placeholder: "Describe anything else you need...", required: false },
    ],
  },
  general: {
    title: "🎫 Open a General Support Ticket",
    fields: [
      { id: "subject",     label: "Subject", placeholder: "Brief summary of your issue", required: true },
      { id: "description", label: "Description", placeholder: "Describe your issue in detail...", required: true },
      { id: "priority",    label: "Priority (Low / Medium / High)", placeholder: "How urgent is this?", required: false },
      { id: "extra",       label: "Anything Else?", placeholder: "Any other relevant info...", required: false },
    ],
  },
};

function loadForm() {
  try {
    if (fs.existsSync(FORM_FILE)) return JSON.parse(fs.readFileSync(FORM_FILE, "utf-8"));
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_FORM));
}

function saveForm(data) {
  fs.writeFileSync(FORM_FILE, JSON.stringify(data, null, 2), "utf-8");
}

let formConfig = loadForm();

// ─── In-memory ticket registry ────────────────────────────────────────────────
// channelId → { ticketNumber, openerId, openerTag, type, openedAt, fields }
const ticketRegistry = new Map();

// Pending manual opens: messageId → { staffTag, targetUserId, targetUserTag }
const pendingManualOpens = new Map();

// ─── Panel message tracker: panelType → { channelId, messageId } ──────────────
const panelRegistry = new Map();

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

client.once("ready", () => console.log(`✅ Logged in as ${client.user.tag} | Ticket counter starts at #${ticketCounter}`));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isStaff(member) {
  return member.roles.cache.has(STAFF_ROLE_1) || member.roles.cache.has(STAFF_ROLE_2);
}
function isAdmin(member) {
  return member.roles.cache.has(ADMIN_ROLE) || member.permissions.has(PermissionFlagsBits.Administrator);
}

function nextTicketNumber() {
  const n = ticketCounter++;
  saveCounter(ticketCounter);
  return n;
}

async function createTicketChannel(guild, opener, { type = "line", fields = {}, manualReason = null }) {
  const ticketNumber = nextTicketNumber();
  const permissionOverwrites = [
    { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
    { id: opener.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: STAFF_ROLE_1, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
    { id: STAFF_ROLE_2, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
  ];

  const channelOptions = {
    name: `📱new-line-${opener.username}`,
    type: ChannelType.GuildText,
    permissionOverwrites,
    topic: `Ticket #${ticketNumber} | ${opener.tag} | Type: ${type}`,
  };
  if (TICKET_CATEGORY_ID) channelOptions.parent = TICKET_CATEGORY_ID;

  const channel = await guild.channels.create(channelOptions);

  ticketRegistry.set(channel.id, {
    ticketNumber, openerId: opener.id, openerTag: opener.tag,
    type, openedAt: new Date(), fields, manualReason,
  });

  // Build embed fields from form submission
  const embedFields = [
    { name: "👤 Opened By", value: `<@${opener.id}>`, inline: true },
    { name: "🎫 Ticket #",  value: `\`${ticketNumber}\``, inline: true },
    { name: "📂 Type",      value: type === "line" ? "📱 New Line" : "🎫 General Support", inline: true },
  ];

  if (manualReason) {
    embedFields.push({ name: "📝 Reason (Manual Open)", value: manualReason, inline: false });
  } else {
    const form = formConfig[type];
    if (form) {
      for (const f of form.fields) {
        if (fields[f.id]) {
          embedFields.push({ name: f.label, value: fields[f.id] || "*Not provided*", inline: f.id !== "description" && f.id !== "features" });
        }
      }
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(type === "line" ? "📱 New Line Request" : "🎫 General Support Ticket")
    .setColor(type === "line" ? 0x5865f2 : 0x57f287)
    .setThumbnail(opener.displayAvatarURL({ dynamic: true }))
    .addFields(embedFields)
    .setFooter({ text: "Staff: use ?close <reason> to close this ticket" })
    .setTimestamp();

  await channel.send({
    content: `<@${opener.id}> <@&${STAFF_ROLE_1}> <@&${STAFF_ROLE_2}>`,
    embeds: [embed],
  });

  return { channel, ticketNumber };
}

// ─── Plain-text transcript ────────────────────────────────────────────────────
async function sendPlainTranscript(channel, ticketData, reason, closedByTag) {
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

  const lines = [
    `╔══════════════════════════════════════════╗`,
    `   📋 TICKET #${ticketData?.ticketNumber ?? "?"} TRANSCRIPT`,
    `╚══════════════════════════════════════════╝`,
    ``,
    `📌 Opened by : ${ticketData?.openerTag ?? "Unknown"}`,
    `📂 Type      : ${ticketData?.type === "line" ? "New Line" : "General Support"}`,
    `🕐 Opened at : ${new Date(ticketData?.openedAt ?? Date.now()).toLocaleString()}`,
    `🔒 Closed by : ${closedByTag}`,
    `📝 Reason    : ${reason}`,
    ``,
    `──────────────────────────────────────────`,
    ``,
  ];

  for (const msg of messages) {
    if (msg.author.bot && msg.embeds.length > 0 && !msg.content) continue; // skip pure-embed bot messages
    const time = new Date(msg.createdTimestamp).toLocaleString();
    const text = msg.content || (msg.embeds[0]?.title ? `[Embed: ${msg.embeds[0].title}]` : "[No content]");
    lines.push(`[${time}] ${msg.author.tag}`);
    lines.push(`  ${text}`);
    if (msg.attachments.size > 0) lines.push(`  📎 ${[...msg.attachments.values()].map(a => a.url).join(", ")}`);
    lines.push(``);
  }

  lines.push(`──────────────────────────────────────────`);
  lines.push(`End of transcript`);

  const transcript = lines.join("\n");

  // DM the opener
  try {
    const opener = await client.users.fetch(ticketData.openerId);
    // Split if over 2000 chars
    const chunks = [];
    let current = "";
    for (const line of transcript.split("\n")) {
      if ((current + line + "\n").length > 1900) { chunks.push(current); current = ""; }
      current += line + "\n";
    }
    if (current) chunks.push(current);

    for (const chunk of chunks) {
      await opener.send(`\`\`\`\n${chunk}\n\`\`\``);
    }
  } catch (err) {
    console.warn("Could not DM opener:", err.message);
  }

  // Post to transcript channel
  try {
    const transcriptChannel = await client.channels.fetch(TRANSCRIPT_CHANNEL);
    const chunks = [];
    let current = "";
    for (const line of transcript.split("\n")) {
      if ((current + line + "\n").length > 1900) { chunks.push(current); current = ""; }
      current += line + "\n";
    }
    if (current) chunks.push(current);

    await transcriptChannel.send({
      embeds: [new EmbedBuilder()
        .setTitle(`📋 Transcript — Ticket #${ticketData?.ticketNumber ?? "?"}`)
        .setColor(0x5865f2)
        .addFields(
          { name: "Opened By", value: ticketData ? `<@${ticketData.openerId}>` : "Unknown", inline: true },
          { name: "Closed By", value: `${closedByTag}`, inline: true },
          { name: "Reason", value: reason },
        )
        .setTimestamp()],
    });
    for (const chunk of chunks) {
      await transcriptChannel.send(`\`\`\`\n${chunk}\n\`\`\``);
    }
  } catch (err) {
    console.error("Failed to post transcript:", err);
  }
}

// ─── Close ticket ─────────────────────────────────────────────────────────────
async function handleCloseTicket(interaction, reason) {
  const channel = interaction.channel;
  const ticketData = ticketRegistry.get(channel.id);

  await interaction.update({ content: "⏳ Closing ticket and sending transcript...", components: [], embeds: [] });

  await sendPlainTranscript(channel, ticketData, reason, interaction.user.tag);

  await channel.send({
    embeds: [new EmbedBuilder()
      .setTitle("🔒 Ticket Closed")
      .setColor(0xed4245)
      .addFields(
        { name: "Closed By", value: interaction.user.tag, inline: true },
        { name: "Reason",    value: reason, inline: true },
        { name: "Ticket",    value: `#${ticketData?.ticketNumber ?? "?"}`, inline: true },
      )
      .setTimestamp()],
  });

  ticketRegistry.delete(channel.id);
  setTimeout(async () => {
    try { await channel.delete(`Closed by ${interaction.user.tag}: ${reason}`); }
    catch (e) { console.error("Failed to delete channel:", e); }
  }, 5000);
}

// ─── Panel builders ───────────────────────────────────────────────────────────
function buildLinePanel() {
  return {
    embeds: [new EmbedBuilder()
      .setTitle("📱 New Line Request")
      .setDescription(
        "Need a new line set up? Click below to open a ticket.\n\n" +
        "**You'll be asked for:**\n• 🔢 Extension number\n• 📋 Caller ID\n• 📬 Voicemail preference\n• ⭐ Additional features\n\n" +
        "*Extensions 1000–1020 are reserved for the Owner.*"
      )
      .setColor(0x5865f2)
      .setFooter({ text: "Our staff will be with you shortly." })
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("open_ticket:line").setLabel("📱 New Line").setStyle(ButtonStyle.Primary)
    )],
  };
}

function buildGeneralPanel() {
  return {
    embeds: [new EmbedBuilder()
      .setTitle("🎫 General Support")
      .setDescription(
        "Need help with something? Click below to open a support ticket.\n\n" +
        "**You'll be asked for:**\n• 📝 Subject\n• 📋 Description\n• ⚡ Priority\n• ⭐ Additional info"
      )
      .setColor(0x57f287)
      .setFooter({ text: "Our staff will be with you shortly." })
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("open_ticket:general").setLabel("🎫 Open Support Ticket").setStyle(ButtonStyle.Success)
    )],
  };
}

// ─── Interaction Handler ──────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  console.log(`[interaction] customId=${interaction.customId ?? "n/a"} user=${interaction.user.tag}`);
  try {

    // ── Open Ticket Button (line or general) ──
    if (interaction.isButton() && interaction.customId.startsWith("open_ticket:")) {
      const type = interaction.customId.split(":")[1]; // "line" or "general"
      const form = formConfig[type];
      if (!form) return interaction.reply({ content: "❌ Unknown ticket type.", ephemeral: true });

      const modal = new ModalBuilder().setCustomId(`ticket_form:${type}`).setTitle(form.title);
      for (const f of form.fields) {
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(f.id).setLabel(f.label).setPlaceholder(f.placeholder)
            .setStyle(f.id === "features" || f.id === "description" || f.id === "extra" ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(f.required ?? true).setMaxLength(1000)
        ));
      }
      await interaction.showModal(modal);
      return;
    }

    // ── Ticket Form Submit ──
    if (interaction.isModalSubmit() && interaction.customId.startsWith("ticket_form:")) {
      const type = interaction.customId.split(":")[1];
      const form = formConfig[type];

      const fields = {};
      for (const f of form.fields) {
        try { fields[f.id] = interaction.fields.getTextInputValue(f.id).trim(); }
        catch { fields[f.id] = ""; }
      }

      // Extension validation for line tickets
      if (type === "line") {
        const extNum = parseInt(fields.extension ?? "", 10);
        if (isNaN(extNum))
          return interaction.reply({ content: "❌ Extension must be a number.", ephemeral: true });
        if (OWNER_EXTENSIONS.includes(extNum))
          return interaction.reply({ content: "❌ Extensions **1000–1020** are reserved for the Owner.", ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      try {
        const { channel, ticketNumber } = await createTicketChannel(interaction.guild, interaction.user, { type, fields });
        await interaction.editReply({ content: `✅ Ticket #${ticketNumber} created: ${channel}` });
      } catch (err) {
        console.error("Ticket creation error:", err);
        await interaction.editReply({ content: "❌ Failed to create your ticket. Please contact a staff member." });
      }
      return;
    }

    // ── Manual Open: "Add Reasoning" button ──
    if (interaction.isButton() && interaction.customId.startsWith("manual_reason:")) {
      const targetUserId = interaction.customId.split(":")[1];
      const modal = new ModalBuilder().setCustomId(`manual_reason_submit:${targetUserId}`).setTitle("📝 Add Reasoning");
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("reason").setLabel("Reason for opening this ticket")
          .setPlaceholder("Explain why you're opening this ticket on behalf of the user...")
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)
      ));
      await interaction.showModal(modal);
      return;
    }

    // ── Manual Open: Reason Modal Submit ──
    if (interaction.isModalSubmit() && interaction.customId.startsWith("manual_reason_submit:")) {
      const targetUserId = interaction.customId.split(":")[1];
      const reason = interaction.fields.getTextInputValue("reason").trim();

      await interaction.deferReply({ ephemeral: true });

      let targetUser;
      try { targetUser = await client.users.fetch(targetUserId); }
      catch { return interaction.editReply({ content: "❌ Could not fetch the target user." }); }

      try {
        const { channel, ticketNumber } = await createTicketChannel(
          interaction.guild, targetUser, { type: "line", fields: {}, manualReason: `${reason}\n\n*(Opened manually by ${interaction.user.tag})*` }
        );
        // Update the original manual open message
        try {
          const pending = pendingManualOpens.get(interaction.message?.id);
          if (pending) {
            await interaction.message.edit({ content: `✅ Ticket #${ticketNumber} opened for <@${targetUserId}>: ${channel}`, components: [] });
            pendingManualOpens.delete(interaction.message.id);
          }
        } catch {}
        await interaction.editReply({ content: `✅ Ticket #${ticketNumber} opened for <@${targetUserId}>: ${channel}` });
      } catch (err) {
        console.error("Manual open error:", err);
        await interaction.editReply({ content: "❌ Failed to create the ticket." });
      }
      return;
    }

    // ── Confirm Close ──
    if (interaction.isButton() && interaction.customId.startsWith("confirm_close:")) {
      const reason = interaction.customId.split(":").slice(1).join(":");
      await handleCloseTicket(interaction, reason);
      return;
    }

    // ── Edit Close Reason ──
    if (interaction.isButton() && interaction.customId.startsWith("edit_reason:")) {
      const currentReason = interaction.customId.split(":").slice(1).join(":");
      const modal = new ModalBuilder().setCustomId("edit_reason_modal").setTitle("✏️ Edit Close Reason");
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("new_reason").setLabel("New Close Reason")
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(currentReason).setMaxLength(500)
      ));
      await interaction.showModal(modal);
      return;
    }

    // ── Edit Reason Modal Submit ──
    if (interaction.isModalSubmit() && interaction.customId === "edit_reason_modal") {
      const newReason = interaction.fields.getTextInputValue("new_reason").trim();
      await interaction.update({
        embeds: [new EmbedBuilder()
          .setTitle("🔒 Close Ticket Request")
          .setColor(0xed4245)
          .setDescription(`**Reason:** ${newReason}`)
          .setFooter({ text: "This channel will be deleted after closing." })
          .setTimestamp()],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`confirm_close:${newReason}`).setLabel("✅ Confirm Close").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`edit_reason:${newReason}`).setLabel("✏️ Edit Reason").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("cancel_close").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary),
        )],
      });
      return;
    }

    // ── Cancel Close ──
    if (interaction.isButton() && interaction.customId === "cancel_close") {
      await interaction.update({ content: "❌ Close request cancelled.", embeds: [], components: [] });
      return;
    }

    // ── Edit Form Modal Submit ──
    if (interaction.isModalSubmit() && interaction.customId.startsWith("editform_modal:")) {
      const type = interaction.customId.split(":")[1];
      const panelMsgId = interaction.customId.split(":")[2];

      const newTitle       = interaction.fields.getTextInputValue("form_title").trim();
      const field1Label    = interaction.fields.getTextInputValue("field1_label").trim();
      const field2Label    = interaction.fields.getTextInputValue("field2_label").trim();
      const field3Label    = interaction.fields.getTextInputValue("field3_label").trim();
      const field4Label    = interaction.fields.getTextInputValue("field4_label").trim();

      formConfig[type].title = newTitle;
      if (formConfig[type].fields[0]) formConfig[type].fields[0].label = field1Label;
      if (formConfig[type].fields[1]) formConfig[type].fields[1].label = field2Label;
      if (formConfig[type].fields[2]) formConfig[type].fields[2].label = field3Label;
      if (formConfig[type].fields[3]) formConfig[type].fields[3].label = field4Label;
      saveForm(formConfig);

      // Edit the panel message if we have it
      const panelInfo = panelRegistry.get(type);
      if (panelInfo) {
        try {
          const panelChannel = await client.channels.fetch(panelInfo.channelId);
          const panelMsg = await panelChannel.messages.fetch(panelInfo.messageId);
          const updatedPanel = type === "line" ? buildLinePanel() : buildGeneralPanel();
          await panelMsg.edit(updatedPanel);
        } catch (err) {
          console.warn("Could not edit panel message:", err.message);
        }
      }

      await interaction.reply({ content: `✅ Form for **${type}** panel updated and saved.`, ephemeral: true });
      return;
    }

    // ── Edit Form Open Button ──
    if (interaction.isButton() && interaction.customId.startsWith("editform_open:")) {
      const type = interaction.customId.split(":")[1];
      if (!isAdmin(interaction.member))
        return interaction.reply({ content: "❌ Only admins can edit forms.", ephemeral: true });

      const form = formConfig[type];
      const panelInfo = panelRegistry.get(type);

      const modal = new ModalBuilder()
        .setCustomId(`editform_modal:${type}:${panelInfo?.messageId ?? "none"}`)
        .setTitle(`✏️ Edit ${type === "line" ? "New Line" : "General"} Form`);

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("form_title").setLabel("Modal Title")
            .setStyle(TextInputStyle.Short).setRequired(true).setValue(form.title).setMaxLength(100)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("field1_label").setLabel("Field 1 Label")
            .setStyle(TextInputStyle.Short).setRequired(true).setValue(form.fields[0]?.label ?? "").setMaxLength(100)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("field2_label").setLabel("Field 2 Label")
            .setStyle(TextInputStyle.Short).setRequired(true).setValue(form.fields[1]?.label ?? "").setMaxLength(100)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("field3_label").setLabel("Field 3 Label")
            .setStyle(TextInputStyle.Short).setRequired(false).setValue(form.fields[2]?.label ?? "").setMaxLength(100)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("field4_label").setLabel("Field 4 Label")
            .setStyle(TextInputStyle.Short).setRequired(false).setValue(form.fields[3]?.label ?? "").setMaxLength(100)
        ),
      );
      await interaction.showModal(modal);
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

  // ── ?sendpanel <line|general> <channel id> ──
  if (message.content.startsWith("?sendpanel")) {
    if (!isStaff(member)) return message.reply("❌ Only staff can deploy panels.");

    const args = message.content.slice("?sendpanel".length).trim().split(/\s+/);
    const panelType  = args[0]?.toLowerCase();
    const channelArg = args[1]?.replace(/^<#(\d+)>$/, "$1");

    if (!panelType || !["line", "general"].includes(panelType)) {
      return message.reply("❌ Usage: `?sendpanel <line|general> <channel id>`\nExample: `?sendpanel line 1234567890`");
    }
    if (!channelArg) {
      return message.reply(`❌ Please provide a channel ID.\nUsage: \`?sendpanel ${panelType} <channel id>\``);
    }

    let targetChannel;
    try {
      targetChannel = await message.guild.channels.fetch(channelArg);
      if (!targetChannel?.isTextBased()) return message.reply("❌ That's not a valid text channel.");
    } catch {
      return message.reply("❌ Could not find a channel with that ID.");
    }

    const panel = panelType === "line" ? buildLinePanel() : buildGeneralPanel();
    const sent  = await targetChannel.send(panel);

    panelRegistry.set(panelType, { channelId: targetChannel.id, messageId: sent.id });

    if (targetChannel.id !== message.channel.id)
      await message.reply({ content: `✅ **${panelType}** panel sent to ${targetChannel}.`, allowedMentions: { parse: [] } });
    await message.delete().catch(() => {});
    return;
  }

  // ── ?close [reason] ──
  if (message.content.startsWith("?close")) {
    if (!isStaff(member)) return message.reply("❌ Only staff can close tickets.");

    const reason = message.content.slice("?close".length).trim() || "No reason provided";
    await message.channel.send({
      embeds: [new EmbedBuilder()
        .setTitle("🔒 Close Ticket Request")
        .setColor(0xed4245)
        .setDescription(`**${message.author.tag}** has requested to close this ticket.\n\n**Reason:** ${reason}`)
        .setFooter({ text: "This channel will be deleted after closing." })
        .setTimestamp()],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`confirm_close:${reason}`).setLabel("✅ Confirm Close").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`edit_reason:${reason}`).setLabel("✏️ Edit Reason").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("cancel_close").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary),
      )],
    });
    return;
  }

  // ── ?reopen <ticket number> ──
  if (message.content.startsWith("?reopen")) {
    if (!isStaff(member)) return message.reply("❌ Only staff can reopen tickets.");

    const arg = message.content.slice("?reopen".length).trim();
    const ticketNum = parseInt(arg, 10);
    if (isNaN(ticketNum)) return message.reply("❌ Usage: `?reopen <ticket number>`");

    const entry = [...ticketRegistry.entries()].find(([, v]) => v.ticketNumber === ticketNum);
    if (entry) return message.reply(`❌ Ticket #${ticketNum} is still open: <#${entry[0]}>`);

    return message.reply(
      `⚠️ Ticket #${ticketNum} has already been closed.\nTo open a new ticket on behalf of someone, use \`?manualopen @user\`.`
    );
  }

  // ── ?manualopen <@user | user id> ──
  if (message.content.startsWith("?manualopen")) {
    if (!isStaff(member)) return message.reply("❌ Only staff can manually open tickets.");

    const arg = message.content.slice("?manualopen".length).trim();
    const userIdMatch = arg.match(/^<@!?(\d+)>$/) || arg.match(/^(\d+)$/);
    if (!userIdMatch) return message.reply("❌ Usage: `?manualopen @user` or `?manualopen <user id>`");

    const userId = userIdMatch[1];
    let targetUser;
    try { targetUser = await client.users.fetch(userId); }
    catch { return message.reply("❌ Could not find that user."); }

    const targetMember = await message.guild.members.fetch(userId).catch(() => null);
    if (!targetMember) return message.reply("❌ That user is not in this server.");

    const sent = await message.channel.send({
      embeds: [new EmbedBuilder()
        .setTitle("📱 Manual Ticket Open")
        .setColor(0xfee75c)
        .setDescription(`Opening a ticket on behalf of <@${userId}> (**${targetUser.tag}**).\n\nClick below to add a reason before creating the ticket.`)
        .setTimestamp()],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`manual_reason:${userId}`)
          .setLabel("📝 Add Reasoning")
          .setStyle(ButtonStyle.Primary)
      )],
    });

    pendingManualOpens.set(sent.id, { staffTag: message.author.tag, targetUserId: userId, targetUserTag: targetUser.tag });
    return;
  }

  // ── ?editform <line|general> ──
  if (message.content.startsWith("?editform")) {
    if (!isAdmin(member)) return message.reply("❌ Only admins can edit forms.");

    const arg  = message.content.slice("?editform".length).trim().toLowerCase();
    if (!arg || !["line", "general"].includes(arg))
      return message.reply("❌ Usage: `?editform <line|general>`");

    const form = formConfig[arg];
    const panelInfo = panelRegistry.get(arg);

    const modal = new ModalBuilder()
      .setCustomId(`editform_modal:${arg}:${panelInfo?.messageId ?? "none"}`)
      .setTitle(`✏️ Edit ${arg === "line" ? "New Line" : "General"} Form`);

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("form_title").setLabel("Form Title")
          .setStyle(TextInputStyle.Short).setRequired(true).setValue(form.title).setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("field1_label").setLabel(`Field 1 Label`)
          .setStyle(TextInputStyle.Short).setRequired(true).setValue(form.fields[0]?.label ?? "").setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("field2_label").setLabel(`Field 2 Label`)
          .setStyle(TextInputStyle.Short).setRequired(true).setValue(form.fields[1]?.label ?? "").setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("field3_label").setLabel(`Field 3 Label`)
          .setStyle(TextInputStyle.Short).setRequired(false).setValue(form.fields[2]?.label ?? "").setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("field4_label").setLabel(`Field 4 Label`)
          .setStyle(TextInputStyle.Short).setRequired(false).setValue(form.fields[3]?.label ?? "").setMaxLength(100)
      ),
    );

    // Modals can't be sent from message commands directly — send a button prompt first
    const sent = await message.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`✏️ Edit ${arg} Form`)
        .setDescription("Click below to open the form editor.")
        .setColor(0xfee75c)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`editform_open:${arg}`).setLabel("✏️ Open Form Editor").setStyle(ButtonStyle.Primary)
      )],
    });

    // Store for the button handler below
    pendingManualOpens.set(`editform:${message.author.id}`, { type: arg });
    return;
  }
});
// ─── Login ────────────────────────────────────────────────────────────────────
client.login(process.env.BOT_TOKEN);
