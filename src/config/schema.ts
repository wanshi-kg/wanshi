import { z } from "zod";

/**
 * The single source of truth for wanshi's configuration.
 *
 * Everything else is derived from this schema: the `ProcessingOptions` TS type
 * (`z.infer`), runtime validation + defaults (`parseConfig`), and the JSON
 * Schema served to the frontend (`configJsonSchema`). Defaults live here and
 * nowhere else — CLI flags carry no defaults, and services no longer apply
 * scattered `?? fallback`s.
 *
 * Objects are `.strict()` so an unknown/legacy flat key (e.g. `chunkSize`) is a
 * hard error with a migration hint, not a silent miscast (clean break from the
 * old flat shape — see docs/MIGRATION.md).
 *
 * Numeric fields use `z.coerce.number()` so CLI string values ("2000") and YAML
 * numbers both validate. `.default()` short-circuits `undefined` before
 * coercion, so an unset flag falls through to the default rather than NaN.
 */

// ── small helpers ──────────────────────────────────────────────────────────

/** A number field with a default; coerces CLI strings + YAML numbers. */
const num = (def: number) => z.coerce.number().default(def);

/** Accept a single string or an array of strings; normalize to an array. */
const stringList = (def: string[]) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .default(def);

// ── enums (reused as exported subtypes) ────────────────────────────────────

export const ProviderModeEnum = z.enum(["ollama", "openai"]);
export const ChunkingModeEnum = z.enum(["enabled", "disabled", "auto"]);
export const RetrievalModeEnum = z.enum(["enabled", "disabled", "auto"]);
export const RetrievalScopeEnum = z.enum(["chunk", "file"]);
export const SpeechRecognitionModeEnum = z.enum(["enabled", "disabled", "auto"]);
export const ImageProcessingModeEnum = z.enum(["enabled", "disabled", "auto"]);
export const ContentClassifierModeEnum = z.enum([
  "disabled",
  "heuristic",
  "llm",
  "cascade",
]);
export const GroundingModeEnum = z.enum(["disabled", "flag", "drop"]);
export const GroundingCheckerEnum = z.enum(["keyword", "minicheck"]);
export const SupersessionModeEnum = z.enum(["disabled", "heuristic", "llm"]);
export const CorpusProfilingModeEnum = z.enum(["disabled", "enabled"]);
export const AstModeEnum = z.enum(["enabled", "disabled"]);
export const ExportFormatEnum = z.enum([
  "json",
  "jsonl",
  "mcp-jsonl",
  "dot",
  "kblam",
  "lora",
  "graphiti",
]);
export const JsonStrategyEnum = z.enum(["structural", "raw"]);
// PDF reading engine: `pdf2json` = built-in text extraction (default, no OCR,
// portable); `tesseract` = pure-JS/WASM OCR (light-local floor, no system binary);
// `docling`/`marker`/`chandra` = local Python tools (subprocess; chandra = slow
// SOTA/handwriting 4B VLM); `mistral` = Mistral OCR HTTP API. Any non-default
// engine degrades to pdf2json on failure. Hardware-aware ladder:
// tesseract (light/CPU) → pdf2json → docling → marker → chandra → mistral (cloud).
export const PdfEngineEnum = z.enum(["pdf2json", "docling", "marker", "mistral", "tesseract", "chandra"]);
// AudioReader transcription engine: `whisper` = built-in single-model nodejs-whisper
// (default, portable, network-free); `dual` = vendored Python audio-pipeline
// (Silero VAD + Parakeet/Whisper dual-STT + diarization, Apple-Silicon only, opt-in).
export const AsrEngineEnum = z.enum(["whisper", "dual"]);
export const AsrModelsEnum = z.enum(["both", "parakeet", "whisper"]);
export const LogLevelEnum = z.enum(["debug", "info", "warning", "error"]);

// ── grouped sub-schemas ────────────────────────────────────────────────────

const LlmSchema = z
  .object({
    provider: ProviderModeEnum.default("ollama").describe(
      "Generation provider. 'openai' targets any OpenAI-compatible endpoint via host."
    ),
    model: z.string().default("llama3.2").describe("LLM used for generation"),
    host: z
      .string()
      .default("http://localhost:11434")
      .describe("Ollama host URL, or OpenAI-compatible base URL when provider=openai"),
    apiKey: z
      .string()
      .optional()
      .describe("API key for OpenAI-compatible provider (falls back to $OPENAI_API_KEY / $WANSHI_API_KEY)"),
    temperature: num(0.1).describe("Model temperature"),
    repeatPenalty: num(1.1).describe(
      "Repeat penalty (Ollama: >1.0 discourages repetition, <1.0 promotes it; 1.0 = off)"
    ),
    contextLength: num(8192).describe("Model context length (system prompt + chunk + response)"),
    maxTokens: z.coerce
      .number()
      .optional()
      .describe("Max output tokens per generation; raise it if KG JSON truncates mid-output"),
    seed: z.coerce.number().optional().describe("Model seed"),
    system: z.string().optional().describe("System prompt text or path to a handlebars template"),
    promptVersion: z
      .string()
      .default("v5")
      .describe("Prompt template version under templates/ (v5 default; v4.5 = legacy)"),
  })
  .strict();

