import { describe, expect, it } from 'vitest'
import {
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
})
