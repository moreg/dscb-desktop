import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createReviewRetryFeedback, ReviewCandidateRejectedError } from '../src/main/data/review-retry-feedback'
import { repairContinuity } from '../src/main/data/continuity-repair'

let dir: string
const source = '林远把钥匙交给师父，站在门外等候。'
const fixed = source.replace('交给师父', '收进怀里')
const output = JSON.stringify({ replacements: [{ before: '交给师父', after: '收进怀里' }] })
const store = (stage = 'continuity', context: unknown = [source]) => createReviewRetryFeedback(dir, 1, stage, context)
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'review-retry-')); await writeFile(join(dir, 'outline.md'), '原始章节边界。') })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('重启后保留具体失败与候选，提示其不是事实，复核通过前不清除', async () => {
  const feedback = await store()
  await feedback.record('道具归属变化，师父不该收到钥匙。', fixed)
  const restarted = await store()
  expect(restarted.prompt()).toContain('道具归属变化')
  expect(restarted.prompt()).toContain(fixed)
  expect(restarted.prompt()).toContain('不是已发生的事实')
  await restarted.clear()
  expect((await store()).prompt()).toBe('')
})

it.each(['source', 'author', 'outline', 'chapter', 'stage'])('反馈隔离且依赖变更后失效：%s', async kind => {
  await (await store()).record('旧稿的具体错误。', '错误候选。')
  if (kind === 'outline') await writeFile(join(dir, 'outline.md'), '修改后的边界。')
  const feedback = kind === 'chapter' ? await createReviewRetryFeedback(dir, 2, 'continuity', [source])
    : kind === 'stage' ? await store('expression')
      : await store('continuity', kind === 'source' ? ['新稿。'] : kind === 'author' ? [source, '新要求。'] : [source])
  expect(feedback.prompt()).toBe('')
})

it('写入期间依据改变不将旧错误绑定到新稿', async () => {
  const feedback = await store()
  await writeFile(join(dir, 'outline.md'), '作者刚刚改过。')
  await feedback.record('旧稿错误。')
  expect((await store()).prompt()).toBe('')
})

it('同步重试仅刷新索引和同步日志时，已知错误不会被误判为上下文变化而丢失', async () => {
  await mkdir(join(dir, '记忆'))
  await writeFile(join(dir, '记忆', '索引.md'), '第一次同步时间。')
  await writeFile(join(dir, '记忆', '.sync-index.json'), '{}')
  await (await store()).record('明确的章节错误。')
  await writeFile(join(dir, '记忆', '索引.md'), '第二次同步时间。')
  await writeFile(join(dir, '记忆', '.sync-index.json'), '{"lastSync":2}')
  expect((await store()).prompt()).toContain('明确的章节错误')
})

it.each(['LLM_ABORTED', 'LLM_RATE_LIMIT', 'LLM_TIMEOUT', 'LONGFORM_CONTEXT_CHANGED: 正文已变化',
  'fetch failed', 'CHAPTER_REPAIR_BUDGET', '临时断网', 'EACCES: permission denied'])('执行错误不变成改剧情指令：%s', async error => {
  await (await store()).record(new Error(error), '未完成的输出。')
  expect((await store()).prompt()).toBe('')
})

it.each(['登录游戏不代表已获知等级，原句缺少这条知情事实。', '人物持有的磁盘变成了别人的道具，缺少交接过程。',
  '试炼已经超时，角色却无依据获得了成功奖励。'])('故事中的登录、磁盘和超时不能被误认为执行错误：%s', async message => {
  await (await store()).record(message, fixed)
  expect((await store()).prompt()).toContain(message)
})

it('同一次执行累积失败原因，手动重试第一轮带反馈，独立复核和原检查均通过才交付', async () => {
  const input = { chapterNumber: 1, content: source, issue: '修正钥匙持有者。', context: '师父没收钥匙。', maxRounds: 2 }
  const rejected = vi.fn().mockRejectedValueOnce(new Error('未保留等候动作。')).mockRejectedValueOnce(new Error('新增了交接承诺。'))
  await expect(repairContinuity(input, { generate: async () => output, verify: rejected, check: vi.fn(), feedback: await store() }))
    .rejects.toThrow('新增了交接承诺')
  const generate = vi.fn().mockResolvedValue(output), verify = vi.fn(), check = vi.fn().mockResolvedValue('passed')
  const result = await repairContinuity(input, { generate, verify, check, feedback: await store() })
  expect(generate.mock.calls[0][0]).toContain('未保留等候动作')
  expect(generate.mock.calls[0][0]).toContain('新增了交接承诺')
  expect(result).toEqual({ content: fixed, check: 'passed' })
  expect(verify).toHaveBeenCalledWith(source, fixed)
  expect(check).toHaveBeenCalledWith(fixed)
  expect((await store()).prompt()).toBe('')
})

it('复检仍报错时不交付候选，保留最后一次复核错误供下一次重试', async () => {
  const check = vi.fn().mockRejectedValue(new Error('复检发现提前揭示。'))
  await expect(repairContinuity({ chapterNumber: 1, content: source, issue: '修复归属', context: '', maxRounds: 1 },
    { generate: async () => output, verify: vi.fn(), check, feedback: await store() })).rejects.toThrow('提前揭示')
  expect((await store()).prompt()).toContain('复检发现提前揭示')
})

it('已被明确否决的同稿跨次重试不能靠重新审核获得不同结论', async () => {
  const input = { chapterNumber: 1, content: source, issue: '修复归属', context: '', maxRounds: 1 }
  await expect(repairContinuity(input, { generate: async () => output, verify: vi.fn().mockRejectedValue(new ReviewCandidateRejectedError('新增了未经授权的承诺。')),
    check: vi.fn(), feedback: await store() })).rejects.toThrow('新增了未经授权的承诺')
  const verify = vi.fn(), check = vi.fn()
  await expect(repairContinuity(input, { generate: async () => output, verify, check, feedback: await store() }))
    .rejects.toThrow('未实际修改')
  expect(verify).not.toHaveBeenCalled()
  expect(check).not.toHaveBeenCalled()
})
