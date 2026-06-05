import { ContainerFactory, TYPES } from "./index";

describe("ContainerFactory — classifier gating", () => {
  it("rejects the unimplemented 'bert' classifier with a clear message", async () => {
    const container = ContainerFactory.createContainer({
      processingOptions: {
        classifier: "bert",
        logLevel: "error",
        silent: true,
        model: "x",
        host: "y",
      } as any,
    });

    await expect(container.resolve(TYPES.ContentClassifier)).rejects.toThrow(
      /bert.*not implemented/i
    );
  });
});
