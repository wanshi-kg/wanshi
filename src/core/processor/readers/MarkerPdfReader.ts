import { FileReader, FileReadResult } from "./FileReader";
import path from "path";
import fs from "fs/promises";
import { spawn, SpawnOptions } from "child_process";
import { Logger } from "../../../shared";
import { TextChunker } from "../chunking";

/** marker-pdf engine knobs (from `readers.marker`). */
export interface MarkerOptions {
  command: string;
  useLlm: boolean;
  forceOcr: boolean;
  timeoutMs: number;
}

/** openai-compatible LLM config reused for marker's `--use_llm` mode. */
export interface MarkerLlmConfig {
  apiKey?: string;
  host?: string;
  model?: string;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * PDF reader backed by marker-pdf's `marker_single` CLI (datalab). Spawns the CLI
 * (DoclingReader pattern), reads the markdown it produces, and returns it as a
 * single content chunk (FileProcessor chunks it downstream). Claims `.pdf` only.
 *
 * marker is slow (~1GB models, minutes on CPU) so a `<pdf>.marker.md` sidecar is
 * reused when newer than the source. Any failure — missing CLI, non-zero exit,
 * timeout — **degrades to the injected pdf2json fallback** so a run never dies on
 * a single PDF and the default path stays portable.
 */
export class MarkerPdfReader extends FileReader {
  constructor(
    private readonly opts: MarkerOptions,
    private readonly llm: MarkerLlmConfig | undefined,
    private readonly fallback: FileReader,
    private readonly tempDir: string,
    chunker: TextChunker,
    logger: Logger
  ) {
    super([".pdf"], chunker, logger);
    this.ensureTempDir();
  }

  getName(): string {
    return "MarkerPdfReader";
  }

  adapterId(): string {
    return "pdf:marker";
  }

  async read(filePath: string): Promise<FileReadResult> {
    await this.validateFile(filePath);
    try {
      const startTime = Date.now();
      const { markdown, cached } = await this.toMarkdown(filePath);
      const content = markdown.trim();
      if (!content) throw new Error("marker produced empty markdown");
      const stats = await fs.stat(filePath);
      return {
        chunks: [
          { content, startOffset: 0, endOffset: content.length, index: 1, totalChunks: 1 },
        ],
        metadata: {
          type: "pdf",
          fileName: filePath,
          fileSize: stats.size,
          pdfEngine: "marker",
          markerUseLlm: this.opts.useLlm,
          markerCached: cached,
          contentLength: content.length,
          processingTimeMs: Date.now() - startTime,
          status: "success",
        },
      };
    } catch (error: any) {
      this.logger.warn(
        `Marker PDF engine failed for ${filePath} (${error.message}); falling back to pdf2json`
      );
      // Stamp the fallback's adapterId so per-engine provenance reflects what
      // actually produced the text (pdf2json), not this engine (WS-11).
      const fallbackResult = await this.fallback.read(filePath);
      const fallbackAdapter = this.fallback.adapterId();
      return {
        ...fallbackResult,
        chunks: fallbackResult.chunks.map((c) => ({
          ...c,
          provenance: { ...c.provenance, sourceAdapter: fallbackAdapter },
        })),
      };
    }
  }

  /** Run marker (or reuse the sidecar) and return its markdown. Throws on failure. */
  private async toMarkdown(filePath: string): Promise<{ markdown: string; cached: boolean }> {
    const sidecar = `${filePath}.marker.md`;
    if (await this.sidecarIsFresh(sidecar, filePath)) {
      this.logger.debug(`Reusing marker sidecar: ${sidecar}`);
      return { markdown: await fs.readFile(sidecar, "utf-8"), cached: true };
    }

    const outDir = path.resolve(
      path.join(this.tempDir, `marker_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`)
    );
    await fs.mkdir(outDir, { recursive: true });
    try {
      const args = [
        path.resolve(filePath),
        "--output_dir", outDir,
        "--output_format", "markdown",
      ];
      if (this.opts.forceOcr) args.push("--force_ocr");
      if (this.opts.useLlm) {
        args.push("--use_llm", "--llm_service", "marker.services.openai.OpenAIService");
      }

      this.logger.info(`Marker: ${this.opts.command} ${args.join(" ")}`);
      const result = await this.executeCommand(this.opts.command, args);
      if (result.code !== 0) {
        throw new Error(`marker_single exited ${result.code}${result.stderr ? `: ${result.stderr.trim().slice(-400)}` : ""}`);
      }

      const produced = await this.findMarkdown(outDir);
      if (!produced) throw new Error(`marker produced no .md under ${outDir}`);
      const markdown = await fs.readFile(produced, "utf-8");
      await fs.writeFile(sidecar, markdown, "utf-8");
      return { markdown, cached: false };
    } finally {
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** First `.md` found under `dir` (marker writes `<dir>/<stem>/<stem>.md`). */
  private async findMarkdown(dir: string): Promise<string | undefined> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const nested = await this.findMarkdown(full);
        if (nested) return nested;
      } else if (e.name.toLowerCase().endsWith(".md")) {
        return full;
      }
    }
    return undefined;
  }

  private async sidecarIsFresh(sidecar: string, filePath: string): Promise<boolean> {
    try {
      const [s, a] = await Promise.all([fs.stat(sidecar), fs.stat(filePath)]);
      return s.mtimeMs >= a.mtimeMs;
    } catch {
      return false;
    }
  }

  /** Spawn marker with captured output + timeout (DoclingReader pattern). The
   *  openai-compatible LLM config is threaded as env for `--use_llm`. */
  private async executeCommand(command: string, args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: "1" };
      if (this.opts.useLlm && this.llm) {
        if (this.llm.apiKey) env.OPENAI_API_KEY = this.llm.apiKey;
        if (this.llm.host) env.OPENAI_BASE_URL = this.llm.host;
        if (this.llm.model) env.OPENAI_MODEL = this.llm.model;
      }
      const options: SpawnOptions = { stdio: ["ignore", "pipe", "pipe"], env };
      const child = spawn(command, args, options);
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`marker timed out after ${this.opts.timeoutMs}ms`));
      }, this.opts.timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`failed to launch marker (${command}): ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 0, stdout, stderr });
      });
    });
  }

  private async ensureTempDir(): Promise<void> {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      this.logger.warn(`Could not create temp directory ${this.tempDir}: ${error}`);
    }
  }
}
