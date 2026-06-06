import { PromptManager } from "./PromptManager";
import { stubLogger } from "../../../__tests__/helpers";

describe("PromptManager corpus glossary injection", () => {
  const manager = () => new PromptManager(stubLogger());

  it("renders the corpus glossary block into the user prompt", async () => {
    const prompt = await manager().getUserPrompt({
      input: "",
      filter: "",
      fileName: "f.txt",
      fileContent: "some content",
      chunkContent: "some content",
      corpusGlossary: {
        entityNames: ["Bayes Theorem", "Naive Bayes Classifier"],
        entityTypes: ["theorem"],
        relationTypes: ["assumes"],
      },
    });

    expect(prompt).toContain("Corpus Glossary");
    expect(prompt).toContain("Bayes Theorem");
    expect(prompt).toContain("Naive Bayes Classifier");
    expect(prompt).toContain("theorem");
    expect(prompt).toContain("assumes");
  });

  it("omits the glossary block when no glossary is supplied", async () => {
    const prompt = await manager().getUserPrompt({
      input: "",
      filter: "",
      fileName: "f.txt",
      fileContent: "some content",
      chunkContent: "some content",
    });
    expect(prompt).not.toContain("Corpus Glossary");
  });

  it("omits the block for an empty glossary", async () => {
    const prompt = await manager().getUserPrompt({
      input: "",
      filter: "",
      fileName: "f.txt",
      fileContent: "some content",
      chunkContent: "some content",
      corpusGlossary: { entityNames: [], entityTypes: [], relationTypes: [] },
    });
    expect(prompt).not.toContain("Corpus Glossary");
  });
});
