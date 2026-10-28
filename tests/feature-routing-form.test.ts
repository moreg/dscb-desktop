import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import FeatureRoutingForm from '../src/renderer/src/FeatureRoutingForm'
import type { ProviderSummary } from '../src/shared/types'

beforeAll(() => vi.stubGlobal('React', React))
afterAll(() => vi.unstubAllGlobals())

const provider: ProviderSummary = {
  id: 'p1',
  label: '测试模型',
  baseUrl: 'https://example.com/v1',
  model: 'demo',
  protocol: 'openai',
  hasKey: true,
  keyMasked: '••••'
}

describe('FeatureRoutingForm', () => {
  it('lists 精修正文 as an independent routing slot', () => {
    const html = renderToStaticMarkup(
      createElement(FeatureRoutingForm, { providers: [provider], onSaved() {} })
    )
    expect(html).toContain('精修正文')
    expect(html).toContain('候选稿 / 修改方案 / 独立核验')
    expect(html.indexOf('正文生成')).toBeLessThan(html.indexOf('精修正文'))
    expect(html.indexOf('精修正文')).toBeLessThan(html.indexOf('审稿质检'))
  })
})
