import { MineScorer, MINE_JUDGE_INSTRUCTION } from './MineScorer';
import { IEmbeddingProvider } from '../../types/IEmbeddingProvider';
import { ILLMProvider, LLMMessage } from '../../types/ILLMProvider';
import { KnowledgeGraph } from '../../types/KnowledgeGraph';

// Bag-of-words "embeddings" over a tiny vocab → deterministic, offline retrieval.
const VOCAB = ['butterfly', 'caterpillar', 'transformation', 'lifespan', 'photosynthesis', 'plant'];
const bow = (t: string): number[] => VOCAB.map((w) => (t.toLowerCase().includes(w) ? 1 : 0));
const fakeEmbeddings: IEmbeddingProvider = {
  embed: async (t) => bow(t),
  embedBatch: async (ts) => ts.map(bow),
  clearCache: () => {},
  getCacheSize: () => 0,
};

const node = (name: string) => ({ name, entityType: 'concept', observations: [], files: [] });
const graph: KnowledgeGraph = {
  entities: ['butterfly', 'caterpillar', 'transformation', 'lifespan', 'weeks'].map(node),
  relations: [
    { from: 'butterfly', to: 'transformation', relationType: ['undergo'] },
    { from: 'caterpillar', to: 'butterfly', relationType: ['becomes'] },
    { from: 'lifespan', to: 'weeks', relationType: ['of'] },
  ],
};

// A faithful mini-judge: 1 iff the context shares a vocab word with the answer
// (i.e. the context contains the information the fact states).
function makeJudge() {
  const calls: LLMMessage[][] = [];
  const judge: ILLMProvider = {
    generateStructured: (async (messages: LLMMessage[]) => {
      calls.push(messages);
      const user = messages.find((m) => m.role === 'user')!.content;
      const [ctx, ans = ''] = user.split('\n\nCorrect answer:\n');
      const ansWords = VOCAB.filter((w) => ans.toLowerCase().includes(w));
      const evaluation = ansWords.some((w) => ctx.toLowerCase().includes(w)) ? 1 : 0;
      return { evaluation };
    }) as ILLMProvider['generateStructured'],
    getModelCapabilities: async () => [],
  };
  return { judge, calls };
}

describe('MineScorer', () => {
  it('retrieves incident triples for the fact and judges with the verbatim prompt', async () => {
    const { judge, calls } = makeJudge();
    const scorer = new MineScorer(fakeEmbeddings, judge);
    const res = await scorer.score('wanshi', graph, ['Butterflies undergo a remarkable transformation.']);

    expect(res.accuracy).toBe(1);
    expect(res.perFact[0].context).toContain('butterfly undergo transformation');
    // The judge's system message preserves MINE's exact criterion (verbatim prefix).
    expect(calls[0][0].role).toBe('system');
    expect(calls[0][0].content).toContain(MINE_JUDGE_INSTRUCTION);
  });

  it('computes accuracy as correct/total across facts', async () => {
    const { judge } = makeJudge();
    const scorer = new MineScorer(fakeEmbeddings, judge);
    const res = await scorer.score('wanshi', graph, [
      'Butterflies undergo a remarkable transformation.', // supported
      'Photosynthesis occurs in every plant.',            // not in the graph
    ]);
    expect(res.correct).toBe(1);
    expect(res.total).toBe(2);
    expect(res.accuracy).toBe(0.5);
  });

  it('scores an empty graph as 0 without ever calling the judge', async () => {
    const { judge, calls } = makeJudge();
    const scorer = new MineScorer(fakeEmbeddings, judge);
    const res = await scorer.score('openie', { entities: [], relations: [] }, ['Any fact at all.']);
    expect(res.accuracy).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('is concurrency-invariant — the bounded pool preserves order + results', async () => {
    const { judge } = makeJudge();
    const facts = [
      'Butterflies undergo a remarkable transformation.', // supported
      'Photosynthesis occurs in every plant.',            // not in the graph
      'Caterpillars become butterflies.',                 // supported
    ];
    const seq = await new MineScorer(fakeEmbeddings, judge, { topK: 15, concurrency: 1 }).score('wanshi', graph, facts);
    const par = await new MineScorer(fakeEmbeddings, judge, { topK: 15, concurrency: 8 }).score('wanshi', graph, facts);
    expect(par.perFact.map((f) => f.fact)).toEqual(facts); // order preserved despite parallelism
    expect(par.perFact.map((f) => f.evaluation)).toEqual(seq.perFact.map((f) => f.evaluation));
    expect(par.accuracy).toBe(seq.accuracy);
  });

  it('treats an embedBatch outage as all-miss, not a thrown run (WS-42)', async () => {
    const failing: IEmbeddingProvider = {
      ...fakeEmbeddings,
      embedBatch: async () => {
        throw new Error('embedding service down');
      },
    };
    const { judge, calls } = makeJudge();
    const res = await new MineScorer(failing, judge).score('wanshi', graph, [
      'Butterflies undergo a remarkable transformation.',
    ]);
    expect(res.accuracy).toBe(0); // graceful miss, like a judge failure — not an abort
    expect(res.total).toBe(1);
    expect(calls).toHaveLength(0); // no usable context ⇒ judge never invoked
  });

  it('treats a per-fact embed failure as a miss, scoring the rest (WS-42)', async () => {
    const flaky: IEmbeddingProvider = {
      ...fakeEmbeddings,
      embed: async (t: string) =>
        t.includes('undergo') ? Promise.reject(new Error('transient')) : bow(t),
    };
    const { judge } = makeJudge();
    const res = await new MineScorer(flaky, judge, { topK: 15, concurrency: 1 }).score('wanshi', graph, [
      'Butterflies undergo a remarkable transformation.', // embed throws ⇒ miss
      'Caterpillars become butterflies.',                 // supported ⇒ 1
    ]);
    expect(res.perFact[0].evaluation).toBe(0);
    expect(res.perFact[1].evaluation).toBe(1);
    expect(res.accuracy).toBe(0.5);
  });

  it('honors topK (fewer retrieved nodes ⇒ smaller context)', async () => {
    const { judge } = makeJudge();
    const wide = new MineScorer(fakeEmbeddings, judge, { topK: 15 });
    const narrow = new MineScorer(fakeEmbeddings, judge, { topK: 1 });
    const fact = ['Butterflies undergo a remarkable transformation.'];
    const w = await wide.score('wanshi', graph, fact);
    const n = await narrow.score('wanshi', graph, fact);
    expect(w.perFact[0].context.length).toBeGreaterThanOrEqual(n.perFact[0].context.length);
  });
});
