import { describe, expect, it } from 'vitest'
import {
  antigravityModelForEffort,
  antigravityModelTier,
  antigravityTierVariants
} from '../src/shared/antigravity-model-tiers'

describe('Antigravity Gemini model tiers', () => {
  it('recognizes only named agy tier suffixes', () => {
    expect(antigravityModelTier('Gemini 3.1 Pro (High)')).toBe('High')
    expect(antigravityModelTier('Gemini 3.1 Pro')).toBeNull()
  })

  it('lists only the available variants from the same model family', () => {
    expect(
      antigravityTierVariants('Gemini 3.1 Pro (High)', [
        'Gemini 3.1 Pro (Low)',
        'Gemini 3.1 Pro (Medium)',
        'Gemini 3.1 Pro (High)',
        'Gemini 3.1 Flash (High)'
      ])
    ).toEqual([
      'Gemini 3.1 Pro (Low)',
      'Gemini 3.1 Pro (Medium)',
      'Gemini 3.1 Pro (High)'
    ])
  })

  it('chooses only a verified same-family tier and preserves the current model if missing', () => {
    const models = [
      'Gemini 3.8 Flash (High)', 'Gemini 3.8 Flash (Medium)', 'Gemini 3.8 Flash (Low)',
      'Gemini 3.1 Pro (High)', 'Gemini 3.1 Pro (Low)'
    ]
    expect(antigravityModelForEffort('Gemini 3.8 Flash (High)', 'low', models)).toBe('Gemini 3.8 Flash (Low)')
    expect(antigravityModelForEffort('Gemini 3.1 Pro (High)', 'medium', models)).toBe('Gemini 3.1 Pro (High)')
    expect(antigravityModelForEffort('Claude Sonnet 4.6 (Thinking)', 'high', models)).toBe('Claude Sonnet 4.6 (Thinking)')
    expect(antigravityModelForEffort('Gemini 3.8 Flash (High)', 'max', models)).toBe('Gemini 3.8 Flash (High)')
  })
})
