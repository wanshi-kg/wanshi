# Gmail API Integration - Environment Variables Setup

## ✅ Integration Complete

The kg-mail-assistant now uses **Google Client credentials** from environment variables instead of credentials.json files. This is cleaner and more secure!

## 🎯 How It Works

### Architecture

```
.env (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET)
  ↓
gmail-auth.ts (npm run gmail:auth)
  ↓
OAuth2 authorization flow
  ↓
token.json (saved locally)
  ↓
MailListener.ts (uses token.json for Gmail API access)
  ↓
Email polling and processing
```

### Setup Flow

1. **Add credentials to .env** ✅ (You already did this!)
   ```bash
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```

2. **Run authentication script**
   ```bash
   npm run gmail:auth
   ```
   - Opens OAuth2 authorization URL in console
   - You visit the URL and grant permission
   - Copy authorization code and paste in terminal
   - Token is automatically saved to `token.json`

3. **Start the app**
   ```bash
   npm run start
   ```
   - Loads `token.json`
   - Connects to Gmail API
   - Starts listening for emails

## 📋 File Changes

### MailListener.ts

**Key improvements:**
- ✅ Removed `credentials.json` requirement
- ✅ Now uses environment variables for client ID/secret
- ✅ Loads token from `token.json` (saved after OAuth2 auth)
- ✅ Better error messages guiding users to run `npm run gmail:auth`
- ✅ Cleaner OAuth2 initialization using `google.auth.OAuth2`

**Before:**
```typescript
// Required credentials.json file
const credentials = JSON.parse(fs.readFileSync("./credentials.json"));
const { client_id, client_secret, redirect_uris } = credentials.installed;
```

**After:**
```typescript
// Uses environment variables
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
// Token loaded from token.json (created by gmail-auth.ts)
```

### scripts/gmail-auth.ts

**Updated to:**
- ✅ Load client credentials from `.env` file via `dotenv`
- ✅ No need for `credentials.json` file
- ✅ Generate authorization URL
- ✅ Accept authorization code from terminal
- ✅ Save token to `token.json` for app to use
- ✅ Clear error messages if env vars missing

**Usage:**
```bash
npm run gmail:auth
```

## 🔑 Environment Variables

Add these to your `.env` file:

```bash
# From Google Cloud Console
GOOGLE_CLIENT_ID=your-client-id-here.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret-here

# These are already configured
TELEGRAM_BOT_TOKEN=...
TELEGRAM_USER_ID=...
```

## 🚀 Quick Start

```bash
# 1. Add credentials to .env (you already did this ✓)

# 2. Authenticate with Gmail
npm run gmail:auth

# 3. Start the app
npm run start
```

That's it! No more confusing `credentials.json` files or app passwords needed! 🎉

## 📁 What Gets Saved

After running `npm run gmail:auth`:

```
kg-mail-assistant/
├── token.json          ← Created after OAuth2 auth (save this, don't commit)
├── .env                ← Your client credentials (don't commit)
└── ... other files
```

## 🔒 Security

- ✅ Client secret only in `.env` (not in repo)
- ✅ Token saved locally only (not uploaded anywhere)
- ✅ Can revoke access anytime from Google Account settings
- ✅ OAuth2 is more secure than app-specific passwords

## 🐛 Troubleshooting

### "Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET"

Make sure `.env` has both:
```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

### "OAuth2 token not found"

Run:
```bash
npm run gmail:auth
```

### "Gmail connection failed"

Check:
1. `.env` file has correct credentials
2. `token.json` exists (run `npm run gmail:auth`)
3. Gmail API is enabled in Google Cloud Console

## ✨ Summary

✅ **Gmail API integration via environment variables**  
✅ **No credentials.json file needed**  
✅ **OAuth2 token saved to token.json**  
✅ **Clear setup instructions**  
✅ **Better error handling**  
✅ **Secure by default**  

You can now start using `npm run start`! 🚀
