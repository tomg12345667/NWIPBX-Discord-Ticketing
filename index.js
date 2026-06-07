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

require("dotenv").config();

// ─── Config ───────────────────────────────────────────────────────────────────
const STAFF_ROLE_1 = "1470145227929944376"; // First staff role
const STAFF_ROLE_2 = "1470179326858231818"; // Second staff role
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || null; // optional category
const OWNER_EXTENSIONS = Array.from({ length: 21 }, (_, i) => 1000 + i); // 1000–1020

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

// ─── Interaction Handler ──────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  // ── Ticket Panel Button ──
  if (interaction.isButton() && interaction.customId === "open_ticket") {
    const modal = new ModalBuilder()
      .setCustomId("ticket_form")
      .setTitle("📞 Open a New Ticket");

    const extensionInput = new TextInputBuilder()
      .setCustomId("extension")
      .setLabel("Extension Number")
      .setPlaceholder("e.g. 1025  (1000–1020 reserved for Owner)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(6);

    const callerIdInput = new TextInputBuilder()
      .setCustomId("caller_id")
      .setLabel("Caller ID")
      .setPlaceholder("Your name or number")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);

    const voicemailInput = new TextInputBuilder()
      .setCustomId("voicemail")
      .setLabel("Voicemail?")
      .setPlaceholder("Yes / No — and any message if applicable")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(200);

    const featuresInput = new TextInputBuilder()
      .setCustomId("features")
      .setLabel("Any Additional Features / Notes?")
      .setPlaceholder("Describe anything else you need...")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(1000);

    modal.addComponents(
      new ActionRowBuilder().addComponents(extensionInput),
      new ActionRowBuilder().addComponents(callerIdInput),
      new ActionRowBuilder().addComponents(voicemailInput),
      new ActionRowBuilder().addComponents(featuresInput)
    );

    await interaction.showModal(modal);
    return;
  }

  // ── Close Confirm Button ──
  if (interaction.isButton() && interaction.customId.startsWith("confirm_close:")) {
    const reason = interaction.customId.split(":").slice(1).join(":");
    await handleCloseTicket(interaction, reason);
    return;
  }

  // ── Cancel Close Button ──
  if (interaction.isButton() && interaction.customId === "cancel_close") {
    await interaction.update({
      content: "❌ Close request cancelled.",
      components: [],
    });
    return;
  }

  // ── Modal Submit ──
  if (interaction.isModalSubmit() && interaction.customId === "ticket_form") {
    const extension = interaction.fields.getTextInputValue("extension").trim();
    const callerId = interaction.fields.getTextInputValue("caller_id").trim();
    const voicemail = interaction.fields.getTextInputValue("voicemail").trim();
    const features = interaction.fields.getTextInputValue("features").trim();

    // Validate extension
    const extNum = parseInt(extension, 10);
    if (isNaN(extNum)) {
      return interaction.reply({
        content: "❌ Extension must be a number.",
        ephemeral: true,
      });
    }

    if (OWNER_EXTENSIONS.includes(extNum)) {
      return interaction.reply({
        content:
          "❌ Extensions **1000–1020** are reserved for the Owner. Please use a different extension.",
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const guild = interaction.guild;

      // Build permission overwrites
      const permissionOverwrites = [
        {
          id: guild.roles.everyone,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        {
          id: STAFF_ROLE_1,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageMessages,
          ],
        },
        {
          id: STAFF_ROLE_2,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageMessages,
          ],
        },
      ];

      const channelOptions = {
        name: `ticket-${interaction.user.username}-ext${extNum}`,
        type: ChannelType.GuildText,
        permissionOverwrites,
        topic: `Ticket by ${interaction.user.tag} | Ext: ${extNum} | Caller ID: ${callerId}`,
      };

      if (TICKET_CATEGORY_ID) {
        channelOptions.parent = TICKET_CATEGORY_ID;
      }

      const ticketChannel = await guild.channels.create(channelOptions);

      // Build embed
      const embed = new EmbedBuilder()
        .setTitle("📞 New Ticket Opened")
        .setColor(0x5865f2)
        .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: "👤 Opened By", value: `<@${interaction.user.id}>`, inline: true },
          { name: "🔢 Extension", value: `\`${extNum}\``, inline: true },
          { name: "📋 Caller ID", value: callerId, inline: true },
          { name: "📬 Voicemail?", value: voicemail, inline: true },
          {
            name: "⭐ Additional Features",
            value: features || "*None provided*",
            inline: false,
          }
        )
        .setFooter({ text: "Staff: use ?close <reason> to close this ticket" })
        .setTimestamp();

      await ticketChannel.send({
        content: `<@${interaction.user.id}> <@&${STAFF_ROLE_1}> <@&${STAFF_ROLE_2}>`,
        embeds: [embed],
      });

      await interaction.editReply({
        content: `✅ Your ticket has been created: ${ticketChannel}`,
      });
    } catch (err) {
      console.error("Error creating ticket channel:", err);
      await interaction.editReply({
        content: "❌ Failed to create your ticket. Please contact a staff member.",
      });
    }
  }
});

// ─── Message Command: ?close ──────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("?close")) return;

  // Check if staff
  const member = message.member;
  const isStaff =
    member.roles.cache.has(STAFF_ROLE_1) || member.roles.cache.has(STAFF_ROLE_2);

  if (!isStaff) {
    return message.reply("❌ Only staff can close tickets.");
  }

  const reason =
    message.content.slice("?close".length).trim() || "No reason provided";

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_close:${reason}`)
      .setLabel("✅ Confirm Close")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("cancel_close")
      .setLabel("❌ Cancel")
      .setStyle(ButtonStyle.Secondary)
  );

  await message.channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("🔒 Close Ticket Request")
        .setColor(0xed4245)
        .setDescription(
          `**${message.author.tag}** has requested to close this ticket.\n\n**Reason:** ${reason}`
        )
        .setFooter({ text: "This channel will be deleted after closing." })
        .setTimestamp(),
    ],
    components: [confirmRow],
  });
});

// ─── Close Handler ────────────────────────────────────────────────────────────
async function handleCloseTicket(interaction, reason) {
  const channel = interaction.channel;

  // Gather all human members who can see this channel
  const members = channel.permissionOverwrites.cache
    .filter(
      (overwrite) =>
        overwrite.type === 1 && // member overwrite (not role)
        overwrite.allow.has(PermissionFlagsBits.ViewChannel)
    )
    .map((overwrite) => `<@${overwrite.id}>`)
    .join(", ");

  const closeEmbed = new EmbedBuilder()
    .setTitle("🔒 Ticket Closed")
    .setColor(0xed4245)
    .setDescription(
      `This ticket has been closed by **${interaction.user.tag}**.\n\n**Reason:** ${reason}`
    )
    .addFields({
      name: "📣 Notified Users",
      value: members || "None",
    })
    .setTimestamp();

  await interaction.update({ content: "🔒 Closing ticket...", components: [] });
  await channel.send({ embeds: [closeEmbed] });

  // Wait 5 seconds so users can read, then delete
  setTimeout(async () => {
    try {
      await channel.delete(`Ticket closed by ${interaction.user.tag}: ${reason}`);
    } catch (e) {
      console.error("Failed to delete channel:", e);
    }
  }, 5000);
}

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(process.env.BOT_TOKEN);
