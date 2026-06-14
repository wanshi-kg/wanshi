"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

const STORAGE_PREFIX = "wanshi"

interface LocalStorageOptions<T> {
  sanitize?: (value: unknown) => T
}

type SetStateAction<T> = T | ((prev: T) => T)

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined"
}

function readValue<T>(storageKey: string, fallback: T, sanitize?: (value: unknown) => T) {
  if (!canUseStorage()) return fallback

  try {
    const raw = window.localStorage.getItem(storageKey)
    if (raw === null) return fallback
    const parsed = JSON.parse(raw) as unknown
    return sanitize ? sanitize(parsed) : (parsed as T)
  } catch {
    return fallback
  }
}

export function makeStorageKey(scope: string, key: string, version: number = 1) {
  return `${STORAGE_PREFIX}:v${version}:${scope}:${key}`
}

export function useLocalStorageState<T>(
  storageKey: string | null,
  fallback: T,
  options: LocalStorageOptions<T> = {},
) {
  const { sanitize } = options

  const [state, setState] = useState<T>(() => (
    storageKey ? readValue(storageKey, fallback, sanitize) : fallback
  ))

  useEffect(() => {
    if (!storageKey || !canUseStorage()) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(state))
    } catch {
      // Ignore storage failures (private mode / quota exceeded).
    }
  }, [state, storageKey])

  return [state, setState] as const
}

export function useLocalStorageSetState<T>(
  storageKey: string | null,
  fallback: Iterable<T> = [],
) {
  const fallbackArray = useMemo(() => Array.from(fallback), [fallback])
  const sanitize = useCallback((value: unknown) => (
    Array.isArray(value) ? (value as T[]) : fallbackArray
  ), [fallbackArray])
  const [stored, setStored] = useLocalStorageState<T[]>(storageKey, fallbackArray, {
    sanitize,
  })

  const state = useMemo(() => new Set(stored), [stored])

  const setState = useCallback((next: SetStateAction<Set<T>>) => {
    setStored((previous) => {
      const previousSet = new Set(previous)
      const resolved = typeof next === "function"
        ? (next as (prev: Set<T>) => Set<T>)(previousSet)
        : next
      return Array.from(resolved)
    })
  }, [setStored])

  return [state, setState] as const
}
