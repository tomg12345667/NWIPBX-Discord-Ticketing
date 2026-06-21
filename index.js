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
const STAFF_ROLE_1         = "1470145227929944376";
const STAFF_ROLE_2         = "1470179326858231818";
const TRANSCRIPT_CHANNEL   = "1470145229771505923";
const ERROR_CHANNEL        = "1513642915145191525";
const NEW_LINE_ROLE        = "1516587356386492416";
const TICKET_CATEGORY_ID   = process.env.TICKET_CATEGORY_ID || null;
const ADMIN_ROLE           = process.env.ADMIN_ROLE_ID || STAFF_ROLE_1;
const OWNER_EXTENSIONS     = Array.from({ length: 21 }, (_, i) => 1000 + i);

// ─── Counter ──────────────────────────────────────────────────────────────────
const COUNTER_FILE = path.join(__dirname, "counter.json");
function loadCounter() {
  try { if (fs.existsSync(COUNTER_FILE)) return JSON.parse(fs.readFileSync(COUNTER_FILE, "utf-8")).counter ?? 1; } catch {}
  return 1;
}
function saveCounter(val) {
  fs.writeFileSync(COUNTER_FILE, JSON.stringify({ counter: val }), "utf-8");
}
let ticketCounter = loadCounter();

// ─── Form config ──────────────────────────────────────────────────────────────
const FORM_FILE = path.join(__dirname, "form.json");
const DEFAULT_FORM = {
  line: {
    title: "New Line Request",
    fields: [
      { id: "extension", label: "Extension Number", placeholder: "Enter your desired extension number", required: true },
      { id: "caller_id", label: "Caller ID",        placeholder: "Your name or number",                required: true },
      { id: "voicemail", label: "Voicemail?",        placeholder: "Yes or No",                          required: true },
      { id: "features",  label: "Additional Features or Notes", placeholder: "Anything else you need", required: false },
    ],
  },
  general: {
    title: "General Support",
    fields: [
      { id: "description", label: "Description", placeholder: "Describe your issue in detail", required: true },
      { id: "extra",       label: "Anything Else?", placeholder: "Any other relevant information", required: false },
    ],
  },
};
function loadForm() {
  try { if (fs.existsSync(FORM_FILE)) return JSON.parse(fs.readFileSync(FORM_FILE, "utf-8")); } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_FORM));
}
function saveForm(data) { fs.writeFileSync(FORM_FILE, JSON.stringify(data, null, 2), "utf-8"); }
let formConfig = loadForm();

// ─── Registries ───────────────────────────────────────────────────────────────
const ticketRegistry  = new Map(); // channelId -> ticketData
const panelRegistry   = new Map(); // type -> { channelId, messageId }
let ticketCounter_ref = ticketCounter;

function nextTicketNumber() {
  const n = ticketCounter++;
  saveCounter(ticketCounter);
  return n;
}

// ─── Client ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once("ready", () => console.log(`Logged in as ${client.user.tag} | Ticket counter: #${ticketCounter}`));

