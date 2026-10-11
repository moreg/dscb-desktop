import { describe, it, expect } from 'vitest'
import { build } from 'esbuild'

describe('renderer browser imports', () => {
  it('bundles chapter auditing without Node.js builtins', async () => {
    const result = await build({
      entryPoints: ['src/main/data/chapter-audit.ts'],
      bundle: true,
      platform: 'browser',
      write: false,
      logLevel: 'silent'
    })
    expect(result.outputFiles[0].text.length).toBeGreaterThan(0)
  })
})
