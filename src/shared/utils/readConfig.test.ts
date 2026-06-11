import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readConfigurationFile } from "./readConfig";

describe("readConfigurationFile (KG-18)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgcfg-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const write = (name: string, content: string) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, content);
    return p;
  };

  it("parses JSON config", async () => {
    const p = write("c.json", JSON.stringify({ input: "./src" }));
    await expect(readConfigurationFile(p)).resolves.toEqual({ input: "./src" });
  });

  it("parses YAML config", async () => {
    const p = write("c.yaml", "input: ./src\n");
    await expect(readConfigurationFile(p)).resolves.toEqual({ input: "./src" });
  });

  it("throws on an unsupported extension instead of silently returning {}", async () => {
    const p = write("c.toml", "input = './src'");
    await expect(readConfigurationFile(p)).rejects.toThrow(/Unsupported config file extension/);
  });
});