const EmbeddingsSchema = z
  .object({
    provider: ProviderModeEnum.default("ollama").describe(
      "Embeddings provider, independent from generation; defaults to local Ollama"
    ),
    model: z.string().default("nomic-embed-text").describe("Embeddings model"),
    host: z.string().default("http://localhost:11434").describe("Embeddings host / OpenAI-compatible base URL"),
    apiKey: z.string().optional().describe("API key for OpenAI-compatible embeddings"),
    maxInputChars: num(1024).describe("Truncate embedding inputs to at most N characters"),
  })
  .strict();

const ChunkingSchema = z
  .object({
    mode: ChunkingModeEnum.default("enabled").describe("Chunking mode"),
    size: num(2000).describe("Maximum chunk size in characters"),
    overlap: num(100).describe("Overlap size between chunks in characters"),
  })
  .strict();

const RetrievalSchema = z
  .object({
    mode: RetrievalModeEnum.default("enabled").describe("Context retrieval mode"),
    limit: num(3).describe("Context retrieval limit"),
    scope: RetrievalScopeEnum.default("chunk").describe(
      "Retrieval granularity: per-chunk (default) or once per file"
    ),
  })
  .strict();

const MergingSchema = z
  .object({
    entitySimilarityThreshold: num(0.9).describe("Jaro-Winkler threshold for entity-name merging, applied uniformly within-file and globally; fuzzy merging never crosses a digit mismatch (Table 1 ≠ Table 2) and cross-type matches need near-exact similarity"),
    observationSimilarityThreshold: num(0.9).describe("Embedding cosine threshold for observation merging"),
    enableSimilarityMerging: z.boolean().default(true).describe("Allow fuzzy (Jaro-Winkler) entity-name merging; false ⇒ only normalized-exact name matches merge"),
    supersession: SupersessionModeEnum.default("disabled").describe("Merge-time supersession (KG-10): a newer fact contradicting an older one invalidates the older (sets invalidAt/expiredAt) instead of deleting it. disabled | heuristic (antonyms+negation) | llm"),
  })
  .strict();

const GroundingSchema = z
  .object({
    mode: GroundingModeEnum.default("disabled").describe(
      "Inline grounding gate: disabled | flag (annotate) | drop (remove ungrounded)"
    ),
    minScore: num(0.5).describe("Minimum keyword-overlap grounding score (0..1)"),
    checker: GroundingCheckerEnum.default("keyword").describe(
      "Grounding checker: keyword (overlap heuristic) | minicheck (local NLI fact-checker, with keyword pre-filter)"
    ),
    model: z
      .string()
      .default("bespoke-minicheck:7b")
      .describe("Ollama model for the minicheck checker (a (document, claim)→Yes/No NLI model)"),
    host: z
      .string()
      .optional()
      .describe("Ollama host for the minicheck checker; defaults to the generation/embeddings host"),
    escalateAbove: num(0.8).describe(
      "Keyword score at/above which minicheck accepts without an NLI call (cheap pre-filter)"
    ),
  })
  .strict();

const AstSchema = z
  .object({
    mode: AstModeEnum.default("enabled").describe("AST symbol seed (Phase 8): seed code definitions + exported members as entities (+ calls/imports edges) before the LLM, so the model augments rather than originates the symbol set"),
    cachePath: z.string().optional().describe("AST symbol cache sidecar path (default <output>.ast-cache.json)"),
  })
  .strict();

const CorpusSchema = z
  .object({
    profiling: CorpusProfilingModeEnum.default("disabled").describe(
      "Corpus analysis pre-pass: term frequency + cached classification + LLM glossary"
    ),
    topTerms: num(100).describe("Number of most-frequent terms fed to the glossary call"),
    profilePath: z.string().optional().describe("Corpus profile sidecar path (default <output>.corpus-profile.json)"),
    clustering: z.boolean().default(false).describe("Embedding clustering of terms (v2 stub, deferred)"),
  })
  .strict();

const ClassifierSchema = z
  .object({
    mode: ContentClassifierModeEnum.default("disabled").describe("Content classifier mode (experimental)"),
    temperature: z.coerce
      .number()
      .positive()
      .default(2.0)
      .describe("Heuristic softmax temperature: lower = sharper/more decisive, higher = flatter/more ties"),
    crossValidationFactor: z.coerce
      .number()
      .min(0)
      .default(0.15)
      .describe("Heuristic cross-validation negative-pattern weight factor"),
    maxEscalations: z.coerce
      .number()
      .int()
      .min(0)
      .default(50)
      .describe("Cascade mode: max LLM tie-break escalations per run (cost guard)"),
    lowConfidenceThreshold: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(0.25)
      .describe("Domain-gate floor: min top-1 confidence to route any domain"),
    mixedDomainThreshold: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(0.15)
      .describe("Domain-gate margin: max top1−top2 gap to also route the second domain"),
  })
  .strict();

