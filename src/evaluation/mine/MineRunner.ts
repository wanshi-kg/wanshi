import { KnowledgeGraphBuilder } from '../../core/knowledge/KnowledgeGraphBuilder';
import { PromptManager } from '../../core/llm/prompts/PromptManager';
import { Logger } from '../../shared';
import { ProcessedFile } from '../../types';
import { KnowledgeGraph } from '../../types/KnowledgeGraph';
import { MineScorer } from './MineScorer';
import {
  MINE_PUBLISHED,
  MineArticleResult,
  MineGraphScore,
  MineResult,
  MineSample,
  MineTool,
} from './types';

export interface MineRunnerOptions {
  model: string;
  judgeModel: string;
  /** Re-score the stored KGGen/GraphRAG/OpenIE graphs with the same retrieve+judge
   *  (the apples-to-apples four-way table). Off ⇒ wanshi-only. */
  rescoreBaselines: boolean;
}

const BASELINE_TOOLS: Exclude<MineTool, 'wanshi'>[] = ['kggen', 'graphrag', 'openie'];

/**
 * Runs the MINE benchmark four ways: extracts wanshi's KG per article and scores
 * it, then re-scores the three stored baseline graphs with the SAME MineScorer, so
 * every tool faces one identical retrieve+judge. Aggregates mean accuracy per tool.
 */
export class MineRunner {
  constructor(
    private readonly kgBuilder: KnowledgeGraphBuilder,
    private readonly promptManager: PromptManager,
    private readonly scorer: MineScorer,
    private readonly logger: Logger
  ) {}

  async run(samples: MineSample[], opts: MineRunnerOptions): Promise<MineResult> {
    const start = Date.now();
    const systemPrompt = await this.promptManager.getSystemPrompt('mine', '**/*.txt', 'MINE benchmark');
    const perArticle: MineArticleResult[] = [];

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      this.logger.info(`[${i + 1}/${samples.length}] MINE article ${s.id} (${s.topic}) — ${s.facts.length} facts`);

      const wanshiKg = await this.extract(s, systemPrompt);
      const scores: Partial<Record<MineTool, MineGraphScore>> = {
        wanshi: await this.scorer.score('wanshi', wanshiKg, s.facts),
      };

      if (opts.rescoreBaselines) {
        for (const tool of BASELINE_TOOLS) {
          const g = s.baselines[tool];
          if (g) scores[tool] = await this.scorer.score(tool, g, s.facts);
        }
      }

      this.logger.info(
        `    ${(Object.keys(scores) as MineTool[])
          .map((t) => `${t}=${(scores[t]!.accuracy * 100).toFixed(1)}%`)
          .join('  ')}`
      );
      perArticle.push({ id: s.id, topic: s.topic, scores });
    }

    return {
      model: opts.model,
      judgeModel: opts.judgeModel,
      sampleCount: samples.length,
      byTool: this.aggregate(perArticle),
      published: MINE_PUBLISHED,
      perArticle,
      durationMs: Date.now() - start,
    };
  }

  private async extract(s: MineSample, systemPrompt: string): Promise<KnowledgeGraph> {
    try {
      const processedFile: ProcessedFile = {
        path: `mine/${s.id}.txt`,
        chunks: [
          { content: s.text, index: 1, totalChunks: 1, startOffset: 0, endOffset: s.text.length },
        ],
        metadata: {},
      };
      const graphs = await this.kgBuilder.build(processedFile, systemPrompt);
      return graphs.length > 0 ? graphs[0] : { entities: [], relations: [] };
    } catch (err) {
      this.logger.warn(`MINE article ${s.id} extraction failed: ${err}`);
      return { entities: [], relations: [] };
    }
  }

  /** Mean accuracy per tool across all articles that produced a score for it. */
  private aggregate(perArticle: MineArticleResult[]): Partial<Record<MineTool, number>> {
    const sum: Partial<Record<MineTool, { s: number; n: number }>> = {};
    for (const a of perArticle) {
      for (const tool of Object.keys(a.scores) as MineTool[]) {
        const acc = sum[tool] ?? { s: 0, n: 0 };
        acc.s += a.scores[tool]!.accuracy;
        acc.n += 1;
        sum[tool] = acc;
      }
    }
    const out: Partial<Record<MineTool, number>> = {};
    for (const tool of Object.keys(sum) as MineTool[]) {
      const { s, n } = sum[tool]!;
      out[tool] = n > 0 ? s / n : 0;
    }
    return out;
  }
}
