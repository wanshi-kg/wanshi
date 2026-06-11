/**
 * Ambient declaration for `jsonrepair`. The package ships types at
 * `lib/types/index.d.ts` via its `exports` map, but this project compiles with
 * classic `moduleResolution: Node`, which ignores `exports` and looks for a
 * `.d.ts` next to `main` (lib/cjs/index.js) — none exists there. This shim
 * surfaces the one symbol we use until/unless module resolution is upgraded.
 */
declare module "jsonrepair" {
  /** Repair a malformed JSON string (e.g. truncated/unterminated output) into valid JSON. */
  export function jsonrepair(text: string): string;
}