const JsonReaderSchema = z
  .object({
    strategy: JsonStrategyEnum.default("structural").describe(
      "JSON reader: structural (split on JSON structure) or raw (text split)"
    ),
    maxChunkSize: z.coerce.number().optional().describe("Max JSON chunk size (inherits chunking.size when unset)"),
  })
  .strict();

// Dual-STT engine knobs (only consulted when `engine: dual`). The Python
// audio-pipeline subproject is invoked per audio file; any failure (missing
// interpreter, model, or service) degrades gracefully back to the whisper engine.
const AsrDualSchema = z
  .object({
    projectDir: z
      .string()
      .default("./audio-pipeline")
      .describe("Path to the vendored Python audio-pipeline subproject"),
    pythonPath: z
      .string()
      .optional()
      .describe("Python/launcher executable (default: `uv` runner inside projectDir)"),
    asr: AsrModelsEnum.default("both").describe("Which ASR backends to run (both keeps parakeet+whisper as provenance)"),
    diarize: z.boolean().default(true).describe("Run pyannote speaker diarization (needs an HF token)"),
    numSpeakers: z.coerce.number().int().positive().optional().describe("Hint the diarizer's speaker count when known"),
    device: z.string().optional().describe("Torch/MLX device override (e.g. mps, cpu, cuda)"),
    timeoutMs: z.coerce.number().int().positive().default(1_800_000).describe("Per-file transcription subprocess timeout (ms)"),
  })
  .strict();

const AsrSchema = z
  .object({
    mode: SpeechRecognitionModeEnum.default("enabled").describe("Automatic speech recognition mode"),
    engine: AsrEngineEnum.default("whisper").describe("Transcription engine: whisper (built-in) or dual (vendored Python VAD+dual-STT+diarization)"),
    whisperModel: z.string().default("medium").describe("Whisper model (whisper engine)"),
    language: z.string().default("auto").describe("Speech recognition language"),
    translate: z.boolean().default(false).describe("Translate transcript to English (whisper engine)"),
    dual: AsrDualSchema.default({}),
  })
  .strict();

// Email reader knobs (`.eml`/`.mbox`). The body still flows through LLM
// extraction; these only govern how an email/thread is turned into turns.
const EmailReaderSchema = z
  .object({
    maxMessages: z.coerce
      .number()
      .int()
      .positive()
      .default(1000)
      .describe("Max messages parsed from one .mbox (warns + truncates beyond this)"),
    stripQuotes: z
      .boolean()
      .default(true)
      .describe("Strip quoted reply chains (`> …` / `On … wrote:`) so each message contributes only its new content"),
  })
  .strict();

// Chat-export reader knobs (WhatsApp .txt, Telegram/Discord/Slack .json). The
// message text still flows through LLM extraction; these only govern parsing.
const ChatReaderSchema = z
  .object({
    maxMessages: z.coerce
      .number()
      .int()
      .positive()
      .default(50000)
      .describe("Max messages parsed from one chat export (warns + truncates beyond this)"),
    skipSystem: z
      .boolean()
      .default(true)
      .describe("Drop system/service noise (joins, encryption notices, <Media omitted>, …)"),
  })
  .strict();

// Jupyter notebook reader knobs (.ipynb). Markdown narrative + fenced code are
// always rendered; outputs/images are opt-in (they often carry noise).
const JupyterReaderSchema = z
  .object({
    includeOutputs: z
      .boolean()
      .default(false)
      .describe("Append code-cell text outputs (stream / text-plain results; error tracebacks always skipped)"),
    includeImages: z
      .boolean()
      .default(false)
      .describe("Attach base64 image outputs as chunk images (for the vision path)"),
  })
  .strict();

const OutlineSchema = z
  .object({
    enabled: z.boolean().default(true).describe("Generate a per-file structural outline and inject it into the prompt"),
    maxDepth: z.coerce.number().optional().describe("Limit outline nesting depth"),
    includeLineNumbers: z.boolean().default(false).describe("Include line numbers in the outline"),
    includePrivate: z.boolean().default(false).describe("Include private/internal members"),
    includeComments: z.boolean().default(false).describe("Include comments"),
    compact: z.boolean().default(false).describe("Token-lean ascii-tree outline: drop line numbers + metadata annotations"),
  })
  .strict();

// marker-pdf engine (Python `marker_single` CLI subprocess; ~1GB models, slow on
// CPU). Only consulted when `pdfEngine: marker`; failure degrades to pdf2json.
const MarkerSchema = z
  .object({
    command: z.string().default("marker_single").describe("marker CLI executable (on PATH)"),
    useLlm: z.boolean().default(false).describe("Marker --use_llm hybrid mode (reuses the openai-compatible llm config; higher table accuracy, costs LLM calls)"),
    forceOcr: z.boolean().default(false).describe("Force OCR on every page (scanned PDFs)"),
    timeoutMs: z.coerce.number().int().positive().default(900_000).describe("Per-file marker subprocess timeout (ms)"),
  })
  .strict();

