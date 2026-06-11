import { google } from "googleapis";
import * as fs from "fs";
import * as readline from "readline";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const TOKEN_PATH = "token.json";

async function authenticate() {
  // Get credentials from environment variables
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("\n❌ ERROR: Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET!\n");
    console.log("📋 Setup Instructions:");
    console.log("1. Go to: https://console.cloud.google.com");
    console.log("2. Create a new project");
    console.log("3. Enable Gmail API");
    console.log("4. Create OAuth 2.0 Desktop credentials");
    console.log("5. Copy Client ID and Client Secret");
    console.log("6. Add to .env file:");
    console.log("   GOOGLE_CLIENT_ID=your-client-id");
    console.log("   GOOGLE_CLIENT_SECRET=your-client-secret\n");
    process.exit(1);
  }

  const redirectUrl = "http://localhost:3000/oauth2callback";
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUrl);

  // Check if token already exists
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    oauth2Client.setCredentials(token);
    console.log("✅ Token already exists! Using existing authentication.");
    return;
  }

  // Generate authorization URL
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });

  console.log("\n🔐 Gmail API Authentication\n");
  console.log("📝 Step 1: Open this URL in your browser:");
  console.log(authUrl);
  console.log("\n📝 Step 2: After authorizing, you'll be redirected to http://localhost:3000/oauth2callback?code=...");
  console.log("📝 Step 3: Copy the authorization code from the URL and paste it here:\n");

  // Get authorization code from user
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question("Enter authorization code: ", async (code) => {
    rl.close();

    try {
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);

      // Save token for future use
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      console.log("\n✅ Authentication successful!");
      console.log(`💾 Token saved to ${TOKEN_PATH}`);
      console.log("\n🚀 You can now run: npm run start\n");
    } catch (error) {
      console.error("❌ Error during authentication:", error);
      process.exit(1);
    }
  });
}

authenticate().catch(console.error);