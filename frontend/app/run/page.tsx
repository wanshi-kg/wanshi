"use client"

import { useEffect, useRef, useState } from "react"
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
import { apiPost } from "@/lib/api"
import { configToYaml } from "@/lib/config-export"
import { makeStorageKey } from "@/lib/local-storage"
import {
  buildDefaultValues,
  flattenConfig,
  partitionValues,
  PATH_KEYS,
  type FieldValue,
} from "@/lib/config-schema"

// Remember the last config across reloads. API keys are NOT persisted here —
// they live (encrypted) in the credential store.
const FORM_STORAGE_KEY = makeStorageKey("run-form", "state")
const SECRET_KEYS = ["apiKey", "embeddingsApiKey"]

function loadStoredState(): {
  values?: Record<string, FieldValue>
  importExtra?: Record<string, unknown>
} {
  if (typeof window === "undefined") return {}
  try {
    const raw = localStorage.getItem(FORM_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export default function RunPage() {
  const router = useRouter()
  const start = useStartRun()
  const [values, setValues] = useState<Record<string, FieldValue>>(() => ({
    ...buildDefaultValues(),
    ...(loadStoredState().values ?? {}),
  }))
  const [importExtra, setImportExtra] = useState<Record<string, unknown>>(
    () => loadStoredState().importExtra ?? {}
  )
  const fileRef = useRef<HTMLInputElement>(null)

  // Persist (minus secrets) so the form reopens with the last-used config.
  useEffect(() => {
    const persistable = { ...values }
    for (const k of SECRET_KEYS) delete persistable[k]
    try {
      localStorage.setItem(
        FORM_STORAGE_KEY,
        JSON.stringify({ values: persistable, importExtra })
      )
    } catch {
      // ignore quota / private mode
    }
  }, [values, importExtra])

  const set = (key: string, value: FieldValue) =>
    setValues((v) => ({ ...v, [key]: value }))

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
      const { values: imported, extra } = flattenConfig(
        parsed as Record<string, unknown>
      )

      // Resolve path fields to absolute against the run dir (the browser can't
      // see the config file's location; a relative output would otherwise
      // double-nest under the input dir at run time).
      const pathKeys = PATH_KEYS.filter(
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
      setImportExtra(extra)
      const n = Object.keys(extra).length
      toast.success(
        `Config imported${n ? ` · ${n} unknown field${n > 1 ? "s" : ""} passed through` : ""}`
      )
    } catch (err) {
      toast.error(
        `Couldn't parse config: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!String(values.input ?? "").trim()) {
      toast.error("Input directory is required")
      return
    }
    if (!String(values.filter ?? "").split("\n").some((s) => s.trim())) {
      toast.error("At least one include pattern is required")
      return
    }
    if (!String(values.model ?? "").trim()) {
      toast.error("Model is required")
      return
    }
    if (!String(values.output ?? "").trim()) {
      toast.error("Output file is required")
      return
    }
    const { req, passthrough } = partitionValues(values, importExtra)
    start.mutate(
      { req, passthrough },
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

  async function copyYaml() {
    try {
      await navigator.clipboard.writeText(configToYaml(values, importExtra))
      toast.success("Config YAML copied to clipboard")
    } catch {
      toast.error("Failed to copy YAML")
    }
  }

  function downloadYaml() {
    try {
      const blob = new Blob([configToYaml(values, importExtra)], { type: "text/yaml" })
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

  const extraKeys = Object.keys(importExtra)

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
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-4 w-4" />
              Import config
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm">
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

      {extraKeys.length > 0 && (
        <div className="mb-4 rounded-md border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {extraKeys.length} unknown imported field{extraKeys.length > 1 ? "s" : ""}
          </span>{" "}
          passed through: <span className="font-mono">{extraKeys.join(", ")}</span>
        </div>
      )}

      <ConfigForm values={values} onChange={set} />
    </form>
  )
}