// Mistral OCR engine (HTTP API; ~$1-2/1k pages). Only consulted when
// `pdfEngine: mistral`; missing key / HTTP error degrades to pdf2json.
const MistralSchema = z
  .object({
    apiKey: z.string().optional().describe("Mistral API key (falls back to $MISTRAL_API_KEY)"),
    host: z.string().default("https://api.mistral.ai").describe("Mistral API base URL"),
    model: z.string().default("mistral-ocr-latest").describe("Mistral OCR model"),
    timeoutMs: z.coerce.number().int().positive().default(300_000).describe("Per-file OCR request timeout (ms)"),
  })
  .strict();

// Tesseract OCR engine (pure-JS/WASM: pdf-to-png-converter rasterizes each page,
// tesseract.js OCRs it; zero system binaries — the light-local floor for hardware
// with no GPU/VLM). Only consulted when `pdfEngine: tesseract`; any failure
// degrades to pdf2json. Language traineddata is fetched from the tesseract.js CDN
// on first use and cached — set `langPath` for a fully offline mirror.
const TesseractSchema = z
  .object({
    lang: z.string().default("eng").describe('Tesseract language code(s), e.g. "eng" or "eng+deu"'),
    scale: z.coerce.number().positive().default(2).describe("PDF→PNG render scale before OCR (higher = sharper input, slower)"),
    oem: z.coerce.number().int().optional().describe("OCR engine mode (tesseract.js OEM; default LSTM)"),
    psm: z.coerce.number().int().optional().describe("Page segmentation mode (tessedit_pageseg_mode)"),
    langPath: z.string().optional().describe("Offline traineddata dir/URL (no trailing slash); omit to use the CDN + cache"),
  })
  .strict();

// Chandra OCR engine (datalab `chandra-ocr` CLI subprocess; 4B VLM, slow on
// CPU/MPS — the SOTA/handwriting rung). Only consulted when `pdfEngine: chandra`;
// any failure degrades to pdf2json. License note: Chandra's weights are modified
// OpenRAIL-M (free for personal/research and orgs under $2M revenue; commercial
// self-hosting needs a license) — unlike Tesseract's clean Apache. Provide a
// license-aware default so a downstream commercial user isn't surprised.
const ChandraSchema = z
  .object({
    command: z.string().default("chandra").describe("chandra CLI executable (on PATH; `pip install chandra-ocr`)"),
    method: z.enum(["hf", "vllm"]).default("hf").describe("Backend: hf (HuggingFace+torch, M4-runnable but slow) | vllm (GPU server)"),
    timeoutMs: z.coerce.number().int().positive().default(900_000).describe("Per-file chandra subprocess timeout (ms)"),
  })
  .strict();

// Image metadata enrichment (deterministic, default OFF → byte-identical run).
// EXIF is graph-native structured data the image already carries; mapped to
// facts (GPS→location, capture time→bitemporal validAt, camera/author/software)
// that AUGMENT the VLM read of the image, stamped sourceAdapter:"exif".
const ExifSchema = z
  .object({
    enabled: z.boolean().default(false).describe("Extract image EXIF (GPS→location, capture time→validAt, camera/author/software) into deterministic graph facts"),
  })
  .strict();

// C2PA content-credential read (deterministic validity signal). Shells the
// official Adobe/CAI `c2patool` (reference-grade cryptographic validation),
// degrade-if-absent like marker. Records a trust observation (present/valid/signer/
// AI-claim) stamped sourceAdapter:"c2pa" — a fact, never a verdict. Default OFF.
const C2paSchema = z
  .object({
    enabled: z.boolean().default(false).describe("Read C2PA content credentials (via the c2patool CLI) into a trust observation on the image"),
    command: z.string().default("c2patool").describe("c2patool executable (on PATH; degrade to no-credential if absent)"),
  })
  .strict();

// CV pre-pass (Phase 2, opt-in, signal-not-verdict). Object detection runs a
// transformers.js detector (already a dep; bundles onnxruntime-node + sharp — no
// new dep) over images; detections feed the VLM prompt as context AND a
// deterministic cv-detection graph fragment (confidence = detector score). Default
// OFF → byte-identical run. (Forensic/manipulation signals — `cv.forensics` — are
// the gated 2b sub-phase, not yet built.)
const CvDetectionSchema = z
  .object({
    enabled: z.boolean().default(false).describe("Detect objects in images (people/vehicles/objects/animals) → VLM context + cv-detection graph facts"),
    mode: z.enum(["closed", "zero-shot"]).default("closed").describe("closed = fixed COCO classes (DETR/YOLOS); zero-shot = open-vocab via `labels` (OWL-ViT)"),
    model: z.string().default("").describe("HF model id; empty ⇒ per-mode default (closed: Xenova/detr-resnet-50, zero-shot: Xenova/owlvit-base-patch32)"),
    threshold: z.coerce.number().min(0).max(1).default(0.5).describe("Minimum detection score to keep"),
    labels: z.array(z.string()).default([]).describe("Zero-shot candidate labels (required for mode=zero-shot; ignored for closed)"),
    maxObjects: z.coerce.number().int().positive().default(20).describe("Cap detected objects per image"),
    cacheDir: z.string().optional().describe("transformers.js model cache dir (env.cacheDir)"),
    allowRemote: z.boolean().default(true).describe("Allow downloading the model from the HF Hub (false ⇒ offline; needs a local cache/mirror)"),
  })
  .strict();

