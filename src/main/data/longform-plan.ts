import { join } from 'path'
import { promises as fs } from 'fs'
import { OutlineMdRepo } from './skill-format/outline-md-repo'
import { OutlineRepository } from './outline-repository'
import { parseDoc, findSection, findSectionsByPrefix, parseSubsections, parseVolumeNumber } from './skill-format/md-parser'
import { readMemoryText } from './memory/repository-cache'

/** Read author plans directly; chapter prose/automatic detail rewrites cannot redefine them. */
export async function readLongformPlan(dir: string, chapterNumber: number): Promise<string> {
  const outline = await new OutlineMdRepo(dir).read()
  const usable = (s?: string) => s?.trim() && !/^（?待(?:生成|完善)）?$/.test(s.trim()) ? s.trim() : ''
  const main = outline?.main
  const legacy = !usable(main?.synopsis) ? await new OutlineRepository(dir).readMain() : null
  const synopsis = usable(main?.synopsis) || usable(legacy?.synopsis)
  const sections: string[] = []
  if (synopsis) sections.push(`全书主线：\n${synopsis}`)
  if (!synopsis && (usable(main?.mainLine) || usable(legacy?.mainLine))) sections.push(`全书阶段计划：\n${usable(main?.mainLine) || usable(legacy?.mainLine)}`)
  const volume = outline?.volumes.find(v => chapterNumber >= v.chapterStart && chapterNumber <= v.chapterEnd)
  if (volume) {
    sections.push(`当前第${volume.number}卷：${volume.name}；章节范围 ${volume.chapterStart}-${volume.chapterEnd}；当前第${chapterNumber}章。`)
    const raw = await readMemoryText(join(dir, '大纲', '大纲.md'))
    const doc = parseDoc(raw)
    const line = findSection(doc, '主线剧情走向') ?? findSectionsByPrefix(doc, '主线剧情')[0]
    const inline = line && parseSubsections(line.body).find(s => parseVolumeNumber(s.title) === volume.number)
    if (inline?.body.trim()) sections.push(`大纲中的本卷计划：\n${inline.body}`)
    // File enumeration/read errors propagate instead of silently disabling the guard.
    const files = await fs.readdir(join(dir, '大纲'))
    const name = files.sort().find(f => f.endsWith('.md') && Number(f.match(/^第(\d+)卷/)?.[1]) === volume.number)
    if (name) sections.push(`本卷原始卷纲 ${name}：\n${await readMemoryText(join(dir, '大纲', name))}`)
  }
  if (!sections.length) return ''
  const result = ['【作者主线契约】以下均为计划，不是历史事实。本章不得自行替换全书目标、抢写后章或卷末终局；实际偏离须核对，不能通过按正文回写细纲来消除。作者本次明确调整计划时以临时要求为准；含糊的继续写不等于允许更换目标。',
    ...sections].join('\n\n')
  if (result.length > 18_000) throw new Error('LONGFORM_PLAN_TOO_LARGE: 全书主线与本卷计划超过18000字符，请精简主线/拆分卷纲后重试；不会静默截断关键目标。')
  return result
}
