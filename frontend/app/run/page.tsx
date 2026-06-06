"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import YAML from "yaml"
import { Play, Loader2, Upload } from "lucide-react"
import { PageHeader } from "@/components/layout/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useStartRun } from "@/hooks/use-runs"
import {
  DEFAULT_RUN_REQUEST,
  splitImportedConfig,
  type RunRequest,
} from "@/lib/kg-options"

function toLines(value: string): string[] {
  return value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
}

export default function RunPage() {
  const router = useRouter()
  const start = useStartRun()

  const [input, setInput] = useState("")
  const [filter, setFilter] = useState(DEFAULT_RUN_REQUEST.filter.join("\n"))
  const [exclude, setExclude] = useState(DEFAULT_RUN_REQUEST.exclude.join("\n"))
  const [provider, setProvider] = useState<RunRequest["provider"]>("ollama")
  const [model, setModel] = useState(DEFAULT_RUN_REQUEST.model)
  const [host, setHost] = useState(DEFAULT_RUN_REQUEST.host)
  const [apiKey, setApiKey] = useState("")
  const [output, setOutput] = useState(DEFAULT_RUN_REQUEST.output)
  const [exportFormat, setExportFormat] =
    useState<RunRequest["exportFormat"]>("json")
  const [chunkSize, setChunkSize] = useState(String(DEFAULT_RUN_REQUEST.chunkSize))
  const [passthrough, setPassthrough] = useState<Record<string, unknown>>({})
  const fileRef = useRef<HTMLInputElement>(null)

  function applyImported(parsed: Record<string, unknown>) {
    const { known, passthrough: extra } = splitImportedConfig(parsed)
    if (known.input != null) setInput(String(known.input))
    if (known.filter) setFilter(known.filter.join("\n"))
    if (known.exclude) setExclude(known.exclude.join("\n"))
    if (known.provider === "ollama" || known.provider === "openai")
      setProvider(known.provider)
    if (known.model != null) setModel(String(known.model))
    if (known.host != null) setHost(String(known.host))
    if (known.apiKey != null) setApiKey(String(known.apiKey))
    if (known.output != null) setOutput(String(known.output))
    if (
      known.exportFormat === "json" ||
      known.exportFormat === "jsonl" ||
      known.exportFormat === "mcp-jsonl" ||
      known.exportFormat === "dot"
    )
      setExportFormat(known.exportFormat)
    if (known.chunkSize != null) setChunkSize(String(known.chunkSize))
    setPassthrough(extra)
    const extraCount = Object.keys(extra).length
    toast.success(
      `Config imported${extraCount ? ` · ${extraCount} extra field${extraCount > 1 ? "s" : ""} passed through` : ""}`
    )
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = "" // allow re-importing the same file
    if (!file) return
    try {
      // YAML.parse also accepts JSON (JSON is valid YAML).
      const parsed = YAML.parse(await file.text())
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("config must be a YAML/JSON object")
      }
      applyImported(parsed as Record<string, unknown>)
    } catch (err) {
      toast.error(
        `Couldn't parse config: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  const passthroughKeys = Object.keys(passthrough)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const filters = toLines(filter)
    if (!input.trim()) {
      toast.error("Input directory is required")
      return
    }
    if (filters.length === 0) {
      toast.error("At least one include pattern is required")
      return
    }
    const req: RunRequest = {
      input: input.trim(),
      filter: filters,
      exclude: toLines(exclude),
      provider,
      model: model.trim(),
      host: host.trim(),
      apiKey: provider === "openai" && apiKey.trim() ? apiKey.trim() : undefined,
      output: output.trim(),
      exportFormat,
      chunkSize: Number(chunkSize) || DEFAULT_RUN_REQUEST.chunkSize,
    }
    start.mutate(
      { req, passthrough: passthroughKeys.length ? passthrough : undefined },
      {
        onSuccess: ({ run }) => {
          toast.success("Run started")
          router.push(`/runs/${run.id}`)
        },
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : "Failed to start run"),
      }
    )
  }

  return (
    <form onSubmit={submit}>
      <PageHeader
        title="New run"
        description="Configure input, model, and output, then launch."
        actions={
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".yaml,.yml,.json"
              className="hidden"
              onChange={onImportFile}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-4 w-4" />
              Import config
            </Button>
            <Button type="submit" size="sm" disabled={start.isPending}>
              {start.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Start run
            </Button>
          </div>
        }
      />

      {passthroughKeys.length > 0 && (
        <div className="mb-4 rounded-md border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {passthroughKeys.length} imported field{passthroughKeys.length > 1 ? "s" : ""}
          </span>{" "}
          passed through to the run:{" "}
          <span className="font-mono">{passthroughKeys.join(", ")}</span>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Input</CardTitle>
            <CardDescription>Directory and file patterns to process.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="input">Input directory</Label>
              <Input
                id="input"
                placeholder="/path/to/project"
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="filter">Include patterns (one per line)</Label>
              <Textarea
                id="filter"
                rows={3}
                className="font-mono text-xs"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exclude">Exclude patterns (one per line)</Label>
              <Textarea
                id="exclude"
                rows={2}
                className="font-mono text-xs"
                value={exclude}
                onChange={(e) => setExclude(e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Model</CardTitle>
            <CardDescription>Generation provider and model.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select
                value={provider}
                onValueChange={(v) => setProvider(v as RunRequest["provider"])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ollama">Ollama (local)</SelectItem>
                  <SelectItem value="openai">OpenAI-compatible</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="model">Model</Label>
              <Input
                id="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="host">Host / base URL</Label>
              <Input
                id="host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
              />
            </div>
            {provider === "openai" && (
              <div className="space-y-1.5">
                <Label htmlFor="apiKey">API key</Label>
                <Input
                  id="apiKey"
                  type="password"
                  placeholder="sk-… (or set $OPENAI_API_KEY)"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Output</CardTitle>
            <CardDescription>Where and how to write the graph.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="output">Output file</Label>
              <Input
                id="output"
                value={output}
                onChange={(e) => setOutput(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Export format</Label>
              <Select
                value={exportFormat}
                onValueChange={(v) =>
                  setExportFormat(v as RunRequest["exportFormat"])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="json">json</SelectItem>
                  <SelectItem value="jsonl">jsonl</SelectItem>
                  <SelectItem value="mcp-jsonl">mcp-jsonl</SelectItem>
                  <SelectItem value="dot">dot</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Processing</CardTitle>
            <CardDescription>Chunking. Runs checkpoint automatically so they can be resumed.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="chunkSize">Chunk size (characters)</Label>
              <Input
                id="chunkSize"
                type="number"
                value={chunkSize}
                onChange={(e) => setChunkSize(e.target.value)}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </form>
  )
}
