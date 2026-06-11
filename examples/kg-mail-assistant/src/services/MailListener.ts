import { EventEmitter } from "events";
import { google } from "googleapis";
import * as fs from "fs";
import { convert } from "html-to-text";

export interface Email {
  from: string;
  subject: string;
  text: string;
  html?: string;
  date: Date;
  messageId?: string;
}

export interface EmailFilterConfig {
  // Only process emails from these domains (if specified)
  allowedDomains?: string[];
  // Skip emails from these domains
  blockedDomains?: string[];
  // Skip emails from these specific addresses
  blockedSenders?: string[];
  // Only process emails newer than this date
  minDate?: Date;
  // Maximum age in hours (alternative to minDate)
  maxAgeHours?: number;
  // Skip emails with these subjects (regex patterns)
  subjectBlocklist?: RegExp[];
}

/**
 * Mail listener service using Gmail API
 * Uses OAuth2 authentication with environment variables for client credentials
 */
export class MailListener extends EventEmitter {
  private oauth2Client: any = null;
  private gmail: any = null;
  private isConnected: boolean = false;
  private isListening: boolean = false;
  private processedMessageIds: Set<string> = new Set();
  private tokenPath: string = "./token.json";
  private redirectUrl: string = "http://localhost:3000/oauth2callback";
  private emailHandler: ((email: Email) => Promise<void>) | null = null;
  private filterConfig: EmailFilterConfig;

  constructor(filterConfig: EmailFilterConfig = {}) {
    super();
    
    // Set default filter: only process emails from last 24 hours
    this.filterConfig = {
      maxAgeHours: 24,
      blockedDomains: [],
      blockedSenders: [],
      subjectBlocklist: [],
      ...filterConfig,
    };
    
    console.log(`[MAIL] Filter config:`, this.filterConfig);
  }

  /**
   * Set the email handler to be called when new emails arrive
   */
  public setEmailHandler(handler: (email: Email) => Promise<void>): void {
    this.emailHandler = handler;
  }

  /**
   * Update filter configuration
   */
  public updateFilterConfig(config: Partial<EmailFilterConfig>): void {
    this.filterConfig = { ...this.filterConfig, ...config };
    console.log(`[MAIL] Updated filter config:`, this.filterConfig);
  }