const CvSchema = z
  .object({
    detection: CvDetectionSchema.default({}),
  })
  .strict();

const ReadersSchema = z
  .object({
    pdfEngine: PdfEngineEnum.default("pdf2json").describe("PDF reading engine: pdf2json (built-in) | tesseract (pure-JS/WASM OCR) | docling | marker (Python subprocess) | chandra (Python subprocess, SOTA) | mistral (HTTP OCR API)"),
    marker: MarkerSchema.default({}),
    mistral: MistralSchema.default({}),
    tesseract: TesseractSchema.default({}),
    chandra: ChandraSchema.default({}),
    stripReferences: z.boolean().default(false).describe("Quarantine trailing references/bibliography sections before extraction (PDF + markdown)"),
    images: ImageProcessingModeEnum.default("auto").describe("Image processing mode"),
    exif: ExifSchema.default({}),
    c2pa: C2paSchema.default({}),
    cv: CvSchema.default({}),
    json: JsonReaderSchema.default({}),
    email: EmailReaderSchema.default({}),
    chat: ChatReaderSchema.default({}),
    jupyter: JupyterReaderSchema.default({}),
    asr: AsrSchema.default({}),
    outline: OutlineSchema.default({}),
  })
  .strict();

// Reference & link resolution (Phase 0, network-free). Turns the references a
// document already contains into graph edges. Both axes default OFF — a default
// run's output shape is unchanged until opted in. Network classes (external web,
// citation span-fetch) are later phases and live behind their own opt-in.
const ReferencesSchema = z
  .object({
    internalLinks: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            "Resolve internal links ([x](./other.md), [[wikilinks]], HTML href) to corpus files as links_to edges"
          ),
      })
      .strict()
      .default({}),
    citations: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            "Parse the bibliography + inline arXiv/DOI/PMID into cites edges (network-free; fetch/resolution is a later phase)"
          ),
        // Phase 2 — citation span-fetch + faithfulness. Opt-in NETWORK; auto-enables
        // citation extraction. Resolves a cited work's id → OA full text, folds it
        // onto the cited-work node, and (with GROBID + MiniCheck) labels the edge.
        fetch: z
          .object({
            enabled: z
              .boolean()
              .default(false)
              .describe(
                "Phase 2 — resolve id-bearing cites to OPEN-ACCESS full text and fetch it. Opt-in NETWORK; auto-enables citation extraction"
              ),
            allowlist: stringList(["arxiv.org", "ncbi.nlm.nih.gov"]).describe(
              "OA hosts eligible to fetch (empty = no fetch). Broaden to raise DOI/Unpaywall reach"
            ),
            rejectlist: stringList([]).describe("Hosts / URL-prefixes to always skip"),
            maxFetches: num(50).describe("Per-run citation fetch budget (hard cap)"),
            timeoutMs: num(15000).describe("Per-fetch timeout (ms)"),
            maxBytes: num(20_000_000).describe("Reject fetched PDFs larger than this"),
            unpaywallEmail: z
              .string()
              .optional()
              .describe("Unpaywall polite-pool email (or $UNPAYWALL_EMAIL) — required to resolve DOI citations"),
            minicheck: z
              .boolean()
              .default(true)
              .describe("Phase 2c — label cites supported/unsupported/uncertain via MiniCheck (needs a citing claim from GROBID)"),
            minicheckModel: z
              .string()
              .default("bespoke-minicheck:7b")
              .describe("Ollama model for the citation faithfulness checker"),
            minicheckHost: z
              .string()
              .optional()
              .describe("Ollama host for the faithfulness checker; defaults to the local daemon"),
            uncertainBand: z
              .tuple([z.coerce.number(), z.coerce.number()])
              .default([0.34, 0.67])
              .describe("[lo, hi]: support score ≤lo ⇒ unsupported, ≥hi ⇒ supported, between ⇒ uncertain"),
            cachePath: z
              .string()
              .optional()
              .describe("Citation fetch-cache sidecar path (default: <output>.citation-cache.jsonl)"),
          })
          .strict()
          .default({}),
        grobid: z
          .object({
            enabled: z
              .boolean()
              .default(false)
              .describe(
                "Phase 2b — use a local GROBID service to link in-text citation markers to references (enables span-select + faithfulness). Run via Docker: lfoppiano/grobid"
              ),
            url: z.string().default("http://localhost:8070").describe("GROBID service base URL"),
          })
          .strict()
          .default({}),
        titleResolver: z
          .object({
            enabled: z
              .boolean()
              .default(false)
              .describe(
                "Phase 2d — resolve id-LESS references to a DOI/arXiv id via Crossref → Semantic Scholar → OpenAlex (widens fetch reach beyond id-bearing cites)"
              ),
            mailto: z.string().optional().describe("Polite-pool email for Crossref/OpenAlex"),
            openAlexKey: z.string().optional().describe("OpenAlex API key (required from Feb 2026)"),
            semanticScholarKey: z.string().optional().describe("Semantic Scholar API key (raises rate limit)"),
            minTitleSimilarity: num(0.85).describe("Min jaroWinkler title similarity to accept a title→id match"),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    follow: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            "Reference-driven ingestion: follow internal links to discover & process files (each once). Network-free, confined to input; auto-enables internalLinks"
          ),
        seeds: stringList([]).describe(
          "Entry docs (relative to input) to crawl from; empty = crawl from the discovered glob set"
        ),
        maxDepth: num(0).describe("Link-follow depth from a seed (0 = unlimited, within maxFiles)"),
        maxFiles: num(5000).describe("Hard cap on files processed per run (cycle/runaway guard)"),
      })
      .strict()
      .default({}),
    web: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            "Phase 1 — fetch allowlisted EXTERNAL web links, extract, emit `references` edges. Opt-in NETWORK; auto-enables internalLinks extraction"
          ),
        allowlist: stringList([]).describe(
          "Domains / URL-prefixes eligible to fetch (e.g. ['letta.com','https://x.io/docs']). Empty = no fetch (master switch)"
        ),
        rejectlist: stringList([]).describe("Domains / URL-prefixes to always skip"),
        maxFetches: num(50).describe("Per-run fetch budget (hard cap)"),
        timeoutMs: num(10000).describe("Per-fetch timeout (ms)"),
        maxBytes: num(5_000_000).describe("Reject response bodies larger than this"),
        relevanceCheck: z
          .boolean()
          .default(true)
          .describe("LLM relevance pre-check on title/meta before the extraction pass"),
        robots: z.boolean().default(true).describe("Respect robots.txt Disallow rules"),
        cachePath: z
          .string()
          .optional()
          .describe("Fetch-cache sidecar path (default: <output>.fetch-cache.jsonl)"),
      })
      .strict()
      .default({}),
  })
  .strict();

