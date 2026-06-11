import { EventEmitter } from "events";
// @ts-ignore
import BotAPI from "node-telegram-bot-api";

/**
 * Telegram bot service for user interactions
 * Sends notifications and receives commands from users
 */
export class TelegramBot extends EventEmitter {
  private botToken: string;
  private userId: string;
  private bot: any = null;
  private isRunning: boolean = false;

  constructor() {
    super();
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || "";
    this.userId = process.env.TELEGRAM_USER_ID || "";

    if (!this.botToken || !this.userId) {
      throw new Error(
        "TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID must be set in environment"
      );
    }
  }

  start(): void {
    try {
      // Initialize telegram bot
      this.bot = new BotAPI(this.botToken, { polling: true });

      console.log("[TELEGRAM] Bot started with polling");
      this.isRunning = true;

      // Handle incoming messages
      this.bot.on("message", (msg: any) => {
        this.handleMessage(msg);
      });

      // Handle command errors
      this.bot.on("polling_error", (error: any) => {
        console.error(`[TELEGRAM] Polling error: ${error}`);
      });
    } catch (error) {
      console.error(`[TELEGRAM] Failed to start bot: ${error}`);
      throw error;
    }
  }

  stop(): void {
    if (this.bot) {
      try {
        this.bot.stopPolling();
        console.log("[TELEGRAM] Bot stopped");
      } catch (error) {
        console.error(`[TELEGRAM] Error stopping bot: ${error}`);
      }
    }

    this.isRunning = false;
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.isRunning || !this.bot) {
      console.warn("[TELEGRAM] Bot is not running, cannot send message");
      return;
    }

    try {
      await this.bot.sendMessage(this.userId, message, {
        parse_mode: "HTML",
      });
      console.log(`[TELEGRAM] Message sent to ${this.userId}`);
    } catch (error) {
      console.error(`[TELEGRAM] Failed to send message: ${error}`);
    }
  }

  private handleMessage(msg: any): void {
    // Only process messages from the configured user
    if (msg.from.id.toString() !== this.userId) {
      console.log(
        `[TELEGRAM] Ignoring message from unauthorized user ${msg.from.id}`
      );
      return;
    }

    const text = msg.text || "";

    // Parse commands
    if (text.startsWith("/")) {
      const parts = text.split(/\s+/);
      const command = parts[0].slice(1); // Remove leading /
      const args = parts.slice(1);

      console.log(`[TELEGRAM] Command received: /${command} ${args.join(" ")}`);
      this.emit("command", command, args);
    } else {
      console.log(`[TELEGRAM] Message: ${text}`);
    }
  }
}
