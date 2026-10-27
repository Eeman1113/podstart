/**
 * Copies the two WebAssembly modules we rely on out of node_modules and into
 * public/vendor, where they are served as plain static files.
 *
 * Why not just import them? Both are Emscripten glue bundles: they rewrite
 * `import.meta.url`, probe for `fs`, and resolve their .wasm sibling relative
 * to their own script URL. Bundlers mangle all three. Loading them at runtime
 * from a known URL -- with an explicit locateFile -- is the only arrangement
 * that survives both `next dev` and a static export on GitHub Pages.
 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, 'public/vendor')

const files = [
  ['node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.js', 'rnnoise/rnnoise.js'],
  ['node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.wasm', 'rnnoise/rnnoise.wasm'],
  ['node_modules/libflacjs/dist/libflac.min.wasm.js', 'flac/libflac.js'],
  ['node_modules/libflacjs/dist/libflac.min.wasm.wasm', 'flac/libflac.wasm'],
]

for (const [from, to] of files) {
  const dest = resolve(out, to)
  await mkdir(dirname(dest), { recursive: true })
  await cp(resolve(root, from), dest)
}

// The rnnoise glue is an ES module that leans on `import.meta.url`; the flac glue
// is UMD and expects `self`. We load each in the form it wants, so the only fixup
// needed is making rnnoise importable from a classic worker context too.
const rn = resolve(out, 'rnnoise/rnnoise.js')
const src = await readFile(rn, 'utf8')
if (!src.includes('export default')) {
  // Older builds attach to a var instead of exporting; normalise it.
  await writeFile(rn, `${src}\nexport default createRNNWasmModule;\n`)
}

console.log(`vendored ${files.length} files -> public/vendor`)