const DotSchema = z
  .object({
    layout: z.enum(["dot", "neato", "fdp", "sfdp", "circo", "twopi"]).default("dot"),
    rankdir: z.enum(["TB", "BT", "LR", "RL"]).default("TB"),
    nodeShape: z.string().default("box"),
    edgeStyle: z.string().default("solid"),
    colorScheme: z.enum(["default", "scientific", "code", "minimal"]).default("default"),
    includeObservations: z.boolean().default(true),
    maxObservationsPerNode: num(3),
    clusterByEntityType: z.boolean().default(false),
    clusterByFile: z.boolean().default(false),
    showLegend: z.boolean().default(true),
  })
  .strict();

const ExportSchema = z
  .object({
    format: ExportFormatEnum.default("json").describe("Export format"),
    dot: DotSchema.default({}).describe("DOT export options (used when format=dot)"),
  })
  .strict();

const ResumeSchema = z
  .object({
    enabled: z.boolean().default(false).describe("Checkpoint each chunk and skip already-done chunks on re-run"),
    checkpointPath: z.string().optional().describe("Checkpoint sidecar file path (default <output>.checkpoint.jsonl)"),
  })
  .strict();

// Debug/observability run-trace (off by default). Emits a versioned append-only
// JSONL sidecar of decision events (ingest→classify→extract→ground→merge→export)
// with mention-instance lineage IDs. Observe-only: the graph is byte-identical on/off.
const TraceSchema = z
  .object({
    enabled: z.boolean().default(false).describe("Emit a structured decision run-trace to a JSONL sidecar"),
    path: z.string().optional().describe("Trace sidecar file path (default <output>.trace.jsonl)"),
  })
  .strict();

// Cost / token metering (off by default; zero overhead, byte-identical default run).
// Records per-model token spend through ILLMProvider, prints a rough pre-run estimate
// + an exact end-of-run tally, enforces a hard `maxCost` cap (graceful stop), and keeps
// a resume-safe cumulative ledger sidecar. Setting `maxCost` auto-enables (ContainerFactory).
const CostSchema = z
  .object({
    enabled: z.boolean().default(false).describe("Meter LLM token usage + cost; print estimate + tally"),
    maxCost: z.coerce
      .number()
      .optional()
      .describe("Hard spend cap (currency units) for THIS run; stops gracefully when exceeded (implies enabled)"),
    currency: z.string().default("USD").describe("Currency label for cost output"),
    prices: z
      .record(z.object({ in: z.coerce.number(), out: z.coerce.number() }).strict())
      .default({})
      .describe("Per-model price overrides (USD per 1M tokens {in,out}); merged over the built-in map"),
    ledgerPath: z.string().optional().describe("Cumulative cost ledger sidecar (default <output>.cost.json)"),
  })
  .strict();

