import yaml from 'js-yaml';
import path from "path";
import fs from "fs";
import { ProcessingOptions } from "../../types";

export async function readConfigurationFile(
  file: string
): Promise<Partial<ProcessingOptions>> {
  const ext = path.extname(file);
  const content = fs.readFileSync(file, "utf-8");
  switch (ext.toLowerCase()) {
    case ".json":
      return JSON.parse(content) as ProcessingOptions;

      case ".yaml":
    case ".yml":
      return yaml.load(content) as ProcessingOptions;

    default:
      return {} as ProcessingOptions;
  }
}
