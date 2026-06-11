# Troubleshooting Guide

## Common Issues

### 1. Mail Listener Not Connecting

#### Error: "Application-specific password required"

**Cause**: Gmail doesn't allow regular account passwords via IMAP for security reasons.

**Solution**:
1. Enable 2-Factor Authentication on your Google Account
2. Go to https://myaccount.google.com/apppasswords
3. Select "Mail" and "Windows Computer" (or your device)
4. Generate a new app password
5. Copy the 16-character password (remove spaces)
6. Update `IMAP_PASSWORD` in `.env` with this app password
7. Restart the application

#### Error: "IMAP_USER and IMAP_PASSWORD must be set in environment"

**Cause**: IMAP credentials are commented out or missing in `.env`

**Solution**:
1. Copy `.env.example` to `.env`
2. Uncomment or fill in the IMAP credentials
3. Make sure `IMAP_USER` and `IMAP_PASSWORD` are not empty

#### Warning: "Mail listener initialization failed" but app continues

**This is expected behavior**: The app gracefully handles IMAP connection failures and continues running with Telegram commands available. Check the error message above the warning for the actual issue.

### 2. Telegram Bot Not Responding

#### Bot not sending messages

**Check**:
1. Verify `TELEGRAM_BOT_TOKEN` is correct from @BotFather
2. Verify `TELEGRAM_USER_ID` is your numeric ID (e.g., 123456789, not username)
3. Message your bot once to establish a chat (bots can only reply to active chats)
4. Check logs for `[TELEGRAM] Message sent` confirmation

#### Invalid token error

**Solution**:
1. Recreate the bot with @BotFather
2. Copy the entire token (should have colons in it)
3. Update `TELEGRAM_BOT_TOKEN` in `.env`

### 3. No Emails Being Processed

#### IMAP connection works but no emails appear

**Check**:
1. Verify emails are in INBOX (not in other folders)
2. Check that emails are marked as UNSEEN
3. View JSONL output file: `./data/graphs/graph-YYYY-MM-DD.jsonl`

**Note**: Currently only UNSEEN emails are processed. Once an email is processed and marked as READ, it won't be reprocessed.

#### JSONL file not being created

**Check**:
1. Verify `./data/graphs/` directory exists
2. Check file permissions
3. Run `npm run start` in debug mode to see detailed logs

### 4. Application Crashes on Startup

#### Error in logs

**Solution**:
1. Check that all required environment variables are set:
   ```
   IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASSWORD (optional - app continues without)
   TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID (required)
   ```
2. Run with error handling enabled (uncomment try-catch in src/index.ts)
3. Check Node.js version compatibility (requires Node 18+)

### 5. High CPU Usage or Memory Leaks

#### App consumes memory over time

**Cause**: Email polling every 30 seconds can accumulate connections

**Solutions**:
1. Increase poll interval in MailListener.ts (line ~87: change `pollInterval`)
2. Clear processed message IDs periodically
3. Monitor logs for connection errors

## Testing the Pipeline

### Manual Test: Send Email

1. Send an email to your Gmail account
2. Wait 30 seconds for next poll
3. Check logs for: `[MAIL] Found N unseen emails`
4. Verify JSONL file updated: `./data/graphs/graph-YYYY-MM-DD.jsonl`

### Manual Test: Telegram Commands

Send messages to your bot:
- `/status` - Shows graph statistics
- `/summary` - Daily summary
- `/reset` - Resets graph file

### View JSONL Output

```bash
cat ./data/graphs/graph-YYYY-MM-DD.jsonl | jq .
```

## Debug Mode

Add more detailed logging:

```bash
LOG_LEVEL=debug npm run start
```

## Getting Help

1. Check error logs first - they often indicate the exact issue
2. Verify all environment variables are set correctly
3. Test IMAP/Telegram credentials independently
4. Check that required services are running (kg-gen, Ollama if using local LLM)

## Known Limitations

- Only processes UNSEEN emails (after processing, emails are marked READ)
- Uses polling-based approach (30-second intervals) instead of IDLE for stability
- JSONL format used instead of full kg-gen integration (Phase 2 planned)
- No retry mechanism for failed email processing