// Structured-emit adapters (data-sink track): graph-native sources mapped DIRECTLY
// to graph fragments (no LLM), still flowing through merge/canon. Each adapter is
// off by default; the registry is empty until one is enabled (default run unchanged).
const AdaptersSchema = z
  .object({
    sqlite: z
      .object({
        enabled: z.boolean().default(false).describe("Map .db/.sqlite files directly to a graph (tables→types, rows→entities, FK→edges)"),
        extensions: z
          .array(z.string())
          .default([".db", ".sqlite", ".sqlite3"])
          .describe("File extensions claimed by the SQLite adapter (a non-sqlite file still falls through)"),
        maxRowsPerTable: z.coerce.number().int().default(5000).describe("Cap rows emitted per table (warns + truncates beyond)"),
        excludeTables: z.array(z.string()).default([]).describe("Table names to skip entirely"),
      })
      .strict()
      .default({}),
  })
  .strict();

const LoggingSchema = z
  .object({
    level: LogLevelEnum.default("info").describe("Log level"),
    file: z.string().optional().describe("Log file path"),
    debug: z.boolean().default(false).describe("Debug mode"),
    silent: z.boolean().default(false).describe("Silent mode"),
    progressNdjson: z
      .boolean()
      .default(false)
      .describe("Emit structured NDJSON progress events on stdout (suppresses pretty logging)"),
  })
  .strict();

const RuntimeSchema = z
  .object({
    watch: z.boolean().default(false).describe("Watch for changes and rebuild the graph"),
    exportOnly: z.boolean().default(false).describe("Convert an existing graph JSON (input) to export.format"),
  })
  .strict();

// ── pipeline stages (canonicalization experiment) ──────────────────────────
//
// Explicit, reorderable, enable/disable stages (canon brief §3/§4). For
// Experiment 1 the producer stages (tf_analysis / schema_induction /
// extraction) run in fixed relative order and gate existing behavior; the
// genuinely reorderable part is the post-extraction graph→graph transforms
// (grounding, canonicalization), which is the seam Experiment 2 needs.

export const TfAnalysisSourceEnum = z.enum(["corpus", "graph"]);
export const CanonMethodEnum = z.enum(["embeddings", "llm", "hybrid"]);
export const ClusterAlgoEnum = z.enum(["agglomerative", "hdbscan", "kmeans"]);
export const CanonicalSelectionEnum = z.enum(["frequency", "degree"]);
export const CanonTargetEnum = z.enum(["entities", "relations"]);

const DEFAULT_STAGES = [
  "tf_analysis",
  "schema_induction",
  "extraction",
  "grounding",
  "canonicalization",
];

const StageToggleSchema = z
  .object({ enabled: z.boolean().default(true) })
  .strict();

const TfAnalysisStageSchema = z
  .object({
    enabled: z.boolean().default(true),
    source: TfAnalysisSourceEnum.default("corpus").describe(
      "Term-frequency source: 'corpus' (lexical, Exp 1) | 'graph' (structural salience, Exp 2 — stat collection only)"
    ),
  })
  .strict();

// NOTE: distinct from the top-level `grounding` group (the inline *observation*
// grounding gate). This is the *edge* co-occurrence gate — OFF for Experiment 1,
// the precision gate Experiment 2 runs before canonicalization.
const PipelineGroundingSchema = z
  .object({
    enabled: z.boolean().default(false).describe("Edge co-occurrence grounding gate (OFF for Exp 1)"),
    requireCooccurrence: z
      .boolean()
      .default(true)
      .describe("Drop edges whose endpoints don't co-occur in their source span"),
  })
  .strict();

const CanonClusterSchema = (threshold: number) =>
  z
    .object({
      cluster: ClusterAlgoEnum.default("agglomerative").describe(
        "Clustering algorithm (only 'agglomerative' is implemented)"
      ),
      threshold: num(threshold).describe("Cosine-similarity merge threshold"),
      linkage: z
        .enum(["single", "complete"])
        .default("complete")
        .describe(
          "Linkage: 'complete' (every in-cluster pair ≥ threshold; stops sibling chaining) | 'single' (legacy connectivity)"
        ),
      k: z.coerce.number().nullable().default(null).describe("Cluster count (only for kmeans)"),
    })
    .strict();

const simBand = () =>
  z
    .tuple([z.coerce.number(), z.coerce.number()])
    .describe("Similarity band [low, high] considered borderline");

