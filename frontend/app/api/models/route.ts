import { NextResponse } from "next/server"
import type { ModelOption } from "@/types"

export const dynamic = "force-dynamic"

/**
 * List the models a provider offers, proxied server-side (avoids CORS and keeps
 * the API key off cross-origin browser requests). Never throws — an unreachable
 * host returns { models: [], error }.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const provider = body?.provider === "openai" ? "openai" : "ollama"
  const host = typeof body?.host === "string" ? body.host.trim() : ""
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey : ""
  if (!host) return NextResponse.json({ models: [], error: "host required" })

  try {
    const models =
      provider === "openai"
        ? await listOpenAI(host, apiKey)
        : await listOllama(host)
    return NextResponse.json({ models })
  } catch (err) {
    return NextResponse.json({
      models: [],
      error: err instanceof Error ? err.message : "failed to list models",
    })
  }
}

function fetchWithTimeout(url: string, init?: RequestInit, ms = 5000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(t))
}

function stripSlash(s: string): string {
  return s.replace(/\/+$/, "")
}

async function listOllama(host: string): Promise<ModelOption[]> {
  const res = await fetchWithTimeout(`${stripSlash(host)}/api/tags`)
  if (!res.ok) throw new Error(`Ollama responded ${res.status}`)
  const data = (await res.json()) as {
    models?: { name: string; size?: number; details?: { parameter_size?: string } }[]
  }
  return (data.models ?? []).map((m) => ({
    id: m.name,
    label: m.name,
    size: m.details?.parameter_size || humanBytes(m.size),
  }))
}

async function listOpenAI(host: string, apiKey: string): Promise<ModelOption[]> {
  const res = await fetchWithTimeout(`${stripSlash(host)}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  })
  if (!res.ok) throw new Error(`Provider responded ${res.status}`)
  const data = (await res.json()) as { data?: { id: string }[] }
  return (data.data ?? []).map((m) => ({ id: m.id, label: m.id }))
}

function humanBytes(n?: number): string | undefined {
  if (!n || n <= 0) return undefined
  const gb = n / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)}GB`
  return `${(n / 1024 ** 2).toFixed(0)}MB`
}
