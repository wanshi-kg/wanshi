import { kgToTriplets, nodeTriplets } from './compareScoring';
import { MineDataset } from '../mine/MineDataset';
import { ExactMatcher } from '../matching/ExactMatcher';
import { computeExactMetrics } from '../metrics/TripleMetrics';
import { KnowledgeGraph } from '../../types/KnowledgeGraph';
import { Triplet } from '../datasets/IDataset';

describe('CrossRE compare scoring', () => {
  describe('kgToTriplets', () => {
    it('flattens relations, one triplet per relationType label', () => {
      const kg: KnowledgeGraph = {
        entities: [],
        relations: [
          { from: 'caterpillar', to: 'butterfly', relationType: ['becomes'] },
          { from: 'a', to: 'b', relationType: ['x', 'y'] }, // multi-label -> 2 triplets
        ],
      };
      expect(kgToTriplets(kg)).toEqual([
        { subject: 'caterpillar', predicate: 'becomes', object: 'butterfly' },
        { subject: 'a', predicate: 'x', object: 'b' },
        { subject: 'a', predicate: 'y', object: 'b' },
      ]);
    });

    it('returns [] for an empty graph', () => {
      expect(kgToTriplets({ entities: [], relations: [] })).toEqual([]);
    });

    it('falls back to "related to" for an empty relationType (symmetry with KGGen)', () => {
      const kg: KnowledgeGraph = {
        entities: [],
        relations: [{ from: 'Phil Simmons', to: 'Leicestershire', relationType: [] }],
      };
      expect(kgToTriplets(kg)).toEqual([
        { subject: 'Phil Simmons', predicate: 'related to', object: 'Leicestershire' },
      ]);
    });
  });

  describe('nodeTriplets (entity-capture over the full node set)', () => {
    it('turns every node into a self-triplet so matchEntities sees all nodes', () => {
      const kg: KnowledgeGraph = {
        // node present but NOT in any relation — must still count for entity-capture
        entities: [
          { name: 'Somerset', entityType: 'org', observations: [], files: [] },
          { name: 'Phil Simmons', entityType: 'person', observations: [], files: [] },
        ],
        relations: [],
      };
      const nodes = nodeTriplets(kg);
      expect(nodes.map((t) => t.subject)).toEqual(['Somerset', 'Phil Simmons']);
      // ExactMatcher.matchEntities recovers both as the entity set
      const { entity } = computeExactMetrics(
        nodes,
        [{ subject: 'Somerset', predicate: 'x', object: 'Phil Simmons' }],
        new ExactMatcher()
      );
      expect(entity.tp).toBe(2);
    });
  });

  describe('KGGen-raw → KnowledgeGraph (MineDataset.toGraph) → triplets', () => {
    it('maps the {entities, edges, relations} shape KGGen emits, so it scores like wanshi', () => {
      // The exact on-disk shape scripts/kggen-crossre.py writes.
      const raw = {
        entities: ['Alan Turing', 'computer science'],
        edges: ['founded'],
        relations: [['Alan Turing', 'founded', 'computer science']],
      };
      const kg = MineDataset.toGraph(raw);
      expect(kg.entities.map((e) => e.name).sort()).toEqual(['Alan Turing', 'computer science']);

      const triplets = kgToTriplets(kg);
      expect(triplets).toEqual([
        { subject: 'Alan Turing', predicate: 'founded', object: 'computer science' },
      ]);
    });

    it('drops malformed relation tuples without throwing', () => {
      const kg = MineDataset.toGraph({ entities: ['x'], edges: [], relations: [['only', 'two'] as any] });
      expect(kgToTriplets(kg)).toEqual([]); // <3 elements -> skipped
    });
  });

  describe('entity-level F1 (the fair cross-tool headline)', () => {
    it('computes exact entity P/R/F1 over subjects ∪ objects, ignoring predicates', () => {
      // Gold entities: {turing, computer science, enigma} (3 unique).
      const gold: Triplet[] = [
        { subject: 'turing', predicate: 'founded', object: 'computer science' },
        { subject: 'turing', predicate: 'broke', object: 'enigma' },
      ];
      // Extracted finds turing + computer science (2 right) and one wrong entity.
      const extracted: Triplet[] = [
        { subject: 'turing', predicate: 'created', object: 'computer science' },
        { subject: 'turing', predicate: 'likes', object: 'tea' },
      ];
      const { entity } = computeExactMetrics(extracted, gold, new ExactMatcher());
      // extracted entity set {turing, computer science, tea}; gold {turing, computer science, enigma}
      expect(entity.tp).toBe(2); // turing, computer science
      expect(entity.fp).toBe(1); // tea
      expect(entity.fn).toBe(1); // enigma
      expect(entity.precision).toBeCloseTo(2 / 3, 5);
      expect(entity.recall).toBeCloseTo(2 / 3, 5);
      expect(entity.f1).toBeCloseTo(2 / 3, 5);
    });
  });
});
