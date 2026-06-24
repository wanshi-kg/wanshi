import { PromptManager } from "./PromptManager";
import { stubLogger } from "../../../__tests__/helpers";
import { ClassificationResult, CorpusGlossary } from "../../../types";
import { resetDomainGate } from "../../knowledge/vocabulary";

/**
 * KG-05 (strict-vocabulary prompt path). Under `strictVocabulary:true` + a corpus
 * glossary + an active classifier domain, the Zod enum is glossary∪escape only —
 * so the prompt must teach exactly that ontology, NOT the domain predicates the
 * enum throws away (which the per-field `.catch` would otherwise silently coerce
 * to `related_to`/`other`). When strict is off (default) the rendering is
 * byte-for-byte unchanged.
 */
describe("PromptManager strict-vocabulary prompt path (KG-05)", () => {
  // A clearly-dominant medical class (clears the 0.25 low-confidence floor; no tie).
  const medicalClasses: ClassificationResult[] = [
    { class: "medical", confidence: 0.9 },
    { class: "narrative", confidence: 0.02 },
  ];

  // Strict ontology: a SUBSET of the medical domain vocabulary. `treats`/`condition`
  // are in it; `causes`/`prevents`/`treatment` (domain types) are deliberately NOT.
  const strictGlossary: CorpusGlossary = {
    entityNames: ["myocardial_infarction"],
    entityTypes: ["condition"],
    relationTypes: ["treats"],
  };

  const manager = () => new PromptManager(stubLogger());

  beforeEach(() => resetDomainGate());

  describe("user prompt domain hints", () => {
    it("under strict, prioritizes ONLY the glossary types — domain predicates the enum throws away are dropped", async () => {
      const prompt = await manager().getUserPrompt({
        input: "",
        filter: "",
        fileName: "chart.txt",
        fileContent: "Patient with acute chest pain.",
        chunkContent: "Patient with acute chest pain.",
        contentClasses: medicalClasses,
        corpusGlossary: strictGlossary,
        strictVocabulary: true,
      });

      // The glossary predicate/type are still taught.
      expect(prompt).toContain("Prioritize these relation types: treats");
      expect(prompt).toContain("Prioritize these entity types: condition");
      // Domain predicates/types NOT in the strict glossary must be absent from the
      // hints — teaching them only to coerce them to related_to/other is the bug.
      expect(prompt).not.toContain("causes");
      expect(prompt).not.toContain("prevents");
      expect(prompt).not.toContain("treatment");
      // The class is still detected (hint header unchanged).
      expect(prompt).toContain("Detected content type: **medical**");
    });

    it("under non-strict (default), the domain predicates ARE taught — rendering unchanged", async () => {
      const prompt = await manager().getUserPrompt({
        input: "",
        filter: "",
        fileName: "chart.txt",
        fileContent: "Patient with acute chest pain.",
        chunkContent: "Patient with acute chest pain.",
        contentClasses: medicalClasses,
        corpusGlossary: strictGlossary,
        // strictVocabulary omitted ⇒ default false
      });

      expect(prompt).toContain("Prioritize these relation types:");
      expect(prompt).toContain("treats");
      expect(prompt).toContain("causes");
      expect(prompt).toContain("prevents");
      expect(prompt).toContain("treatment");
    });

    it("a strict run with NO glossary leaves the hints untouched (nothing to restrict to)", async () => {
      const strict = await manager().getUserPrompt({
        input: "",
        filter: "",
        fileName: "chart.txt",
        fileContent: "Patient with acute chest pain.",
        chunkContent: "Patient with acute chest pain.",
        contentClasses: medicalClasses,
        strictVocabulary: true,
      });
      const plain = await manager().getUserPrompt({
        input: "",
        filter: "",
        fileName: "chart.txt",
        fileContent: "Patient with acute chest pain.",
        chunkContent: "Patient with acute chest pain.",
        contentClasses: medicalClasses,
      });
      // strictVocabulary only passes the glossary through; with no glossary the
      // strictGlossary arg is undefined, so the hints are identical to non-strict.
      expect(strict).toEqual(plain);
    });
  });

  describe("system prompt domain examples", () => {
    it("under strict + glossary, the domain worked-examples partial is suppressed", async () => {
      const prompt = await manager().getSystemPrompt(
        "/repo",
        "**/*.txt",
        undefined,
        medicalClasses,
        strictGlossary,
        false, // openVocabulary
        true // strictVocabulary
      );
      // The worked-examples block (which demonstrates domain predicates the strict
      // enum forbids) must not be injected.
      expect(prompt).not.toContain("Worked examples for this content type");
      // But the glossary's types are still rendered as the authoritative closed set.
      expect(prompt).toContain("use these and only these");
      expect(prompt).toContain("condition");
      expect(prompt).toContain("treats");
    });

    it("under non-strict (default), the domain worked-examples partial IS injected — unchanged", async () => {
      const prompt = await manager().getSystemPrompt(
        "/repo",
        "**/*.txt",
        undefined,
        medicalClasses,
        strictGlossary,
        false // openVocabulary; strictVocabulary omitted ⇒ default false
      );
      expect(prompt).toContain("Worked examples for this content type (medical)");
    });

    it("a strict run with NO glossary keeps the worked-examples partial (no strict ontology to enforce)", async () => {
      const prompt = await manager().getSystemPrompt(
        "/repo",
        "**/*.txt",
        undefined,
        medicalClasses,
        undefined, // no glossary
        false,
        true // strictVocabulary
      );
      expect(prompt).toContain("Worked examples for this content type (medical)");
    });
  });
});
