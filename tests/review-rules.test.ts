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
