/**
 * The single color CHOKEPOINT. Every categorical / trust color decision routes
 * through here, so Sable's color-book can override values via CSS custom
 * properties WITHOUT touching a component.
 *
 * Two consumers, two mechanisms:
 *  - DOM (badges, chips, inspector) → reference the CSS var directly via
 *    {@link trustVar} (SSR-safe, no JS color resolution → no hydration mismatch).
 *  - Canvas (the force-graph paints to a raw <canvas> that CANNOT read CSS vars)
 *    → {@link trustColor} / {@link resolveToken} resolve the var to a string,
 *    cached and invalidated on light/dark toggle (the graph repaints per node
 *    per frame, so an uncached getComputedStyle would thrash layout).
 */
import type { TrustState } from "./trust"

// --- token resolution (canvas bridge) ---------------------------------------

const tokenCache = new Map<string, string>()
let observing = false

/** Clear the cache whenever the theme (`.dark` on <html>) flips. Lazy, once. */
function ensureThemeObserver(): void {
  if (observing || typeof document === "undefined" || typeof MutationObserver === "undefined") return
  observing = true
  new MutationObserver(() => tokenCache.clear()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  })
}

/**
 * Resolve a CSS custom property (e.g. "--color-trust-grounded") to its computed
 * string, for use on the canvas. Returns "" on the server / when unset (callers
 * supply a fallback). Cached because the graph repaints per-node-per-frame.
 */
export function resolveToken(name: string): string {
  if (typeof document === "undefined") return ""
  const hit = tokenCache.get(name)
  if (hit !== undefined) return hit
  ensureThemeObserver()
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  tokenCache.set(name, v)
  return v
}

// --- entity-type categorical color ------------------------------------------

/**
 * Deterministic categorical color for an entity (or relation) type, so the same
 * type gets the same color across the charts and the graph. Palette is tuned to
 * read on both light and dark backgrounds. This array is itself the chokepoint
 * for the entity-type palette — Sable's domain-extensible scheme replaces it here
 * (a CSS-var-driven entity scale is the convergence follow-up).
 */
const PALETTE = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ef4444", // red
  "#14b8a6", // teal
  "#ec4899", // pink
  "#84cc16", // lime
  "#f97316", // orange
  "#6366f1", // indigo
  "#06b6d4", // cyan
  "#a855f7", // purple
]

function hash(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h)
}

export function colorForType(type: string): string {
  return PALETTE[hash(type) % PALETTE.length]
}

export { PALETTE as TYPE_PALETTE }

// --- trust-state color (the brief's identity seam) --------------------------

/**
 * Grayscale PLACEHOLDERS — deliberately neutral so this pass makes no palette
 * decision Sable would have to undo (states stay distinguishable by their icon +
 * label until his trust color-book overwrites these `--color-trust-*` values).
 * These hex values are only the SSR / unset fallback; the CSS vars win in-browser.
 */
const TRUST_FALLBACK: Record<TrustState, string> = {
  grounded: "#71717a",
  ungrounded: "#52525b",
  uncertain: "#a1a1aa",
  contradicted: "#3f3f46",
  superseded: "#a1a1aa",
  "tool-derived": "#71717a",
  unknown: "#d4d4d8",
}

/** CSS-var string for a trust state — for DOM styling (SSR-safe). */
export function trustVar(state: TrustState): string {
  return `var(--color-trust-${state})`
}

/** Resolved color string for a trust state — for the canvas. */
export function trustColor(state: TrustState): string {
  return resolveToken(`--color-trust-${state}`) || TRUST_FALLBACK[state]
}
