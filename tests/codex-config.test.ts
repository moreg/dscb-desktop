import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { getCodexReasoningEffort, setCodexReasoningEffort } from '../src/main/data/codex-config'

describe('Codex global reasoning config', () => {
  it('reads the configured effort and falls back to medium', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-codex-config-'))
    const config = path.join(dir, 'config.toml')
    await writeFile(config, 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n')
    await expect(getCodexReasoningEffort(config)).resolves.toBe('high')
    await expect(getCodexReasoningEffort(path.join(dir, 'missing.toml'))).resolves.toBe('medium')
  })

  it('updates only model_reasoning_effort and preserves other config', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-codex-config-'))
    const config = path.join(dir, 'config.toml')
    await writeFile(config, '# keep this\nmodel = "gpt-5.6-sol"\nmodel_reasoning_effort = "low"\n')
    await expect(setCodexReasoningEffort('xhigh', config)).resolves.toBe('xhigh')
    await expect(readFile(config, 'utf8')).resolves.toBe(
      '# keep this\nmodel = "gpt-5.6-sol"\nmodel_reasoning_effort = "xhigh"\n'
    )
  })
})
