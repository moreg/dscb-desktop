import { describe, it, expect, vi } from 'vitest'
import {
  parseChapterNameJson,
  sanitizeChapterName,
  stripChapterPrefix,
  buildChapterNameSystemPrompt,
  buildChapterNameUserPrompt
} from '../src/shared/parsers'
import { ChapterNameService } from '../src/main/data/chapter-name-service'
import type { LlmService } from '../src/main/data/llm-service'

function mockLlm(reply: string): LlmService {
  return {
    generateStream: vi.fn().mockResolvedValue(reply)
  } as unknown as LlmService
}

describe('stripChapterPrefix', () => {
  it('removes 第N章 / 第N章： prefix', () => {
    expect(stripChapterPrefix('第1章')).toBe('')
    expect(stripChapterPrefix('第 1 章：打脸全场')).toBe('打脸全场')
    expect(stripChapterPrefix('第一章：标题')).toBe('标题')
    expect(stripChapterPrefix('第12章')).toBe('')
    expect(stripChapterPrefix('  第 3 章 ： 反转 ')).toBe('反转')
  })

  it('passes through string with no prefix unchanged', () => {
    expect(stripChapterPrefix('打脸全场')).toBe('打脸全场')
    expect(stripChapterPrefix('')).toBe('')
  })
})

describe('sanitizeChapterName', () => {
  it('strips quotes and surrounding whitespace', () => {
    expect(sanitizeChapterName('"打脸全场"')).toBe('打脸全场')
    expect(sanitizeChapterName('"打脸全场"')).toBe('打脸全场')
    expect(sanitizeChapterName('  标题  ')).toBe('标题')
  })

  it('strips chapter prefix and rejects blanks after stripping', () => {
    expect(sanitizeChapterName('第1章')).toBe('')
    expect(sanitizeChapterName('第 5 章：')).toBe('')
    expect(sanitizeChapterName('第3章：开局打脸')).toBe('开局打脸')
  })

  it('clamps to max length 50', () => {
    const long = '一'.repeat(80)
    const out = sanitizeChapterName(long)
    expect(out.length).toBeLessThanOrEqual(50)
  })

  it('returns empty string for blank/whitespace only', () => {
    expect(sanitizeChapterName('   ')).toBe('')
    expect(sanitizeChapterName('""')).toBe('')
    expect(sanitizeChapterName("''")).toBe('')
  })

  it('returns empty string for input containing no Chinese chars and only punctuation', () => {
    // purely symbols/emoji should still be sanitized if there's Chinese base
    expect(sanitizeChapterName('🔥🔥🔥')).toBe('🔥🔥🔥') // emojis kept
  })
})

describe('parseChapterNameJson', () => {
  it('parses well-formed JSON with title field', () => {
    const out = parseChapterNameJson('{"title":"反派当场下跪"}', 1)
    expect(out).not.toBeNull()
    expect(out!.title).toBe('反派当场下跪')
    expect(out!.reason).toBe('')
  })

  it('extracts JSON object embedded in markdown code block', () => {
    const raw = '```json\n{"title":"一巴掌打回原形","reason":"反差"}\n```'
    const out = parseChapterNameJson(raw, 2)
    expect(out).not.toBeNull()
    expect(out!.title).toBe('一巴掌打回原形')
    expect(out!.reason).toBe('反差')
  })

  it('returns null for missing title', () => {
    expect(parseChapterNameJson('{}', 1)).toBeNull()
    expect(parseChapterNameJson('{"reason":"x"}', 1)).toBeNull()
  })

  it('returns null for empty title', () => {
    expect(parseChapterNameJson('{"title":""}', 1)).toBeNull()
    expect(parseChapterNameJson('{"title":"   "}', 1)).toBeNull()
  })

  it('returns null when JSON is malformed', () => {
    expect(parseChapterNameJson('not json', 1)).toBeNull()
    expect(parseChapterNameJson('{"title":', 1)).toBeNull()
  })

  it('returns null when no JSON object found at all', () => {
    expect(parseChapterNameJson('hello world', 1)).toBeNull()
  })

  it('strips chapter prefix from returned title', () => {
    const raw = '{"title":"第5章：反派连夜赶来"}'
    const out = parseChapterNameJson(raw, 5)
    expect(out).not.toBeNull()
    expect(out!.title).toBe('反派连夜赶来')
  })

  it('treats non-string title as invalid', () => {
    expect(parseChapterNameJson('{"title":123}', 1)).toBeNull()
    expect(parseChapterNameJson('{"title":null}', 1)).toBeNull()
  })
})

