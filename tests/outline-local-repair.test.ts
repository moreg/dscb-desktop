import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { repairOutlineDifference } from '../src/main/data/outline-local-repair'
import type { OutlineDiffReport } from '../src/shared/types'

describe('细纲与正文的局部修复', () => {
 let dir: string, prose: string, outline: string
 const report: OutlineDiffReport = { chapterNumber: 4, checked: true, hasOutline: true, passed: true,
   diffs: [{ type: 3, typeLabel: '细节调整', priority: 'P2', outline: '他升了五级', actual: '从一级到五级', suggestion: '核对升级幅度' }] }
 const verify = vi.fn(async () => '{"passed":true,"issues":[]}')
 const check = vi.fn(async () => {})
 const save = vi.fn(async (candidate: string) => { await writeFile(join(dir, '正文', '004.md'), candidate) })
 beforeEach(async () => {
   dir = await mkdtemp(join(tmpdir(), 'outline-repair-')); await mkdir(join(dir, '正文')); await mkdir(join(dir, '细纲'))
   prose = '张伟打开面板，看见自己从一级升到五级，兴奋地笑了。'
   outline = '# 第4章\n张伟获得补偿后连续提升五级，然后回到宿舍。'
   await writeFile(join(dir, '正文', '004.md'), prose)
   await writeFile(join(dir, '正文', '003.md'), '韩烁此前被系统认定为神眷者标签持有者。')
   await writeFile(join(dir, '细纲', '细纲_第004章_测试.md'), outline)
   vi.clearAllMocks()
 })
 afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
 const plan = () => JSON.stringify({ action: 'prose', index: 0, before: '从一级升到五级', after: '从一级升到六级',
   evidence: '张伟获得补偿后连续提升五级', evidenceChapter: 0, reason: '细纲明确提升五级，正文只提升四级。' })
 it('先核验候选，提交时保存原稿、证据与理由', async () => {
   const result = await repairOutlineDifference(dir, 4, prose, report, { decide: async () => plan(), verify, check, saveProse: save })
   expect(result.status).toBe('candidate')
   expect(await readFile(join(dir, '正文', '004.md'), 'utf8')).toBe(prose)
   if (result.status !== 'candidate') throw Error('no candidate')
   await result.commit()
   expect(await readFile(join(dir, '正文', '004.md'), 'utf8')).toContain('从一级升到六级')
   const folder = join(dir, '.versions', 'outline-sync-repairs')
   const audit = JSON.parse(await readFile(join(folder, (await readdir(folder))[0]), 'utf8'))
   expect(audit.original).toBe(prose)
   expect(audit.evidence).toBe('张伟获得补偿后连续提升五级')
   expect(verify).toHaveBeenCalledOnce(); expect(check).toHaveBeenCalledOnce()
 })
 it('拒绝伪造细纲依据、独立复核拒绝和提交前的正文更改', async () => {
   const forged = JSON.parse(plan()); forged.evidence = '不存在的细纲内容'
   expect((await repairOutlineDifference(dir, 4, prose, report, { decide: async () => JSON.stringify(forged), verify, check, saveProse: save })).status).toBe('unresolved')
   expect(verify).not.toHaveBeenCalled()
   const rejected = await repairOutlineDifference(dir, 4, prose, report, { decide: async () => plan(), verify: async () => '{"passed":false,"issues":["逻辑不符"]}', check, saveProse: save })
   expect(rejected.status).toBe('unresolved')
   const candidate = await repairOutlineDifference(dir, 4, prose, report, { decide: async () => plan(), verify, check, saveProse: save })
   if (candidate.status !== 'candidate') throw Error('no candidate')
   await writeFile(join(dir, '正文', '004.md'), prose + '作者新增。')
   await expect(candidate.commit()).rejects.toThrow('已变化')
   expect(save).not.toHaveBeenCalled()
 })
 it('独立复核驳回后将具体原因送回 Agent 重试', async () => {
   const decide = vi.fn(async (_prompt: string) => plan())
   const reviewer = vi.fn().mockResolvedValueOnce('{"passed":false,"issues":["请同时修正相关台词"]}').mockResolvedValue('{"passed":true,"issues":[]}')
   const candidate = await repairOutlineDifference(dir, 4, prose, report, { decide, verify: reviewer, check, saveProse: save })
   expect(candidate.status).toBe('candidate')
   expect(decide).toHaveBeenCalledTimes(2)
   expect(decide.mock.calls[1][0]).toContain('请同时修正相关台词')
 })
 it('同一问题可以修复多处独立短句', async () => {
   const base = '张伟叫道自己五级了。张伟继续说自己从一级升到五级，十分兴奋。'
   await writeFile(join(dir, '正文', '004.md'), base)
   const multiple = { action: 'prose', index: 0, replacements: [
     { before: '自己五级了', after: '自己六级了' }, { before: '从一级升到五级', after: '从一级升到六级' }
   ], evidence: '张伟获得补偿后连续提升五级', evidenceChapter: 0, reason: '两句同时描述同一升级结果。' }
   const candidate = await repairOutlineDifference(dir, 4, base, report, { decide: async () => JSON.stringify(multiple), verify, check, saveProse: save })
   expect(candidate.status).toBe('candidate')
   if (candidate.status === 'candidate') { await candidate.commit(); expect(await readFile(join(dir, '正文', '004.md'), 'utf8')).toContain('自己六级了') }
 })
 it('前文直接证明细纲冲突时，只替换有定位依据的细纲短句', async () => {
   const revised = outline + '\n张伟完全不知道官方因事故发放过补偿。'
   await writeFile(join(dir, '细纲', '细纲_第004章_测试.md'), revised)
   await writeFile(join(dir, '正文', '003.md'), '张伟已看到官方因事故发放了全服补偿。')
   const local = { action: 'outline', index: 0, replacements: [{ before: '张伟完全不知道官方因事故发放过补偿', after: '张伟不知道自己是实验对象' }],
     evidence: '张伟已看到官方因事故发放了全服补偿', evidenceChapter: 3, reason: '前文已明确张伟知道官方补偿。' }
   const candidate = await repairOutlineDifference(dir, 4, prose, report, { decide: async () => JSON.stringify(local), verify, check, saveProse: save })
   expect(candidate.status).toBe('candidate')
   if (candidate.status === 'candidate') { await candidate.commit(); expect(await readFile(join(dir, '细纲', '细纲_第004章_测试.md'), 'utf8')).toContain('张伟不知道自己是实验对象') }
   expect(save).not.toHaveBeenCalled()
 })
 it('不能凭本章正文反向修改细纲', async () => {
   const bad = { action: 'outline', index: 0, before: '张伟获得补偿后连续提升五级', after: '张伟只提升四级',
     evidence: '看见自己从一级升到五级', evidenceChapter: 4, reason: '按照正文修改细纲。' }
   const result = await repairOutlineDifference(dir, 4, prose, report, { decide: async () => JSON.stringify(bad), verify, check, saveProse: save })
   expect(result.status).toBe('unresolved'); expect(verify).not.toHaveBeenCalled()
 })
})
