import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { exportCommand } from "./export.command";
import { DIContainer, TYPES } from "../../core/di";
import { KnowledgeGraphExportService } from "../../core/export/KnowledgeGraphExportService";
import { JsonExportStrategy, McpExportStrategy } from "../../core/export/strategies";
import { stubLogger } from "../../__tests__/helpers";

describe("exportCommand", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgexp-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function container(options: any): DIContainer {
    const c = new DIContainer();
    c.registerValue(TYPES.Logger, stubLogger());
    c.registerValue(TYPES.ProcessingOptions, options);
    c.registerValue(
      TYPES.KnowledgeGraphExportService,
      new KnowledgeGraphExportService(
        new JsonExportStrategy(),
        new McpExportStrategy()
      )
    );
    return c;
  }

  it("converts an existing graph file to a new format", async () => {
    const inFile = path.join(tmp, "in.json");
    const outFile = path.join(tmp, "out.jsonl");
    fs.writeFileSync(
      inFile,
      JSON.stringify({
        entities: [
          { name: "E", entityType: "person", observations: ["o"], files: [] },
        ],
        relations: [],
      })
    );

    await exportCommand(
      container({ input: inFile, output: outFile, exportFormat: "mcp-jsonl" })
    );

    expect(fs.existsSync(outFile)).toBe(true);
    const content = fs.readFileSync(outFile, "utf-8");
    expect(content).toContain('"type":"entity"');
    expect(content).toContain('"name":"E"');
  });

  it("rejects when --input is not a file", async () => {
    await expect(
      exportCommand(
        container({ input: tmp, output: path.join(tmp, "o.json"), exportFormat: "json" })
      )
    ).rejects.toThrow(/must point to an existing knowledge-graph JSON file/);
  });
});
