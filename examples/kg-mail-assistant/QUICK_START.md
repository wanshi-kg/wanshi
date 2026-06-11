# KG Mail Assistant - Quick Reference

## 🚀 Quick Start (Copy & Paste)

```bash
# 1. Clone and install
cd examples/kg-mail-assistant
npm install

# 2. Setup Gmail API (follow browser prompts)
npm run gmail:auth

# 3. Start the bot
npm run start
```

## 📋 Setup Checklist

- [ ] Node.js 18+ installed (`node --version`)
- [ ] @BotFather created bot on Telegram
- [ ] Got `credentials.json` from Google Cloud Console
- [ ] Ran `npm run gmail:auth` (browser OAuth2 flow)
- [ ] Set TELEGRAM_TOKEN in `.env`
- [ ] Set TELEGRAM_USER_ID in `.env`

## 🔧 Configuration

### `.env` File

```txt
# Get from @BotFather on Telegram
TELEGRAM_TOKEN=123456:ABCDEfghijklmnop

# Your numeric Telegram user ID
TELEGRAM_USER_ID=987654321

# Optional: kg-gen configuration
# KG_GEN_HOST=http://localhost:3000
# KG_GEN_MODEL=neural-net
```

### Get Your Telegram User ID

Send any message to your bot, then:

```bash
curl https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates | grep from
```

Look for `"id":123456789` in the output.

## 📧 How to Use

### 1. First Time Setup

```bash
# Google will ask to authorize in browser
npm run gmail:auth

# Saves token to ./token.json
# ✅ All set!
```

### 2. Telegram Commands

Once running, send these to your bot:

```
/status  → Show graph stats
/summary → Day summary
/reset   → Clear graph
```

### 3. Send Emails

- Send emails from any account to your Gmail
- Bot automatically detects and processes them
- Creates knowledge graph entries (JSONL format)

## 📁 Important Files

```
kg-mail-assistant/
├── credentials.json     ← Download from Google Cloud
├── token.json          ← Created after first auth
├── .env                ← Your configuration
├── src/
│   ├── index.ts        ← Main app
│   └── services/
│       ├── MailListener.ts    ← Gmail polling
│       ├── TelegramBot.ts     ← Telegram bot
│       └── KnowledgeGraphBuilder.ts
├── scripts/
│   └── gmail-auth.ts   ← OAuth2 setup
├── data/graphs/        ← Output JSONL files
└── package.json        ← Dependencies
```

## 🐛 Common Issues

### "credentials.json not found"

```bash
# Download from Google Cloud Console:
# https://console.cloud.google.com/credentials

# Place in project root
mv ~/Downloads/client_secret_*.json ./credentials.json
```

### "Authorization failed"

```bash
# Delete token and re-authenticate
rm token.json
npm run gmail:auth
```

### "Message not received" / "Bot not responding"

```bash
# Make sure TELEGRAM_USER_ID is correct
echo $TELEGRAM_USER_ID  # Should show a number

# Check bot token is correct
npm run start  # Look for "Telegram bot ready" message
```

### "No emails found"

1. Make sure emails exist in Gmail (check web app first)
2. Verify OAuth2 scopes are correct (see token.json)
3. Check logs for `[MAIL]` messages
4. Send a test email and wait 30 seconds

## 📊 Output

### Knowledge Graph (JSONL)

Saved in `./data/graphs/YYYY-MM-DD.jsonl`:

```json
{"timestamp":"2024-01-15T10:30:00Z","source":"gmail","from":"user@example.com","subject":"Important Meeting","entities":["project","deadline"],"text":"Full email body..."}
```

### Logs

```txt
[MAIL] Checking for new emails...
[MAIL] Found 3 unread emails
[GRAPH] Added 3 entries to today's graph
[TELEGRAM] Bot ready for commands
```

## 🔒 Security Reminders

- ✅ Never commit `credentials.json` or `token.json`
- ✅ Already in `.gitignore` - they're safe
- ✅ OAuth2 is more secure than passwords
- ✅ Can revoke access anytime: [Google Account Permissions](https://myaccount.google.com/permissions)

## 🔄 Scripts

```bash
npm run start     # Run the bot
npm run dev       # Run with watch mode
npm run gmail:auth  # Setup/refresh Gmail OAuth2
npm run build     # Compile TypeScript
npm run lint      # Check code
```

## 📖 Full Guides

- **[GMAIL_SETUP.md](./GMAIL_SETUP.md)** - Detailed Gmail API setup (5 min)
- **[README.md](./README.md)** - Project overview and architecture
- **[IMPLEMENTATION_COMPLETE.md](./IMPLEMENTATION_COMPLETE.md)** - Migration details

## 🆘 Get Help

**Problem not listed?** Check these files:

1. `.env` - Verify all env vars are set correctly
2. `src/index.ts` - Main app initialization
3. Terminal logs - Look for error messages

**Reset everything:**

```bash
rm -f credentials.json token.json
npm run gmail:auth
npm run start
```

## 💡 Pro Tips

- Run with `npm run dev` to automatically restart on code changes
- Check `./data/graphs/` to see what's being stored
- Use `/status` command in Telegram to debug issues
- First email detection takes ~30 seconds (polling interval)

## 🎯 Next Phase

Once everything works, we'll add:

- [ ] Entity extraction (kg-gen integration)
- [ ] Daily summaries (AI-generated)
- [ ] Important email detection
- [ ] Custom filtering rules
- [ ] Export/visualization

---

**Last Updated:** January 2024 | **Status:** Phase 1 Complete ✅