// ─── Error reporter ───────────────────────────────────────────────────────────
async function reportError(err, context = "") {
  console.error(`[ERROR] ${context}`, err);
  try {
    const ch = await client.channels.fetch(ERROR_CHANNEL);
    if (ch) await ch.send(`**Bot Error** ${context ? `(${context})` : ""}\n\`\`\`\n${err?.stack ?? err}\n\`\`\``);
  } catch {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isStaff(member)  { return member?.roles.cache.has(STAFF_ROLE_1) || member?.roles.cache.has(STAFF_ROLE_2); }
function isAdmin(member)  { return member?.roles.cache.has(ADMIN_ROLE) || member?.permissions.has(PermissionFlagsBits.Administrator); }
function isTicketChannel(channelId) { return ticketRegistry.has(channelId); }

async function createTicketChannel(guild, opener, { type = "line", fields = {}, manualReason = null }) {
  const ticketNumber = nextTicketNumber();
  const permissionOverwrites = [
    { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
    { id: opener.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: STAFF_ROLE_1, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
    { id: STAFF_ROLE_2, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
  ];

  const channelName = type === "line" ? `new-line-${opener.username}` : `general-support-${opener.username}`;
  const channelOptions = {
    name: channelName,
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

  const embedFields = [
    { name: "Opened By", value: `<@${opener.id}>`, inline: true },
    { name: "Ticket",    value: `#${ticketNumber}`, inline: true },
    { name: "Type",      value: type === "line" ? "New Line" : "General Support", inline: true },
  ];

  if (manualReason) {
    embedFields.push({ name: "Reason", value: manualReason, inline: false });
  } else {
    const form = formConfig[type];
    if (form) {
      for (const f of form.fields) {
        if (fields[f.id]) embedFields.push({ name: f.label, value: fields[f.id] || "Not provided", inline: false });
      }
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(type === "line" ? "New Line Request" : "General Support Ticket")
    .setColor(type === "line" ? 0x5865f2 : 0x57f287)
    .addFields(embedFields)
    .setFooter({ text: "Staff: use ?close <reason> to close this ticket" })
    .setTimestamp();

  await channel.send({
    content: `<@${opener.id}> <@&${STAFF_ROLE_1}> <@&${STAFF_ROLE_2}>`,
    embeds: [embed],
  });

  return { channel, ticketNumber };
}

// ─── Plain transcript ─────────────────────────────────────────────────────────
async function sendPlainTranscript(channel, ticketData, reason, closedByTag) {
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
    "NWIPBX - TICKET TRANSCRIPT",
    "===========================",
    "",
    `Ticket    : #${ticketData?.ticketNumber ?? "?"}`,
    `Opened by : ${ticketData?.openerTag ?? "Unknown"}`,
    `Type      : ${ticketData?.type === "line" ? "New Line" : "General Support"}`,
    `Opened at : ${new Date(ticketData?.openedAt ?? Date.now()).toLocaleString()}`,
    `Closed by : ${closedByTag}`,
    `Reason    : ${reason}`,
    "",
    "---",
    "",
  ];

  for (const msg of messages) {
    if (msg.author.bot && msg.embeds.length > 0 && !msg.content) continue;
    const time = new Date(msg.createdTimestamp).toLocaleString();
    const text = msg.content || (msg.embeds[0]?.title ? `[Embed: ${msg.embeds[0].title}]` : "[No content]");
    lines.push(`[${time}] ${msg.author.tag}`);
    lines.push(`  ${text}`);
    if (msg.attachments.size > 0) lines.push(`  Attachments: ${[...msg.attachments.values()].map(a => a.url).join(", ")}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("End of transcript");

  const transcript = lines.join("\n");

  function chunkText(text) {
    const chunks = [];
    let current = "";
    for (const line of text.split("\n")) {
      if ((current + line + "\n").length > 1850) { chunks.push(current); current = ""; }
      current += line + "\n";
    }
    if (current) chunks.push(current);
    return chunks;
  }

  try {
    const opener = await client.users.fetch(ticketData.openerId);
    for (const chunk of chunkText(transcript)) await opener.send("```\n" + chunk + "```");
  } catch (err) { console.warn("Could not DM opener:", err.message); }

  try {
    const transcriptChannel = await client.channels.fetch(TRANSCRIPT_CHANNEL);
    await transcriptChannel.send({
      embeds: [new EmbedBuilder()
        .setTitle(`Transcript - Ticket #${ticketData?.ticketNumber ?? "?"}`)
        .setColor(0x5865f2)
        .addFields(
          { name: "Opened By", value: ticketData ? `<@${ticketData.openerId}>` : "Unknown", inline: true },
          { name: "Closed By", value: closedByTag, inline: true },
          { name: "Reason",    value: reason },
        )
        .setTimestamp()],
    });
    for (const chunk of chunkText(transcript)) await transcriptChannel.send("```\n" + chunk + "```");
  } catch (err) { await reportError(err, "sendPlainTranscript"); }
}

// ─── Close ticket ─────────────────────────────────────────────────────────────
async function handleCloseTicket(interaction, reason) {
  const channel = interaction.channel;
  const ticketData = ticketRegistry.get(channel.id);

  await interaction.update({ content: "Closing ticket and sending transcript...", components: [], embeds: [] });

  try { await sendPlainTranscript(channel, ticketData, reason, interaction.user.tag); }
  catch (err) { await reportError(err, "handleCloseTicket > sendPlainTranscript"); }

  await channel.send({
    embeds: [new EmbedBuilder()
      .setTitle("Ticket Closed")
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
    catch (err) { await reportError(err, "handleCloseTicket > channel.delete"); }
  }, 5000);
}

// ─── Panel builders ───────────────────────────────────────────────────────────
function buildLinePanel() {
  return {
    embeds: [new EmbedBuilder()
      .setTitle("NWIPBX - New Line Request")
      .setDescription(
        "To request a new line, click the button below to get started.\n\n" +
        "You will be asked for:\n" +
        "- Extension number\n" +
        "- Caller ID\n" +
        "- Voicemail preference\n" +
        "- Any additional features or notes\n\n" +
        "If you are unsure which extension to request, a member of our team will assist you during the process."
      )
      .setColor(0x5865f2)
      .setFooter({ text: "NWIPBX - A team member will be with you shortly." })
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("open_ticket:line").setLabel("New Line Request").setStyle(ButtonStyle.Primary)
    )],
  };
}

function buildGeneralPanel() {
  return {
    embeds: [new EmbedBuilder()
      .setTitle("NWIPBX - General Support")
      .setDescription(
        "Need assistance? Click the button below to open a support ticket and a member of our team will be with you shortly.\n\n" +
        "You will be asked for:\n" +
        "- Description of your issue\n" +
        "- Any additional information"
      )
      .setColor(0x57f287)
      .setFooter({ text: "NWIPBX - A team member will be with you shortly." })
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("open_ticket:general").setLabel("Open Support Ticket").setStyle(ButtonStyle.Success)
    )],
  };
}

// ─── Interaction Handler ──────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  console.log(`[interaction] customId=${interaction.customId ?? "n/a"} user=${interaction.user.tag}`);
  try {

    // ── Open Ticket Button ──
    if (interaction.isButton() && interaction.customId.startsWith("open_ticket:")) {
      const type = interaction.customId.split(":")[1];
      const form = formConfig[type];
      if (!form) return interaction.reply({ content: "Unknown ticket type.", ephemeral: true });

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
        try { fields[f.id] = interaction.fields.getTextInputValue(f.id).trim(); } catch { fields[f.id] = ""; }
      }

      if (type === "line") {
        const extNum = parseInt(fields.extension ?? "", 10);
        if (isNaN(extNum)) return interaction.reply({ content: "Extension must be a number.", ephemeral: true });
        if (OWNER_EXTENSIONS.includes(extNum)) return interaction.reply({ content: "Extensions 1000 through 1020 are reserved for the Owner.", ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      try {
        const { channel, ticketNumber } = await createTicketChannel(interaction.guild, interaction.user, { type, fields });
        await interaction.editReply({ content: `Ticket #${ticketNumber} created: ${channel}` });
      } catch (err) {
        await reportError(err, "ticket_form submit");
        await interaction.editReply({ content: "Failed to create your ticket. Please contact a staff member." });
      }
      return;
    }

    // ── Extension Created: Open Modal Button ──
    if (interaction.isButton() && interaction.customId === "extensioncreated_open") {
      const modal = new ModalBuilder().setCustomId("extensioncreated_submit").setTitle("Extension Created");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("ext_number").setLabel("Extension").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("ext_secret").setLabel("Secret").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("sip_server").setLabel("SIP Server").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("sip_port").setLabel("SIP Port").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("caller_id").setLabel("Caller ID").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
        ),
      );
      await interaction.showModal(modal);
      return;
    }

    // ── Extension Created: Second Modal (Voicemail) ──
    if (interaction.isButton() && interaction.customId.startsWith("extensioncreated_vm:")) {
      const dataStr = interaction.customId.split(":").slice(1).join(":");
      const modal = new ModalBuilder().setCustomId(`extensioncreated_vm_submit:${dataStr}`).setTitle("Voicemail Details");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("voicemail").setLabel("Voicemail?").setPlaceholder("Yes or No").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("vm_pin").setLabel("Voicemail PIN (optional)").setPlaceholder("Leave blank if not required").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20)
        ),
      );
      await interaction.showModal(modal);
      return;
    }

    // ── Extension Created: First Modal Submit ──
    if (interaction.isModalSubmit() && interaction.customId === "extensioncreated_submit") {
      const ext      = interaction.fields.getTextInputValue("ext_number").trim();
      const secret   = interaction.fields.getTextInputValue("ext_secret").trim();
      const sipSrv   = interaction.fields.getTextInputValue("sip_server").trim();
      const sipPort  = interaction.fields.getTextInputValue("sip_port").trim();
      const callerId = interaction.fields.getTextInputValue("caller_id").trim();

      // Encode first modal data into customId for second modal
      const encoded = Buffer.from(JSON.stringify({ ext, secret, sipSrv, sipPort, callerId })).toString("base64");

      await interaction.reply({
        content: "First step saved. Click below to enter voicemail details.",
        ephemeral: true,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`extensioncreated_vm:${encoded}`)
            .setLabel("Continue - Voicemail Details")
            .setStyle(ButtonStyle.Primary)
        )],
      });
      return;
    }

    // ── Extension Created: Voicemail Modal Submit ──
    if (interaction.isModalSubmit() && interaction.customId.startsWith("extensioncreated_vm_submit:")) {
      const encoded  = interaction.customId.split(":").slice(1).join(":");
      let parsed;
      try { parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")); }
      catch { return interaction.reply({ content: "Failed to parse extension data.", ephemeral: true }); }

      const { ext, secret, sipSrv, sipPort, callerId } = parsed;
      const voicemail = interaction.fields.getTextInputValue("voicemail").trim();
      const vmPin     = interaction.fields.getTextInputValue("vm_pin").trim();

      // Post details to ticket channel
      const embed = new EmbedBuilder()
        .setTitle("Extension Created")
        .setColor(0x57f287)
        .addFields(
          { name: "Extension",    value: ext,      inline: true },
          { name: "Secret",       value: secret,   inline: true },
          { name: "SIP Server",   value: sipSrv,   inline: true },
          { name: "SIP Port",     value: sipPort,  inline: true },
          { name: "Caller ID",    value: callerId, inline: true },
          { name: "Voicemail",    value: voicemail, inline: true },
          { name: "Voicemail PIN", value: vmPin || "Not provided", inline: true },
        )
        .setFooter({ text: `Created by ${interaction.user.tag}` })
        .setTimestamp();

      await interaction.channel.send({ embeds: [embed] });

      // Get ticket opener
      const ticketData = ticketRegistry.get(interaction.channel.id);
      const openerId   = ticketData?.openerId;

      // Send ephemeral role grant prompt to the staff member who ran the command
      await interaction.reply({
        ephemeral: true,
        embeds: [new EmbedBuilder()
          .setTitle("Role Assignment")
          .setDescription(`Would you like to grant <@${openerId ?? "the ticket opener"}> the <@&${NEW_LINE_ROLE}> role?`)
          .setColor(0xfee75c)],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`grant_role:${openerId}`).setLabel("Yes").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("grant_role_no").setLabel("No").setStyle(ButtonStyle.Danger),
        )],
      });
      return;
    }

    // ── Grant Role: Yes ──
    if (interaction.isButton() && interaction.customId.startsWith("grant_role:")) {
      const targetId = interaction.customId.split(":")[1];
      try {
        const member = await interaction.guild.members.fetch(targetId);
        await member.roles.add(NEW_LINE_ROLE);
        await interaction.update({ content: `Role granted to <@${targetId}>.`, embeds: [], components: [] });
      } catch (err) {
        await reportError(err, "grant_role");
        await interaction.update({ content: "Failed to assign the role.", embeds: [], components: [] });
      }
      return;
    }

    // ── Grant Role: No ──
    if (interaction.isButton() && interaction.customId === "grant_role_no") {
      await interaction.update({ content: "Role not assigned.", embeds: [], components: [] });
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
      const modal = new ModalBuilder().setCustomId("edit_reason_modal").setTitle("Edit Close Reason");
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
          .setTitle("Close Ticket Request")
          .setColor(0xed4245)
          .setDescription(`**Reason:** ${newReason}`)
          .setFooter({ text: "This channel will be deleted after closing." })
          .setTimestamp()],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`confirm_close:${newReason}`).setLabel("Confirm Close").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`edit_reason:${newReason}`).setLabel("Edit Reason").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("cancel_close").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
        )],
      });
      return;
    }

    // ── Cancel Close ──
    if (interaction.isButton() && interaction.customId === "cancel_close") {
      await interaction.update({ content: "Close request cancelled.", embeds: [], components: [] });
      return;
    }

    // ── Edit Response Open Button ──
    if (interaction.isButton() && interaction.customId.startsWith("editresponse_open:")) {
      const ticketNum = parseInt(interaction.customId.split(":")[1], 10);
      if (!isStaff(interaction.member))
        return interaction.reply({ content: "Only staff can edit ticket responses.", ephemeral: true });

      const entry = [...ticketRegistry.entries()].find(([, v]) => v.ticketNumber === ticketNum);
      if (!entry) return interaction.reply({ content: `Ticket #${ticketNum} not found or already closed.`, ephemeral: true });

      const [, ticketData] = entry;
      const form = formConfig[ticketData.type] ?? formConfig.line;
      const current = ticketData.fields ?? {};

      const modal = new ModalBuilder()
        .setCustomId(`editresponse_submit:${ticketNum}`)
        .setTitle(`Edit Ticket #${ticketNum} Responses`);

      for (const f of form.fields) {
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(f.id).setLabel(f.label)
            .setStyle(f.id === "features" || f.id === "description" || f.id === "extra" ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(false).setValue(current[f.id] ?? "").setMaxLength(1000)
        ));
      }
      await interaction.showModal(modal);
      return;
    }

    // ── Edit Response Modal Submit ──
    if (interaction.isModalSubmit() && interaction.customId.startsWith("editresponse_submit:")) {
      const ticketNum = parseInt(interaction.customId.split(":")[1], 10);
      const entry = [...ticketRegistry.entries()].find(([, v]) => v.ticketNumber === ticketNum);
      if (!entry) return interaction.reply({ content: `Ticket #${ticketNum} not found.`, ephemeral: true });

      const [channelId, ticketData] = entry;
      const form = formConfig[ticketData.type] ?? formConfig.line;

      for (const f of form.fields) {
        try { ticketData.fields[f.id] = interaction.fields.getTextInputValue(f.id).trim(); } catch {}
      }
      ticketRegistry.set(channelId, ticketData);

      try {
        const ticketChannel = await client.channels.fetch(channelId);
        const msgs   = await ticketChannel.messages.fetch({ limit: 10 });
        const botMsg = msgs.find(m => m.author.id === client.user.id && m.embeds.length > 0);
        if (botMsg) {
          const embedFields = [
            { name: "Opened By", value: `<@${ticketData.openerId}>`, inline: true },
            { name: "Ticket",    value: `#${ticketData.ticketNumber}`, inline: true },
            { name: "Type",      value: ticketData.type === "line" ? "New Line" : "General Support", inline: true },
          ];
          if (ticketData.manualReason) {
            embedFields.push({ name: "Reason", value: ticketData.manualReason, inline: false });
          } else {
            for (const f of form.fields) {
              if (ticketData.fields[f.id]) embedFields.push({ name: f.label, value: ticketData.fields[f.id] || "Not provided", inline: false });
            }
          }
          const updatedEmbed = new EmbedBuilder()
            .setTitle(ticketData.type === "line" ? "New Line Request" : "General Support Ticket")
            .setColor(ticketData.type === "line" ? 0x5865f2 : 0x57f287)
            .addFields(embedFields)
            .setFooter({ text: `Last edited by ${interaction.user.tag}` })
            .setTimestamp();
          await botMsg.edit({ embeds: [updatedEmbed] });
        }
      } catch (err) { await reportError(err, "editresponse_submit"); }

      await interaction.reply({ content: `Ticket #${ticketNum} responses updated.`, ephemeral: true });
      return;
    }

    // ── Edit Form Open Button ──
    if (interaction.isButton() && interaction.customId.startsWith("editform_open:")) {
      const type = interaction.customId.split(":")[1];
      if (!isAdmin(interaction.member))
        return interaction.reply({ content: "Only admins can edit forms.", ephemeral: true });

      const form = formConfig[type];
      const panelInfo = panelRegistry.get(type);

      const modal = new ModalBuilder()
        .setCustomId(`editform_modal:${type}:${panelInfo?.messageId ?? "none"}`)
        .setTitle(`Edit ${type === "line" ? "New Line" : "General"} Form`);

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

    // ── Edit Form Modal Submit ──
    if (interaction.isModalSubmit() && interaction.customId.startsWith("editform_modal:")) {
      const type = interaction.customId.split(":")[1];
      formConfig[type].title = interaction.fields.getTextInputValue("form_title").trim();
      const labels = ["field1_label","field2_label","field3_label","field4_label"];
      labels.forEach((l, i) => {
        try {
          const val = interaction.fields.getTextInputValue(l).trim();
          if (val && formConfig[type].fields[i]) formConfig[type].fields[i].label = val;
        } catch {}
      });
      saveForm(formConfig);

      const panelInfo = panelRegistry.get(type);
      if (panelInfo) {
        try {
          const panelChannel = await client.channels.fetch(panelInfo.channelId);
          const panelMsg = await panelChannel.messages.fetch(panelInfo.messageId);
          await panelMsg.edit(type === "line" ? buildLinePanel() : buildGeneralPanel());
        } catch (err) { console.warn("Could not edit panel message:", err.message); }
      }
      await interaction.reply({ content: `Form for ${type} panel updated.`, ephemeral: true });
      return;
    }

  } catch (err) {
    await reportError(err, `interactionCreate: ${interaction.customId ?? "unknown"}`);
  }
});

