"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import YAML from "yaml"
import { Play, Loader2, Upload } from "lucide-react"
import { PageHeader } from "@/components/layout/page-header"
import { Button } from "@/components/ui/button"
import { ConfigForm } from "@/components/config-form"
import { useStartRun } from "@/hooks/use-runs"
import { apiPost } from "@/lib/api"
import {
  buildDefaultValues,
  flattenConfig,
  partitionValues,
  PATH_KEYS,
  type FieldValue,
} from "@/lib/config-schema"

export default function RunPage() {
  const router = useRouter()
  const start = useStartRun()
  const [values, setValues] = useState<Record<string, FieldValue>>(() =>
    buildDefaultValues()
  )
  const [importExtra, setImportExtra] = useState<Record<string, unknown>>({})
  const fileRef = useRef<HTMLInputElement>(null)

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
