import { describe, it, expect } from 'vitest'
import { normalizeCastPresence, parseCastJson } from '../src/shared/cast-presence'

describe('normalizeCastPresence', () => {
  it('accepts English and Chinese appeared labels', () => {
    expect(normalizeCastPresence('appeared', '')).toBe('appeared')
    expect(normalizeCastPresence('APPEAR', '')).toBe('appeared')
    expect(normalizeCastPresence('present', '')).toBe('appeared')
    expect(normalizeCastPresence('出场', '')).toBe('appeared')
    expect(normalizeCastPresence('登场', '')).toBe('appeared')
    expect(normalizeCastPresence('到场', '')).toBe('appeared')
  })

  it('accepts English and Chinese mentioned labels', () => {
    expect(normalizeCastPresence('mentioned', '')).toBe('mentioned')
    expect(normalizeCastPresence('mention', '')).toBe('mentioned')
    expect(normalizeCastPresence('reference', '')).toBe('mentioned')
    expect(normalizeCastPresence('提及', '')).toBe('mentioned')
    expect(normalizeCastPresence('仅提及', '')).toBe('mentioned')
    expect(normalizeCastPresence('被提及', '')).toBe('mentioned')
  })

  it('fail-closes to mentioned when presence is missing or unknown', () => {
    expect(normalizeCastPresence(undefined, '')).toBe('mentioned')
    expect(normalizeCastPresence(null, '')).toBe('mentioned')
    expect(normalizeCastPresence('', '')).toBe('mentioned')
    expect(normalizeCastPresence('maybe', '')).toBe('mentioned')
    expect(normalizeCastPresence(1, '')).toBe('mentioned')
  })

  it('uses reason fallback for mentioned phrasing', () => {
    expect(normalizeCastPresence(undefined, '仅被提及一次')).toBe('mentioned')
    expect(normalizeCastPresence('', '没有出场，只是被人提起')).toBe('mentioned')
  })

  it('uses reason fallback for appeared phrasing when presence missing', () => {
    expect(normalizeCastPresence(undefined, '真正出场并有对话')).toBe('appeared')
    expect(normalizeCastPresence('', '本人出场，开口说话')).toBe('appeared')
  })

  it('prefers explicit presence over reason', () => {
    expect(normalizeCastPresence('appeared', '仅被提及')).toBe('appeared')
    expect(normalizeCastPresence('mentioned', '真正出场')).toBe('mentioned')
  })
})

describe('parseCastJson', () => {
  it('parses a plain JSON array with presence', () => {
    const text = JSON.stringify([
      { name: '林风', presence: 'appeared', reason: '主角对打', quote: '林风拔剑' },
      { name: '赵公', presence: 'mentioned', reason: '仅被提及', quote: '想起赵公' }
    ])
    expect(parseCastJson(text)).toEqual([
      {
        name: '林风',
        presence: 'appeared',
        reason: '主角对打',
        quote: '林风拔剑'
      },
      {
        name: '赵公',
        presence: 'mentioned',
        reason: '仅被提及',
        quote: '想起赵公'
      }
    ])
  })

  it('reads status/type aliases and defaults missing presence to mentioned', () => {
    const text = `[
      { "name": "甲", "status": "出场", "reason": "x" },
      { "name": "乙", "type": "mention", "reason": "y" },
      { "name": "丙", "reason": "模糊一句" }
    ]`
    const rows = parseCastJson(text)
    expect(rows.map((r) => [r.name, r.presence])).toEqual([
      ['甲', 'appeared'],
      ['乙', 'mentioned'],
      ['丙', 'mentioned']
    ])
  })

  it('tolerates markdown fences and trailing noise', () => {
    const text = '如下：\n```json\n[{"name":"丁","presence":"appeared","reason":"到场"}]\n```\n完'
    expect(parseCastJson(text)).toEqual([
      { name: '丁', presence: 'appeared', reason: '到场', quote: '' }
    ])
  })

  it('filters empty names and non-arrays', () => {
    expect(parseCastJson('{"name":"x"}')).toEqual([])
    expect(parseCastJson('not json')).toEqual([])
    expect(parseCastJson('[{"name":"  "},{"name":"戊","presence":"appeared"}]')).toEqual([
      { name: '戊', presence: 'appeared', reason: '', quote: '' }
    ])
  })
})
