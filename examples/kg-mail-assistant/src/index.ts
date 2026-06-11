import * as dotenv from "dotenv";
import { MailListener, EmailFilterConfig } from "./services/MailListener";
import { TelegramBot } from "./services/TelegramBot";
import { KnowledgeGraphBuilder } from "./services/KnowledgeGraphBuilder";

// Load environment variables
dotenv.config();

// Simple logger utility
const logger = {
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
};

interface AssistantConfig {
  kgGenOptions: Record<string, any>;
  imapEnabled: boolean;
  telegramEnabled: boolean;
  watchMode: boolean;
  emailFilter: EmailFilterConfig;
}

class KGMailAssistant {
  private config: AssistantConfig;
  private mailListener: MailListener | null = null;
  private telegramBot: TelegramBot | null = null;
  private kgBuilder: KnowledgeGraphBuilder | null = null;

  constructor(config: AssistantConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    logger.info("Initializing KG Mail Assistant...");

    // Initialize kg-gen builder
    this.kgBuilder = new KnowledgeGraphBuilder(this.config.kgGenOptions);
    await this.kgBuilder.initialize();

    // Initialize mail listener if enabled
    if (this.config.imapEnabled) {
      try {
        this.mailListener = new MailListener(this.config.emailFilter);
        this.mailListener.setEmailHandler((email: any) =>
          this.handleNewEmail(email)
        );
        await this.mailListener.connect();
        
        logger.info("✅ Mail listener initialized with filters:");
        logger.info(`   - Max age: ${this.config.emailFilter.maxAgeHours || 24}h`);
        if (this.config.emailFilter.allowedDomains) {
          logger.info(`   - Allowed domains: ${this.config.emailFilter.allowedDomains.join(", ")}`);
        }
        if (this.config.emailFilter.blockedDomains) {
          logger.info(`   - Blocked domains: ${this.config.emailFilter.blockedDomains.join(", ")}`);
        }
      } catch (error) {
        logger.warn(`Mail listener initialization failed: ${error}`);
        logger.warn(
          "Continuing without mail listener - Telegram commands still available"
        );
        this.mailListener = null;
      }
    }

    // Initialize Telegram bot if enabled
    if (this.config.telegramEnabled) {
      try {
        this.telegramBot = new TelegramBot();
        this.telegramBot.on("command", (cmd: string, args: string[]) =>
          this.handleTelegramCommand(cmd, args)
        );
        this.telegramBot.start();
        logger.info("✅ Telegram bot initialized");
      } catch (error) {
        logger.warn(`Telegram bot initialization failed: ${error}`);
        this.telegramBot = null;
      }
    }

    logger.info("KG Mail Assistant initialized successfully");
  }

  async start(): Promise<void> {
    logger.info("Starting KG Mail Assistant...");

    if (this.config.watchMode && this.kgBuilder) {
      logger.info("Watch mode enabled - monitoring for new emails...");
      await this.startWatchMode();
    }
  }

  private async startWatchMode(): Promise<void> {
    // Keep the process running and listening for emails
    if (this.mailListener) {
      await this.mailListener.startListening();
    }
  }

  private async handleNewEmail(email: {
    from: string;
    subject: string;
    text: string;
    html?: string;
    date: Date;
  }): Promise<void> {
    logger.info(`📧 Processing email from ${email.from}: ${email.subject}`);

    try {
      // Add email to kg-gen for processing
      if (this.kgBuilder) {
        await this.kgBuilder.processEmail(email);
        logger.info(`✅ Email processed successfully`);
      }

      // Notify user via Telegram (optional - can be disabled)
      if (this.telegramBot && process.env.TELEGRAM_NOTIFY_ALL !== "false") {
        const preview = email.text.substring(0, 100).replace(/\n/g, " ");
        await this.telegramBot.sendMessage(
          `📧 <b>New email processed</b>\n` +
            `From: ${email.from}\n` +
            `Subject: ${email.subject}\n` +
            `Preview: ${preview}...`
        );
      }
    } catch (error) {
      logger.error(`Error processing email: ${error}`);
      
      // Notify about error via Telegram
      if (this.telegramBot) {
        await this.telegramBot.sendMessage(
          `❌ <b>Error processing email</b>\n` +
            `From: ${email.from}\n` +
            `Subject: ${email.subject}\n` +
            `Error: ${error}`
        );
      }
    }
  }

