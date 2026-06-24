import { z } from 'zod';
import { KnowledgeGraph } from '../../types/KnowledgeGraph';
import { IEmbeddingProvider } from '../../types/IEmbeddingProvider';
import { ILLMProvider, LLMMessage } from '../../types/ILLMProvider';
import { cosineSimilarity } from '../../shared/utils/cosineSimilarity';
import { MineFactResult, MineGraphScore, MineTool } from './types';

/**
 * MINE scorer — replicates kg-gen `experiments/MINE/_1_evaluation.py` so it can be
 * applied IDENTICALLY to any KnowledgeGraph (wanshi's fresh extraction and the
 * three stored baselines), which is the apples-to-apples requirement of the
 * comparison. For each atomic fact: embed graph nodes, take the top-k nearest to
 * the fact, gather their incident triples (serialized "from predicate to") as the
 * retrieved context, then ask the judge whether that context contains the fact.
 */

// Verbatim instruction from MINE's DSPy `EvaluateResponse` signature.
export const MINE_JUDGE_INSTRUCTION =
  'Determine whether the context contains the information stated in the correct answer. Respond with 1 if yes, 0 if no.';

// The verbatim criterion + a firm output directive. Without it, smaller judges
// (gemma3:4b) intermittently EXPLAIN their answer (prose), which fails the schema →
// retries → some land as a wrong 0, biasing scores low and unequally across the
// graphs being compared. The directive (DSPy adds the equivalent internally) drives
// a clean bare digit; the tolerant schema accepts it (or the object form).
const JUDGE_SYSTEM = `${MINE_JUDGE_INSTRUCTION} Respond with ONLY the digit 1 or 0 — no explanation, no other text.`;

// Output {evaluation: 0|1}. Tolerant of a BARE number/string too: gemma3:4b honors
// the verbatim "respond with 1" prompt with a bare `1` under Ollama's soft format
// constraint, so we coerce that into {evaluation:1} instead of 3x-retrying then
// dropping it — which zeroed every score AND took 27min on the first dev run.
// zod-to-json-schema emits the inner object schema, so capable judges still get an
// object format constraint and comply directly. We threshold ≥0.5 ⇒ 1.
const JudgeSchema = z.preprocess(
  (v) => (typeof v === 'number' || typeof v === 'string' ? { evaluation: v } : v),
  z.object({ evaluation: z.coerce.number() })
);

export interface MineScorerOptions {
  /** Entities retrieved per fact; their incident triples form the context.
   *  Mirrors kg-gen's node-embedding retrieve (default tuned to its context size). */
  topK: number;
  /** Facts judged concurrently. The judge is ~15 LLM calls/graph and the bottleneck;
   *  the calls are independent so a bounded pool is a pure ~10× speedup (same results).
   *  The provider already retries 429s, so a modest pool is safe against rate limits. */
  concurrency?: number;
}

export class MineScorer {
  constructor(
    private readonly embeddings: IEmbeddingProvider,
    private readonly judge: ILLMProvider,
    private readonly opts: MineScorerOptions = { topK: 15 }
  ) {}

  async score(tool: MineTool, graph: KnowledgeGraph, facts: string[]): Promise<MineGraphScore> {
    const nodes = graph.entities.map((e) => e.name).filter((n): n is string => !!n);
    let nodeEmb: number[][] = [];
    try {
      nodeEmb = nodes.length ? await this.embeddings.embedBatch(nodes) : [];
    } catch {
      nodeEmb = []; // WS-42: an embedding outage is a miss for every fact, never a thrown run (mirrors judgeFact's catch)
    }
    // Only retrieve when every node embedded; a partial/empty result ⇒ context '' ⇒ miss.
    const usable = nodeEmb.length === nodes.length ? nodes : [];
    const incident = this.buildIncident(graph);

    // Judge facts through a bounded-concurrency pool (order preserved by index).
    const perFact: MineFactResult[] = new Array(facts.length);
    const limit = Math.max(1, Math.min(this.opts.concurrency ?? 8, facts.length || 1));
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let i = next++; i < facts.length; i = next++) {
        const fact = facts[i];
        const context = usable.length ? await this.retrieve(fact, usable, nodeEmb, incident) : '';
        const evaluation = context ? await this.judgeFact(context, fact) : 0;
        perFact[i] = { fact, context, evaluation };
      }
    };
    await Promise.all(Array.from({ length: limit }, () => worker()));

    const correct = perFact.reduce((s, r) => s + r.evaluation, 0);
    const total = facts.length;
    return { tool, accuracy: total ? correct / total : 0, correct, total, perFact };
  }

  /** node → its incident triples serialized as "from predicate to". */
  private buildIncident(graph: KnowledgeGraph): Map<string, string[]> {
    const m = new Map<string, string[]>();
    const add = (node: string, s: string) => {
      const arr = m.get(node);
      if (arr) arr.push(s);
      else m.set(node, [s]);
    };
    for (const r of graph.relations) {
      const pred = r.relationType?.[0] ?? 'related to';
      const serialized = `${r.from} ${pred} ${r.to}`;
      add(r.from, serialized);
      add(r.to, serialized);
    }
    return m;
  }

  private async retrieve(
    fact: string,
    nodes: string[],
    nodeEmb: number[][],
    incident: Map<string, string[]>
  ): Promise<string> {
    let q: number[];
    try {
      q = await this.embeddings.embed(fact);
    } catch {
      return ''; // WS-42: a per-fact embedding failure is a miss, not an aborted run
    }
    const ranked = nodes
      .map((name, i) => ({ name, sim: cosineSimilarity(q, nodeEmb[i]) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, this.opts.topK);

    const seen = new Set<string>();
    const parts: string[] = [];
    for (const { name } of ranked) {
      for (const s of incident.get(name) ?? []) {
        if (!seen.has(s)) {
          seen.add(s);
          parts.push(s);
        }
      }
    }
    return parts.join('. ');
  }

  private async judgeFact(context: string, fact: string): Promise<0 | 1> {
    const messages: LLMMessage[] = [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: `Context:\n${context}\n\nCorrect answer:\n${fact}` },
    ];
    try {
      // Cast: the preprocess schema's INPUT is `unknown` (it accepts bare numbers),
      // but its OUTPUT is exactly {evaluation:number}, which is what we read.
      const out = await this.judge.generateStructured<{ evaluation: number }>(
        messages,
        JudgeSchema as unknown as z.ZodType<{ evaluation: number }>
      );
      return out.evaluation >= 0.5 ? 1 : 0;
    } catch {
      return 0; // a judge failure is a miss, never a thrown run
    }
  }
}