// ─── Message Commands ─────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  // DM handler
  if (!message.guild) {
    if (message.author.bot) return;
    try {
      await message.author.send(
        "Thank you for reaching out to NWIPBX. All tickets are handled inside our Discord server via ticket channels. " +
        "Modmail support via direct messages will be available in the future. " +
        "Please open a ticket in the server and a member of our team will assist you."
      );
    } catch {}
    return;
  }

  if (message.author.bot) return;
  if (!message.content.startsWith("?")) return;

  const member = message.member;

  // ── ?sendpanel <line|general> <channel id> ──
  if (message.content.startsWith("?sendpanel")) {
    if (!isStaff(member)) return message.reply("Only staff can deploy panels.");
    const args = message.content.slice("?sendpanel".length).trim().split(/\s+/);
    const panelType  = args[0]?.toLowerCase();
    const channelArg = args[1]?.replace(/^<#(\d+)>$/, "$1");

    if (!panelType || !["line","general"].includes(panelType))
      return message.reply("Usage: ?sendpanel <line|general> <channel id>");
    if (!channelArg)
      return message.reply(`Usage: ?sendpanel ${panelType} <channel id>`);

    let targetChannel;
    try {
      targetChannel = await message.guild.channels.fetch(channelArg);
      if (!targetChannel?.isTextBased()) return message.reply("That is not a valid text channel.");
    } catch { return message.reply("Could not find a channel with that ID."); }

    const panel = panelType === "line" ? buildLinePanel() : buildGeneralPanel();
    const sent  = await targetChannel.send(panel);
    panelRegistry.set(panelType, { channelId: targetChannel.id, messageId: sent.id });

    if (targetChannel.id !== message.channel.id)
      await message.reply({ content: `Panel sent to ${targetChannel}.`, allowedMentions: { parse: [] } });
    await message.delete().catch(() => {});
    return;
  }

  // ── ?close <reason> ──
  if (message.content.startsWith("?close")) {
    if (!isStaff(member)) return message.reply("Only staff can close tickets.");
    if (!isTicketChannel(message.channel.id)) return message.reply("This command can only be used inside a ticket channel.");

    const reason = message.content.slice("?close".length).trim() || "No reason provided";
    await message.channel.send({
      embeds: [new EmbedBuilder()
        .setTitle("Close Ticket Request")
        .setColor(0xed4245)
        .setDescription(`**${message.author.tag}** has requested to close this ticket.\n\n**Reason:** ${reason}`)
        .setFooter({ text: "This channel will be deleted after closing." })
        .setTimestamp()],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`confirm_close:${reason}`).setLabel("Confirm Close").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`edit_reason:${reason}`).setLabel("Edit Reason").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("cancel_close").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      )],
    });
    return;
  }

  // ── ?extensioncreated ──
  if (message.content.startsWith("?extensioncreated")) {
    if (!isStaff(member)) return message.reply("Only staff can use this command.");
    if (!isTicketChannel(message.channel.id)) return message.reply("This command can only be used inside a ticket channel.");

    await message.reply({
      content: "Click below to enter the extension details.",
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("extensioncreated_open").setLabel("Enter Extension Details").setStyle(ButtonStyle.Primary)
      )],
    });
    return;
  }

  // ── ?reopen <ticket number> ──
  if (message.content.startsWith("?reopen")) {
    if (!isStaff(member)) return message.reply("Only staff can reopen tickets.");
    const arg = message.content.slice("?reopen".length).trim();
    const ticketNum = parseInt(arg, 10);
    if (isNaN(ticketNum)) return message.reply("Usage: ?reopen <ticket number>");

    const entry = [...ticketRegistry.entries()].find(([, v]) => v.ticketNumber === ticketNum);
    if (entry) return message.reply(`Ticket #${ticketNum} is still open: <#${entry[0]}>`);
    return message.reply(`Ticket #${ticketNum} has already been closed. Use ?manualopen <user id> <reason> to open a new one.`);
  }

  // ── ?manualopen <user id> <reason> ──
  if (message.content.startsWith("?manualopen")) {
    if (!isStaff(member)) return message.reply("Only staff can manually open tickets.");
    const arg   = message.content.slice("?manualopen".length).trim();
    const match = arg.match(/^(?:<@!?(\d+)>|(\d+))\s+(.+)$/s);
    if (!match) return message.reply("Usage: ?manualopen <user id> <reason>");

    const userId = match[1] ?? match[2];
    const reason = match[3].trim();

    let targetUser;
    try { targetUser = await client.users.fetch(userId); }
    catch { return message.reply("Could not find that user."); }

    const targetMember = await message.guild.members.fetch(userId).catch(() => null);
    if (!targetMember) return message.reply("That user is not in this server.");

    try {
      const { channel, ticketNumber } = await createTicketChannel(
        message.guild, targetUser,
        { type: "line", fields: {}, manualReason: `${reason}\n\n(Opened manually by ${message.author.tag})` }
      );
      await message.reply({ content: `Ticket #${ticketNumber} opened for <@${userId}>: ${channel}`, allowedMentions: { parse: [] } });
    } catch (err) {
      await reportError(err, "?manualopen");
      await message.reply("Failed to create the ticket.");
    }
    return;
  }

  // ── ?editformresponse <ticket number> ──
  if (message.content.startsWith("?editformresponse")) {
    if (!isStaff(member)) return message.reply("Only staff can edit ticket responses.");
    const arg = message.content.slice("?editformresponse".length).trim();
    const ticketNum = parseInt(arg, 10);
    if (isNaN(ticketNum)) return message.reply("Usage: ?editformresponse <ticket number>");

    const entry = [...ticketRegistry.entries()].find(([, v]) => v.ticketNumber === ticketNum);
    if (!entry) return message.reply(`Ticket #${ticketNum} not found or already closed.`);
    const [, ticketData] = entry;

    await message.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`Edit Responses - Ticket #${ticketNum}`)
        .setDescription(`Click below to edit the submitted responses for <@${ticketData.openerId}>'s ticket.`)
        .setColor(0xfee75c)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`editresponse_open:${ticketNum}`).setLabel("Edit Responses").setStyle(ButtonStyle.Primary)
      )],
    });
    return;
  }

  // ── ?ticket sendstaffinfo <channel id> ──
  if (message.content.startsWith("?ticket sendstaffinfo")) {
    if (!isStaff(member)) return message.reply("Only staff can use this command.");
    const arg = message.content.slice("?ticket sendstaffinfo".length).trim();
    const channelIdArg = arg.replace(/^<#(\d+)>$/, "$1");
    if (!channelIdArg) return message.reply("Usage: ?ticket sendstaffinfo <channel id>");

    let targetChannel;
    try {
      targetChannel = await message.guild.channels.fetch(channelIdArg);
      if (!targetChannel?.isTextBased()) return message.reply("That is not a valid text channel.");
    } catch { return message.reply("Could not find a channel with that ID."); }

    const lines = [
      "NWIPBX - STAFF INFORMATION",
      "===========================",
      "",
      "COMMANDS",
      "--------",
      "",
      "?sendpanel <line|general> <channel id>",
      "Deploys a ticket panel to the specified channel. Use 'line' for new line requests or 'general' for general support tickets.",
      "",
      "?close <reason>",
      "Closes the current ticket channel. Can only be used inside a ticket channel. Posts a confirmation prompt before proceeding. The reason can be edited before confirming. Once confirmed, a transcript is generated and the channel is deleted after 5 seconds.",
      "",
      "?extensioncreated",
      "Staff only. Used inside a ticket channel after an extension has been set up. Opens a form to enter the extension number, secret, SIP server, SIP port, caller ID, voicemail status, and optional voicemail PIN. Posts the details to the ticket channel and privately asks staff whether to grant the opener the new line role.",
      "",
      "?manualopen <user id> <reason>",
      "Manually opens a new line ticket on behalf of a user. The ticket is created immediately with the provided reason.",
      "",
      "?reopen <ticket number>",
      "Checks if a ticket is still open and points to its channel. If the ticket has already been closed, suggests using ?manualopen instead.",
      "",
      "?editformresponse <ticket number>",
      "Allows staff to edit the submitted form responses on an open ticket. Opens a pre-filled modal with the current responses. Once submitted, the original ticket embed is updated.",
      "",
      "?ticket sendstaffinfo <channel id>",
      "Sends this staff information message to the specified channel.",
      "",
      "HOW CLOSING WORKS",
      "-----------------",
      "",
      "When a staff member runs ?close, a message is posted in the ticket channel showing the reason with three options: confirm the close, edit the reason, or cancel. ?close can only be run inside a ticket channel.",
      "",
      "If confirmed, the bot generates a transcript of all messages in the channel. The channel is deleted 5 seconds after the close embed is posted.",
      "",
      "HOW TRANSCRIPTS WORK",
      "--------------------",
      "",
      "When a ticket is closed, a plain text transcript is generated containing every message sent in the channel, including timestamps and usernames.",
      "",
      "The transcript is sent in two places:",
      "1. As a direct message to the user who opened the ticket.",
      "2. Posted in the transcripts log channel with a summary embed.",
      "",
      "If the user has direct messages disabled, the bot skips the DM and still posts to the log channel.",
      "",
      "EXTENSION RULES",
      "---------------",
      "",
      "Extensions 1000 through 1020 are reserved for the Owner and cannot be used in a new line ticket.",
      "",
      "TICKET CHANNELS",
      "---------------",
      "",
      "New line tickets    : new-line-[username]",
      "General support     : general-support-[username]",
      "Ticket numbers persist across bot restarts.",
    ];

    const transcript = lines.join("\n");
    const chunks = [];
    let current = "";
    for (const line of transcript.split("\n")) {
      if ((current + line + "\n").length > 1850) { chunks.push(current); current = ""; }
      current += line + "\n";
    }
    if (current) chunks.push(current);

    for (const chunk of chunks) await targetChannel.send("```\n" + chunk + "```");

    if (targetChannel.id !== message.channel.id)
      await message.reply({ content: `Staff info sent to ${targetChannel}.`, allowedMentions: { parse: [] } });
    await message.delete().catch(() => {});
    return;
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(process.env.BOT_TOKEN);
