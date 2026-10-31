import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WriteService } from '../src/main/data/write-service'
import { WriteFlowService } from '../src/main/data/write-flow-service'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { readChapterBoundary, assertOutlineBoundary } from '../src/main/data/chapter-boundary'
import { readLongformReviewState } from '../src/main/data/longform-review-state'
import { parseOutlineDiffJson } from '../src/shared/parsers'
import { readLongformPlan } from '../src/main/data/longform-plan'
import { createWritingProject } from './helpers/writing-project'
import { acceptedDeslop } from './helpers/accepted-deslop'
import { ChapterRepairReviewRequiredError } from '../src/main/data/chapter-rewrite-review-error'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { OutlineDiffReport } from '../src/shared/types'

let root: string, dir: string, id: string, service: WriteService
const scopeConflict = JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item', 'boundary'], findings: [{
  kind: 'boundary', message: '本章提前完成后章解毒复明。', snippet: '双眼已经彻底复明，体内的毒素也排得干干净净。', reference: '本章只交药，不得解毒复明。'
}] })
let generate: ReturnType<typeof vi.fn>
const future = '陆安服下解药，毒素排尽，双眼彻底恢复视力。'
const leaked = '陆安摸到药瓶的瓶口，把封蜡捏在指间。他听见母亲放下药箱，又搬来一把椅子，便顺着她的手坐下，掌心仍紧紧攥着瓶身。\n他抬起头，终于看清母亲的面容。双眼已经彻底复明，体内的毒素也排得干干净净。'
const clear = JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item', 'boundary'], findings: [] })
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'outline-boundary-audit-'))
  const settings = { getProjectsRoot: async (fallback: string) => fallback } as SettingsRepository
  const projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
  const project = await createWritingProject(projects, { name: '章界测试', genre: '玄幻' })
  dir = project.path; id = project.id
  await writeFile(join(dir, '细纲', '细纲_第001章_送药.md'), '# 细纲\n\n## 第 1 章：送药\n\n- **核心事件**：母亲将药瓶送到陆安手中，本章只交药，不得解毒复明。\n')
  await writeFile(join(dir, '细纲', '细纲_第002章_复明.md'), `# 细纲\n\n## 第 2 章：复明\n\n- **核心事件**：${future}\n`)
  generate = vi.fn().mockImplementation(async (_prompt, opts) => opts?.meta?.feature === 'longformGuard' ? clear : leaked)
  service = new WriteService(projects, { generateStream: generate } as unknown as LlmService,
    undefined, undefined, undefined, undefined, undefined, acceptedDeslop)
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

it('局部修复两次失败后升级场景，复核通过仍只交付候选并备份原稿', async () => {
  const passage = '甲'.repeat(400)
  const original = '开头。' + passage + '结尾。' + '其余正文。'.repeat(300)
  const candidate = original.replace(passage, '乙'.repeat(400))
  await new ProseRepo(dir).write(1, original)
  vi.spyOn(service, 'buildChapterPrompt').mockResolvedValue({ user: '原计划', system: '' } as Awaited<ReturnType<WriteService['buildChapterPrompt']>>)
  const flow = (service as unknown as { flow: WriteFlowService }).flow
  vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue('[]')
  let rounds = 0
  generate.mockImplementation(async (_prompt, opts) => {
    if (opts?.meta?.feature === 'continuityRepair') {
      rounds++
      return JSON.stringify({ replacements: [{ before: passage, after: '乙'.repeat(400) }] })
    }
    if (opts?.meta?.feature === 'continuityRepairVerify') return JSON.stringify({ passed: true, issues: [] })
    if (opts?.meta?.feature === 'longformGuard') return clear
    throw new Error(`unexpected ${opts?.meta?.feature}`)
  })
  const internal = service as unknown as { repairLongformConflict: (
    pid: string, chapter: number, prose: string, issue: string, progress: () => void, opts: object
  ) => Promise<string> }
  await expect(internal.repairLongformConflict(id, 1, original, '人物状态错误', () => {}, {}))
    .rejects.toMatchObject({ name: ChapterRepairReviewRequiredError.name, original, candidate, scope: 'scene' })
  expect(rounds).toBe(3)
  expect(await new ProseRepo(dir).read(1)).toBe(original)
  const { readdir } = await import('fs/promises')
  const files = await readdir(join(dir, '.cache', 'repair-proposals'))
  const saved = JSON.parse(await readFile(join(dir, '.cache', 'repair-proposals', files[0]), 'utf8'))
  expect(saved).toMatchObject({ original, candidate, scope: 'scene' })
  expect(await service.getChapterRepairProposal(id, 1, original)).toEqual({ original, candidate, scope: 'scene' })
  expect(await service.getChapterRepairProposal(id, 1, '过期原稿')).toBeNull()
  await new ProseRepo(dir).write(1, '另一窗口修改后的正文。')
  expect(await service.getChapterRepairProposal(id, 1, original)).toBeNull()
})

