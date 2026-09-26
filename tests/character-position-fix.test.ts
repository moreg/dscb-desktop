import { describe, it, expect } from 'vitest'
import { assessCharacterPositions } from '../src/main/data/chapter-self-check'
import {
  pickFixTargets,
  buildCharacterPositionFixPrompt,
  applyCharacterPositionFix
} from '../src/main/data/character-position-fix'

const positions = [
  { name: '车道贤', location: '大贤黑石大厦顶层生化实验室', action: '看化验结果' },
  { name: '崔敏秀', location: '大贤黑石大厦顶层生化实验室', action: '坐着' },
  { name: '金正勋', location: '大贤医院', action: '值班' }
]

describe('assessCharacterPositions', () => {
  it('看首次出场所在行及其前一行，后续句子写明地点也能对上', () => {
    const content = [
      '“从一开始就在救您的命！”',
      '崔敏秀刚说完，车道贤便把那只试管放回架上。',
      '车道贤站在大贤黑石大厦顶层的实验室里，松开衬衫领扣。'
    ].join('\n')
    const a = assessCharacterPositions(content, positions)
    expect(a.absent).toEqual(['金正勋'])
    // 首次出场行里两人挤在一句、且没写地点：都对不上
    expect(a.uncertain.map((p) => p.name).sort()).toEqual(['崔敏秀', '车道贤'].sort())
    expect(a.uncertain.find((p) => p.name === '车道贤')?.firstLine).toBe(1)
  })

  it('本人带移动动作的句子算转场交代', () => {
    const a = assessCharacterPositions('雨还在下。金正勋赶到停车场，收起了伞。', positions)
    expect(a.anchored).toEqual(['金正勋'])
  })

  it('否定或远望不算在场', () => {
    const a = assessCharacterPositions('金正勋望向大贤医院的方向。', positions)
    expect(a.uncertain.map((p) => p.name)).toEqual(['金正勋'])
  })
})

describe('character position fix', () => {
  const content = [
    '　　凌晨两点半，首尔还亮着大片灯光。',
    '',
    '　　车道贤把那只试管放回架上，看着屏幕上的绿色曲线。',
    '　　“全部重新测。”'
  ].join('\n')
  const assessment = assessCharacterPositions(content, positions.slice(0, 1))

  it('只允许改首次出场行和前一个非空行', () => {
    const targets = pickFixTargets(content, assessment)
    expect(targets).toHaveLength(1)
    expect(targets[0].lines).toEqual([0, 2])
    const { prompt, allowed } = buildCharacterPositionFixPrompt({
      chapterNumber: 10, content, prevTail: '车道贤盯着化验单。', targets
    })
    expect(allowed).toEqual([0, 2])
    expect(prompt).toContain('车道贤：在大贤黑石大厦顶层生化实验室')
    expect(prompt).toContain('[2] 车道贤把那只试管放回架上')
    expect(prompt).not.toContain('[3]')
  })

  it('按下标拼回，保留缩进与其他段落，修补后能对上', () => {
    const raw = JSON.stringify({
      paragraphs: [{ index: 2, text: '车道贤还站在大贤黑石大厦顶层的生化实验室里，把那只试管放回架上，看着屏幕上的绿色曲线。' }]
    })
    const r = applyCharacterPositionFix(content, '```json\n' + raw + '\n```', [0, 2])
    expect(r.changedLines).toEqual([2])
    const lines = r.content.split('\n')
    expect(lines[2].startsWith('　　车道贤还站在')).toBe(true)
    expect(lines[0]).toBe(content.split('\n')[0])
    expect(lines[3]).toBe('　　“全部重新测。”')
    expect(assessCharacterPositions(r.content, positions.slice(0, 1)).anchored).toEqual(['车道贤'])
  })

  it('越权段落、过度增删、坏 JSON 都被拒绝', () => {
    const raw = JSON.stringify({
      paragraphs: [
        { index: 3, text: '改了对白。' },
        { index: 2, text: '车道贤。' },
        { index: 0, text: '凌晨两点半，首尔还亮着大片灯光。' + '多'.repeat(100) }
      ]
    })
    const r = applyCharacterPositionFix(content, raw, [0, 2])
    expect(r.changedLines).toEqual([])
    expect(r.content).toBe(content)
    expect(r.rejected.map((x) => x.index).sort()).toEqual([0, 2, 3])
    expect(applyCharacterPositionFix(content, 'not json', [0, 2]).content).toBe(content)
  })

  it('修补文字里的破折号/省略号按项目规则归一', () => {
    const raw = JSON.stringify({
      paragraphs: [{ index: 2, text: '车道贤还站在实验室里……把那只试管放回架上，看着屏幕上的绿色曲线。' }]
    })
    const r = applyCharacterPositionFix(content, raw, [0, 2])
    expect(r.content).not.toContain('…')
  })
})

describe('WriteService.fixCharacterPositions', () => {
  it('提取上章位置、只改首次出场段落，并报告修补结果', async () => {
    const { vi } = await import('vitest')
    const { mkdtemp, mkdir, writeFile } = await import('fs/promises')
    const { tmpdir } = await import('os')
    const path = (await import('path')).default
    const { ProjectService } = await import('../src/main/data/project-service')
    const { LibraryRepository } = await import('../src/main/data/library-repository')
    const { WriteService } = await import('../src/main/data/write-service')
    const root = await mkdtemp(path.join(tmpdir(), 'aw-charpos-'))
    const settings = { getProjectsRoot: async (f: string) => f } as never
    const ps = new ProjectService(path.join(root, 'projects'), new LibraryRepository(path.join(root, 'library.json')), settings)
    const projectId = (await ps.create({ name: '位置修补', genre: '都市' })).id
    const dir = await ps.resolveDir(projectId)
    await mkdir(path.join(dir, '正文'), { recursive: true })
    await writeFile(path.join(dir, '正文', '第001章 上一章.md'), '林远站在码头上，望着远处的船。', 'utf-8')

    const generateStream = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        characterPositions: [{ name: '林远', location: '码头', action: '眺望' }],
        characterStates: [], timePoint: '傍晚', unfinished: [], suspense: '', props: []
      }))
      .mockResolvedValueOnce(JSON.stringify({
        paragraphs: [{ index: 1, text: '林远还站在码头上，把船票塞进口袋。' }]
      }))
    const service = new WriteService(ps, { generateStream } as never)
    const content = '天色暗了下来。\n林远把船票塞进口袋。\n“走吧。”'
    const r = await service.fixCharacterPositions(projectId, 2, content)

    expect(r.changed).toBe(1)
    expect(r.fixed).toEqual(['林远'])
    expect(r.remaining).toEqual([])
    expect(r.content).toBe('天色暗了下来。\n林远还站在码头上，把船票塞进口袋。\n“走吧。”')
    expect(generateStream).toHaveBeenCalledTimes(2)

    // 已对上就不再打 LLM
    const again = await service.fixCharacterPositions(projectId, 2, r.content)
    expect(again.changed).toBe(0)
    expect(generateStream).toHaveBeenCalledTimes(2)
  })
})
