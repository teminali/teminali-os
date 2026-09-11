/**
 * Ambient types for Vite's import suffixes.
 *
 * Declared here rather than by referencing `vite/client`, which would also pull
 * in DOM asset and `import.meta.env` shapes this project does not use. Only the
 * suffixes actually imported are declared, so an unhandled one still fails the
 * typecheck instead of resolving to `any`.
 */

/** Source text of a file, imported verbatim. Used for the audio worklets. */
declare module "*?raw" {
  const content: string;
  export default content;
}