it('没有总纲也强制检查细纲边界，冲突稿保留但不能成功交稿或同步', async () => {
  generate.mockImplementation(async (_prompt, opts) => opts?.meta?.feature === 'longformGuard' ? scopeConflict : leaked)
  expect(await readLongformPlan(dir, 1)).toBe('')
  await expect(service.generateChapterStream(id, 1, { existingText: '陆安听见母亲的脚步声。' })).rejects.toThrow('LONGFORM_CONFLICT')
  const saved = await new ProseRepo(dir).read(1)
  expect(saved).toContain('彻底复明')
  expect((await readLongformReviewState(dir)).pending['1']).toBeDefined()
  const synced = await service.syncChapterAfterWrite(id, 1, saved, { selfCheck: null })
  expect(synced?.memory.reviewRequired?.join('')).toContain('LONGFORM_CONFLICT')
  expect(generate.mock.calls.some(([, opts]) => opts?.meta?.feature === 'memoryExtract')).toBe(false)
})

it('总纲存在时仍提供本章禁区和后章细纲，旧四项通过结果不能放行', async () => {
  await writeFile(join(dir, '大纲', '大纲.md'), '# 大纲\n\n## 主线剧情走向\n\n陆安与母亲寻找失散的家人。')
  generate.mockImplementation(async (_prompt, opts) => opts?.meta?.feature === 'longformGuard'
    ? JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item'], findings: [] }) : leaked)
  await expect(service.generateChapterStream(id, 1)).rejects.toThrow('LONGFORM_REVIEW_INCOMPLETE')
  const call = generate.mock.calls.find(([, opts]) => opts?.meta?.feature === 'longformGuard')!
  expect(call[0]).toContain(future)
  expect(call[0]).toContain('本章只交药，不得解毒复明')
  expect(call[0]).toContain('陆安与母亲寻找失散的家人')
})

const violation = { type: 2, typeLabel: '超纲增量', outline: '本章只交药，不得解毒复明',
  actual: '本章已经彻底解毒复明，提前完成下一章核心事件',
  suggestion: '删除提前完成的解毒复明结果', priority: 'P0', resolution: 'updateContent' }

it('即使长篇核对漏报，细纲对照的 P0 越界仍阻止交稿，不能被无遗漏伏笔吞掉', async () => {
  await new ProseRepo(dir).write(1, leaked)
  const flow = (service as unknown as { flow: WriteFlowService }).flow
  vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue(JSON.stringify([violation]))
  await expect(service.repairChapterForeshadowings(id, 1, leaked)).rejects.toThrow('LONGFORM_CONFLICT')
  expect((await readLongformReviewState(dir)).pending['1']).toBeDefined()
  expect(generate.mock.calls.map(([, opts]) => opts?.meta?.feature)).toEqual(Array(6).fill('continuityRepair'))
})

it('明确越界不能由连续模式回写当前或未来细纲消除', async () => {
  const file = join(dir, '细纲', '细纲_第001章_送药.md')
  const nextFile = join(dir, '细纲', '细纲_第002章_复明.md')
  const original = await readFile(file, 'utf8'), nextOriginal = await readFile(nextFile, 'utf8')
  const report = { ...parseOutlineDiffJson(JSON.stringify([{ ...violation, boundaryViolation: true }]), 1), checked: true, hasOutline: true }
  const internal = service as unknown as { syncOutlineFromProse: (id: string, n: number, text: string, report: OutlineDiffReport) => Promise<OutlineDiffReport> }
  expect(await internal.syncOutlineFromProse(id, 1, leaked, report)).toMatchObject({ checked: false, passed: false })
  expect(await readFile(file, 'utf8')).toBe(original)
  expect(await readFile(nextFile, 'utf8')).toBe(nextOriginal)
  expect(generate).not.toHaveBeenCalled()
})

it.each([1, 2, 4])('核对通过后第 %i 章细纲变化，使旧提交凭证失效', async chapter => {
  await new ProseRepo(dir).write(1, leaked)
  const internal = service as unknown as { assertLongformConsistency: (id: string, n: number, text: string) => Promise<() => Promise<void>> }
  const confirm = await internal.assertLongformConsistency(id, 1, leaked)
  const file = chapter === 1 ? '细纲_第001章_送药.md' : chapter === 2 ? '细纲_第002章_复明.md' : '细纲_第004章_揭晓.md'
  await writeFile(join(dir, '细纲', file), `# 细纲\n\n## 第 ${chapter} 章：调整\n\n- **核心事件**：新的明确限制，不允许提前确认幕后真凶。`)
  await expect(confirm()).rejects.toThrow('章节边界细纲')
})

it('保留散文禁区的原文证据；超过预算不能截断后放行', async () => {
  const file = join(dir, '细纲', '细纲_第001章_送药.md')
  await writeFile(file, '# 细纲\n\n## 第 1 章：送药\n\n## 写作禁区\n\n只能把药瓶递到手中，\n不能宣告毒素已排尽。')
  expect(await readChapterBoundary(dir, 1)).toContain('只能把药瓶递到手中，\n不能宣告毒素已排尽。')
  await writeFile(file, '# 细纲\n\n## 第 1 章：送药\n\n## 写作禁区\n\n' + '禁区'.repeat(13000))
  await expect(readChapterBoundary(dir, 1)).rejects.toThrow('CHAPTER_BOUNDARY_TOO_LARGE')
})

it('合理增量可以通过，明确越界即使标成 P2 或漏写也必须拦截', () => {
  const report = (diff: object) => parseOutlineDiffJson(JSON.stringify([diff]), 1)
  expect(() => assertOutlineBoundary(report({ ...violation, boundaryViolation: false, actual: '交药时增加了药瓶的外观细节' }))).not.toThrow()
  expect(() => assertOutlineBoundary(report({ ...violation, type: 1, priority: 'P2', boundaryViolation: true }))).toThrow('LONGFORM_CONFLICT')
  const forbiddenPatch = report({ ...violation, priority: 'P2', boundaryViolation: true,
    resolution: 'updateOutline', outlinePatch: { plotSummary: '接受提前解毒复明' } })
  expect(forbiddenPatch.passed).toBe(false)
  expect(forbiddenPatch.diffs[0].resolution).toBe('updateContent')
  expect(forbiddenPatch.diffs[0].outlinePatch).toBeUndefined()
  expect(report({ ...violation, boundaryViolation: 'false' }).checked).toBe(false)
})

it.each([false, true])('越界局部修复必须重新过章节边界检查，不能只信修复模型自评（仍越界=%s）', async stillConflicts => {
  const before = '他抬起头，终于看清母亲的面容。双眼已经彻底复明，体内的毒素也排得干干净净。'
  const after = stillConflicts
    ? '他抬起头，眼前已经明亮。他握住母亲的手，终于看见窗外的青山，药力已经彻底见效。'
    : '他抬起头，眼前依旧漆黑。母亲握住他的手，让他留在椅子上等候，瓶口的封蜡还没拆开。'
  const repaired = leaked.replace(before, after)
  generate.mockImplementation(async (prompt, opts) => {
    switch (opts?.meta?.feature) {
      case 'chapter': return leaked
      case 'continuityRepair': return JSON.stringify({ replacements: [{ before, after }] })
      case 'continuityRepairVerify': return JSON.stringify({ passed: true, issues: [] })
      case 'batchOutline': return '[]'
      case 'longformGuard':
        if (prompt.endsWith(leaked)) return scopeConflict
        return stillConflicts ? JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item', 'boundary'], findings: [{
          kind: 'boundary', message: '本章只允许交药，仍提前完成复明。',
          snippet: '他抬起头，眼前已经明亮。', reference: '本章只交药，不得解毒复明。'
        }] }) : clear
      default: throw new Error(`Unexpected feature: ${opts?.meta?.feature}`)
    }
  })
  if (stillConflicts) {
    await expect(service.generateChapterStream(id, 1)).rejects.toThrow('LONGFORM_CONFLICT')
    expect(await new ProseRepo(dir).read(1)).toBe(leaked)
    expect((await readLongformReviewState(dir)).pending['1']).toBeDefined()
  } else {
    expect(await service.generateChapterStream(id, 1)).toBe(repaired)
    expect(await new ProseRepo(dir).read(1)).toBe(repaired)
    expect((await readLongformReviewState(dir)).pending['1']).toBeUndefined()
  }
  expect(generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'continuityRepair').length).toBeLessThanOrEqual(stillConflicts ? 6 : 2)
  expect(generate.mock.calls.find(([, opts]) => opts?.meta?.feature === 'continuityRepair')![0]).toContain(future)
})

