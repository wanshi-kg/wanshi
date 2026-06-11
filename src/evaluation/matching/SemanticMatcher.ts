import { cosineSimilarity } from '../../shared';
import { IEmbeddingProvider } from '../../types/IEmbeddingProvider';
import { ExactMatcher } from './ExactMatcher';
import { Triplet } from '../datasets/IDataset';

export class SemanticMatcher {
  private exactMatcher = new ExactMatcher();
  private embeddingCache: Map<string, number[]> = new Map();

  // Depends only on the provider interface (embed/embedBatch), so the metrics
  // command can pass whichever provider the container built (Ollama | OpenAI).
  constructor(
    private embeddingService: IEmbeddingProvider,
    private threshold: number = 0.80
  ) {}

  /**
   * Pre-warm the embedding cache for a batch of strings.
   * Call this before running matchTriplets on many samples to batch
   * the embedding calls efficiently.
   */
  async warmCache(strings: string[]): Promise<void> {
    const unique = Array.from(new Set(strings)).filter(s => !this.embeddingCache.has(s));
    if (unique.length === 0) return;
    const embeddings = await this.embeddingService.embedBatch(unique);
    for (let i = 0; i < unique.length; i++) {
      this.embeddingCache.set(unique[i], embeddings[i]);
    }
  }

  async matchTriplets(extracted: Triplet[], groundTruth: Triplet[]): Promise<{
    tp: number; fp: number; fn: number;
  }> {
    // Warm cache for all strings — subjects, predicates, and objects
    const allStrings = [
      ...extracted.flatMap(t => [t.subject, t.predicate, t.object]),
      ...groundTruth.flatMap(t => [t.subject, t.predicate, t.object]),
    ];
    await this.warmCache(allStrings);

    let tp = 0;
    const matchedGT = new Set<number>();

    for (const ex of extracted) {
      const idx = await this.findMatch(ex, groundTruth, matchedGT);
      if (idx !== -1) {
        tp++;
        matchedGT.add(idx);
      }
    }

    return { tp, fp: extracted.length - tp, fn: groundTruth.length - tp };
  }

  async matchEntities(extracted: Triplet[], groundTruth: Triplet[]): Promise<{
    tp: number; fp: number; fn: number;
  }> {
    const exEntities = this.uniqueEntities(extracted);
    const gtEntities = this.uniqueEntities(groundTruth);
    await this.warmCache([...exEntities, ...gtEntities]);

    let tp = 0;
    const matchedGT = new Set<number>();

    for (const ex of exEntities) {
      const idx = gtEntities.findIndex((gt, i) => {
        if (matchedGT.has(i)) return false;
        return this.stringSimilar(ex, gt);
      });
      if (idx !== -1) {
        tp++;
        matchedGT.add(idx);
      }
    }

    return { tp, fp: exEntities.length - tp, fn: gtEntities.length - tp };
  }

  /**
   * Semantically match predicate sets. Uses embedding similarity rather than
   * exact string matching — critical when the extractor uses free-form labels
   * (e.g. "defeated") while ground truth uses a fixed taxonomy ("win-defeat").
   */
  async matchRelations(extracted: Triplet[], groundTruth: Triplet[]): Promise<{
    tp: number; fp: number; fn: number;
  }> {
    const exPreds = extracted.map(t => t.predicate);
    const gtPreds = groundTruth.map(t => t.predicate);
    await this.warmCache([...exPreds, ...gtPreds]);

    let tp = 0;
    const matchedGT = new Set<number>();

    for (const ex of exPreds) {
      const idx = gtPreds.findIndex((gt, i) => {
        if (matchedGT.has(i)) return false;
        return this.stringSimilar(ex, gt);
      });
      if (idx !== -1) {
        tp++;
        matchedGT.add(idx);
      }
    }

    return { tp, fp: exPreds.length - tp, fn: gtPreds.length - tp };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async findMatch(ex: Triplet, groundTruth: Triplet[], matchedGT: Set<number>): Promise<number> {
    for (let i = 0; i < groundTruth.length; i++) {
      if (matchedGT.has(i)) continue;
      const gt = groundTruth[i];

      // All three components: semantic similarity
      if (
        this.stringSimilar(ex.subject,   gt.subject)   &&
        this.stringSimilar(ex.predicate, gt.predicate) &&
        this.stringSimilar(ex.object,    gt.object)
      ) {
        return i;
      }
    }
    return -1;
  }

  private stringSimilar(a: string, b: string): boolean {
    const aVec = this.embeddingCache.get(a);
    const bVec = this.embeddingCache.get(b);
    if (!aVec || !bVec) {
      // Fall back to exact match if embeddings not available
      return this.exactMatcher.normalize(a) === this.exactMatcher.normalize(b);
    }
    return cosineSimilarity(aVec, bVec) >= this.threshold;
  }

  private uniqueEntities(triplets: Triplet[]): string[] {
    const set = new Set<string>();
    for (const t of triplets) {
      set.add(t.subject);
      set.add(t.object);
    }
    return Array.from(set);
  }
}
