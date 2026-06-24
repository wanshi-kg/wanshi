import { KeywordGroundingChecker } from "./KeywordGroundingChecker";
import { MiniCheckGroundingChecker, MiniCheckClient } from "./MiniCheckGroundingChecker";
import { splitSentences, verbalizeRelation } from "./verbalize";
import { stubLogger } from "../../../__tests__/helpers";

describe("grounding/verbalize", () => {
  it("splits multi-sentence claims and keeps a terminator-less claim whole", () => {
    expect(splitSentences("The cache is local. It batches by ten!")).toEqual([
      "The cache is local.",
      "It batches by ten!",
    ]);
    expect(splitSentences("a single fragment with no terminator")).toEqual([
      "a single fragment with no terminator",
    ]);
  });

  it("verbalizes a relation triple, turning a snake_case predicate into words", () => {
    expect(verbalizeRelation("EmbeddingService", ["part_of"], "wanshi")).toBe(
      "EmbeddingService part of wanshi"
    );
    expect(verbalizeRelation("a", [], "b")).toBe("a related to b");
  });
});

describe("KeywordGroundingChecker", () => {
  it("supports a claim whose words appear in the source, rejects one that doesn't", async () => {
    const c = new KeywordGroundingChecker(0.5);
    const src = "the embedding service batches requests in groups of ten";
    expect((await c.check("embedding service batches requests", src)).supported).toBe(true);
    expect((await c.check("quantum teleportation hyperdrive manifold", src)).supported).toBe(false);
  });
});

/**
 * A fake MiniCheck standing in for the real NLI model: paraphrase-tolerant —
 * it supports a sentence iff at least one content word (>3 chars) overlaps the
 * document. Unlike strict keyword overlap it doesn't require *all* words, so it
 * can support claims the keyword gate's threshold would reject.
 */
function fakeClient(): MiniCheckClient {
  return {
    async generate({ prompt }) {
      const [docLine, claimLine] = prompt.split("\nClaim: ");
      const doc = docLine.replace(/^Document: /, "").toLowerCase();
      const words = (claimLine ?? "")
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.replace(/[^a-z0-9_]/g, ""))
        .filter((w) => w.length > 3);
      const ok = words.some((w) => doc.includes(w));
      return { response: ok ? "Yes" : "No" };
    },
  };
}

const opts = { model: "bespoke-minicheck:7b", min: 0.5, escalateAbove: 0.8 };

