import { HeuristicContentClassifier } from "./HeuristicContentClassifier";
import { stubLogger } from "../../../__tests__/helpers";

describe("HeuristicContentClassifier", () => {
  const classifier = new HeuristicContentClassifier(stubLogger());

  it("classifies a code file as `code`", async () => {
    const content = `
import { Foo } from "./foo";

export class UserService extends BaseService {
  async getUser(id: string): Promise<User> {
    const user = await this.repo.findById(id);
    if (!user) {
      throw new Error("not found");
    }
    return user;
  }
}

function helper(a: number, b: number) {
  return a + b;
}
`;
    const results = await classifier.classify(
      content,
      "/project/src/services/UserService.ts"
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].class).toBe("code");
  });

  it("classifies clinical prose as `medical` from content alone (neutral path)", async () => {
    const content = `
The patient was prescribed 500 mg of amoxicillin BID for the infection.
Following the randomized controlled, double-blind, placebo-controlled clinical
trial, FDA approval was granted. The diagnosis indicated a chronic condition
requiring ongoing treatment and medication. Blood pressure and heart rate were
monitored, and adverse events were recorded throughout the study.
`;
    const results = await classifier.classify(content, "note.txt");

    expect(results[0].class).toBe("medical");
  });

  it("returns a near-uniform distribution for empty content (no clear winner)", async () => {
    const results = await classifier.classify("", "note.txt");
    // The classifier no longer abstains internally (the >0.7 filter is gone, S3) —
    // it ranks every class. Empty content has no signal, so the softmax is
    // ~uniform and it's the *gate* (activeDomainClasses) that abstains. The top
    // probability stays well under the routing floor.
    expect(results.length).toBe(12);
    expect(results.reduce((a, r) => a + r.confidence, 0)).toBeCloseTo(1, 5);
    expect(results[0].confidence).toBeLessThan(0.15); // ≈ 1/12
  });

  it("temperature controls how decisive the distribution is (A1 config knob)", async () => {
    // Moderate single-domain signal on a neutral path → top prob is sensitive to T.
    const content =
      "Revenue grew this quarter and earnings exceeded our forecast. The investment " +
      "is paying off; analysts remain bullish on the stock and expect the dividend to hold.";
    const sharp = new HeuristicContentClassifier(stubLogger(), 0.5);
    const flat = new HeuristicContentClassifier(stubLogger(), 20);

    const sharpTop = (await sharp.classify(content, "memo.txt"))[0];
    const flatTop = (await flat.classify(content, "memo.txt"))[0];

    expect(sharpTop.class).toBe(flatTop.class); // argmax is temperature-invariant
    expect(sharpTop.confidence).toBeGreaterThan(flatTop.confidence); // lower T → sharper
  });

  it("returns a sorted softmax distribution (probabilities, not independent squashes)", async () => {
    const content = "x".repeat(50_000) + "\nasync function f() { return 1; }\n";
    const results = await classifier.classify(content, "big.ts");

    expect(results.length).toBe(12);
    const confidences = results.map((r) => r.confidence);
    for (const c of confidences) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    expect(confidences.reduce((a, c) => a + c, 0)).toBeCloseTo(1, 5); // sums to 1
    expect(confidences).toEqual([...confidences].sort((a, b) => b - a)); // sorted desc
  });
});
