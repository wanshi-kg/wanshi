"use client"

import { useMemo, useState } from "react"
import { ChevronsUpDown, Star, RotateCw, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { useModels } from "@/hooks/use-models"
import { favoriteKey, getFavorites, toggleFavorite } from "@/lib/favorite-models"

export function ModelPicker({
  value,
  onChange,
  provider,
  host,
  apiKey,
}: {
  value: string
  onChange: (v: string) => void
  provider: string
  host: string
  apiKey?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set())

  const { data, isFetching, refetch } = useModels(provider, host, apiKey, open)
  const models = data?.models ?? []
  const error = data?.error

  // hydrate favorites when the popover opens (client-only localStorage)
  function handleOpen(next: boolean) {
    setOpen(next)
    if (next) setFavorites(getFavorites())
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = q
      ? models.filter(
          (m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)
        )
      : models
    return [...list].sort((a, b) => {
      const af = favorites.has(favoriteKey(provider, a.id)) ? 0 : 1
      const bf = favorites.has(favoriteKey(provider, b.id)) ? 0 : 1
      if (af !== bf) return af - bf
      return a.label.localeCompare(b.label)
    })
  }, [models, search, favorites, provider])

  const typed = search.trim()
  const showFreeText = typed && !models.some((m) => m.id === typed)

  function select(id: string) {
    onChange(id)
    setOpen(false)
    setSearch("")
  }

  function star(e: React.MouseEvent, id: string) {
    e.preventDefault()
    e.stopPropagation()
    setFavorites(new Set(toggleFavorite(favoriteKey(provider, id))))
  }

  return (
    <Popover open={open} onOpenChange={handleOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          className="w-full justify-between font-normal"
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value || "Select a model…"}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command shouldFilter={false}>
          <div className="flex items-center border-b pr-1">
            <CommandInput
              placeholder="Search or type a model…"
              value={search}
              onValueChange={setSearch}
              className="border-0"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title="Refresh"
              onClick={() => refetch()}
            >
              {isFetching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCw className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
          <CommandList>
            {error && (
              <div className="px-3 py-2 text-xs text-amber-600">
                Couldn&apos;t list models ({error}). Type a name below.
              </div>
            )}
            {!error && filtered.length === 0 && !showFreeText && (
              <CommandEmpty>
                {isFetching ? "Loading…" : "No models found."}
              </CommandEmpty>
            )}
            <CommandGroup>
              {filtered.map((m) => {
                const isFav = favorites.has(favoriteKey(provider, m.id))
                return (
                  <CommandItem
                    key={m.id}
                    value={m.id}
                    onSelect={() => select(m.id)}
                    className="gap-2"
                  >
                    <button
                      type="button"
                      onClick={(e) => star(e, m.id)}
                      className="shrink-0 p-0.5 transition-colors hover:text-yellow-500"
                      title={isFav ? "Unfavorite" : "Favorite"}
                    >
                      <Star
                        className={cn(
                          "h-3.5 w-3.5",
                          isFav ? "fill-yellow-500 text-yellow-500" : "text-muted-foreground/40"
                        )}
                      />
                    </button>
                    <span className="flex-1 truncate" title={m.id}>
                      {m.label}
                    </span>
                    {m.size && (
                      <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
                        {m.size}
                      </Badge>
                    )}
                    {value === m.id && <span className="text-xs text-muted-foreground">✓</span>}
                  </CommandItem>
                )
              })}
              {showFreeText && (
                <CommandItem value={`__free__${typed}`} onSelect={() => select(typed)}>
                  Use <span className="ml-1 font-mono">&quot;{typed}&quot;</span>
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