describe("MiniCheckGroundingChecker", () => {
  it("supports a paraphrased claim the keyword gate would reject (escalates to NLI)", async () => {
    const source = "The cosine similarity helper compares two vectors.";
    const claim = "vectors comparison utility"; // paraphrase: low verbatim overlap
    // Keyword overlap alone rejects it (only "vectors" of 3 content words hits) ...
    expect((await new KeywordGroundingChecker(0.5).check(claim, source)).supported).toBe(false);
    // ... but the score (0.33) is below escalateAbove, so MiniCheck decides — and supports it.
    const mc = new MiniCheckGroundingChecker(opts, stubLogger(), fakeClient());
    const v = await mc.check(claim, source);
    expect(v.checker).toBe("minicheck");
    expect(v.supported).toBe(true);
  });

  it("rejects a hallucinated claim via the NLI path", async () => {
    const mc = new MiniCheckGroundingChecker(opts, stubLogger(), fakeClient());
    const v = await mc.check(
      "quantum bitcoin mining rig",
      "the cosine similarity helper compares two vectors"
    );
    expect(v.checker).toBe("minicheck");
    expect(v.supported).toBe(false);
  });

  it("requires every sentence of a multi-sentence claim to be supported", async () => {
    const mc = new MiniCheckGroundingChecker(opts, stubLogger(), fakeClient());
    const source = "alpha beta gamma delta epsilon zeta";
    // First sentence overlaps the source, second doesn't → unsupported, score 0.5.
    const v = await mc.check("alpha beta gamma. omega kappa lambda.", source);
    expect(v.supported).toBe(false);
    expect(v.score).toBeCloseTo(0.5, 5);
  });

  it("pre-filter: high keyword overlap short-circuits without an NLI call", async () => {
    let nliCalls = 0;
    const counting: MiniCheckClient = {
      async generate() {
        nliCalls++;
        return { response: "No" };
      },
    };
    const mc = new MiniCheckGroundingChecker(opts, stubLogger(), counting);
    const source = "embedding service batches requests in groups of ten";
    const v = await mc.check("embedding service batches requests", source);
    expect(v.checker).toBe("keyword");
    expect(v.supported).toBe(true);
    expect(nliCalls).toBe(0);
  });

  it("falls back to keyword overlap when the NLI call throws (never crashes the run)", async () => {
    const throwing: MiniCheckClient = {
      async generate() {
        throw new Error("ollama down");
      },
    };
    const mc = new MiniCheckGroundingChecker(opts, stubLogger(), throwing);
    const v = await mc.check("unrelated lexical tokens here", "completely different source text");
    expect(v.checker).toBe("keyword");
    expect(v.supported).toBe(false);
  });

  // WS-43: parseVerdict must match a leading WHOLE positive token, not any
  // digit-prefixed prose. A "1. No" answer is negative.
  describe("parseVerdict tolerance (WS-43)", () => {
    const reply = (response: string): MiniCheckClient => ({ async generate() { return { response }; } });
    // A single-content-word claim with no source overlap so the pre-filter never
    // short-circuits — the NLI reply alone decides the verdict.
    const claim = "xenophonic";
    const source = "completely unrelated body of prose";

    it("reads `1. No` as NEGATIVE (the bug: startsWith('1') accepted it)", async () => {
      const mc = new MiniCheckGroundingChecker(opts, stubLogger(), reply("1. No"));
      expect((await mc.check(claim, source)).supported).toBe(false);
    });
    it("reads `1) Maybe` as NEGATIVE", async () => {
      const mc = new MiniCheckGroundingChecker(opts, stubLogger(), reply("1) Maybe"));
      expect((await mc.check(claim, source)).supported).toBe(false);
    });
    it("reads a bare `1` as POSITIVE", async () => {
      const mc = new MiniCheckGroundingChecker(opts, stubLogger(), reply("1"));
      expect((await mc.check(claim, source)).supported).toBe(true);
    });
    it("reads `yes` and `true` as POSITIVE", async () => {
      expect((await new MiniCheckGroundingChecker(opts, stubLogger(), reply("yes")).check(claim, source)).supported).toBe(true);
      expect((await new MiniCheckGroundingChecker(opts, stubLogger(), reply("true")).check(claim, source)).supported).toBe(true);
    });
  });

  // WS-17: a hung Ollama daemon must not stall the gate — the NLI call is bounded
  // by a timeout and degrades to the keyword fallback.
  it("times out a hung NLI call and degrades to the keyword fallback (WS-17)", async () => {
    const hanging: MiniCheckClient = {
      generate: () => new Promise(() => undefined), // never resolves
    };
    const mc = new MiniCheckGroundingChecker({ ...opts, timeoutMs: 50 }, stubLogger(), hanging);
    const started = Date.now();
    const v = await mc.check("unrelated lexical tokens here", "completely different source text");
    expect(Date.now() - started).toBeLessThan(2000); // didn't hang
    expect(v.checker).toBe("keyword"); // degraded, not stuck
  });

  // WS-16: the keyword pre-filter must require BOTH relation endpoints present in
  // the source before it short-circuit-accepts an edge.
  describe("relation endpoint pre-filter (WS-16)", () => {
    it("does NOT short-circuit-accept when an endpoint is absent (predicate-only overlap)", async () => {
      let nliCalls = 0;
      const sayNo: MiniCheckClient = { async generate() { nliCalls++; return { response: "No" }; } };
      const mc = new MiniCheckGroundingChecker(opts, stubLogger(), sayNo);
      // The verbalized claim FULLY overlaps the source (ks = 1 ≥ escalateAbove), yet the
      // `river_gauge` endpoint's tokens never appear — the old pre-filter would accept it.
      const source = "these measures record data values here";
      const v = await mc.check("measures record data values here", source, ["river_gauge", "values_today"]);
      expect(v.checker).toBe("minicheck"); // fell through to NLI, not a cheap keyword accept
      expect(v.supported).toBe(false);
      expect(nliCalls).toBeGreaterThan(0);
    });

    it("DOES short-circuit-accept when both endpoints are present (no NLI call)", async () => {
      let nliCalls = 0;
      const counting: MiniCheckClient = { async generate() { nliCalls++; return { response: "No" }; } };
      const mc = new MiniCheckGroundingChecker(opts, stubLogger(), counting);
      const source = "the river flows through the green valley below";
      const v = await mc.check("river flows through valley", source, ["river", "valley"]);
      expect(v.checker).toBe("keyword");
      expect(v.supported).toBe(true);
      expect(nliCalls).toBe(0);
    });

    it("observation path (no endpoints) keeps the original pre-filter behavior", async () => {
      let nliCalls = 0;
      const counting: MiniCheckClient = { async generate() { nliCalls++; return { response: "No" }; } };
      const mc = new MiniCheckGroundingChecker(opts, stubLogger(), counting);
      const v = await mc.check("embedding service batches requests", "embedding service batches requests in groups of ten");
      expect(v.checker).toBe("keyword");
      expect(v.supported).toBe(true);
      expect(nliCalls).toBe(0);
    });
  });
});
