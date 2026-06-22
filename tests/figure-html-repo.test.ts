import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { FigureHtmlRepo } from '../src/main/data/skill-format/figure-html-repo'
import {
  parseFigureDraftJson,
  buildFigureHtml
} from '../src/shared/parsers'

describe('buildFigureHtml', () => {
  it('wraps mermaid in HTML template', () => {
    const html = buildFigureHtml('战斗', '林风vs赵乾', 'graph TD\n    A --> B')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('战斗_林风vs赵乾')
    expect(html).toContain('graph TD')
    expect(html).toContain('mermaid.min.js')
    expect(html).toContain('mermaid.initialize')
  })

  it('escapes HTML special chars in type/topic', () => {
    const html = buildFigureHtml('a<b', 'c>d', 'graph TD')
    expect(html).toContain('a&lt;b_c&gt;d')
    expect(html).not.toContain('a<b_c>d')
  })
})

describe('parseFigureDraftJson', () => {
  it('parses shouldGenerate=true draft with mermaid', () => {
    const raw = JSON.stringify({
      shouldGenerate: true,
      type: '战斗',
      topic: '林风vs赵乾',
      reason: '关键决战',
      mermaid: 'graph TD\n    A[开始] --> B[胜利]'
    })
    const draft = parseFigureDraftJson(raw, 5)
    expect(draft.shouldGenerate).toBe(true)
    expect(draft.type).toBe('战斗')
    expect(draft.topic).toBe('林风vs赵乾')
    expect(draft.fileName).toBe('战斗_林风vs赵乾.html')
    expect(draft.html).toContain('<!DOCTYPE html>')
    expect(draft.html).toContain('graph TD')
    expect(draft.reason).toBe('关键决战')
  })

  it('parses shouldGenerate=false draft', () => {
    const raw = JSON.stringify({
      shouldGenerate: false,
      reason: '本章为日常铺垫'
    })
    const draft = parseFigureDraftJson(raw, 3)
    expect(draft.shouldGenerate).toBe(false)
    expect(draft.fileName).toBe('')
    expect(draft.html).toBe('')
    expect(draft.reason).toBe('本章为日常铺垫')
  })

  it('sanitizes illegal filename chars', () => {
    const raw = JSON.stringify({
      shouldGenerate: true,
      type: '战/斗',
      topic: 'a:b?c',
      mermaid: 'graph TD'
    })
    const draft = parseFigureDraftJson(raw, 1)
    expect(draft.fileName).toBe('战_斗_a_b_c.html')
  })

  it('falls back to shouldGenerate=false on parse failure', () => {
    const draft = parseFigureDraftJson('not json', 1)
    expect(draft.shouldGenerate).toBe(false)
    expect(draft.reason).toBe('解析失败')
  })

  it('falls back when no JSON object found', () => {
    const draft = parseFigureDraftJson('plain text without json', 1)
    expect(draft.shouldGenerate).toBe(false)
  })
})

describe('FigureHtmlRepo', () => {
  let dir: string
  let repo: FigureHtmlRepo

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aw-fig-'))
    repo = new FigureHtmlRepo(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('write creates file in 图解/ directory', async () => {
    const fileName = '战斗_测试.html'
    const html = '<html><body>test</body></html>'
    const saved = await repo.write(fileName, html)
    expect(saved).toBe(fileName)
    expect(existsSync(join(dir, '图解', fileName))).toBe(true)
    expect(readFileSync(join(dir, '图解', fileName), 'utf-8')).toBe(html)
  })

  it('exists returns true after write, false before', async () => {
    const fileName = '关系_人物.html'
    expect(await repo.exists(fileName)).toBe(false)
    await repo.write(fileName, '<html></html>')
    expect(await repo.exists(fileName)).toBe(true)
  })

  it('list returns html files excluding 节奏图谱.html', async () => {
    await repo.write('战斗_a.html', '<html></html>')
    await repo.write('关系_b.html', '<html></html>')
    await repo.write('节奏图谱.html', '<html></html>')
    const list = await repo.list()
    expect(list).toContain('战斗_a.html')
    expect(list).toContain('关系_b.html')
    expect(list).not.toContain('节奏图谱.html')
  })

  it('list returns empty when 图解/ does not exist', async () => {
    const list = await repo.list()
    expect(list).toEqual([])
  })
})
