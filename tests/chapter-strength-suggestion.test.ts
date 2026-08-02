import { describe, expect, it } from 'vitest'
import { suggestChapterStrength } from '../src/shared/chapter-strength-suggestion'

describe('suggestChapterStrength', () => {
  it('suggests high effort for big climax chapters (climax >= 3)', () => {
    const s = suggestChapterStrength({ emotion: 7, climax: 3 })
    expect(s.effort).toBe('high')
    expect(s.tier).toBe('High')
    expect(s.temperature).toBe(1.0)
    expect(s.reason).toContain('爽点')
  })

  it('suggests high effort for peak emotion chapters (emotion >= 9)', () => {
    const s = suggestChapterStrength({ emotion: 9, climax: 0 })
    expect(s.effort).toBe('high')
    expect(s.reason).toContain('情绪 9')
  })

  it('suggests low effort for flat transition chapters', () => {
    const s = suggestChapterStrength({ emotion: 2, climax: 0 })
    expect(s.effort).toBe('low')
    expect(s.tier).toBe('Low')
    expect(s.temperature).toBe(0.6)
  })

  it('suggests medium for regular chapters with rhythm data', () => {
    const s = suggestChapterStrength({ emotion: 6, climax: 1 })
    expect(s.effort).toBe('medium')
    expect(s.tier).toBe('Medium')
    expect(s.temperature).toBe(0.8)
  })

  it('falls back to medium when no rhythm data exists', () => {
    expect(suggestChapterStrength(null).effort).toBe('medium')
    expect(suggestChapterStrength(undefined).reason).toContain('无节奏数据')
    expect(suggestChapterStrength({}).reason).toContain('无节奏数据')
  })

  it('climax beats low emotion (climax chapter is never "transition")', () => {
    const s = suggestChapterStrength({ emotion: 2, climax: 3 })
    expect(s.effort).toBe('high')
  })
})
