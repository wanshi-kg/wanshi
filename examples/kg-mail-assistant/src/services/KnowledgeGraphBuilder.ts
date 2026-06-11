import type { Email } from "./MailListener";
import * as fs from "fs";
import * as path from "path";

/**
 * KnowledgeGraphBuilder service
 * Integrates with kg-gen to build and manage the knowledge graph
 */
export class KnowledgeGraphBuilder {
  private options: Record<string, any>;
  private graphData: Map<string, any> = new Map();
  private isInitialized: boolean = false;
  private outputDir: string;
  private currentGraphFile: string = "";
  private directoryProcessor: any = null;
  private emailInputDir: string;
  private processingOptions: Record<string, any> | null = null;

  constructor(options: Record<string, any>) {
    this.options = {
      ...options,
      exportFormat: "jsonl", // Force JSONL format for less verbosity
    };
    this.outputDir = options.output || "./data/graphs";
    this.emailInputDir = "./data/emails";
  }

  async initialize(): Promise<void> {
    console.log("[KG] Initializing Knowledge Graph Builder with kg-gen...");
    console.log(`[KG] Output directory: ${this.outputDir}`);
    console.log(`[KG] Email input directory: ${this.emailInputDir}`);
    console.log(`[KG] Model: ${this.options.model}`);
    console.log(`[KG] Export format: ${this.options.exportFormat}`);

    // Create output directory if it doesn't exist
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
      console.log(`[KG] Created output directory: ${this.outputDir}`);
    }

    // Create email input directory if it doesn't exist
    if (!fs.existsSync(this.emailInputDir)) {
      fs.mkdirSync(this.emailInputDir, { recursive: true });
      console.log(`[KG] Created email input directory: ${this.emailInputDir}`);
    }

    // Initialize graph file
    const timestamp = new Date().toISOString().split("T")[0];
    this.currentGraphFile = path.join(
      this.outputDir,
      `graph-${timestamp}.jsonl`
    );

    try {
      // Setup kg-gen container with processing options
      this.processingOptions = {
        input: this.emailInputDir,
        output: this.currentGraphFile,
        filter: ["**/*.txt", "**/*.md"],
        exclude: ["node_modules/**", "dist/**"],
        description: "Email content for knowledge graph extraction",
        model: this.options.model || "gemma3:4b",
        contextLength: 12000,
        embeddingsModel: "mxbai-embed-large:335m",
        chunking: "enabled",
        chunkSize: 2000,
        overlapSize: 100,
        asr: "disabled",
        docling: false,
        images: "disabled",
        retrieval: "enabled",
        retrievalLimit: 3,
        enableSimilarityMerging: true,
        entitySimilarityThreshold: 0.9,
        observationSimilarityThreshold: 0.7,
        exportFormat: "json",
        dotOptions: {
          layout: "neato",
          rankdir: "LR",
          colorScheme: "scientific",
          includeObservations: true,
          maxObservationsPerNode: 10,
          clusterByEntityType: true,
          clusterByFile: true,
          showLegend: true,
        },
        classifier: this.options.classifier || "heuristic",
        logLevel: this.options.logLevel || "info",
        debug: this.options.debug || false,
        silent: this.options.silent !== false,
      };

      // Dynamically load kg-gen components
      const ContainerFactory = require("kg-gen/src/core/di/ContainerFactory")
        .ContainerFactory;
      const TYPES = require("kg-gen/src/core/di/index").TYPES;

      const container = ContainerFactory.createContainer({
        processingOptions: this.processingOptions,
      });

      this.directoryProcessor = await container.resolve(TYPES.DirectoryProcessor);
      console.log("[KG] kg-gen initialized successfully");
    } catch (error) {
      console.error(`[KG] Failed to initialize kg-gen: ${error}`);
      console.warn("[KG] Will use fallback JSONL-only mode");
      this.directoryProcessor = null;
    }

