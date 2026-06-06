"use client"

/**
 * Encrypted-at-rest localStorage store for provider endpoints (host + API key),
 * ported from gol-eval. AES-GCM via the Web Crypto API — obfuscation, not true
 * security against local access. Keyed by host so multiple endpoints coexist.
 */
const STORAGE_KEY = "kg-gen-api-credentials"
const SALT = new TextEncoder().encode("kg-gen-credential-salt-v1")

export interface StoredCredential {
  host: string
  apiKey: string
}

async function deriveKey(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode((navigator.userAgent || "kg-gen").slice(0, 64)),
    "PBKDF2",
    false,
    ["deriveKey"]
  )
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: SALT, iterations: 100_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

async function encrypt(plain: string): Promise<string> {
  const key = await deriveKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain)
  )
  const combined = new Uint8Array(iv.length + ct.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ct), iv.length)
  return btoa(String.fromCharCode(...combined))
}

async function decrypt(b64: string): Promise<string> {
  const key = await deriveKey()
  const combined = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const iv = combined.slice(0, 12)
  const ct = combined.slice(12)
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct)
  return new TextDecoder().decode(pt)
}

export async function loadCredentials(): Promise<StoredCredential[]> {
  if (typeof window === "undefined") return []
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(await decrypt(raw))
    return Array.isArray(parsed) ? (parsed as StoredCredential[]) : []
  } catch {
    return []
  }
}

export async function saveCredential(host: string, apiKey: string): Promise<void> {
  if (!host) return
  const creds = await loadCredentials()
  const i = creds.findIndex((c) => c.host === host)
  if (i >= 0) creds[i].apiKey = apiKey
  else creds.push({ host, apiKey })
  localStorage.setItem(STORAGE_KEY, await encrypt(JSON.stringify(creds)))
}

export async function deleteCredential(host: string): Promise<void> {
  const creds = (await loadCredentials()).filter((c) => c.host !== host)
  if (creds.length === 0) localStorage.removeItem(STORAGE_KEY)
  else localStorage.setItem(STORAGE_KEY, await encrypt(JSON.stringify(creds)))
}
