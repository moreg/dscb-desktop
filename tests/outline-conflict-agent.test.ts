import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { reconcileOutlineWithHistory } from '../src/main/data/outline-conflict-agent'

describe('细纲冲突自动决策', () => {
  let dir: string, outlinePath: string
  const original = '# 第 4 章\n\n秦牧看到自己被贴上神眷者标签。\n接着进行补偿实验。\n'
  const evidence = '韩烁的后台面板出现了神眷者标签。'
  const decision = { changes: [{ before: '秦牧看到自己被贴上神眷者标签', after: '秦牧看到韩烁被贴上神眷者标签',
    chapter: 3, evidence, reason: '前文明确标签属于韩烁。' }] }
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'outline-conflict-'))
    await mkdir(join(dir, '细纲')); await mkdir(join(dir, '正文'))
    outlinePath = join(dir, '细纲', '细纲_第004章_实验.md')
    await writeFile(outlinePath, original)
    await writeFile(join(dir, '正文', '第003章 前文.md'), evidence)
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
  it('以可定位的前文为依据修正细纲，并保存完整原稿及理由', async () => {
    const verify = vi.fn().mockResolvedValue('{"passed":true,"issues":[]}')
    expect(await reconcileOutlineWithHistory(dir, 4, async () => JSON.stringify(decision), verify)).toBe('changed')
    expect(await readFile(outlinePath, 'utf8')).toBe(original.replace(decision.changes[0].before, decision.changes[0].after))
    const historyDir = join(dir, '.versions', 'outline-conflict-decisions')
    const audit = JSON.parse(await readFile(join(historyDir, (await readdir(historyDir))[0]), 'utf8'))
    expect(audit.original).toBe(original)
    expect(audit.changes[0]).toEqual(decision.changes[0])
    expect(verify).toHaveBeenCalledOnce()
  })
  it('缺少前文原句或独立审核拒绝时不修改', async () => {
    const forged = { changes: [{ ...decision.changes[0], evidence: '不存在的证据' }] }
    const verify = vi.fn().mockResolvedValue('{"passed":true,"issues":[]}')
    expect(await reconcileOutlineWithHistory(dir, 4, async () => JSON.stringify(forged), verify)).toBe('unavailable')
    expect(verify).not.toHaveBeenCalled()
    expect(await reconcileOutlineWithHistory(dir, 4, async () => JSON.stringify(decision), async () => '{"passed":false,"issues":["证据不足"]}')).toBe('unavailable')
    expect(await readFile(outlinePath, 'utf8')).toBe(original)
  })
  it('核对过程中细纲变化时拒绝覆盖作者修改', async () => {
    const verify = async () => { await writeFile(outlinePath, original + '作者修改。'); return '{"passed":true,"issues":[]}' }
    await expect(reconcileOutlineWithHistory(dir, 4, async () => JSON.stringify(decision), verify)).rejects.toThrow('OUTLINE_CONTEXT_CHANGED')
    expect(await readFile(outlinePath, 'utf8')).toBe(original + '作者修改。')
  })
})
