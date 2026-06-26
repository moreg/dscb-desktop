import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { SettingsRepository } from '../src/main/data/settings-repository'
import {
  DEFAULT_REVIEW_RULES,
  DEFAULT_REVIEW_THRESHOLDS,
  REVIEW_CHECK_SECTIONS,
  ALGORITHM_CHECK_IDS,
  LLM_CHECK_IDS
} from '../src/main/data/skill-prompts'
import type { ReviewCheckId } from '../src/shared/types'

describe('SettingsRepository review rules', () => {
  let repo: SettingsRepository

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-rr-'))
    repo = new SettingsRepository(path.join(dir, 'settings.json'))
  })

  it('returns full defaults when unset', async () => {
    const cfg = await repo.getReviewRules()
    expect(cfg.enabled).toBe(DEFAULT_REVIEW_RULES.enabled)
    expect(cfg.autoDeepReview).toBe(DEFAULT_REVIEW_RULES.autoDeepReview)
    expect(cfg.checks).toEqual({})
    expect(cfg.thresholds).toEqual(DEFAULT_REVIEW_THRESHOLDS)
    expect(cfg.wordLists.metaBreak.length).toBeGreaterThan(0)
    expect(cfg.wordLists.sensitive.length).toBeGreaterThan(0)
  })

  it('persists checks toggle (whitelisted id only)', async () => {
    const saved = await repo.setReviewRules({
      checks: { dash_fragment: false, character_breakdown: false }
    })
    expect(saved.checks.dash_fragment).toBe(false)
    expect(saved.checks.character_breakdown).toBe(false)
    // 其他项缺省 = 开（不在 checks 表里）
    expect(saved.checks.meta_break).toBeUndefined()
    expect(await repo.getReviewRules()).toEqual(saved)
  })

  it('drops unknown checkId silently', async () => {
    const saved = await repo.setReviewRules({
      checks: { dash_fragment: false, bogus_id: true as unknown as ReviewCheckId }
    })
    expect((saved.checks as Record<string, unknown>).bogus_id).toBeUndefined()
    expect(saved.checks.dash_fragment).toBe(false)
  })

  it('merges checks incrementally (改一项不清空其他)', async () => {
    await repo.setReviewRules({ checks: { dash_fragment: false } })
    const saved = await repo.setReviewRules({ checks: { meta_break: false } })
    expect(saved.checks.dash_fragment).toBe(false) // 仍在
    expect(saved.checks.meta_break).toBe(false) // 新增
  })

  it('clamps invalid thresholds to defaults', async () => {
    const saved = await repo.setReviewRules({
      thresholds: { minWords: -5, maxWords: NaN, maxParagraphLen: 'x' as unknown as number }
    })
    expect(saved.thresholds.minWords).toBe(DEFAULT_REVIEW_THRESHOLDS.minWords)
    expect(saved.thresholds.maxWords).toBe(DEFAULT_REVIEW_THRESHOLDS.maxWords)
    expect(saved.thresholds.maxParagraphLen).toBe(DEFAULT_REVIEW_THRESHOLDS.maxParagraphLen)
  })

  it('preserves valid thresholds and allows fractional dashDensity', async () => {
    const saved = await repo.setReviewRules({
      thresholds: { minWords: 2000, dashDensityPer100: 1.5 }
    })
    expect(saved.thresholds.minWords).toBe(2000)
    expect(saved.thresholds.dashDensityPer100).toBe(1.5)
  })

  it('dedups and trims word lists, falls back to defaults when empty', async () => {
    const saved = await repo.setReviewRules({
      wordLists: { metaBreak: ['  弹幕  ', '弹幕', '', '  '] }
    })
    expect(saved.wordLists.metaBreak).toEqual(['弹幕'])
    // sensitive 未传 → 保留默认（非空）
    expect(saved.wordLists.sensitive.length).toBeGreaterThan(0)
  })

  it('resets word lists to defaults when both empty', async () => {
    const saved = await repo.setReviewRules({
      wordLists: { metaBreak: [], sensitive: [] }
    })
    expect(saved.wordLists.metaBreak).toEqual(DEFAULT_REVIEW_RULES.wordLists.metaBreak)
    expect(saved.wordLists.sensitive).toEqual(DEFAULT_REVIEW_RULES.wordLists.sensitive)
  })

  it('toggles enabled / autoDeepReview', async () => {
    const off = await repo.setReviewRules({ enabled: false })
    expect(off.enabled).toBe(false)
    const auto = await repo.setReviewRules({ autoDeepReview: true })
    expect(auto.autoDeepReview).toBe(true)
    expect(auto.enabled).toBe(false) // 不应被重置
  })

  it('sanitizes non-object / malformed payloads to defaults on read', async () => {
    await repo.update({ reviewRules: 'not-an-object' as unknown as never })
    const cfg = await repo.getReviewRules()
    expect(cfg.enabled).toBe(DEFAULT_REVIEW_RULES.enabled)
    expect(cfg.thresholds).toEqual(DEFAULT_REVIEW_THRESHOLDS)
  })
})