  private async handleTelegramCommand(
    command: string,
    args: string[]
  ): Promise<void> {
    logger.info(`Telegram command: ${command} ${args.join(" ")}`);

    try {
      switch (command) {
        case "status":
          await this.handleStatusCommand();
          break;

        case "summary":
          await this.handleSummaryCommand();
          break;

        case "reset":
          await this.handleResetCommand();
          break;

        case "stats":
          await this.handleStatsCommand();
          break;

        case "filter":
          await this.handleFilterCommand(args);
          break;

        case "help":
          await this.handleHelpCommand();
          break;

        default:
          if (this.telegramBot) {
            await this.telegramBot.sendMessage(
              "❌ <b>Unknown command</b>\n\n" +
                "Available commands:\n" +
                "• /status - Graph status\n" +
                "• /summary - Daily summary\n" +
                "• /stats - Processing statistics\n" +
                "• /filter - Manage email filters\n" +
                "• /reset - Reset graph\n" +
                "• /help - Show this help"
            );
          }
      }
    } catch (error) {
      logger.error(`Error handling command: ${error}`);
      if (this.telegramBot) {
        await this.telegramBot.sendMessage(
          `❌ <b>Command failed</b>\n${error}`
        );
      }
    }
  }

  private async handleStatusCommand(): Promise<void> {
    if (this.telegramBot && this.kgBuilder) {
      const status = await this.kgBuilder.getGraphStatus();
      
      let message = `📊 <b>Knowledge Graph Status</b>\n\n`;
      message += `Total Entries: ${status.totalEntries}\n`;
      message += `Total Entities: ${status.totalEntities || 0}\n`;
      message += `File Size: ${(status.fileSize / 1024).toFixed(2)} KB\n`;
      message += `Lines: ${status.lineCount || 0}\n`;
      message += `KG-Gen: ${status.kgGenEnabled ? "✅ Enabled" : "⚠️ Disabled"}\n`;

      await this.telegramBot.sendMessage(message);
    }
  }

  private async handleSummaryCommand(): Promise<void> {
    if (this.telegramBot && this.kgBuilder) {
      const summary = await this.kgBuilder.generateDailySummary();
      
      // Split long messages if needed
      const maxLength = 4000;
      if (summary.length > maxLength) {
        const parts = summary.match(new RegExp(`.{1,${maxLength}}`, "g")) || [];
        for (const part of parts) {
          await this.telegramBot.sendMessage(part);
        }
      } else {
        await this.telegramBot.sendMessage(summary);
      }
    }
  }

  private async handleResetCommand(): Promise<void> {
    if (this.kgBuilder && this.telegramBot) {
      await this.kgBuilder.resetGraph();
      await this.telegramBot.sendMessage("✅ <b>Graph reset successfully</b>");
    }
  }

  private async handleStatsCommand(): Promise<void> {
    if (this.mailListener && this.telegramBot) {
      const stats = this.mailListener.getStats();
      
      let message = `📈 <b>Processing Statistics</b>\n\n`;
      message += `Processed Emails: ${stats.processedCount}\n`;
      
      if (stats.processedCount > 0) {
        message += `\nRecent Message IDs:\n`;
        const recent = stats.processedIds.slice(-5);
        for (const id of recent) {
          message += `  • ${id.substring(0, 30)}...\n`;
        }
      }

      await this.telegramBot.sendMessage(message);
    }
  }

  private async handleFilterCommand(args: string[]): Promise<void> {
    if (!this.telegramBot) return;

    if (args.length === 0) {
      // Show current filters
      const config = this.mailListener ? (this.mailListener as any).filterConfig : null;
      
      let message = `🔍 <b>Current Email Filters</b>\n\n`;
      message += `Max Age: ${config?.maxAgeHours || 24} hours\n`;
      
      if (config?.allowedDomains?.length) {
        message += `Allowed Domains: ${config.allowedDomains.join(", ")}\n`;
      }
      
      if (config?.blockedDomains?.length) {
        message += `Blocked Domains: ${config.blockedDomains.join(", ")}\n`;
      }
      
      if (config?.blockedSenders?.length) {
        message += `Blocked Senders: ${config.blockedSenders.length} configured\n`;
      }

      await this.telegramBot.sendMessage(message);
    } else {
      await this.telegramBot.sendMessage(
        "⚠️ <b>Filter management via commands not yet implemented</b>\n\n" +
          "Please update filters in your .env file and restart the assistant."
      );
    }
  }

