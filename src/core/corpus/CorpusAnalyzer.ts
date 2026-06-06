import * as crypto from "crypto";
import { z } from "zod";
import {
  ClassificationResult,
  CorpusGlossary,
  CorpusProfile,
  ICorpusAnalyzer,
  ILLMProvider,
  LLMMessage,
  ProcessingOptions,
  TermCount,
} from "../../types";
import { Logger, shutdown } from "../../shared";
import { FileReaderFactory } from "../processor/readers";
import { IContentClassifier } from "../processor/classifier/IContentTypeClassifier";
import { countTerms } from "./termFrequency";
import { CorpusProfileStore } from "./CorpusProfileStore";
import { toRelPathId } from "./relPath";

/** Per-file text read for the pre-pass is capped to bound frequency + classifier cost. */
const PER_FILE_CHAR_CAP = 16_000;

const GlossarySchema = z.object({
  entityNames: z.array(z.string()).describe("Canonical entity names recurring in this corpus"),
  entityTypes: z.array(z.string()).describe("Entity type categories appropriate to this corpus"),
  relationTypes: z.array(z.string()).describe("Relation type names appropriate to this corpus"),
});

/**
 * Corpus analysis pre-pass: read + classify each file (char-capped), count term
 * frequency, then make ONE LLM call to propose a corpus-specific glossary
 * (canonical entity names / types / relation types). Cached to a sidecar and
 * reused on re-run when the corpus + model are unchanged.
 */
export class CorpusAnalyzer implements ICorpusAnalyzer {
  constructor(
    private readonly llm: ILLMProvider,
    private readonly classifier: IContentClassifier | undefined,
    private readonly readerFactory: FileReaderFactory,
    private readonly logger: Logger
  ) {}

  async analyzeOrLoad(
    files: string[],
    options: ProcessingOptions
  ): Promise<CorpusProfile> {
    const inputRoot = options.input ?? "";
    const topN = Number(options.corpusTopTerms) || 100;
    const profilePath =
      options.corpusProfilePath || `${options.output}.corpus-profile.json`;
    const store = new CorpusProfileStore(profilePath, this.logger);
    const key = this.computeKey(files, inputRoot, options, topN);

    const cached = await store.load();
    if (cached && cached.key === key) {
      this.logger.info(
        `Reusing cached corpus profile (${cached.glossary.entityNames.length} names) from ${profilePath}`
      );
      return cached;
    }
    if (cached) {
      this.logger.info(
        `Corpus profile at ${profilePath} is stale (corpus/model changed); rebuilding`
      );
    }
    if (options.corpusClustering) {
      this.logger.info(
        "corpusClustering is not implemented yet (deferred to a follow-up); ignoring the flag"
      );
    }

    // 1. Read (char-capped) + classify each file. The classifier call here is the
    //    expensive bit we cache; FileProcessor reuses perFileClasses downstream.
    const texts: string[] = [];
    const perFileClasses: Record<string, ClassificationResult[]> = {};
    for (const file of files) {
      if (shutdown.isRequested()) {
        this.logger.warn("Interrupted during corpus pre-pass; profiling partial corpus");
        break;
      }
      const text = await this.readCapped(file);
      if (!text) continue;
      texts.push(text);
      if (this.classifier) {
        try {
          perFileClasses[toRelPathId(inputRoot, file)] =
            await this.classifier.classify(text, file);
        } catch (error) {
          this.logger.warn(`Corpus pre-pass could not classify ${file}: ${error}`);
        }
      }
    }

    // 2. Frequency + corpus-level class aggregate.
    const topTerms = countTerms(texts, { topN });
    const corpusClasses = aggregateClasses(Object.values(perFileClasses));

    // 3. One LLM call → glossary.
    const glossary = await this.generateGlossary(corpusClasses, topTerms, texts);

    const profile: CorpusProfile = {
      generatedAt: new Date().toISOString(),
      key,
      fileCount: files.length,
      corpusClasses,
      perFileClasses,
      topTerms,
      glossary,
    };
    await store.save(profile);
    this.logger.info(
      `Corpus profile built: ${topTerms.length} top terms, glossary ` +
        `${glossary.entityNames.length} names / ${glossary.entityTypes.length} types / ` +
        `${glossary.relationTypes.length} relations → ${profilePath}`
    );
    return profile;
  }

