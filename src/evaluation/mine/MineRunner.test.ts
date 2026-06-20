import { relatedToShare } from './MineRunner';
import { KnowledgeGraph } from '../../types/KnowledgeGraph';

const rel = (from: string, to: string, ...types: string[]) => ({ from, to, relationType: types });

describe('relatedToShare (vocab-fit guardrail)', () => {
  it('is 0 for a graph with no relations', () => {
    expect(relatedToShare({ entities: [], relations: [] })).toBe(0);
  });

  it('is the fraction of relations that are wholly related_to', () => {
    const g: KnowledgeGraph = {
      entities: [],
      relations: [
        rel('a', 'b', 'related_to'),
        rel('c', 'd', 'related_to'),
        rel('e', 'f', 'causes'), // a real predicate
        rel('g', 'h', 'feeds_on'),
      ],
    };
    expect(relatedToShare(g)).toBe(0.5); // 2 of 4
  });

  it('counts a relation only if EVERY predicate is related_to', () => {
    const g: KnowledgeGraph = {
      entities: [],
      relations: [rel('a', 'b', 'related_to', 'causes')], // mixed → not catch-all
    };
    expect(relatedToShare(g)).toBe(0);
  });
});