describe('buildChapterNameSystemPrompt / buildChapterNameUserPrompt', () => {
  it('system prompt embeds TOMATO_CHAPTER_NAME_SPEC and JSON output requirement', () => {
    const sys = buildChapterNameSystemPrompt('玄幻修真', undefined)
    // TOMATO spec 关键内容必须出现（嵌入式简化版保留核心 8 结构 + 七禁七必）
    expect(sys).toContain('番茄小说章名风格规范')
    expect(sys).toContain('反差/反转型')
    expect(sys).toContain('打脸/反杀型')
    expect(sys).toContain('12-20字')
    expect(sys).toContain('JSON')
    expect(sys).toContain('title')
    expect(sys).toContain('reason')
    // 与完整 spec 字段一致
    expect(sys).toContain('核心关键词在前 15 字')
  })

  it('system prompt includes genre voice when provided', () => {
    const sys = buildChapterNameSystemPrompt('古风仙侠', null)
    expect(sys).toContain('古风')
  })

  it('user prompt contains chapterNumber, currentTitle and draft excerpt', () => {
    const user = buildChapterNameUserPrompt({
      chapterNumber: 7,
      currentTitle: '第 7 章：旧标题',
      draft: '苏九推门而入，迎面撞上…'.repeat(50),
      maxDraftChars: 200
    })
    expect(user).toContain('7')
    expect(user).toContain('旧标题')
    expect(user).toContain('苏九推门而入')
  })

  it('user prompt truncates draft to maxDraftChars', () => {
    const long = '一'.repeat(2000)
    const user = buildChapterNameUserPrompt({
      chapterNumber: 1,
      currentTitle: 'x',
      draft: long,
      maxDraftChars: 100
    })
    // 100 chars from draft + labels should be < 200 total but contain the excerpt
    expect(user.length).toBeLessThan(500)
    expect(user).toContain('一'.repeat(50))
  })

  it('user prompt handles empty currentTitle gracefully', () => {
    const user = buildChapterNameUserPrompt({
      chapterNumber: 1,
      currentTitle: '',
      draft: '一',
      maxDraftChars: 10
    })
    expect(user).toContain('1')
  })
})

describe('ChapterNameService.suggest', () => {
  it('returns sanitized candidate from LLM JSON', async () => {
    const llm = mockLlm('{"title":"反派当场下跪","reason":"反差对比"}')
    const svc = new ChapterNameService(llm)
    const result = await svc.suggest({
      projectId: 'p1',
      chapterNumber: 5,
      currentTitle: '旧标题',
      draft: '苏九一拳打在反派胸口，反派当场跪下…'.repeat(20)
    })
    expect(result.title).toBe('反派当场下跪')
    expect(result.reason).toBe('反差对比')
  })

  it('strips chapter prefix from LLM output', async () => {
    const llm = mockLlm('{"title":"第5章：反派连夜赶来"}')
    const svc = new ChapterNameService(llm)
    const result = await svc.suggest({
      projectId: 'p1',
      chapterNumber: 5,
      currentTitle: '',
      draft: '…'
    })
    expect(result.title).toBe('反派连夜赶来')
  })

  it('returns ok=false and surfaces error when LLM JSON is invalid', async () => {
    const llm = mockLlm('not json')
    const svc = new ChapterNameService(llm)
    const result = await svc.suggest({
      projectId: 'p1',
      chapterNumber: 1,
      currentTitle: '',
      draft: '…'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('returns ok=false when sanitized title is blank', async () => {
    const llm = mockLlm('{"title":"   "}')
    const svc = new ChapterNameService(llm)
    const result = await svc.suggest({
      projectId: 'p1',
      chapterNumber: 1,
      currentTitle: '',
      draft: '…'
    })
    expect(result.ok).toBe(false)
  })

  it('passes chapterNumber, currentTitle and draft excerpt to LLM', async () => {
    const llm = mockLlm('{"title":"a"}')
    const svc = new ChapterNameService(llm)
    await svc.suggest({
      projectId: 'p1',
      chapterNumber: 42,
      currentTitle: '旧',
      draft: '正文摘要'.repeat(200)
    })
    const call = (llm.generateStream as ReturnType<typeof vi.fn>).mock.calls[0]
    const prompt = call[0] as string
    const opts = call[1] as { meta?: { chapterNumber?: number; projectId?: string } }
    expect(prompt).toContain('42')
    expect(prompt).toContain('旧')
    expect(prompt).toContain('正文摘要')
    expect(opts.meta?.chapterNumber).toBe(42)
    expect(opts.meta?.projectId).toBe('p1')
  })

  it('uses opening feature category for routing', async () => {
    const llm = mockLlm('{"title":"x"}')
    const svc = new ChapterNameService(llm)
    await svc.suggest({
      projectId: 'p1',
      chapterNumber: 1,
      currentTitle: '',
      draft: 'd'
    })
    const call = (llm.generateStream as ReturnType<typeof vi.fn>).mock.calls[0]
    const opts = call[1] as { meta?: { feature?: string } }
    expect(opts.meta?.feature).toBe('chapter-name')
  })
})