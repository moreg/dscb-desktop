import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createForeshadowingRepairFeedback } from '../src/main/data/foreshadowing-repair-feedback'
import { ForeshadowingRepairRejectedError, repairMissingForeshadowings } from '../src/main/data/foreshadowing-repair'
import type { OutlineDiffReport } from '../src/shared/types'

let dir: string
const original = '林野接过残木，听见里面传来一声轻响。\n他将残木收好，转身离开。'
const firstBad = '残魂说：“我的魂魄不能离开这根木头。”'
const secondBad = '林野听清了残魂不能脱离原木的规矩。'
const good = '残木里的声音忽然断了，只剩一点微弱的震颤。'
const patch = (text: string) => JSON.stringify({ insertions: [{ after: 0, text }] })
const report: OutlineDiffReport = { chapterNumber: 10, hasOutline: true, checked: true, passed: false,
  diffs: [{ type: 1, typeLabel: '漏写', priority: 'P1', outline: '埋设附魂伏笔，保留信息差', suggestion: '补写伏笔' }] }
const input = { chapterNumber: 10, content: original, outline: '林野未知附魂机制', plans: [], report, context: '保留信息差' }
const reject = (evidence: string) => new ForeshadowingRepairRejectedError([{ message: '提前揭示残魂依存机制', evidence }])
const store = (context: unknown = input) => createForeshadowingRepairFeedback(dir, 10, context)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foreshadow-feedback-'))
  await writeFile(join(dir, 'outline.md'), input.outline)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function failTwice() {
  await expect(repairMissingForeshadowings(input, {
    feedback: await store(), generate: vi.fn().mockResolvedValueOnce(patch(firstBad)).mockResolvedValueOnce(patch(secondBad)),
    check: vi.fn(), verify: vi.fn(), review: vi.fn().mockRejectedValueOnce(reject(firstBad)).mockRejectedValueOnce(reject(secondBad))
  })).rejects.toThrow('提前揭示残魂依存机制')
}

it('重新创建补写流程后，首轮就读取两轮否决依据，合格新稿仍须独立核验', async () => {
  await failTwice()
  const generate = vi.fn().mockResolvedValue(patch(good))
  const review = vi.fn().mockResolvedValue({ ...report, passed: true, diffs: [] })
  const result = await repairMissingForeshadowings(input, { feedback: await store(), generate, review, check: vi.fn(), verify: vi.fn() })
  const prompt = generate.mock.calls[0][0] as string
  expect(prompt).toContain(firstBad)
  expect(prompt).toContain(secondBad)
  expect(prompt).toContain('提前揭示残魂依存机制')
  expect(prompt.split('当前完整正文（编号只用于定位）')[1]).not.toContain(firstBad)
  expect(prompt).toContain('区分读者能察觉的线索与角色已知的事实')
  expect(result.content).toBe(`林野接过残木，听见里面传来一声轻响。\n${good}\n他将残木收好，转身离开。`)
  expect(review).toHaveBeenCalledWith(original, result.content, [good])
})

it.each([firstBad, secondBad])('重试再次生成已否决内容时不重新抽取审核结论：%s', async bad => {
  await failTwice()
  const review = vi.fn()
  await expect(repairMissingForeshadowings(input, { feedback: await store(), generate: async () => patch(bad), review, check: vi.fn(), verify: vi.fn() }))
    .rejects.toThrow('提前揭示残魂依存机制')
  expect(review).not.toHaveBeenCalled()
})

it.each(['author', 'outline', 'prose'])('修改 %s 后不沿用旧否决记录', async change => {
  await failTwice()
  let context = input
  if (change === 'author') context = { ...input, context: '本章现在允许揭示机制' }
  if (change === 'outline') await writeFile(join(dir, 'outline.md'), '本章揭晓附魂机制')
  if (change === 'prose') context = { ...input, content: original + '\n作者改稿。' }
  expect(await (await store(context)).read()).toBeUndefined()
})

it('生成期间依据改变时不将否决记录绑定到新依据', async () => {
  const feedback = await store()
  await writeFile(join(dir, 'outline.md'), '作者改过的细纲')
  await feedback.write([{ candidateHash: 'a'.repeat(64), issues: reject(firstBad).issues }])
  expect(await (await store()).read()).toBeUndefined()
})
