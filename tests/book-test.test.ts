import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { BookTestService } from '../src/main/data/book-test-service'
import {
  bookTestCoverIsStale,
  buildBookTestTitlePrompt,
  fanqieTestTitleIssues,
  normalizeFanqieTestTitle,
  parseBookTestDrafts,
  selectOutlineExcerpt
} from '../src/shared/book-test'
import type { CoverFile, GenerateCoverInput } from '../src/shared/types'

describe('番茄书测书名规则', () => {
  it('去掉书名号和空格，并把英文标点换成中文标点', () => {
    expect(normalizeFanqieTestTitle(' 《退婚当天, 我逆袭了!》 ')).toBe('退婚当天，我逆袭了！')
    expect(normalizeFanqieTestTitle('种田、修仙')).toBe('种田，修仙')
    expect(normalizeFanqieTestTitle('【系统】开局')).toBe('【系统】开局')
    expect(normalizeFanqieTestTitle('Ｈｅｌｌｏ！')).toBe('Hello！')
  })

  it('超过 15 字、非法字符、空书名和与原书名相同都会标出来', () => {
    expect(fanqieTestTitleIssues('灵'.repeat(15)).issues).toEqual([])
    expect(fanqieTestTitleIssues('灵'.repeat(16)).issues[0]).toContain('16')
    expect(fanqieTestTitleIssues('霸道总裁·爱上我').issues.join('')).toContain('·')
    expect(fanqieTestTitleIssues('   ').issues).toContain('书名是空的')
    expect(fanqieTestTitleIssues('！！！').issues).toContain('书名里没有实际的字')
    expect(fanqieTestTitleIssues('《修仙从种田开始》', { originalTitle: '修仙从种田开始' }).issues).toContain(
      '和当前书名相同'
    )
    expect(fanqieTestTitleIssues('退婚当天，我逆袭了', { otherTitles: ['退婚当天,我逆袭了'] }).issues).toContain(
      '和另一套测试书名重复'
    )
  })

  it('从带思考和代码围栏的输出里解析书名，并去掉重复', () => {
    const raw = `<think>{"candidates":[{"title":"坏书名","hook":"x","coverHint":"y"}]}</think>
\`\`\`json
{"candidates":[
  {"title":"《甲,乙!》","hook":"测甲","coverHint":"画甲"},
  {"title":"甲，乙！","hook":"重复","coverHint":"再画"}
]}
\`\`\``
    expect(parseBookTestDrafts(raw)).toEqual([{ title: '甲，乙！', hook: '测甲', coverHint: '画甲' }])
  })

  it('大纲摘录优先保留卖点', () => {
    const excerpt = selectOutlineExcerpt([
      { title: '闲笔', body: '天气很好' },
      { title: '卖点', body: '灵田会结果' }
    ])
    expect(excerpt.startsWith('## 卖点')).toBe(true)
    expect(excerpt).toContain('灵田会结果')
  })

  it('起名提示词写明字数、条数、原书名和已有方案', () => {
    const prompt = buildBookTestTitlePrompt({
      bookName: '修仙从种田开始',
      genre: '玄幻',
      description: '一块灵田',
      outlineExcerpt: '## 卖点\n灵田会结果',
      existingTitles: ['已有书名'],
      count: 5,
      direction: '测打脸'
    })
    expect(prompt).toContain('最多 15 个字')
    expect(prompt).toContain('正好给出 5 条')
    expect(prompt).toContain('修仙从种田开始')
    expect(prompt).toContain('测打脸')
    expect(prompt).toContain('已有书名')
    expect(prompt).toContain('灵田会结果')
  })
})

