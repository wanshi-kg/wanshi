import * as fs from "fs";
import * as path from "path";
import { CorpusProfile } from "../../types";
import { Logger } from "../../shared";

/**
 * Load/save the corpus profile sidecar (`<output>.corpus-profile.json`). Like
 * {@link CheckpointService}, a missing or unparseable file is non-fatal — the
 * caller just rebuilds the profile.
 */
export class CorpusProfileStore {
  constructor(private readonly path: string, private readonly logger: Logger) {}

  getPath(): string {
    return this.path;
  }

  async load(): Promise<CorpusProfile | undefined> {
    if (!fs.existsSync(this.path)) return undefined;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.path, "utf-8"));
      if (parsed && typeof parsed === "object" && parsed.glossary && parsed.key) {
        return parsed as CorpusProfile;
      }
      this.logger.warn(`Corpus profile at ${this.path} has an unexpected shape; ignoring`);
      return undefined;
    } catch (error) {
      this.logger.warn(`Could not read corpus profile at ${this.path} (ignored): ${error}`);
      return undefined;
    }
  }

  async save(profile: CorpusProfile): Promise<void> {
    // The pre-pass runs before the output directory is created (that happens at
    // export time), so ensure the sidecar's parent dir exists first.
    const dir = path.dirname(this.path);
    if (dir && !fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
    await fs.promises.writeFile(this.path, JSON.stringify(profile, null, 2));
  }
}
