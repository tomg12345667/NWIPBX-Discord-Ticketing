# 📞 Discord Ticket Bot

A Discord ticketing bot with modal forms, automatic channel creation, and staff close flow.

---

## Features

- 🎫 **Ticket Panel** — persistent button embed in any channel
- 📋 **Modal Form** — collects Extension, Caller ID, Voicemail, and Additional Features
- 🔒 **Extension Guard** — blocks 1000–1020 (reserved for Owner)
- 📁 **Private Channel** — auto-created with correct permissions for staff roles + user
- ❌ **?close** command — staff-only, prompts for reason, sends confirmation embed, deletes channel after 5s

---

## Setup

### 1. Create a Discord Bot

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → name it
3. Go to **Bot** tab → click **Add Bot**
4. Under **Privileged Gateway Intents**, enable:
   - ✅ Server Members Intent
   - ✅ Message Content Intent
5. Copy the **Token** (you'll need it in `.env`)

### 2. Invite the Bot

Use this OAuth2 URL (replace `YOUR_CLIENT_ID`):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=8&scope=bot
```

Or manually select these permissions:
- Manage Channels
- View Channels
- Send Messages
- Embed Links
- Read Message History
- Manage Messages

### 3. Install & Configure

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```env
BOT_TOKEN=your_bot_token_here
PANEL_CHANNEL_ID=the_channel_id_for_the_ticket_button
TICKET_CATEGORY_ID=optional_category_id_for_ticket_channels
```

**To get a channel ID:** Right-click the channel in Discord → Copy Channel ID  
*(Enable Developer Mode in Discord Settings → Advanced → Developer Mode)*

### 4. Start the Bot

```bash
npm start
```

### 5. Deploy the Panel

In Discord, go to the channel where you want the ticket panel and type:

```
?sendpanel
```

Staff roles only. The command message is silently deleted, leaving just the clean panel embed.

---

## Staff Role IDs

The two staff roles are hardcoded in `index.js`:

```js
const STAFF_ROLE_1 = "1470145227929944376";
const STAFF_ROLE_2 = "1470179326858231818";
```

Change these if needed.

---

## Commands

| Command | Who | Description |
|---|---|---|
| `?close <reason>` | Staff only | Sends close confirmation to channel, deletes after 5s |

---

## Channel Naming

Ticket channels are created as:
```
ticket-<username>-ext<number>
```
e.g. `ticket-john-ext1025`

---

## Extension Rules

| Range | Status |
|---|---|
| 1000–1020 | 🔒 Reserved for Owner — blocked |
| All others | ✅ Allowed |