it('生成过程中改变未来细纲时不采用旧边界生成稿', async () => {
  generate.mockImplementation(async (_prompt, opts) => {
    if (opts?.meta?.feature === 'chapter') {
      await writeFile(join(dir, '细纲', '细纲_第002章_复明.md'), '# 细纲\n\n## 第 2 章：复明\n\n- **核心事件**：本章只能尝试治疗，第三章才复明。')
      return leaked
    }
    return clear
  })
  await expect(service.generateChapterStream(id, 1)).rejects.toThrow('LONGFORM_CONTEXT_CHANGED')
  expect(await new ProseRepo(dir).read(1)).toBe('')
})

it('最终润色引入越界仍被拦截，不能只检查生成原稿', async () => {
  const safe = '陆安接过母亲递来的药瓶，把它握在掌心，等她告诉自己该怎么服药。'
  generate.mockImplementation(async (prompt, opts) => opts?.meta?.feature === 'longformGuard'
    ? (prompt.endsWith(safe) ? clear : scopeConflict) : safe)
  vi.spyOn(service as unknown as { autoDeslopGeneratedProse: () => Promise<string> }, 'autoDeslopGeneratedProse').mockResolvedValue(leaked)
  await expect(service.generateChapterStream(id, 1)).rejects.toThrow('LONGFORM_CONFLICT')
  const calls = generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'longformGuard')
  expect(calls.length).toBeGreaterThan(1)
  expect(calls[0][0].endsWith(safe)).toBe(true)
  expect(calls.slice(1).every(([prompt]) => prompt.endsWith(leaked))).toBe(true)
  expect((await readLongformReviewState(dir)).pending['1']).toBeDefined()
})
