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
 * Sable's 12-hue categorical scale — one lightness/chroma band, spread around
 * the wheel but clear of the glow-cyan brand hue and the alarm reds, legible on
 * both petrol-dark and pale-light grounds. Mirrored as `--color-entity-*` in
 * globals.css; this array is the SSR/canvas fallback.
 */
const PALETTE = [
  "#6e8ae6",
  "#9d7ae6",
  "#c46fcb",
  "#de6e9b",
  "#e08a5c",
  "#cbae3f",
  "#9ab84a",
  "#4fb87e",
  "#3fb2b0",
  "#54a6c8",
  "#5e93d6",
  "#b96fb0",
]

function hash(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h)
}

/**
 * Deterministic categorical color for an entity/relation type, stable across the
 * charts and the graph. Resolves the `--color-entity-<n>` token (so Sable's scale
 * is the single source) with the JS palette as the SSR/unset fallback.
 */
export function colorForType(type: string): string {
  const idx = hash(type) % PALETTE.length
  return resolveToken(`--color-entity-${idx + 1}`) || PALETTE[idx]
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