const CanonicalizationSchema = z
  .object({
    enabled: z.boolean().default(false).describe("Global embedding-clustering canonicalization pass (after merge)"),
    target: z
      .array(CanonTargetEnum)
      .default(["entities", "relations"])
      .describe("Canonicalize entity names/types, edge labels, or both"),
    method: CanonMethodEnum.default("embeddings").describe(
      "embeddings (cluster) | llm (adjudicate) | hybrid (cluster + escalate borderline)"
    ),
    canonicalSelection: CanonicalSelectionEnum.default("frequency").describe(
      "Pick the cluster's canonical representative by frequency or graph degree"
    ),
    blockTopN: z.coerce
      .number()
      .int()
      .default(0)
      .describe(
        "Blocking: only an item's N nearest neighbours are merge-eligible (complete-linkage). 0 = off"
      ),
    maxAdjudications: z.coerce
      .number()
      .int()
      .default(2000)
      .describe(
        "Safety cap on LLM adjudication calls per canon pass; further escalations reject (the 26K guard)"
      ),
    embeddings: z
      .object({
        entity: CanonClusterSchema(0.82).default({}),
        relation: CanonClusterSchema(0.85).default({}),
      })
      .strict()
      .default({}),
    llm: z
      .object({
        model: z.string().optional().describe("Adjudication model (defaults to llm.model)"),
        adjudicate: z.enum(["borderline_only"]).default("borderline_only"),
        band: simBand().default([0.72, 0.88]),
      })
      .strict()
      .default({}),
    hybrid: z
      .object({
        escalateBand: simBand().default([0.72, 0.88]),
      })
      .strict()
      .default({}),
  })
  .strict();

const PipelineRelationFilterSchema = z
  .object({
    // `related_to` is the relation layer's catch-all (NR-4): on the telegram-sink corpus
    // ~30% of edges. This post-canon gate prunes the low-value subset. `redundant` drops
    // a `related_to` edge only when the same unordered endpoint pair already carries a
    // typed edge (safe — no information lost). `all` drops every `related_to` edge (for
    // consumers wanting only typed relations). Re-typing (LLM pass) is a future option.
    mode: z
      .enum(["off", "redundant", "all"])
      .default("off")
      .describe("related_to pruning: off | redundant (drop when a typed twin exists) | all"),
  })
  .strict();

const PipelineSchema = z
  .object({
    stages: z
      .array(z.string())
      .default(DEFAULT_STAGES)
      .describe("Ordered stage list; reorder for Experiment 2 (typeless-first)"),
    tfAnalysis: TfAnalysisStageSchema.default({}),
    schemaInduction: StageToggleSchema.default({}),
    extraction: StageToggleSchema.default({}),
    grounding: PipelineGroundingSchema.default({}),
    canonicalization: CanonicalizationSchema.default({}),
    relationFilter: PipelineRelationFilterSchema.default({}),
  })
  .strict();

const InspectionSchema = z
  .object({
    emitMergeLog: z.boolean().default(false).describe("Write the per-cluster canonicalization merge log"),
    mergeLogPath: z
      .string()
      .optional()
      .describe("Merge-log path (default runs/<run_id>/merges.jsonl)"),
  })
  .strict();

const EvalSchema = z
  .object({
    seed: z.coerce.number().optional().describe("Experiment seed (recorded in the run manifest)"),
    groundTruth: z.string().optional().describe("Ground-truth facts JSONL for scoring"),
    pinVersions: z
      .boolean()
      .default(true)
      .describe("Pin model/embedding/seed versions in the run manifest"),
  })
  .strict();

// ── root schema ────────────────────────────────────────────────────────────

export const ConfigSchema = z
  .object({
    // Core run essentials stay top-level.
    input: z.string().default(".").describe("Input directory (or existing graph file in export-only mode)"),
    filter: stringList(["**/*"]).describe("Include files by glob (string or list)"),
    exclude: stringList([]).describe("Exclude files by glob (string or list)"),
    output: z.string().default("knowledge-graph.json").describe("Output knowledge graph file"),
    description: z.string().default("").describe("Short description of the corpus for the LLM"),

    // Grouped by concern.
    llm: LlmSchema.default({}),
    embeddings: EmbeddingsSchema.default({}),
    chunking: ChunkingSchema.default({}),
    retrieval: RetrievalSchema.default({}),
    merging: MergingSchema.default({}),
    grounding: GroundingSchema.default({}),
    corpus: CorpusSchema.default({}),
    ast: AstSchema.default({}),
    classifier: ClassifierSchema.default({}),
    readers: ReadersSchema.default({}),
    references: ReferencesSchema.default({}),
    adapters: AdaptersSchema.default({}),
    export: ExportSchema.default({}),
    resume: ResumeSchema.default({}),
    trace: TraceSchema.default({}),
    cost: CostSchema.default({}),
    logging: LoggingSchema.default({}),
    runtime: RuntimeSchema.default({}),

    // Canonicalization experiment (canon brief). Config-only (no CLI flags).
    pipeline: PipelineSchema.default({}),
    inspection: InspectionSchema.default({}),
    eval: EvalSchema.default({}),
  })
  .strict();
