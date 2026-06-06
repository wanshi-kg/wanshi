import { CorpusProfile } from "./CorpusProfile";
import { ProcessingOptions } from "./ProcessingOptions";

/**
 * Builds (or loads from the sidecar cache) a corpus-global {@link CorpusProfile}:
 * term frequencies + cached content classification + an LLM-suggested glossary.
 */
export interface ICorpusAnalyzer {
  analyzeOrLoad(
    files: string[],
    options: ProcessingOptions
  ): Promise<CorpusProfile>;
}