  private async handleHelpCommand(): Promise<void> {
    if (!this.telegramBot) return;

    const helpText = `
📚 <b>KG Mail Assistant - Help</b>

<b>Available Commands:</b>

• /status - Show current knowledge graph statistics
• /summary - Generate a daily summary report
• /stats - Show email processing statistics
• /filter - View current email filter configuration
• /reset - Reset the knowledge graph (creates new file)
• /help - Show this help message

<b>Features:</b>

✅ Automatic email processing with smart filtering
✅ Knowledge graph generation from email content
✅ Real-time Telegram notifications
✅ Configurable domain/sender blocklists

<b>Configuration:</b>

Edit your .env file to customize:
• EMAIL_MAX_AGE_HOURS - How far back to process
• EMAIL_BLOCKED_DOMAINS - Domains to skip
• EMAIL_ALLOWED_DOMAINS - Only process these domains
    `.trim();

    await this.telegramBot.sendMessage(helpText);
  }

  async shutdown(): Promise<void> {
    logger.info("Shutting down KG Mail Assistant...");

    if (this.mailListener) {
      await this.mailListener.disconnect();
    }

    if (this.telegramBot) {
      this.telegramBot.stop();
    }

    logger.info("KG Mail Assistant stopped");
  }
}

/**
 * Parse environment variable list (comma-separated)
 */
function parseEnvList(envVar: string | undefined): string[] | undefined {
  if (!envVar) return undefined;
  return envVar.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse regex patterns from environment variable
 */
function parseRegexList(envVar: string | undefined): RegExp[] | undefined {
  if (!envVar) return undefined;
  
  return envVar
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pattern) => {
      try {
        // Handle /pattern/flags format
        const match = pattern.match(/^\/(.+)\/([gimuy]*)$/);
        if (match) {
          return new RegExp(match[1], match[2]);
        }
        // Plain string - make it case-insensitive by default
        return new RegExp(pattern, "i");
      } catch (e) {
        logger.warn(`Invalid regex pattern: ${pattern}`);
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);
}

async function main(): Promise<void> {
  // Build email filter config from environment
  const emailFilter: EmailFilterConfig = {
    maxAgeHours: parseInt(process.env.EMAIL_MAX_AGE_HOURS || "24", 10),
    allowedDomains: parseEnvList(process.env.EMAIL_ALLOWED_DOMAINS),
    blockedDomains: parseEnvList(process.env.EMAIL_BLOCKED_DOMAINS),
    blockedSenders: parseEnvList(process.env.EMAIL_BLOCKED_SENDERS),
    subjectBlocklist: parseRegexList(process.env.EMAIL_SUBJECT_BLOCKLIST),
  };

  const assistantConfig: AssistantConfig = {
    kgGenOptions: {
      input: process.env.KG_GEN_INPUT_DIR || "./data/emails",
      output: process.env.KG_GEN_OUTPUT_DIR || "./data/graphs",
      model: process.env.KG_GEN_MODEL || "gemma3:4b",
      host: process.env.KG_GEN_HOST || "http://localhost:11434",
      filter: ["**/*.txt", "**/*.md", "**/*.html"],
      exclude: ["node_modules/**", "dist/**"],
      chunking: "auto",
      chunkSize: 1024,
      overlapSize: 128,
      retrieval: "enabled",
      retrievalLimit: 5,
      entitySimilarityThreshold: 0.85,
      observationSimilarityThreshold: 0.8,
      enableSimilarityMerging: true,
      logLevel: (process.env.LOG_LEVEL as any) || "info",
      description: "Personal assistant knowledge graph from emails",
      system:
        "You are an intelligent assistant. Extract entities, relationships, and important observations from emails.",
      watch: true,
    },
    imapEnabled: process.env.GOOGLE_CLIENT_ID !== undefined,
    telegramEnabled: process.env.TELEGRAM_BOT_TOKEN !== undefined,
    watchMode: process.env.KG_GEN_WATCH_ENABLED !== "false",
    emailFilter,
  };

  const assistant = new KGMailAssistant(assistantConfig);

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    logger.info("Received SIGINT, shutting down gracefully...");
    await assistant.shutdown();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Received SIGTERM, shutting down gracefully...");
    await assistant.shutdown();
    process.exit(0);
  });

  try {
    await assistant.initialize();
    await assistant.start();
  } catch (error) {
    logger.error(`Fatal error: ${error}`);
    await assistant.shutdown();
    process.exit(1);
  }
}

main();