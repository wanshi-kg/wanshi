"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import YAML from "yaml"
import { Play, Loader2, Upload, Download, Copy, FileDown } from "lucide-react"
import { PageHeader } from "@/components/layout/page-header"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ConfigForm } from "@/components/config-form"
import { useStartRun } from "@/hooks/use-runs"
import { useConfigSchema } from "@/hooks/use-config-schema"
import { apiPost } from "@/lib/api"
import { configToYaml } from "@/lib/config-export"
import { makeStorageKey } from "@/lib/local-storage"
import {
  adaptGroups,
  buildDefaultValues,
  configToValues,
  valuesToConfig,
  pathFieldKeys,
  secretFieldKeys,
  type FieldValue,
  type SchemaPayload,
} from "@/lib/config-schema"

// Remember the last config across reloads. API keys are NOT persisted here —
// they live (encrypted) in the credential store.
const FORM_STORAGE_KEY = makeStorageKey("run-form", "state")

function loadStoredValues(): Record<string, FieldValue> {
  if (typeof window === "undefined") return {}
  try {
    const raw = localStorage.getItem(FORM_STORAGE_KEY)
    return raw ? (JSON.parse(raw).values ?? {}) : {}
  } catch {
    return {}
  }
}

export default function RunPage() {
  const router = useRouter()
  const start = useStartRun()
  const { data: schema, isLoading, error } = useConfigSchema()

  const groups = useMemo(() => (schema ? adaptGroups(schema) : []), [schema])
  const [values, setValues] = useState<Record<string, FieldValue>>({})
  const [ready, setReady] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Initialize form values from the schema defaults + last-used config once the
  // schema arrives.
  useEffect(() => {
    if (schema && !ready) {
      setValues({ ...buildDefaultValues(schema), ...loadStoredValues() })
      setReady(true)
    }
  }, [schema, ready])

  // Persist (minus secrets) so the form reopens with the last-used config.
  useEffect(() => {
    if (!schema || !ready) return
    const persistable = { ...values }
    for (const k of secretFieldKeys(schema)) delete persistable[k]
    try {
      localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify({ values: persistable }))
    } catch {
      // ignore quota / private mode
    }
  }, [values, schema, ready])

  const set = (key: string, value: FieldValue) =>
    setValues((v) => ({ ...v, [key]: value }))

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = "" // allow re-importing the same file
    if (!file || !schema) return
    try {
      // YAML.parse also accepts JSON (JSON is valid YAML).
      const parsed = YAML.parse(await file.text())
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("config must be a YAML/JSON object")
      }
      const imported = configToValues(parsed as Record<string, unknown>, schema)

      // Resolve path fields to absolute against the run dir (the browser can't
      // see the config file's location; a relative output would otherwise
      // double-nest under the input dir at run time).
      const pathKeys = pathFieldKeys(schema).filter(
        (k) => imported[k] != null && String(imported[k]).trim() !== ""
      )
      if (pathKeys.length) {
        try {
          const { resolved } = await apiPost<{ resolved: string[] }>(
            "/api/config/resolve",
            { paths: pathKeys.map((k) => String(imported[k])) }
          )
          pathKeys.forEach((k, i) => {
            imported[k] = resolved[i]
          })
        } catch {
          // fall back to the raw (relative) paths
        }
      }

      setValues((v) => ({ ...v, ...imported }))
      toast.success("Config imported")
    } catch (err) {
      toast.error(
        `Couldn't parse config: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!schema) return
    if (!String(values.input ?? "").trim()) {
      toast.error("Input directory is required")
      return
    }
    if (!String(values.filter ?? "").split("\n").some((s) => s.trim())) {
      toast.error("At least one include pattern is required")
      return
    }
    if (!String(values["llm.model"] ?? "").trim()) {
      toast.error("Model is required")
      return
    }
    if (!String(values.output ?? "").trim()) {
      toast.error("Output file is required")
      return
    }
    const config = valuesToConfig(values, schema)
    start.mutate(config, {
      onSuccess: ({ run }) => {
        toast.success("Run started")
        router.push(`/runs/${run.id}`)
      },
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : "Failed to start run"),
    })
  }

  async function copyYaml() {
    if (!schema) return
    try {
      await navigator.clipboard.writeText(configToYaml(values, schema))
      toast.success("Config YAML copied to clipboard")
    } catch {
      toast.error("Failed to copy YAML")
    }
  }

  function downloadYaml() {
    if (!schema) return
    try {
      const blob = new Blob([configToYaml(values, schema)], { type: "text/yaml" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "config.yaml"
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error("Failed to download YAML")
    }
  }

  return (
    <form onSubmit={submit}>
      <PageHeader
        title="New run"
        description="Configure and launch. Import a YAML/JSON config to prefill."
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
              disabled={!schema}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-4 w-4" />
              Import config
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm" disabled={!schema}>
                  <Download className="h-4 w-4" />
                  Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={copyYaml}>
                  <Copy className="mr-2 h-4 w-4" /> Copy YAML
                </DropdownMenuItem>
                <DropdownMenuItem onClick={downloadYaml}>
                  <FileDown className="mr-2 h-4 w-4" /> Download config.yaml
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button type="submit" size="sm" disabled={start.isPending || !ready}>
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

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading config schema…
        </div>
      )}
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Couldn&apos;t load the config schema. Build the wanshi backend
          (<span className="font-mono">npm run build</span> in the repo root) and reload.
        </div>
      )}

      {ready && <ConfigForm groups={groups} values={values} onChange={set} />}
    </form>
  )
}
