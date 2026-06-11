/**
 * Import an ESM-only package from this CommonJS build.
 *
 * TypeScript with `module: CommonJS` rewrites a literal `import()` into
 * `require()`, which throws `ERR_REQUIRE_ESM` for pure-ESM packages (e.g.
 * @extractus/article-extractor). Hiding the `import()` inside `new Function`
 * keeps it a genuine dynamic import at runtime.
 */
export const importEsm = new Function(
  "specifier",
  "return import(specifier)"
) as <T = any>(specifier: string) => Promise<T>;
