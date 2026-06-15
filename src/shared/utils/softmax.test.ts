import { softmax } from "./softmax";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("softmax", () => {
  it("returns a monotone distribution that sums to 1", () => {
    const out = softmax([1, 2, 3]);
    expect(sum(out)).toBeCloseTo(1, 10);
    expect(out[2]).toBeGreaterThan(out[1]);
    expect(out[1]).toBeGreaterThan(out[0]);
  });

  it("is uniform when all scores are equal", () => {
    softmax([5, 5, 5]).forEach((x) => expect(x).toBeCloseTo(1 / 3, 10));
  });

  it("handles negative scores without NaN (why the classifier uses it)", () => {
    const out = softmax([-3, -1, -2]);
    expect(out.every((x) => x >= 0 && x <= 1)).toBe(true);
    expect(sum(out)).toBeCloseTo(1, 10);
  });

  it("temperature controls sharpness", () => {
    const sharp = softmax([0, 5], 0.5);
    const flat = softmax([0, 5], 5);
    expect(sharp[1]).toBeGreaterThan(flat[1]); // lower T → more mass on the max
  });

  it("does not overflow on large scores (max-subtraction)", () => {
    const out = softmax([1000, 1001]);
    expect(out.every(Number.isFinite)).toBe(true);
    expect(sum(out)).toBeCloseTo(1, 10);
  });

  it("returns [] for empty input", () => {
    expect(softmax([])).toEqual([]);
  });
});
