import { normalizeGlossary } from "./normalizeGlossary";

describe("normalizeGlossary (KG-06)", () => {
  it("snake_cases types, collapses case/space variants, drops has_*, caps lists", () => {
    const raw = {
      entityNames: ["Bayes Theorem", "bayes theorem", "  ", "Markov Chain"],
      entityTypes: [
        "Concept", // case-fragmented vs the lowercase form below
        "concept",
        "Programming Language", // spaced + cased
        "File System Object",
        "part of", // spaced → part_of (collapses with base downstream)
      ],
      relationTypes: [
        "is a", // spaced
        "part of", // spaced, dup of base
        "has format", // banned has_* family
        "has length",
        "has_total_chunks",
        "depends_on",
        "depends-on", // hyphen variant → dup of depends_on
      ],
    };

    const g = normalizeGlossary(raw);

    // Names: trimmed, case-insensitive dedupe, original casing preserved.
    expect(g.entityNames).toEqual(["Bayes Theorem", "Markov Chain"]);

    // Types: lowercase snake_case, no case-fragmented pairs, no spaces.
    expect(g.entityTypes).toEqual([
      "concept",
      "programming_language",
      "file_system_object",
      "part_of",
    ]);
    expect(g.entityTypes).not.toContain("Concept");

    // Predicates: spaced → snake, has_* family dropped entirely, hyphen variant
    // collapses with depends_on.
    expect(g.relationTypes).toEqual(["is_a", "part_of", "depends_on"]);
    expect(g.relationTypes.some((r) => r.startsWith("has_"))).toBe(false);
    // no two entries differ only by case or separators
    const lowered = g.relationTypes.map((r) => r.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length);
  });

  it("caps entity types at 20 and relation types at 15", () => {
    const many = (n: number, p: string) =>
      Array.from({ length: n }, (_, i) => `${p}_${i}`);
    const g = normalizeGlossary({
      entityNames: [],
      entityTypes: many(29, "etype"),
      relationTypes: many(40, "rel"),
    });
    expect(g.entityTypes).toHaveLength(20);
    expect(g.relationTypes).toHaveLength(15);
  });

  it("respects custom caps", () => {
    const g = normalizeGlossary(
      {
        entityNames: [],
        entityTypes: ["a", "b", "c"],
        relationTypes: ["x", "y", "z"],
      },
      { entityCap: 2, relationCap: 1 }
    );
    expect(g.entityTypes).toEqual(["a", "b"]);
    expect(g.relationTypes).toEqual(["x"]);
  });
});
