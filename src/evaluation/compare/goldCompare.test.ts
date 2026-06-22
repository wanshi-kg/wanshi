import { scoreGraph, tripleKey } from './goldCompare';
import { ExactMatcher } from '../matching/ExactMatcher';
import { SemanticMatcher } from '../matching/SemanticMatcher';
import { IEmbeddingProvider } from '../../types/IEmbeddingProvider';
import { KnowledgeGraph } from '../../types/KnowledgeGraph';
import { Triplet } from '../datasets/IDataset';

// Deterministic offline embedding: each distinct string → a unique one-hot basis
// vector, so identical strings give cosine 1.0 and different strings cosine 0.0.
// (Semantic == exact for the controlled tokens here — keeps the test network-free.)
function fakeEmbeddings(): IEmbeddingProvider {
  const idx = new Map<string, number>();
  const D = 256;
  const vec = (s: string): number[] => {
    const key = s.trim().toLowerCase();
    if (!idx.has(key)) idx.set(key, idx.size % D);
    const v = new Array(D).fill(0);
    v[idx.get(key)!] = 1;
    return v;
  };
  return {
    embed: async (t: string) => vec(t),
    embedBatch: async (ts: string[]) => ts.map(vec),
    clearCache: () => { /* no-op */ },
    getCacheSize: () => idx.size,
  };
}

const rel = (from: string, to: string, t: string[]) => ({ from, to, relationType: t });
const ent = (name: string) => ({ name, entityType: 'x', observations: [], files: [] });

describe('goldCompare.scoreGraph', () => {
  let exact: ExactMatcher;
  let semantic: SemanticMatcher;
  beforeEach(() => {
    exact = new ExactMatcher();
    semantic = new SemanticMatcher(fakeEmbeddings(), 0.8);
  });

  it('tripleKey normalizes (trim + lowercase + pipe-join)', () => {
    expect(tripleKey({ subject: ' Turing ', predicate: 'Founded', object: 'CS' })).toBe('turing|founded|cs');
  });

  it('omits perDomainNode and ignTriplet when neither option is given', async () => {
    const kg: KnowledgeGraph = { entities: [ent('turing'), ent('cs')], relations: [rel('turing', 'cs', ['founded'])] };
    const gold: Triplet[] = [{ subject: 'turing', predicate: 'founded', object: 'cs' }];
    const sc = await scoreGraph(['s1'], new Map([['s1', kg]]), new Map([['s1', gold]]), exact, semantic);
    expect(sc.perDomainNode).toBeUndefined();
    expect(sc.ignTripletSem).toBeUndefined();
    expect(sc.nodeEntitySem.f1).toBeCloseTo(1, 5); // both gold entities recovered
    expect(sc.triplesPer).toBeCloseTo(1, 5);
    expect(sc.entsPer).toBeCloseTo(2, 5);
  });

  it('populates perDomainNode when domainById is provided', async () => {
    const kgA: KnowledgeGraph = { entities: [ent('a1')], relations: [] };
    const kgB: KnowledgeGraph = { entities: [ent('b1')], relations: [] };
    const sc = await scoreGraph(
      ['a', 'b'],
      new Map([['a', kgA], ['b', kgB]]),
      new Map<string, Triplet[]>([
        ['a', [{ subject: 'a1', predicate: 'p', object: 'a1' }]],
        ['b', [{ subject: 'b1', predicate: 'p', object: 'b1' }]],
      ]),
      exact, semantic,
      { domainById: new Map([['a', 'ai'], ['b', 'news']]) },
    );
    expect(sc.perDomainNode).toBeDefined();
    expect(sc.perDomainNode!.get('ai')!.f1).toBeCloseTo(1, 5);
    expect(sc.perDomainNode!.get('news')!.f1).toBeCloseTo(1, 5);
  });

  it('Ign-F1 excludes train-seen triples → a memorized fact earns no Ign credit', async () => {
    // gold = one train-seen triple + one novel triple.
    const seen: Triplet = { subject: 'turing', predicate: 'founded', object: 'cs' };
    const novel: Triplet = { subject: 'turing', predicate: 'broke', object: 'enigma' };
    const gold = [seen, novel];
    const ignoreKeys = new Set([tripleKey(seen)]);

    // Tool finds ONLY the memorized (train-seen) triple, misses the novel one.
    const kg: KnowledgeGraph = {
      entities: [ent('turing'), ent('cs')],
      relations: [rel('turing', 'cs', ['founded'])],
    };
    const sc = await scoreGraph(['s1'], new Map([['s1', kg]]), new Map([['s1', gold]]), exact, semantic, { ignoreKeys });

    // Regular triple F1 rewards the (memorized) hit: tp=1, fn=1 → 2/3.
    expect(sc.tripletExact.triple.f1).toBeCloseTo(2 / 3, 5);
    // Ign-F1 drops the train-seen triple from both sides → tp=0, fn=1 (novel) → 0.
    expect(sc.ignTripletExact!.triple.f1).toBeCloseTo(0, 5);
  });
});