  /** Read a file via its reader and concatenate chunk text, capped. Non-fatal. */
  private async readCapped(file: string): Promise<string> {
    try {
      const reader = this.readerFactory.getReader(file);
      if (!reader) return "";
      const res = await reader.read(file);
      return (res.chunks ?? [])
        .map((c) => c.content)
        .join("\n")
        .slice(0, PER_FILE_CHAR_CAP);
    } catch (error) {
      this.logger.warn(`Corpus pre-pass could not read ${file}: ${error}`);
      return "";
    }
  }

  /** Validity key: sorted relpaths + model + topN + classifier mode. */
  private computeKey(
    files: string[],
    inputRoot: string,
    options: ProcessingOptions,
    topN: number
  ): string {
    const rels = files.map((f) => toRelPathId(inputRoot, f)).sort();
    const hash = crypto.createHash("sha1");
    hash.update(
      `${options.model} ${topN} ${options.classifier} ${rels.length}\n${rels.join("\n")}`
    );
    return hash.digest("hex");
  }

  private async generateGlossary(
    corpusClasses: ClassificationResult[],
    topTerms: TermCount[],
    texts: string[]
  ): Promise<CorpusGlossary> {
    const classLine =
      corpusClasses.length > 0
        ? corpusClasses
            .slice(0, 2)
            .map((c) => `${c.class} (${c.confidence.toFixed(2)})`)
            .join(", ")
        : "unknown";
    const termList = topTerms
      .map((t) => `${t.term} (${t.count})`)
      .join(", ");
    const snippets = texts
      .slice(0, 3)
      .map((t, i) => `--- sample ${i + 1} ---\n${t.slice(0, 600)}`)
      .join("\n\n");

    const system =
      "You design a controlled vocabulary (glossary) for knowledge-graph extraction " +
      "over a document corpus. Given the dominant content type and the most frequent " +
      "terms, propose: (1) canonical ENTITY NAMES — the real recurring proper nouns / " +
      "key concepts, each normalized to ONE canonical spelling so extraction stays " +
      "consistent; (2) ENTITY TYPES appropriate to this corpus; (3) RELATION TYPES " +
      "appropriate to this corpus. Prefer terms that actually appear. Be concise — a " +
      "few dozen names at most. Return JSON only.";
    const user =
      `Corpus content type: ${classLine}\n\n` +
      `Most frequent terms (with counts):\n${termList}\n\n` +
      `Representative snippets:\n${snippets}`;

    const messages: LLMMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];

    try {
      const result = await this.llm.generateStructured(messages, GlossarySchema);
      return {
        entityNames: dedupe(result.entityNames),
        entityTypes: dedupe(result.entityTypes),
        relationTypes: dedupe(result.relationTypes),
      };
    } catch (error) {
      this.logger.error(`Corpus glossary generation failed (continuing without it): ${error}`);
      return { entityNames: [], entityTypes: [], relationTypes: [] };
    }
  }
}

/** Average per-class confidence across files, sorted descending. */
function aggregateClasses(
  perFile: ClassificationResult[][]
): ClassificationResult[] {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const classes of perFile) {
    for (const c of classes) {
      const e = sums.get(c.class) ?? { sum: 0, n: 0 };
      e.sum += c.confidence;
      e.n += 1;
      sums.set(c.class, e);
    }
  }
  return Array.from(sums.entries())
    .map(([cls, { sum, n }]) => ({ class: cls, confidence: sum / n } as ClassificationResult))
    .sort((a, b) => b.confidence - a.confidence);
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}
