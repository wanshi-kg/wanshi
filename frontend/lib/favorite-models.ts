"use client"

/**
 * Favorite models, persisted as a plain JSON set of `provider:modelId` keys in
 * localStorage. Ported from gol-eval. Favorites sort to the top of the picker.
 */
const STORAGE_KEY = "kg-gen-favorite-models"

function readStore(): Set<string> {
  if (typeof window === "undefined") return new Set()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch {
    return new Set()
  }
}

function writeStore(favorites: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...favorites]))
  } catch {
    // ignore quota / private mode
  }
}

/** Namespaced key so the same model id across providers doesn't collide. */
export function favoriteKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`
}

export function getFavorites(): Set<string> {
  return readStore()
}

export function toggleFavorite(key: string): Set<string> {
  const fav = readStore()
  if (fav.has(key)) fav.delete(key)
  else fav.add(key)
  writeStore(fav)
  return fav
}

export function isFavorite(key: string): boolean {
  return readStore().has(key)
}