describe('BookTestService', () => {
  async function createHarness(answer: string): Promise<{
    service: BookTestService
    prompts: string[]
    covers: GenerateCoverInput[]
    dir: string
  }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-book-test-'))
    const prompts: string[] = []
    const covers: GenerateCoverInput[] = []
    const service = new BookTestService(
      {
        async resolveDir() {
          return dir
        },
        async getProjectData() {
          return {
            name: '修仙从种田开始',
            genre: '玄幻',
            description: '灵田种出大道果'
          }
        }
      } as never,
      {
        async getOutlineSections() {
          return { h1Title: '大纲', sections: [{ title: '卖点', body: '灵田会结果' }] }
        }
      } as never,
      {
        async generateStream(prompt: string) {
          prompts.push(prompt)
          return answer
        }
      } as never,
      {
        async generate(input: GenerateCoverInput): Promise<CoverFile> {
          covers.push(input)
          return {
            fileName: `封面_v${covers.length}.png`,
            relPath: `封面/封面_v${covers.length}.png`,
            version: covers.length,
            isUploadSize: false,
            size: 12,
            genre: 'xianxia',
            createdAt: '2026-09-28T00:00:00.000Z'
          }
        }
      } as never
    )
    return { service, prompts, covers, dir }
  }

  const answer = JSON.stringify({
    candidates: [
      { title: '《退婚当天,我逆袭了!》', hook: '测退婚后的反击', coverHint: '婚书摔在地上' },
      { title: '修仙从种田开始', hook: '原书名', coverHint: '灵田' },
      { title: `灵田种出大道果${'啊'.repeat(9)}`, hook: '太长', coverHint: '金光灵田' }
    ]
  })

  it('生成的书名落盘，封面用新书名而不是原书名', async () => {
    const { service, prompts, covers } = await createHarness(answer)
    const created = await service.generateTitles('p1', {
      count: 3,
      authorName: '青椒',
      stylePreset: 'fanqie_impact',
      direction: '测反击'
    })
    expect(created.candidates.map((item) => item.title)).toEqual([
      '退婚当天，我逆袭了！',
      '修仙从种田开始',
      `灵田种出大道果${'啊'.repeat(9)}`
    ])
    expect(created.authorName).toBe('青椒')
    expect(prompts[0]).toContain('灵田会结果')
    expect(prompts[0]).toContain('测反击')

    const good = created.candidates[0]
    const same = created.candidates[1]
    const tooLong = created.candidates[2]
    await expect(service.generateCover('p1', same.id)).rejects.toThrow('BOOK_TEST_TITLE_INVALID')
    await expect(service.generateCover('p1', tooLong.id)).rejects.toThrow('BOOK_TEST_TITLE_INVALID')
    expect(covers).toHaveLength(0)

    const withCover = await service.generateCover('p1', good.id)
    expect(covers[0]).toMatchObject({
      bookName: '退婚当天，我逆袭了！',
      authorName: '青椒',
      platform: 'fanqie',
      stylePreset: 'fanqie_impact'
    })
    expect(covers[0].styleHint).toContain('测退婚后的反击')
    const stored = withCover.candidates.find((item) => item.id === good.id)
    expect(stored?.coverFileName).toBe('封面_v1.png')
    expect(stored?.coverTitle).toBe('退婚当天，我逆袭了！')
    expect(bookTestCoverIsStale(stored!)).toBe(false)
  })

  it('改了书名以后，旧封面会被标成过期，文件还留着', async () => {
    const { service } = await createHarness(
      JSON.stringify({
        candidates: [{ title: '开局被退婚', hook: '测开局', coverHint: '退婚现场' }]
      })
    )
    const first = await service.generateTitles('p1', { count: 1, authorName: '青椒' })
    const id = first.candidates[0].id
    await service.generateCover('p1', id)
    const edited = await service.updateCandidate('p1', id, { title: '退婚当天我翻盘' })
    const candidate = edited.candidates[0]
    expect(candidate.coverFileName).toBe('封面_v1.png')
    expect(candidate.coverTitle).toBe('开局被退婚')
    expect(bookTestCoverIsStale(candidate)).toBe(true)
  })

  it('坏掉的记录不会被读操作覆盖', async () => {
    const { service, dir } = await createHarness(answer)
    const file = path.join(dir, '书测', '书测.json')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '{', 'utf-8')
    await expect(service.getState('p1')).rejects.toThrow('BOOK_TEST_CORRUPT')
    expect(await readFile(file, 'utf-8')).toBe('{')
  })

  it('没有笔名时不出封面', async () => {
    const { service, covers } = await createHarness(
      JSON.stringify({ candidates: [{ title: '开局被退婚', hook: '测开局', coverHint: '退婚现场' }] })
    )
    const created = await service.generateTitles('p1', { count: 1 })
    await expect(service.generateCover('p1', created.candidates[0].id)).rejects.toThrow('BOOK_TEST_NO_AUTHOR')
    expect(covers).toHaveLength(0)
  })

  it('满 40 套后拒绝再生成，但笔名仍会记下', async () => {
    const { service, dir } = await createHarness(answer)
    await mkdir(path.join(dir, '书测'), { recursive: true })
    const candidates = Array.from({ length: 40 }, (_, index) => ({
      id: `id-${index}`,
      title: `书名${index}`,
      hook: '卖点',
      coverHint: '画面',
      kept: false,
      createdAt: '2026-09-28T00:00:00.000Z'
    }))
    await writeFile(
      path.join(dir, '书测', '书测.json'),
      JSON.stringify({ schemaVersion: 1, authorName: '', stylePreset: 'auto', direction: '', candidates, updatedAt: '' }),
      'utf-8'
    )
    await expect(service.generateTitles('p1', { count: 1, authorName: '青椒' })).rejects.toThrow('BOOK_TEST_POOL_FULL')
    const state = await service.getState('p1')
    expect(state.authorName).toBe('青椒')
    expect(state.candidates).toHaveLength(40)
  })
})
