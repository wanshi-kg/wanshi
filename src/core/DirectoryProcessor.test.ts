import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DirectoryProcessor } from "./DirectoryProcessor";
import { DIContainer, TYPES } from "./di";
import { stubLogger } from "../__tests__/helpers";

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
    container.registerValue(TYPES.KnowledgeGraphBuilder, {} as any);
    container.registerValue(TYPES.ProgressEmitter, { emit: () => undefined } as any);

    const dp = new DirectoryProcessor(container);
    // No files this run; the prior graph must be used for retrieval only, never
    // merged. So the returned merge set is empty (would contain "OLD" before fix).
    const result = await dp.processFiles([], {
      output,
      retrieval: "disabled",
    } as any);

    expect(result).toEqual([]);
  });
});