    this.isInitialized = true;
  }

  async processEmail(email: Email): Promise<void> {
    if (!this.isInitialized) {
      throw new Error("KnowledgeGraphBuilder not initialized");
    }

    console.log(
      `[KG] Processing email from ${email.from}: "${email.subject}"`
    );

    try {
      // Step 1: Save email to temporary text file for kg-gen processing
      const emailFileName = `email-${Date.now()}.txt`;
      const emailFilePath = path.join(this.emailInputDir, emailFileName);

      const emailContent = this.formatEmailForProcessing(email);
      fs.writeFileSync(emailFilePath, emailContent);
      console.log(`[KG] Saved email to file: ${emailFileName}`);
      console.log(`[KG] Content length: ${emailContent.length} chars`);

      // Step 2: Process with kg-gen if available
      let kgGenResult: any = null;
      if (this.directoryProcessor) {
        try {
          console.log(`[KG] Starting kg-gen processing...`);
          kgGenResult = await this.directoryProcessor.processFiles(
            [emailFilePath],
            this.processingOptions
          );
          
          console.log(
            `[KG] ✅ kg-gen processed email, extracted entities: ${
              kgGenResult?.entities?.length || 0
            }`
          );
          
          if (kgGenResult?.metadata?.classes) {
            console.log(
              `[KG] Content classes: ${JSON.stringify(
                kgGenResult.metadata.classes
              )}`
            );
          }
        } catch (error) {
          console.warn(`[KG] ⚠️  kg-gen processing failed: ${error}`);
          console.warn(`[KG] Using fallback metadata extraction`);
        }
      }

      // Step 3: Build graph entry combining email metadata and kg-gen results
      const graphEntry = this.buildGraphEntry(email, kgGenResult);

      // Step 4: Save to JSONL
      this.saveGraphEntry(graphEntry);

      // Step 5: Optional cleanup - keep files for debugging by default
      if (process.env.KG_CLEANUP_EMAILS === "true") {
        try {
          fs.unlinkSync(emailFilePath);
          console.log(`[KG] Cleaned up temporary file: ${emailFileName}`);
        } catch (e) {
          console.warn(`[KG] Failed to cleanup ${emailFileName}: ${e}`);
        }
      }
    } catch (error) {
      console.error(`[KG] Error processing email: ${error}`);
      throw error; // Propagate error for better debugging
    }
  }

  /**
   * Format email for processing - clean text extraction
   */
  private formatEmailForProcessing(email: Email): string {
    // Email text is already cleaned by html-to-text in MailListener
    // Just do some final cleanup
    const cleanText = email.text
      .replace(/\s+/g, " ") // Normalize whitespace
      .replace(/\n{3,}/g, "\n\n") // Max 2 consecutive newlines
      .replace(/(http[s]?:\/\/\S+)/g, s => s.substring(0, 30)) // Remove URLs
      .trim();

    // Build structured email content
    const metadata = [
      `Subject: ${email.subject}`,
      `From: ${email.from}`,
      `Date: ${email.date.toISOString()}`,
      `Message-ID: ${email.messageId || "N/A"}`,
      `---`,
    ].join("\n");

    return `${metadata}\n${cleanText}`;
  }

  /**
   * Build graph entry from email and kg-gen results
   */
  private buildGraphEntry(email: Email, kgGenResult: any): Record<string, any> {
    const senderName = email.from.split("<")[0].trim();
    const senderEmail = email.from.match(/<([^>]+)>/)?.[1] || email.from;

    // Extract entities from kg-gen if available
    const entities: any[] = [];
    const relationships: any[] = [];

    // Use kg-gen results if available
    if (kgGenResult?.entities) {
      entities.push(...kgGenResult.entities);
    }

    // Use kg-gen relationships if available
    if (kgGenResult?.relations) {
      relationships.push(...kgGenResult.relations);
    }

    // Always add basic email-specific entities
    entities.push(
      {
        type: "Person",
        value: senderName,
        metadata: { email: senderEmail },
      },
      {
        type: "EmailSubject",
        value: email.subject,
      }
    );

    // Extract simple keywords from subject for additional entities
    const subjectKeywords = this.extractKeywords(email.subject);
    for (const keyword of subjectKeywords) {
      entities.push({
        type: "Keyword",
        value: keyword,
      });
    }

    return {
      type: "email",
      timestamp: new Date().toISOString(),
      source: {
        type: "gmail",
        from: email.from,
        subject: email.subject,
        date: email.date.toISOString(),
        messageId: email.messageId,
      },
      entities,
      relationships,
      observations: [
        {
          type: "EmailReceived",
          content: `Email received from ${senderName} with subject: "${email.subject}"`,
          timestamp: email.date.toISOString(),
        },
      ],
      metadata: {
        contentClasses: kgGenResult?.metadata?.classes || [],
        kgGenProcessed: !!kgGenResult,
        textLength: email.text.length,
        hasHtml: !!email.html,
      },
    };
  }

  /**
   * Extract meaningful keywords from text (simple implementation)
   */
  private extractKeywords(text: string): string[] {
    // Remove common words and extract potential keywords
    const stopWords = new Set([
      "the",
      "a",
      "an",
      "and",
      "or",
      "but",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "with",
      "by",
      "from",
      "as",
      "is",
      "was",
      "are",
      "were",
      "been",
      "be",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "should",
      "could",
      "may",
      "might",
      "must",
      "can",
      "this",
      "that",
      "these",
      "those",
      "i",
      "you",
      "he",
      "she",
      "it",
      "we",
      "they",
      "re",
      "fwd",
    ]);

    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopWords.has(w));

    // Return unique keywords (limit to top 10)
    return [...new Set(words)].slice(0, 10);
  }

  /**
   * Save graph entry to JSONL file
   */
  private saveGraphEntry(graphEntry: Record<string, any>): void {
    try {
      fs.appendFileSync(
        this.currentGraphFile,
        JSON.stringify(graphEntry) + "\n"
      );
      console.log(
        `[KG] ✅ Saved graph entry to ${path.basename(this.currentGraphFile)}`
      );
    } catch (error) {
      console.error(`[KG] ❌ Error writing to graph file: ${error}`);
      console.error(`[KG] Current file: ${this.currentGraphFile}`);
      console.error(`[KG] Directory exists: ${fs.existsSync(this.outputDir)}`);
      throw error;
    }

    // Store in memory as well
    const key = `${graphEntry.source.from}_${graphEntry.timestamp}`;
    this.graphData.set(key, graphEntry);
  }

  async getGraphStatus(): Promise<Record<string, any>> {
    const stats: Record<string, any> = {
      totalEntries: this.graphData.size,
      graphFile: this.currentGraphFile,
      fileExists: fs.existsSync(this.currentGraphFile),
      fileSize: this.currentGraphFile && fs.existsSync(this.currentGraphFile)
        ? fs.statSync(this.currentGraphFile).size
        : 0,
      lastUpdated: new Date(),
      exportFormat: this.options.exportFormat,
      kgGenEnabled: !!this.directoryProcessor,
    };

    if (stats.fileExists) {
      const content = fs
        .readFileSync(this.currentGraphFile, "utf-8")
        .split("\n")
        .filter((l) => l.trim());
      stats.lineCount = content.length;

      // Analyze entries for statistics
      let totalEntities = 0;
      let entityTypes: Record<string, number> = {};
      let contentClasses: Record<string, number> = {};

      for (const line of content) {
        try {
          const entry = JSON.parse(line);
          totalEntities += entry.entities?.length || 0;

          for (const entity of entry.entities || []) {
            const type = entity.type || "Unknown";
            entityTypes[type] = (entityTypes[type] || 0) + 1;
          }

          for (const contentClass of entry.metadata?.contentClasses || []) {
            contentClasses[contentClass] =
              (contentClasses[contentClass] || 0) + 1;
          }
        } catch (e) {
          // Skip invalid JSON lines
        }
      }

      stats.totalEntities = totalEntities;
      stats.entityTypes = entityTypes;
      stats.contentClasses = contentClasses;
    }

    return stats;
  }

  async generateDailySummary(): Promise<string> {
    const status = await this.getGraphStatus();

    let summary =
      `📊 Daily Knowledge Graph Summary\n` +
      `Date: ${new Date().toDateString()}\n` +
      `Total Emails: ${status.totalEntries}\n` +
      `Total Entities: ${status.totalEntities || 0}\n` +
      `Graph File: ${path.basename(status.graphFile)}\n` +
      `File Size: ${(status.fileSize / 1024).toFixed(2)} KB\n` +
      `Lines: ${status.lineCount || 0}\n` +
      `Format: ${status.exportFormat}\n` +
      `KG-Gen Processing: ${status.kgGenEnabled ? "✅ Enabled" : "⚠️ Disabled"}\n`;

    if (status.entityTypes && Object.keys(status.entityTypes).length > 0) {
      summary += `\n📋 Entity Types:\n`;
      const sortedTypes = Object.entries(status.entityTypes).sort(
        ([, a], [, b]) => (b as number) - (a as number)
      );
      for (const [type, count] of sortedTypes) {
        summary += `  • ${type}: ${count}\n`;
      }
    }

    if (status.contentClasses && Object.keys(status.contentClasses).length > 0) {
      summary += `\n📂 Content Classes (from kg-gen):\n`;
      const sortedClasses = Object.entries(status.contentClasses).sort(
        ([, a], [, b]) => (b as number) - (a as number)
      );
      for (const [contentClass, count] of sortedClasses) {
        summary += `  • ${contentClass}: ${count}\n`;
      }
    }

    return summary;
  }

  async resetGraph(): Promise<void> {
    console.log("[KG] Resetting knowledge graph...");
    this.graphData.clear();

    // Don't delete the file, just create a new one
    const timestamp = new Date().toISOString().split("T")[0];
    this.currentGraphFile = path.join(
      this.outputDir,
      `graph-${timestamp}-reset-${Date.now()}.jsonl`
    );
    console.log(
      `[KG] Graph reset, new file: ${path.basename(this.currentGraphFile)}`
    );
  }

  getOutputDir(): string {
    return this.outputDir;
  }

  getCurrentGraphFile(): string {
    return this.currentGraphFile;
  }

  getGraphData(): Map<string, any> {
    return this.graphData;
  }
}