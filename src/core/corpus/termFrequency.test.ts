import { countTerms } from "./termFrequency";

describe("countTerms", () => {
  it("ranks content words by frequency and drops stopwords / short / numeric tokens", () => {
    const texts = [
      "recursion recursion recursion calls the function",
      "the function calls itself 1234 ok",
    ];
    const top = countTerms(texts, { topN: 10 });
    const map = Object.fromEntries(top.map((t) => [t.term, t.count]));

    expect(map["recursion"]).toBe(3);
    expect(map["function"]).toBe(2);
    expect(map["calls"]).toBe(2);
    // stopword "the" dropped, pure number "1234" dropped, sub-minLength "ok" dropped
    expect(map["the"]).toBeUndefined();
    expect(map["1234"]).toBeUndefined();
    expect(map["ok"]).toBeUndefined();
  });

  it("captures capitalized multiword runs as proper-noun candidates (original casing)", () => {
    const texts = [
      "We covered the Naive Bayes Classifier today.",
      "The Naive Bayes Classifier assumes independence.",
    ];
    const top = countTerms(texts, { topN: 20 });
    const proper = top.find((t) => t.term === "Naive Bayes Classifier");
    expect(proper).toBeDefined();
    expect(proper!.count).toBe(2);
  });

  it("is deterministic: ties break alphabetically and topN bounds the result", () => {
    const texts = ["alpha bravo charlie alpha bravo charlie delta"];
    const top = countTerms(texts, { topN: 2 });
    // alpha/bravo/charlie all count 2; alphabetical tiebreak → alpha, bravo
    expect(top.map((t) => t.term)).toEqual(["alpha", "bravo"]);
  });

  it("returns [] for empty input", () => {
    expect(countTerms([])).toEqual([]);
    expect(countTerms(["", "   "])).toEqual([]);
  });
});
