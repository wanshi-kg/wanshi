import { computeGraphHealth } from "./GraphHealthMetrics";
import { KnowledgeGraph } from "../types/KnowledgeGraph";

function entity(name: string, entityType: string): KnowledgeGraph["entities"][number] {
  return { name, entityType, files: [], observations: [] };
}

describe("computeGraphHealth", () => {
  it("counts planted topology problems exactly", () => {
    const graph: KnowledgeGraph = {
      entities: [
        entity("a", "thing"),
        entity("b", "thing"),
        entity("c", "widget"),
      ],
      relations: [
        { from: "a", to: "a", relationType: ["loops_to"] },          // self-loop
        { from: "a", to: "b", relationType: ["uses"] },              // A→B
        { from: "b", to: "a", relationType: ["used_by"] },           // B→A  → bidirectional pair {a,b}
        { from: "a", to: "b", relationType: ["uses"] },              // parallel of a→b:uses
        { from: "a", to: "ghost", relationType: ["needs"] },         // dangling (ghost not an entity)
      ],
    };

    const m = computeGraphHealth(graph);

    expect(m.entityCount).toBe(3);
    expect(m.relationCount).toBe(5);
    expect(m.entityTypeCount).toBe(2); // thing, widget
    expect(m.relationTypeCount).toBe(4); // loops_to, uses, used_by, needs
    expect(m.selfLoopCount).toBe(1);
    expect(m.bidirectionalContradictionCount).toBe(1); // the {a,b} pair, counted once
    expect(m.danglingEndpointCount).toBe(1); // a→ghost
    expect(m.parallelEdgeCount).toBe(1); // the duplicate a→b:uses
    expect(m.referentialIntegrity).toBeCloseTo(1 - 1 / 5, 5);
  });

  it("normalizes predicate order/case when detecting parallel edges", () => {
    const graph: KnowledgeGraph = {
      entities: [entity("x", "t"), entity("y", "t")],
      relations: [
        { from: "x", to: "y", relationType: ["Calls", "uses"] },
        { from: "x", to: "y", relationType: ["uses", "calls"] }, // same set, reversed + recased
      ],
    };
    expect(computeGraphHealth(graph).parallelEdgeCount).toBe(1);
  });

  it("is clean on an empty graph", () => {
    const m = computeGraphHealth({ entities: [], relations: [] });
    expect(m.selfLoopCount).toBe(0);
    expect(m.bidirectionalContradictionCount).toBe(0);
    expect(m.referentialIntegrity).toBe(1);
  });
});
