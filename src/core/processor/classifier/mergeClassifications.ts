import { ClassificationResult, ContentClass } from "../../../types";

/**
 * Merge per-chunk classification results into one prevalence-weighted ranking.
 *
 * Each class's confidence is summed across the chunks it appears in, then divided
 * by the **total** number of chunks — chunks where a class is absent contribute 0.
 * So a class present in every chunk outranks a single high-confidence spike, which
 * matches "what domain is this whole document".
 *
 * This replaces the earlier pairwise-reduce that averaged over *present* chunks
 * only (`sum / resultsByClass.length`): there a class in 1/10 chunks @0.9 beat a
 * class in 10/10 @0.8, letting one off-topic chunk hijack the file's domain.
 */
export function mergeChunkClassifications(
  perChunk: ClassificationResult[][]
): ClassificationResult[] {
  const totalChunks = perChunk.length;
  if (totalChunks === 0) return [];

  const sums = new Map<ContentClass, number>();
  for (const chunkResults of perChunk) {
    for (const { class: cls, confidence } of chunkResults) {
      sums.set(cls, (sums.get(cls) ?? 0) + confidence);
    }
  }

  return Array.from(sums, ([cls, sum]) => ({
    class: cls,
    confidence: sum / totalChunks,
  })).sort((a, b) => b.confidence - a.confidence);
}
