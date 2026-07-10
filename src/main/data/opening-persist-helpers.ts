/**
 * 开书落盘辅助函数（从 opening-service.ts 提取，避免 service 文件过长）。
 * 这些纯函数不依赖实例状态，可独立测试。
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { writeTextAtomic } from './atomic'
import { parseDoc, findSection, parseTable, parseBoldFields } from './skill-format/md-parser'
import {
  splitByChapterMarker,
  parseChapterTitle,
  sanitizeTitleForFilename,
  cleanContent,
  cleanVolumeContent,
  parseVolumeToken
} from './opening-markdown'

/**
 * 写入追踪/目录下的 5 个文件（伏笔、时间线、角色状态、上下文、问题记录）。
 * 同时写一份伏笔到 记忆系统/（向后兼容 diagnostics-service）。
 */
export async function writeTrackingFiles(
  dir: string,
  today: string,
  mainOutlineContent: string,
  volumes: Array<{ number: number; name: string; chapterStart: number; chapterEnd: number }>,
  characterNames: string[]
): Promise<void> {
  const outlineDoc = mainOutlineContent ? parseDoc(mainOutlineContent) : null
  const fubiSection = outlineDoc ? findSection(outlineDoc, '伏笔清单') : null
  const fubiRows = fubiSection ? parseTable(fubiSection.body).rows : []
  let fubiContent = `**版本**：v1.0（${today} 创建）\n**修改记录**\n- v1.0（${today}）：初版\n\n# 伏笔追踪\n\n| 伏笔编号 | 伏笔内容 | 伏笔类型 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 |\n|---|---|---|---|---|---|---|\n`
  for (const row of fubiRows) {
    const cols = [row[0] || 'FB-001', row[1] || '', row[2] || '设定', row[3] || '', row[4] || '', row[5] || '未回收', row[6] || '已埋设']
    fubiContent += `| ${cols.join(' | ')} |\n`
  }
  await writeTextAtomic(join(dir, '追踪', '伏笔.md'), fubiContent.trim() + '\n')
  await fs.mkdir(join(dir, '记忆系统'), { recursive: true })
  await writeTextAtomic(join(dir, '记忆系统', '伏笔追踪.md'), fubiContent.trim() + '\n')

  let timelineContent = `**版本**：v1.0（${today} 创建）\n**修改记录**\n- v1.0（${today}）：初版\n\n# 时间线\n\n| 章节 | 事件名 | 时间跨度 | 涉及角色 | 详细描述 |\n|---|---|---|---|---|\n`
  for (const v of volumes) {
    timelineContent += `| 第 ${v.chapterStart} 章 | 第 ${v.number} 卷开始 | 1 天 | 主角 | ${v.name} |\n`
  }
  await writeTextAtomic(join(dir, '追踪', '时间线.md'), timelineContent)

  const names = characterNames.length > 0 ? characterNames : ['主角', '配角', '反派']
  let statusContent = `**版本**：v1.0（${today} 创建）\n**修改记录**\n- v1.0（${today}）：初版\n\n# 角色状态快照\n\n| 角色 | 当前实力 | 当前立场 | 当前目标 | 关键道具 | 关系快照 | 更新章节 |\n|---|---|---|---|---|---|---|\n`
  for (const name of names) {
    statusContent += `| ${name} | 初始 | 默认 | 默认 | 无 | 主角：待定 | 第 1 章 |\n`
  }
  await writeTextAtomic(join(dir, '追踪', '角色状态.md'), statusContent)

  const contextContent = `**版本**：v1.0（${today} 创建）\n**修改记录**\n- v1.0（${today}）：初版\n\n# 上下文（日更进度摘要）\n\n| 日期 | 章节 | 进度摘要 | 下一章目标 | 阻塞点 |\n|---|---|---|---|---|\n`
  await writeTextAtomic(join(dir, '追踪', '上下文.md'), contextContent)

  const issueContent = `**版本**：v1.0（${today} 创建）\n**修改记录**\n- v1.0（${today}）：初版\n\n# 问题记录\n\n| 日期 | 问题描述 | 原因分析 | 修正方案 | 状态 |\n|---|---|---|---|---|\n`
  await writeTextAtomic(join(dir, '追踪', '问题记录.md'), issueContent)
}