describe('review-checks registry integrity', () => {
  it('every section checkId is unique', () => {
    const ids = REVIEW_CHECK_SECTIONS.map((s) => s.checkId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every section checkId appears in ALGORITHM_CHECK_IDS or LLM_CHECK_IDS exactly once', () => {
    for (const s of REVIEW_CHECK_SECTIONS) {
      const inAlgo = ALGORITHM_CHECK_IDS.has(s.checkId)
      const inLlm = LLM_CHECK_IDS.has(s.checkId)
      expect(inAlgo || inLlm).toBe(true)
      expect(inAlgo && inLlm).toBe(false) // 互斥
      const expected = s.kind === 'algorithm' ? inAlgo : inLlm
      expect(expected).toBe(true)
    }
  })

  it('algorithm checkIds count matches llm checkIds count expectation', () => {
    expect(ALGORITHM_CHECK_IDS.size).toBe(11)
    expect(LLM_CHECK_IDS.size).toBe(8)
  })
})

describe('SettingsRepository custom checks / builtinMeta / hiddenBuiltin', () => {
  let repo: SettingsRepository

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-cc-'))
    repo = new SettingsRepository(path.join(dir, 'settings.json'))
  })

  it('持久化 customChecks（合法项）', async () => {
    const saved = await repo.setReviewRules({
      customChecks: [
        {
          id: 'custom_words',
          label: '我的禁用词',
          hint: '命中提醒',
          severity: 'warn',
          type: 'keyword',
          group: 'toxic',
          keywords: ['居然', '竟然'],
          enabled: true
        }
      ]
    })
    expect(saved.customChecks?.length).toBe(1)
    expect(saved.customChecks?.[0].id).toBe('custom_words')
    expect(saved.customChecks?.[0].keywords).toEqual(['居然', '竟然'])
    expect(await repo.getReviewRules()).toEqual(saved)
  })

  it('丢弃非法 custom id（非 custom_ 前缀）', async () => {
    const saved = await repo.setReviewRules({
      customChecks: [
        { id: 'badid', label: 'x', hint: '', severity: 'warn', type: 'keyword', group: 'toxic', keywords: ['a'], enabled: true },
        { id: 'custom_ok', label: 'y', hint: '', severity: 'warn', type: 'keyword', group: 'toxic', keywords: ['b'], enabled: true }
      ]
    })
    expect(saved.customChecks?.length).toBe(1)
    expect(saved.customChecks?.[0].id).toBe('custom_ok')
  })

  it('丢弃大写/非法字符的 custom id', async () => {
    const saved = await repo.setReviewRules({
      customChecks: [
        { id: 'custom_Bad', label: 'x', hint: '', severity: 'warn', type: 'keyword', group: 'toxic', keywords: ['a'], enabled: true },
        { id: 'custom_ok1', label: 'y', hint: '', severity: 'warn', type: 'keyword', group: 'toxic', keywords: ['b'], enabled: true }
      ]
    })
    expect(saved.customChecks?.length).toBe(1)
    expect(saved.customChecks?.[0].id).toBe('custom_ok1')
  })

  it('非法 group 降级为 toxic（保证 AuditViolation.category 合法）', async () => {
    const saved = await repo.setReviewRules({
      customChecks: [
        { id: 'custom_g', label: 'x', hint: '', severity: 'warn', type: 'keyword', group: '非法定义', keywords: ['a'], enabled: true }
      ]
    })
    expect(saved.customChecks?.length).toBe(1)
    expect(saved.customChecks?.[0].group).toBe('toxic')
  })

  it('丢弃非法正则的 regex 项', async () => {
    const saved = await repo.setReviewRules({
      customChecks: [
        { id: 'custom_bad', label: 'x', hint: '', severity: 'warn', type: 'regex', group: 'quality', pattern: '[unclosed', enabled: true },
        { id: 'custom_ok', label: 'y', hint: '', severity: 'warn', type: 'regex', group: 'quality', pattern: 'abc', enabled: true }
      ]
    })
    expect(saved.customChecks?.length).toBe(1)
    expect(saved.customChecks?.[0].id).toBe('custom_ok')
  })

  it('custom id 去重', async () => {
    const saved = await repo.setReviewRules({
      customChecks: [
        { id: 'custom_dup', label: 'a', hint: '', severity: 'warn', type: 'keyword', group: 'toxic', keywords: ['x'], enabled: true },
        { id: 'custom_dup', label: 'b', hint: '', severity: 'warn', type: 'keyword', group: 'toxic', keywords: ['y'], enabled: true }
      ]
    })
    expect(saved.customChecks?.length).toBe(1)
  })

  it('持久化 builtinMeta（编辑内置项元数据）', async () => {
    const saved = await repo.setReviewRules({
      builtinMeta: { meta_break: { label: '改名', severity: 'warn' } }
    })
    expect(saved.builtinMeta?.meta_break?.label).toBe('改名')
    expect(saved.builtinMeta?.meta_break?.severity).toBe('warn')
  })

  it('builtinMeta 仅保留白名单 checkId', async () => {
    const saved = await repo.setReviewRules({
      builtinMeta: { bogus_id: { label: 'x' } as never, meta_break: { label: 'y' } }
    })
    expect((saved.builtinMeta as Record<string, unknown>).bogus_id).toBeUndefined()
    expect(saved.builtinMeta?.meta_break?.label).toBe('y')
  })

  it('持久化 hiddenBuiltin（软删除内置项）', async () => {
    const saved = await repo.setReviewRules({
      hiddenBuiltin: ['meta_break', 'pov_mix']
    })
    expect(saved.hiddenBuiltin).toEqual(['meta_break', 'pov_mix'])
  })

  it('hiddenBuiltin 仅保留白名单 id 并去重', async () => {
    const saved = await repo.setReviewRules({
      hiddenBuiltin: ['meta_break', 'meta_break', 'bogus' as never]
    })
    expect(saved.hiddenBuiltin).toEqual(['meta_break'])
  })

  it('checks 白名单含 custom id', async () => {
    // 先建一个自定义项
    await repo.setReviewRules({
      customChecks: [
        { id: 'custom_c', label: 'x', hint: '', severity: 'warn', type: 'keyword', group: 'toxic', keywords: ['a'], enabled: true }
      ]
    })
    // 再关掉它
    const saved = await repo.setReviewRules({ checks: { custom_c: false } })
    expect(saved.checks.custom_c).toBe(false)
  })

  it('空/缺省时 customChecks/builtinMeta/hiddenBuiltin 返回默认（[]/{}/[]）', async () => {
    const cfg = await repo.getReviewRules()
    expect(cfg.customChecks).toEqual([])
    expect(cfg.builtinMeta).toEqual({})
    expect(cfg.hiddenBuiltin).toEqual([])
  })
})
