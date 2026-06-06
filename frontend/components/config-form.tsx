"use client"

import { ChevronRight } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { CONFIG_GROUPS, type ConfigField, type FieldValue } from "@/lib/config-schema"

function Field({
  field,
  value,
  onChange,
}: {
  field: ConfigField
  value: FieldValue | undefined
  onChange: (key: string, value: FieldValue) => void
}) {
  if (field.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={!!value}
          onCheckedChange={(v) => onChange(field.key, v === true)}
        />
        {field.label}
      </label>
    )
  }

  const str = value == null ? "" : String(value)
  const mono = field.type === "path"

  return (
    <div className="space-y-1.5">
      <Label htmlFor={field.key}>
        {field.label}
        {field.required && <span className="text-destructive"> *</span>}
      </Label>
      {field.type === "lines" ? (
        <Textarea
          id={field.key}
          rows={3}
          className="font-mono text-xs"
          placeholder={field.placeholder}
          value={str}
          onChange={(e) => onChange(field.key, e.target.value)}
        />
      ) : field.type === "select" ? (
        <Select value={str} onValueChange={(v) => onChange(field.key, v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={field.key}
          type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
          className={cn(mono && "font-mono text-xs")}
          placeholder={field.placeholder}
          value={str}
          onChange={(e) => onChange(field.key, e.target.value)}
        />
      )}
      {field.help && <p className="text-[11px] text-muted-foreground">{field.help}</p>}
    </div>
  )
}

export function ConfigForm({
  values,
  onChange,
}: {
  values: Record<string, FieldValue>
  onChange: (key: string, value: FieldValue) => void
}) {
  return (
    <div className="space-y-3">
      {CONFIG_GROUPS.map((group) => (
        <Collapsible
          key={group.id}
          defaultOpen={group.defaultOpen}
          className="overflow-hidden rounded-xl border bg-card"
        >
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition-colors hover:bg-accent/40">
            <div className="min-w-0">
              <div className="font-semibold">{group.title}</div>
              {group.description && (
                <div className="text-xs text-muted-foreground">{group.description}</div>
              )}
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t px-5 py-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {group.fields.map((f) => (
                <div key={f.key} className={cn(f.type === "lines" && "sm:col-span-2")}>
                  <Field field={f} value={values[f.key]} onChange={onChange} />
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  )
}
