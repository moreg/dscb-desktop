import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { adjudicateOutlineDiffs } from '../src/main/data/outline-sync-agent'
import type { OutlineDiffReport } from '../src/shared/types'

describe('细纲对照自动判断', () => {
 let dir: string
 const prose = '韩烁打开面板，发现标签显示为神眷者。'
 const report: OutlineDiffReport = { chapterNumber: 4, checked: true, hasOutline: true, passed: true,
   diffs: [{ type: 3, typeLabel: '细节调整', priority: 'P2', suggestion: '检查称谓', outline: '韩烁获得标签', actual: prose }] }
 beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'outline-sync-')); await mkdir(join(dir, '正文')); await mkdir(join(dir, '细纲')); await writeFile(join(dir, '正文', '004.md'), prose) })
 afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
 const decision = async () => JSON.stringify({ resolved: [{ index: 0, evidence: prose, reason: '称谓相同且事件已发生。' }] })
 it('独立复核后记录原始差异和原文依据', async () => {
   expect(await adjudicateOutlineDiffs(dir, 4, prose, report, decision, async () => '{"approved":[0]}')).toEqual([0])
   const folder = join(dir, '.versions', 'outline-sync-decisions')
   const audit = JSON.parse(await readFile(join(folder, (await readdir(folder))[0]), 'utf8'))
   expect(audit.decisions[0].evidence).toBe(prose)
   expect(audit.decisions[0].diff).toEqual(report.diffs[0])
 })
 it('按实际字数和细纲目标核算，自动清除纯字数误报并记录依据', async () => {
   const full = '字'.repeat(2323)
   await writeFile(join(dir, '正文', '004.md'), full)
   await writeFile(join(dir, '细纲', '细纲_第004章_测试.md'), '# 细纲\n\n## 第 4 章：测试\n\n- **字数目标**：2500 字\n')
   const wordReport: OutlineDiffReport = { ...report, diffs: [{ type: 5, typeLabel: '结构性偏离', priority: 'P2', outline: '字数目标2500字', actual: '正文篇幅可能偏离超过30%', suggestion: '请核对字数' }] }
   const model = vi.fn(async () => '{"resolved":[]}')
   expect(await adjudicateOutlineDiffs(dir, 4, full, wordReport, model, model)).toEqual([0])
   expect(model).not.toHaveBeenCalled()
   const folder = join(dir, '.versions', 'outline-sync-decisions')
   const audit = JSON.parse(await readFile(join(folder, (await readdir(folder))[0]), 'utf8'))
   expect(audit.decisions[0].evidence).toContain('2323')
   const short = '字'.repeat(1000)
   await writeFile(join(dir, '正文', '004.md'), short)
   expect(await adjudicateOutlineDiffs(dir, 4, short, wordReport, model, model)).toEqual([])
 })
 it('不接受伪造证据、未通过复核、重大差异或旧正文', async () => {
   const verify = vi.fn().mockResolvedValue('{"approved":[0]}')
   expect(await adjudicateOutlineDiffs(dir, 4, prose, report, async () => '{"resolved":[{"index":0,"evidence":"不存在的完整原句","reason":"理由足够长但没有证据"}]}', verify)).toEqual([])
   expect(verify).not.toHaveBeenCalled()
   expect(await adjudicateOutlineDiffs(dir, 4, prose, report, decision, async () => '{"approved":[]}')).toEqual([])
   expect(await adjudicateOutlineDiffs(dir, 4, prose, { ...report, diffs: [{ ...report.diffs[0], priority: 'P0' }] }, decision, verify)).toEqual([])
   await expect(adjudicateOutlineDiffs(dir, 4, prose + '修改', report, decision, verify)).rejects.toThrow('正文已变化')
 })
})
