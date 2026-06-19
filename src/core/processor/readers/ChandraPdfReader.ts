import { FileReader, FileReadResult } from "./FileReader";
import path from "path";
import fs from "fs/promises";
import { spawn, SpawnOptions } from "child_process";
import { Logger } from "../../../shared";
import { TextChunker } from "../chunking";

/** Chandra OCR engine knobs (from `readers.chandra`). */
export interface ChandraOptions {
  command: string;
  method: "hf" | "vllm";
  timeoutMs: number;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * PDF reader backed by Datalab's **Chandra** OCR CLI — the slow-local SOTA /
 * handwriting rung of the engine ladder (4B VLM; complex tables, forms,
 * handwriting, full layout). A sibling of `MarkerPdfReader` (same Datalab
 * lineage Surya→Marker→Chandra), so it follows the same shape: spawn the CLI,
 * read the markdown it writes, and **chunk it via the shared chunker** (Chandra
 * can emit a long document, so unlike Marker's single blob we size-chunk it).
 * Claims `.pdf` only.
 *
 * Chandra is slow (a 4B VLM; minutes on CPU/MPS) so a `<pdf>.chandra.md` sidecar
 * is reused when newer than the source. Any failure — missing CLI, non-zero
 * exit, timeout, empty output — **degrades to the injected pdf2json fallback** so
 * a run never dies on one PDF and the default path stays portable.
 *
 * CLI (datalab `chandra-ocr`, `pip install chandra-ocr`): `chandra <in> <outDir>
 * --method hf`. The `vllm` backend uses a different launcher (`chandra_vllm`) and
 * is a GPU-server deployment detail — confirm its exact invocation at live
 * validation; here `command`/`method` are configurable and any mismatch simply
 * degrades to pdf2json.
 */
export class ChandraPdfReader extends FileReader {
  constructor(
    private readonly opts: ChandraOptions,
    private readonly fallback: FileReader,
    private readonly tempDir: string,
    chunker: TextChunker,
    logger: Logger
  ) {
    super([".pdf"], chunker, logger);
    this.ensureTempDir();
  }

  getName(): string {
    return "ChandraPdfReader";
  }

  adapterId(): string {
    return "pdf:chandra";
  }

  async read(filePath: string): Promise<FileReadResult> {
    await this.validateFile(filePath);
    try {
      const startTime = Date.now();
      const { markdown, cached } = await this.toMarkdown(filePath);
      const content = markdown.trim();
      if (!content) throw new Error("chandra produced empty markdown");

      // Chandra can emit a long document → size-chunk it (Marker returns one blob;
      // FileProcessor does not re-chunk, so chunking here keeps prompts bounded).
      const parts = await this.chunker.chunk(content);
      const stats = await fs.stat(filePath);
      return {
        chunks: parts.map((p) => ({ ...p })),
        metadata: {
          type: "pdf",
          fileName: filePath,
          fileSize: stats.size,
          pdfEngine: "chandra",
          chandraMethod: this.opts.method,
          chandraCached: cached,
          contentLength: content.length,
          processingTimeMs: Date.now() - startTime,
          status: "success",
        },
      };
    } catch (error: any) {
      this.logger.warn(
        `Chandra OCR engine failed for ${filePath} (${error.message}); falling back to pdf2json`
      );
      return this.fallback.read(filePath);
    }
  }

  /** Run chandra (or reuse the sidecar) and return its markdown. Throws on failure. */
  private async toMarkdown(filePath: string): Promise<{ markdown: string; cached: boolean }> {
    const sidecar = `${filePath}.chandra.md`;
    if (await this.sidecarIsFresh(sidecar, filePath)) {
      this.logger.debug(`Reusing chandra sidecar: ${sidecar}`);
      return { markdown: await fs.readFile(sidecar, "utf-8"), cached: true };
    }

    const outDir = path.resolve(
      path.join(this.tempDir, `chandra_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`)
    );
    await fs.mkdir(outDir, { recursive: true });
    try {
      const args = [path.resolve(filePath), outDir, "--method", this.opts.method];
      this.logger.info(`Chandra: ${this.opts.command} ${args.join(" ")}`);
      const result = await this.executeCommand(this.opts.command, args);
      if (result.code !== 0) {
        throw new Error(`chandra exited ${result.code}${result.stderr ? `: ${result.stderr.trim().slice(-400)}` : ""}`);
      }

      const produced = await this.findMarkdown(outDir);
      if (!produced) throw new Error(`chandra produced no .md under ${outDir}`);
      const markdown = await fs.readFile(produced, "utf-8");
      await fs.writeFile(sidecar, markdown, "utf-8");
      return { markdown, cached: false };
    } finally {
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** First `.md` found under `dir` (chandra writes `<dir>/<stem>/<stem>.md`). */
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

  /** Spawn chandra with captured output + timeout (MarkerPdfReader pattern). */
  private async executeCommand(command: string, args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const options: SpawnOptions = {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      };
      const child = spawn(command, args, options);
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`chandra timed out after ${this.opts.timeoutMs}ms`));
      }, this.opts.timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`failed to launch chandra (${command}): ${error.message}`));
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
