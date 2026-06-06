"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Save, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  deleteCredential,
  loadCredentials,
  saveCredential,
  type StoredCredential,
} from "@/lib/credential-store"
import type { ConfigField, FieldValue } from "@/lib/config-schema"

/** Host input + Save/Load of {host, apiKey} credentials (encrypted localStorage). */
export function HostField({
  field,
  value,
  values,
  onChange,
}: {
  field: ConfigField
  value: string
  values: Record<string, FieldValue>
  onChange: (key: string, value: FieldValue) => void
}) {
  const [saved, setSaved] = useState<StoredCredential[]>([])
  const apiKey = field.apiKeyKey ? String(values[field.apiKeyKey] ?? "") : ""

  useEffect(() => {
    loadCredentials().then(setSaved)
  }, [])

  async function save() {
    if (!value) return
    await saveCredential(value, apiKey)
    setSaved(await loadCredentials())
    toast.success("Endpoint saved")
  }

  function load(host: string) {
    const c = saved.find((s) => s.host === host)
    if (!c) return
    onChange(field.key, c.host)
    if (field.apiKeyKey) onChange(field.apiKeyKey, c.apiKey)
  }

  async function remove() {
    if (!value) return
    await deleteCredential(value)
    setSaved(await loadCredentials())
    toast.message("Endpoint removed")
  }

  const isSaved = saved.some((c) => c.host === value)

  return (
    <div className="space-y-1.5">
      <Label htmlFor={field.key}>{field.label}</Label>
      <Input
        id={field.key}
        className="font-mono text-xs"
        placeholder={field.placeholder}
        value={value}
        onChange={(e) => onChange(field.key, e.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="xs" onClick={save} disabled={!value}>
          <Save className="h-3 w-3" /> Save
        </Button>
        {isSaved && (
          <Button type="button" variant="ghost" size="xs" onClick={remove} title="Remove saved">
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
        {saved.length > 0 && (
          <Select onValueChange={load}>
            <SelectTrigger className="h-7 w-44 text-xs">
              <SelectValue placeholder="Load saved…" />
            </SelectTrigger>
            <SelectContent>
              {saved.map((c) => (
                <SelectItem key={c.host} value={c.host} className="text-xs">
                  {c.host.replace(/^https?:\/\//, "").slice(0, 30)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  )
}
