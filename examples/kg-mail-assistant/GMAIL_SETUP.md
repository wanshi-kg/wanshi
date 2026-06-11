# Gmail API Setup Guide

## ✨ Benefits of Gmail API

✅ **No app-specific password needed** - Uses OAuth2 instead  
✅ **More reliable** - Official API instead of IMAP workarounds  
✅ **Better error handling** - Clearer error messages  
✅ **Safer** - Only requires email read permissions (we don't store passwords)  
✅ **Works with 2FA enabled** - No special app passwords needed  

## 🚀 Quick Setup (5 minutes)

### Step 1: Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Click "Select a Project" → "New Project"
3. Enter project name: `kg-mail-assistant`
4. Click "Create"

### Step 2: Enable Gmail API

1. In Cloud Console, search for "Gmail API"
2. Click "Gmail API"
3. Click "Enable"

### Step 3: Create OAuth 2.0 Credentials

1. In Cloud Console, go to "Credentials" (left sidebar)
2. Click "Create Credentials" → "OAuth client ID"
3. If prompted, configure OAuth consent screen first:
   - User Type: "External"
   - Click "Create"
   - Fill in app name: `kg-mail-assistant`
   - Add your email as a test user
   - Save and continue
4. Choose Application Type: "Desktop app"
5. Name: `kg-mail-assistant`
6. Click "Create"
7. Click "Download" (JSON format)

### Step 4: Setup Credentials in Project

1. Save the downloaded JSON file as `credentials.json` in project root:

   ```bash
   mv ~/Downloads/client_secret_*.json /path/to/kg-mail-assistant/credentials.json
   ```

2. Run authentication setup:

   ```bash
   npm run gmail:auth
   ```

3. Follow the prompts:
   - A browser window will open
   - Click "Continue"
   - Grant permission to access Gmail
   - Copy the authorization code from the redirect URL
   - Paste it into the terminal prompt

### Step 5: Done! 🎉

Token will be automatically saved to `token.json`. You can now run:

```bash
npm run start
```

## 📁 Files Created

```txt
kg-mail-assistant/
├── credentials.json     # Downloaded from Google Cloud (DO NOT COMMIT)
├── token.json          # Created after first auth (DO NOT COMMIT)
└── scripts/
    └── gmail-auth.ts   # Authentication setup script
```

## 🔒 Security Notes

- ✅ Never commit `credentials.json` or `token.json` to git
- ✅ Add them to `.gitignore` (already done)
- ✅ Tokens are stored locally only
- ✅ Can revoke access anytime from [Google Account](https://myaccount.google.com/permissions)

## 🐛 Troubleshooting

### Error: "credentials.json not found"

**Solution**: Download credentials from Google Cloud Console (Step 3-7 above)

### Error: "Invalid authorization code"

**Solution**: Make sure you copied the entire code from the redirect URL

### Error: "Client is not authorized to access this API"

**Solution:**
1. Make sure Gmail API is enabled in Cloud Console
2. Re-run `npm run gmail:auth` to get fresh token### Connection keeps failing

**Solution:**

Check that `token.json` exists and is valid:

```bash
ls -la token.json
cat token.json | head
```

## 📊 Permissions

The app requests only `gmail.modify` scope, which allows:

- ✅ Read emails
- ✅ Mark emails as read
- ✅ Label operations
- ❌ Send emails (not requested)
- ❌ Access other Google services (not requested)

## 🔄 Token Refresh

Tokens automatically refresh when needed. If you need to re-authorize:

```bash
rm token.json
npm run gmail:auth
```

## 📖 Next Steps

Once authenticated:

1. Start the application:

   ```bash
   npm run start
   ```

2. Send emails to test:
   - Send emails from another account to your Gmail
   - App will automatically detect and process them

3. Use Telegram commands:

   ```txt
   /status  - Show graph statistics
   /summary - Daily summary
   /reset   - Reset graph
   ```

## 🎓 Learn More

- [Gmail API Documentation](https://developers.google.com/gmail/api)
- [OAuth 2.0 Guide](https://developers.google.com/identity/protocols/oauth2)
- [Google Auth Library Docs](https://github.com/googleapis/google-auth-library-nodejs)
