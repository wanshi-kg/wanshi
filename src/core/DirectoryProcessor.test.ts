import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DirectoryProcessor } from "./DirectoryProcessor";
import { DIContainer, TYPES } from "./di";
import { stubLogger, makeConfig } from "../__tests__/helpers";

describe("DirectoryProcessor — double-count regression", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgdp-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("does not pull a prior output graph into the merge set", async () => {
    const output = path.join(tmp, "kg.json");
    // A prior run's output sits on disk with one entity.
    fs.writeFileSync(
      output,
      JSON.stringify({
        entities: [
          { name: "OLD", entityType: "t", observations: [], files: [] },
        ],
        relations: [],
      })
    );

    const container = new DIContainer();
    container.registerValue(TYPES.Logger, stubLogger());
    container.registerValue(TYPES.FileProcessor, {} as any);
    container.registerValue(TYPES.KnowledgeGraphBuilder, {
      getFailedChunks: () => [],
      getGroundingRejections: () => [],
    } as any);
    container.registerValue(TYPES.ProgressEmitter, { emit: () => undefined } as any);
    container.registerValue(TYPES.AstSeedService, {
      loadCache: async () => undefined,
      saveCache: async () => undefined,
      seedGraph: async () => null,
    } as any);

    const dp = new DirectoryProcessor(container);
    // No files this run; the prior graph must be used for retrieval only, never
    // merged. So the returned merge set is empty (would contain "OLD" before fix).
    const result = await dp.processFiles(
      [],
      makeConfig({ output, retrieval: { mode: "disabled" } })
    );

    expect(result).toEqual([]);
  });

  it("seeds prior graphs from the format-rewritten path, not the configured stem (KG-11)", async () => {
    const container = new DIContainer();
    container.registerValue(TYPES.Logger, stubLogger());
    container.registerValue(TYPES.FileProcessor, {} as any);
    container.registerValue(TYPES.KnowledgeGraphBuilder, {
      getFailedChunks: () => [],
      getGroundingRejections: () => [],
    } as any);
    container.registerValue(TYPES.ProgressEmitter, { emit: () => undefined } as any);
    container.registerValue(TYPES.AstSeedService, {
      loadCache: async () => undefined,
      saveCache: async () => undefined,
      seedGraph: async () => null,
    } as any);

    const dp = new DirectoryProcessor(container);
    const spy = jest.spyOn(dp as any, "loadPriorGraphs").mockResolvedValue([]);
    // output stem is .json but the export format is jsonl, so the writer produces
    // kg.jsonl — the prior-graph loader must look there, not at the missing kg.json.
    await dp.processFiles(
      [],
      makeConfig({
        output: path.join(tmp, "kg.json"),
        export: { format: "jsonl" },
        retrieval: { mode: "disabled" },
      })
    );
    expect(spy).toHaveBeenCalledWith(path.join(tmp, "kg.jsonl"), expect.anything());
  });
});
