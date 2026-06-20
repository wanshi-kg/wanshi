import { KnowledgeGraph } from '../../types/KnowledgeGraph';

/** The four extractors compared on MINE. `wanshi` is freshly extracted; the other
 *  three are re-scored from the graphs stored in the MINE mirror. */
export type MineTool = 'wanshi' | 'kggen' | 'graphrag' | 'openie';

/** One MINE article: text + its ~15 atomic facts (each fact is BOTH the retrieval
 *  query and the statement the judge verifies) + the stored baseline graphs. */
export interface MineSample {
  id: string;
  topic: string;
  text: string;
  facts: string[];
  baselines: Partial<Record<Exclude<MineTool, 'wanshi'>, KnowledgeGraph>>;
}

export interface MineFactResult {
  fact: string;
  context: string;
  evaluation: 0 | 1;
}

export interface MineGraphScore {
  tool: MineTool;
  accuracy: number; // correct / total
  correct: number;
  total: number;
  perFact: MineFactResult[];
}

export interface MineArticleResult {
  id: string;
  topic: string;
  scores: Partial<Record<MineTool, MineGraphScore>>;
  /** The freshly-extracted wanshi graph, persisted so vocab/topology can be
   *  diagnosed post-hoc (Bug 1 was found this way — from serialized contexts). */
  wanshiGraph?: KnowledgeGraph;
  /** Fraction of wanshi relations that are the generic `related_to` catch-all — the
   *  vocab-fit guardrail. High share = closed vocab coercing real predicates away. */
  relatedToShare?: number;
}

export interface MineResult {
  model: string; // wanshi generation model
  judgeModel: string;
  sampleCount: number;
  byTool: Partial<Record<MineTool, number>>; // mean accuracy across articles
  published: Record<Exclude<MineTool, 'wanshi'>, number>; // paper headline (reference)
  perArticle: MineArticleResult[];
  durationMs: number;
  /** Mean wanshi `related_to` share across articles (logged as a guardrail line). */
  relatedToShare?: number;
}

/** KGGen paper headline accuracies on MINE (their judge + retrieval). A labelled
 *  reference row only — our re-scored numbers use one identical retrieve+judge over
 *  all four graphs, so they may differ from these and shouldn't be conflated. */
export const MINE_PUBLISHED: Record<Exclude<MineTool, 'wanshi'>, number> = {
  kggen: 0.66,
  graphrag: 0.48,
  openie: 0.30,
};

export interface MineBaselineGraphRaw {
  entities?: string[];
  edges?: string[];
  relations?: string[][];
}
