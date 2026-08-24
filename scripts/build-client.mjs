/**
 * Build the browser half (src/client → lib/client.js) in the DSH client
 * module-table format: window.__ModuleLoader__.load({ id, factory }) with a
 * CJS factory resolving externals through the injected require.
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Resolved from the loader module table at runtime (never inlined). */
const EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** 构建期注入的插件版本（浏览器端读不到 package.json，define 内联）。 */
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

const result = await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  loader: { '.ts': 'ts' },
  external: EXTERNALS,
  define: { __TN_VERSION__: JSON.stringify(pkg.version) },
  write: false,
  banner: {
    js: 'window.__ModuleLoader__.load({\n\tid: "dsh-turn-notify",\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });'
  },
  footer: {
    js: '\n\t\treturn module.exports;\n\t}\n});'
  }
})

const output = result.outputFiles[0]
if (output === undefined) throw new Error('esbuild produced no output')
mkdirSync(dirname('lib/client.js'), { recursive: true })
writeFileSync('lib/client.js', output.text)
console.log('built lib/client.js (' + output.text.length + ' bytes)')