  /**
   * Authenticate using OAuth2 with credentials from environment variables
   */
  private async authenticateOAuth2(): Promise<void> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error(
        "Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in environment variables"
      );
    }

    this.oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      this.redirectUrl
    );

    // Try to load existing token
    if (fs.existsSync(this.tokenPath)) {
      const token = JSON.parse(fs.readFileSync(this.tokenPath, "utf-8"));
      this.oauth2Client.setCredentials(token);
      console.log("[MAIL] Loaded saved OAuth2 token");
      return;
    }

    // If no token exists, generate new authorization URL
    console.log("[MAIL] No existing OAuth2 token found");
    console.log("[MAIL] Please authenticate with Google first:");
    console.log(`[MAIL] Run: npm run gmail:auth`);

    throw new Error(
      "OAuth2 token not found. Run 'npm run gmail:auth' to authenticate."
    );
  }

  async connect(): Promise<void> {
    try {
      console.log("[MAIL] Initializing Gmail API with OAuth2...");

      await this.authenticateOAuth2();

      // Initialize Gmail API
      this.gmail = google.gmail({ version: "v1", auth: this.oauth2Client });

      // Test connection by fetching profile
      const profile = await this.gmail.users.getProfile({ userId: "me" });
      console.log(
        `[MAIL] Connected to Gmail successfully (${profile.data.emailAddress})`
      );

      this.isConnected = true;
    } catch (error) {
      console.error(`[MAIL] Connection failed: ${error}`);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
    this.isListening = false;
    console.log("[MAIL] Disconnected from Gmail API");
  }

  async startListening(): Promise<void> {
    if (!this.isConnected) {
      throw new Error("Not connected to Gmail");
    }

    this.isListening = true;
    console.log("[MAIL] Started listening for new emails (polling every 30s)");

    // Poll for new emails every 30 seconds
    const pollInterval = 30000;

    while (this.isListening) {
      try {
        await this.checkForNewEmails();
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      } catch (error) {
        console.error(`[MAIL] Error during polling: ${error}`);
        // Continue polling even on error
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }
  }

  /**
   * Check if email passes all filters
   */
  private shouldProcessEmail(email: Email): { allowed: boolean; reason?: string } {
    // Check date filters
    const minDate = this.filterConfig.minDate || 
      (this.filterConfig.maxAgeHours 
        ? new Date(Date.now() - this.filterConfig.maxAgeHours * 60 * 60 * 1000)
        : null);
    
    if (minDate && email.date < minDate) {
      return { 
        allowed: false, 
        reason: `Too old (${email.date.toISOString()})` 
      };
    }

    // Extract email address from "Name <email@domain.com>" format
    const emailMatch = email.from.match(/<([^>]+)>/);
    const emailAddress = emailMatch ? emailMatch[1] : email.from;
    const domain = emailAddress.split("@")[1]?.toLowerCase();

    // Check blocked senders
    if (this.filterConfig.blockedSenders?.includes(emailAddress.toLowerCase())) {
      return { 
        allowed: false, 
        reason: `Blocked sender: ${emailAddress}` 
      };
    }

    // Check blocked domains
    if (domain && this.filterConfig.blockedDomains?.includes(domain)) {
      return { 
        allowed: false, 
        reason: `Blocked domain: ${domain}` 
      };
    }

    // Check allowed domains (if specified)
    if (this.filterConfig.allowedDomains && this.filterConfig.allowedDomains.length > 0) {
      if (!domain || !this.filterConfig.allowedDomains.includes(domain)) {
        return { 
          allowed: false, 
          reason: `Domain not in allowlist: ${domain}` 
        };
      }
    }

    // Check subject blocklist
    if (this.filterConfig.subjectBlocklist) {
      for (const pattern of this.filterConfig.subjectBlocklist) {
        if (pattern.test(email.subject)) {
          return { 
            allowed: false, 
            reason: `Subject matches blocklist: ${pattern}` 
          };
        }
      }
    }

    return { allowed: true };
  }

  private async checkForNewEmails(): Promise<void> {
    try {
      // Search for unread emails
      const response = await this.gmail.users.messages.list({
        userId: "me",
        q: "is:unread",
        includeSpamTrash: false, // Changed to false - no need to process spam
        maxResults: 10,
      });

      const messages = response.data.messages || [];
      console.log(`[MAIL] Found ${messages.length} unread emails`);

      for (const message of messages) {
        try {
          const email = await this.parseEmail(message.id);
          
          // Check if already processed
          if (email.messageId && this.processedMessageIds.has(email.messageId)) {
            console.log(`[MAIL] Skipping already processed: ${email.messageId}`);
            continue;
          }

          // Apply filters
          const filterResult = this.shouldProcessEmail(email);
          
          if (!filterResult.allowed) {
            console.log(
              `[MAIL] Filtered out: "${email.subject}" from ${email.from} - ${filterResult.reason}`
            );
            
            // Mark as read anyway to avoid re-checking
            await this.markAsRead(message.id);
            continue;
          }

          // Process the email
          if (email.messageId) {
            this.processedMessageIds.add(email.messageId);
          }
          
          console.log(
            `[MAIL] ✅ Processing: "${email.subject}" from ${email.from}`
          );

          // Call the handler if set
          if (this.emailHandler) {
            try {
              await this.emailHandler(email);
            } catch (handlerError) {
              console.error(`[MAIL] Error in email handler: ${handlerError}`);
            }
          }

          // Emit the event for backward compatibility
          setImmediate(() => this.emit("newEmail", email));

          // Mark as read
          await this.markAsRead(message.id);
          
        } catch (error) {
          console.error(`[MAIL] Error parsing email: ${error}`);
        }
      }
    } catch (error) {
      console.error(`[MAIL] Error checking for new emails: ${error}`);
    }
  }

  private async markAsRead(messageId: string): Promise<void> {
    try {
      await this.gmail.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: {
          addLabelIds: ["CATEGORY_UPDATES"],
          removeLabelIds: ["UNREAD"],
        },
      });
    } catch (error) {
      console.error(`[MAIL] Failed to mark as read: ${error}`);
    }
  }

  private async parseEmail(messageId: string): Promise<Email> {
    try {
      // Get full message details
      const response = await this.gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });

      const message = response.data;
      const headers = message.payload.headers;

      // Extract headers
      const getHeader = (name: string) => {
        const header = headers.find((h: any) => h.name === name);
        return header ? header.value : "";
      };

      const from = getHeader("From");
      const subject = getHeader("Subject") || "(no subject)";
      const date = getHeader("Date");
      const messageIdHeader = getHeader("Message-ID");

      // Extract body (text and HTML)
      let text = "";
      let html = "";

      const extractBody = (part: any): { text: string; html: string } => {
        let bodyText = "";
        let bodyHtml = "";

        if (part.mimeType === "text/plain") {
          bodyText = part.body.data
            ? Buffer.from(part.body.data, "base64").toString("utf-8")
            : "";
        } else if (part.mimeType === "text/html") {
          bodyHtml = part.body.data
            ? Buffer.from(part.body.data, "base64").toString("utf-8")
            : "";
        } else if (part.parts) {
          for (const subPart of part.parts) {
            const extracted = extractBody(subPart);
            bodyText += extracted.text;
            bodyHtml += extracted.html;
          }
        }

        return { text: bodyText, html: bodyHtml };
      };

      const body = extractBody(message.payload);
      html = body.html;
      
      // Convert HTML to clean text if no plain text available
      if (!body.text && html) {
        text = convert(html, {
          wordwrap: false,
          selectors: [
            // Preserve important structure
            { selector: 'h1', format: 'heading', options: { leadingLineBreaks: 2, trailingLineBreaks: 1 } },
            { selector: 'h2', format: 'heading', options: { leadingLineBreaks: 2, trailingLineBreaks: 1 } },
            { selector: 'h3', format: 'heading', options: { leadingLineBreaks: 2, trailingLineBreaks: 1 } },
            { selector: 'h4', format: 'heading', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
            { selector: 'h5', format: 'heading', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
            { selector: 'h6', format: 'heading', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
            { selector: 'p', format: 'paragraph', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
            { selector: 'br', format: 'lineBreak' },
            { selector: 'ul', format: 'unorderedList', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
            { selector: 'ol', format: 'orderedList', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
            { selector: 'li', format: 'listItem', options: { leadingLineBreaks: 1 } },
            { selector: 'blockquote', format: 'blockquote', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
            { selector: 'table', format: 'table' },
            // Remove unwanted elements
            { selector: 'script', format: 'skip' },
            { selector: 'style', format: 'skip' },
            { selector: 'nav', format: 'skip' },
            { selector: '.navigation', format: 'skip' },
            { selector: '.sidebar', format: 'skip' },
            { selector: '.footer', format: 'skip' },
            { selector: '.header', format: 'skip' },
            { selector: '.menu', format: 'skip' },
            { selector: '.advertisement', format: 'skip' },
            { selector: '.ads', format: 'skip' }
          ]
        });
      } else {
        text = body.text;
      }

      const email: Email = {
        from: from.split("<")[0].trim() || from,
        subject,
        text: text || "",
        html: html || undefined,
        date: new Date(date || new Date()),
        messageId: messageIdHeader || messageId,
      };

      return email;
    } catch (error) {
      throw new Error(`Failed to parse email ${messageId}: ${error}`);
    }
  }

  stop(): void {
    this.isListening = false;
  }
  
  /**
   * Get statistics about processed emails
   */
  getStats(): { processedCount: number; processedIds: string[] } {
    return {
      processedCount: this.processedMessageIds.size,
      processedIds: Array.from(this.processedMessageIds),
    };
  }
}