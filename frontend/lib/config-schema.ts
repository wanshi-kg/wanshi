/**
 * The config form is driven entirely by the backend schema — there is no
 * hardcoded option list here anymore. `wanshi schema` (served via
 * `/api/config-schema`) returns the JSON Schema + UI group metadata; this module
 * adapts that payload into the form's `ConfigGroup`/`ConfigField` shapes and
 * converts between the flat form values (keyed by nested dotted path, e.g.
 * `llm.model`) and the nested config object the CLI consumes.
 */

/** Form value as stored in the flat `values` record. */
export type FieldValue = string | boolean

export type FieldType =
  | "text"
  | "password"
  | "number"
  | "boolean"
  | "select"
  | "lines"
  | "path"
  | "model"
  | "host"

export interface ConfigField {
  /** Nested dotted path into the config, e.g. "llm.model". */
  key: string
  label: string
  type: FieldType
  options?: readonly string[]
  default?: FieldValue
  placeholder?: string
  help?: string
  required?: boolean
  /** For "model"/"host" fields: sibling paths the picker/credential UI reads. */
  providerKey?: string
  hostKey?: string
  apiKeyKey?: string
}

export interface ConfigGroup {
  id: string
  title: string
  description?: string
  defaultOpen?: boolean
  fields: ConfigField[]
}

// ── backend payload shapes (from `wanshi schema --json`) ────────────────────

interface JsonSchemaNode {
  type?: string | string[]
  enum?: string[]
  default?: unknown
  description?: string
  properties?: Record<string, JsonSchemaNode>
  items?: JsonSchemaNode
}

interface SchemaFieldMeta {
  path: string
  label: string
  widget: FieldType
  placeholder?: string
  required?: boolean
  core?: boolean
  pathLike?: boolean
  controlled?: boolean
  providerPath?: string
  hostPath?: string
  apiKeyPath?: string
}

interface SchemaGroupMeta {
  id: string
  title: string
  description?: string
  defaultOpen?: boolean
  fields: SchemaFieldMeta[]
}

export interface SchemaPayload {
  jsonSchema: {
    properties?: Record<string, JsonSchemaNode>
    definitions?: Record<string, JsonSchemaNode>
  }
  groups: SchemaGroupMeta[]
  controlledPaths: string[]
}

// ── JSON Schema navigation ──────────────────────────────────────────────────

/** zod-to-json-schema wraps the schema under definitions.KgGenConfig when named. */
function rootNode(payload: SchemaPayload): JsonSchemaNode {
  const js = payload.jsonSchema
  return (js.definitions?.KgGenConfig as JsonSchemaNode) ?? (js as JsonSchemaNode)
}

function nodeAt(payload: SchemaPayload, path: string): JsonSchemaNode | undefined {
  let node: JsonSchemaNode | undefined = rootNode(payload)
  for (const part of path.split(".")) {
    node = node?.properties?.[part]
    if (!node) return undefined
  }
  return node
}

function enumAt(payload: SchemaPayload, path: string): string[] | undefined {
  return nodeAt(payload, path)?.enum
}

function defaultAt(payload: SchemaPayload, path: string): unknown {
  return nodeAt(payload, path)?.default
}

// ── path helpers ────────────────────────────────────────────────────────────

export function getPath(obj: Record<string, unknown>, path: string): unknown {
  let node: unknown = obj
  for (const part of path.split(".")) {
    if (node == null || typeof node !== "object") return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".")
  let node = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (typeof node[k] !== "object" || node[k] === null) node[k] = {}
    node = node[k] as Record<string, unknown>
  }
  node[parts[parts.length - 1]] = value
}

// ── adapt payload → form metadata ───────────────────────────────────────────

/** Convert the backend schema payload into the form's group/field metadata. */
export function adaptGroups(payload: SchemaPayload): ConfigGroup[] {
  return payload.groups.map((g) => ({
    id: g.id,
    title: g.title,
    description: g.description,
    defaultOpen: g.defaultOpen,
    fields: g.fields.map<ConfigField>((f) => ({
      key: f.path,
      label: f.label,
      type: f.widget,
      options: enumAt(payload, f.path),
      placeholder: f.placeholder,
      required: f.required,
      help: nodeAt(payload, f.path)?.description,
      providerKey: f.providerPath,
      hostKey: f.hostPath,
      apiKeyKey: f.apiKeyPath,
    })),
  }))
}

function allFields(payload: SchemaPayload): SchemaFieldMeta[] {
  return payload.groups.flatMap((g) => g.fields)
}

/** Path fields (resolved to absolute on import). */
export function pathFieldKeys(payload: SchemaPayload): string[] {
  return allFields(payload)
    .filter((f) => f.pathLike)
    .map((f) => f.path)
}

/** Field paths the run form treats as secrets (never persisted to localStorage). */
export function secretFieldKeys(payload: SchemaPayload): string[] {
  return allFields(payload)
    .filter((f) => f.widget === "password")
    .map((f) => f.path)
}

// ── values ⇄ nested config ──────────────────────────────────────────────────

function toFieldValue(widget: FieldType, val: unknown): FieldValue {
  if (widget === "boolean") return Boolean(val)
  if (widget === "lines") return Array.isArray(val) ? val.map(String).join("\n") : String(val)
  return String(val)
}

/** Initial flat form values from the schema defaults. */
export function buildDefaultValues(payload: SchemaPayload): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {}
  for (const f of allFields(payload)) {
    const def = defaultAt(payload, f.path)
    values[f.path] =
      def != null ? toFieldValue(f.widget, def) : f.widget === "boolean" ? false : ""
  }
  return values
}

/** Coerce a form value to its real type, or undefined to omit it from the config. */
function coerce(widget: FieldType, raw: FieldValue | undefined): unknown {
  if (widget === "boolean") return Boolean(raw)
  const s = raw == null ? "" : String(raw)
  if (widget === "number") {
    if (s.trim() === "") return undefined
    const n = Number(s)
    return Number.isFinite(n) ? n : undefined
  }
  if (widget === "lines") {
    const arr = s.split("\n").map((x) => x.trim()).filter(Boolean)
    return arr.length ? arr : undefined
  }
  const t = s.trim()
  return t === "" ? undefined : t
}

/** Assemble the nested config object the CLI consumes from flat form values. */
export function valuesToConfig(
  values: Record<string, FieldValue>,
  payload: SchemaPayload
): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const f of allFields(payload)) {
    if (f.controlled) continue
    const v = coerce(f.widget, values[f.path])
    if (v !== undefined) setPath(config, f.path, v)
  }
  return config
}

/** Flatten an imported nested config into the form's flat values. */
export function configToValues(
  config: Record<string, unknown>,
  payload: SchemaPayload
): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {}
  for (const f of allFields(payload)) {
    const v = getPath(config, f.path)
    if (v != null) values[f.path] = toFieldValue(f.widget, v)
  }
  return values
}