/**
 * 落盘细纲：逐章独立文件 细纲/细纲_第NNN章_标题.md（技能规范格式）。
 * 同时聚合写一份 细纲/第01卷.md 和 大纲/细纲_第01卷.md（向后兼容）。
 * 返回写入的文件相对路径列表。
 */
export async function persistChapterOutlines(
  dir: string,
  md: string,
  fromChapter: number
): Promise<string[]> {
  const maxAllowed = fromChapter + 50
  let chapters = splitByChapterMarker(md)
  if (chapters.length === 0 && md.trim()) {
    const searchRe = /第\s*(\d+)\s*章/g
    let num = fromChapter
    let m: RegExpExecArray | null
    while ((m = searchRe.exec(md)) !== null) {
      const parsed = parseInt(m[1], 10)
      if (parsed >= 1 && parsed <= maxAllowed) {
        num = parsed
        break
      }
    }
    chapters = [{ chapterNumber: num, content: md }]
  }

  const files: string[] = []
  let volumeContent = '# 第 1 卷细纲\n\n'
  for (const ch of chapters) {
    if (!ch.chapterNumber || !ch.content.trim()) continue
    if (ch.chapterNumber < 1 || ch.chapterNumber > maxAllowed) {
      console.warn(`[opening-service] 跳过越界章号：第${ch.chapterNumber}章`)
      continue
    }
    const padded = String(ch.chapterNumber).padStart(3, '0')
    // 技能规范要求：逐章独立文件 细纲/细纲_第NNN章_标题.md
    // 标题从内容中的 `## 第 N 章：标题` 行解析；标题须与文件名、大纲标题列三处一致
    const title = parseChapterTitle(ch.content)
    const safeTitle = sanitizeTitleForFilename(title)
    const relPath = safeTitle
      ? `细纲/细纲_第${padded}章_${safeTitle}.md`
      : `细纲/细纲_第${padded}章.md`
    await fs.mkdir(join(dir, '细纲'), { recursive: true })
    await writeTextAtomic(join(dir, relPath), ch.content.trim())
    files.push(relPath)
    volumeContent += ch.content.trim().replace(/^###\s+第/gm, '## 第') + '\n\n'
  }

  if (files.length > 0) {
    await writeTextAtomic(join(dir, '细纲', '第01卷.md'), volumeContent.trim())
    // 保留旧路径别名（向后兼容：OutlineMdRepo 读取旧路径），新写入主路径在 细纲/
    await writeTextAtomic(join(dir, '大纲', '细纲_第01卷.md'), volumeContent.trim())
  }
  return files
}

/**
 * 编译并写入 记忆系统/ 兼容层文件（diagnostics-service 依赖）。
 * 设定/ 与大纲/ 已落盘后，聚合为 4 个汇总文件：世界观设定、角色卡、地点档案、核心情节。
 * 注意：outlineMap 是已 deslop 后的大纲文件映射；settingsMap 是已 deslop 后的设定文件映射。
 */
export async function compileMemorySystemCompat(
  dir: string,
  today: string,
  settingsMap: Record<string, string>,
  outlineMap: Record<string, string>,
  volumes: Array<{ number: number; name: string; chapterStart: number; chapterEnd: number }>
): Promise<void> {
  await fs.mkdir(join(dir, '记忆系统'), { recursive: true })

  // 1. 世界观设定
  const wvSections: string[] = []
  for (const [relPath, content] of Object.entries(settingsMap)) {
    if (relPath.startsWith('设定/世界观/') && relPath.endsWith('.md') && relPath !== '设定/世界观/地理.md') {
      const name = relPath.replace('设定/世界观/', '').replace(/\.md$/, '')
      const body = cleanContent(content)
      wvSections.push(`## ${name}\n\n${body}`)
    }
  }
  const compiledWorldview = [
    `**版本**：v1.0（${today} 创建）`,
    `**修改记录**`,
    `- v1.0（${today}）：初版`,
    '',
    `# 世界观设定`,
    '',
    ...wvSections
  ].join('\n')
  await writeTextAtomic(join(dir, '记忆系统', '世界观设定.md'), compiledWorldview)

  // 2. 角色卡
  const protagonists: string[] = []
  const sideCharacters: string[] = []
  const villains: string[] = []

  for (const [relPath, content] of Object.entries(settingsMap)) {
    if (relPath.startsWith('设定/角色/') && relPath.endsWith('.md')) {
      const charName = relPath.replace('设定/角色/', '').replace(/\.md$/, '')
      const lines = content.split(/\r?\n/)
      const h1Line = lines.find(l => /^#\s+/.test(l))
      const heading = h1Line ? h1Line.replace(/^#\s+/, '').trim() : charName

      const { fields } = parseBoldFields(content)
      const zhenying = String(fields.get('阵营') || fields.get('角色类型') || '').trim()

      let category = '核心配角'
      if (zhenying.includes('主角')) category = '主角'
      else if (zhenying.includes('反派')) category = '核心反派'

      const body = cleanContent(content)
      const block = `### ${heading}\n\n${body}`

      if (category === '主角') protagonists.push(block)
      else if (category === '核心反派') villains.push(block)
      else sideCharacters.push(block)
    }
  }

  const relContent = settingsMap['设定/关系.md'] || ''
  const relDoc = parseDoc(relContent)
  const relLogSec = findSection(relDoc, '关系变更日志')
  const relLogTable = relLogSec ? `## 关系变更日志\n\n${relLogSec.body.trim()}` : ''

  const compiledCharacterCard = [
    `**版本**：v1.0（${today} 创建）`,
    `**修改记录**`,
    `- v1.0（${today}）：初版`,
    '',
    `# 角色卡`,
    '',
    `## 主角`,
    ...protagonists,
    '',
    `## 核心配角`,
    ...sideCharacters,
    '',
    `## 核心反派`,
    ...villains,
    '',
    relLogTable
  ].join('\n')
  await writeTextAtomic(join(dir, '记忆系统', '角色卡.md'), compiledCharacterCard)

  // 3. 地点档案
  const diliContent = settingsMap['设定/世界观/地理.md']
  if (diliContent) {
    const lines = diliContent.split(/\r?\n/)
    const h1Index = lines.findIndex(l => /^#\s+/.test(l))
    const cleanDili = h1Index >= 0
      ? [
          `**版本**：v1.0（${today} 创建）`,
          `**修改记录**`,
          `- v1.0（${today}）：初版`,
          '',
          `# 地点档案`,
          ...lines.slice(h1Index + 1)
        ].join('\n')
      : diliContent
    await writeTextAtomic(join(dir, '记忆系统', '地点档案.md'), cleanDili)
  }

  // 4. 核心情节
  const plotVolumes: string[] = []
  if (volumes.length > 0) {
    const keys = Object.keys(outlineMap)
    for (const v of volumes) {
      const volumeKey = keys.find(k => {
        const m = k.match(/第([一二三四五六七八九十百零〇两\d]+)卷/)
        if (!m) return false
        const val = parseVolumeToken(m[1])
        return val === v.number
      })
      if (volumeKey) {
        const content = cleanVolumeContent(outlineMap[volumeKey])
        if (content) {
          plotVolumes.push(`## 第${v.number}卷：${v.name}（第${v.chapterStart}-${v.chapterEnd}章）\n\n${content}`)
        }
      }
    }
  }

  if (plotVolumes.length > 0) {
    const compiledPlot = [
      `**版本**：v1.0（${today} 创建）`,
      `**修改记录**`,
      `- v1.0（${today}）：初版`,
      '',
      `# 核心情节`,
      '',
      ...plotVolumes
    ].join('\n')
    await writeTextAtomic(join(dir, '记忆系统', '核心情节.md'), compiledPlot)
  }
}
