import { join } from 'path'
import { promises as fs } from 'fs'
import {
  readText,
  parseDoc,
  parseBoldFields,
  parseVolumeNumber,
  parseChapterNumber,
  parseChapterHeadingNumber,
  BOLD_FIELD_HEAD,
  BOLD_FIELD_SUB_DASH,
  BOLD_FIELD_SUB_NUM,
  type FieldValue
} from './md-parser'
import type { ChapterDetail, DetailedOutlineRaw, OutlineProseSection } from '../../../shared/types'
import { composeWritingRequirements } from '../../../shared/writing-requirement-templates'

/**
 * 细纲读取。支持双格式：
 *
 * 1. **技能标准格式（v3.2+）**：`细纲/细纲_第NNN章_标题.md`（每章一个文件）
 *    - 文件名含 3 位零填充章号 + 番茄风格标题
 *    - H1 = `# 细纲_第NNN章_标题.md`
 *    - H2 `## 第 N 章：标题` 为章号块，含富字段
 *    - 其余 H2（内容概括/情节安排/人物关系/情节细化/结尾设定等）为扩展节
 *    - 来源：小说立项技能 + 参考书《民国老六》等
 *
 * 2. **旧格式（兼容）**：`细纲/第NN卷.md`（每卷一个文件，H2 分章）
 *    - H1 给出卷号；H2 `## 第N章：标题` 每章一块
 *    - 来源：app 自身创建的项目
 */
export class DetailedOutlineMdRepo {
  constructor(private readonly projectDir: string) {}

  /** 读取所有章的细纲，合并为 ChapterDetail[]（自动识别双格式） */
  async listAll(): Promise<ChapterDetail[]> {
    const dir = join(this.projectDir, '细纲')
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      throw err
    }
    const details: ChapterDetail[] = []
    for (const f of files.sort()) {
      if (!f.endsWith('.md')) continue
      const text = await readText(join(dir, f))
      if (!text) continue
      details.push(...this.parseFile(f, text))
    }
    return details.sort((a, b) => a.chapterNumber - b.chapterNumber)
  }

  /**
   * 读取指定章细纲的**原始 md 文本**（不做字段解析）。
   *
   * 用于「查看完整细纲」：`listAll()` 只把加粗字段行收进 ChapterDetail，
   * 纯段落节（如 `## 情节安排` 下的散文）在结构化结果里看不到，这里给出磁盘原文。
   *
   * - 新格式（每章一文件）：返回整份文件文本（含所有扩展 H2 节）。
   * - 旧格式（每卷一文件）：只截取该章的 H2 块，避免把整卷剧透出来。
   *
   * 找不到该章时返回 null。
   */
  async readRaw(chapterNumber: number): Promise<DetailedOutlineRaw | null> {
    const dir = join(this.projectDir, '细纲')
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return null
      throw err
    }
    for (const f of files.sort()) {
      if (!f.endsWith('.md')) continue
      const text = await readText(join(dir, f))
      if (!text) continue
      const doc = parseDoc(text)
      const chapterSections = doc.sections.filter((s) => parseChapterHeadingNumber(s.title) != null)
      // 每章一文件：文件名/H1 命中 `细纲_第NNN章`，或文件内根本没有章号 H2 块（变体格式）
      const isPerChapterFile =
        /^细纲_第\d+章/.test(f) || /^细纲_第\d+章/.test(doc.h1Title) || chapterSections.length === 0
      if (isPerChapterFile) {
        const fileChapter = parseChapterNumber(f) ?? parseChapterNumber(doc.h1Title)
        if (fileChapter === chapterNumber) return { fileName: f, text }
        continue
      }
      // 每卷一文件：截取本章 H2 块
      const sec = chapterSections.find((s) => parseChapterHeadingNumber(s.title) === chapterNumber)
      if (sec) return { fileName: f, text: `## ${sec.title}\n${sec.body}`.trim() }
    }
    return null
  }

  /** 读取指定卷的细纲 */
  async listVolume(volume: number): Promise<ChapterDetail[]> {
    // 旧格式：直接读 第NN卷.md
    const legacyFile = join(this.projectDir, '细纲', `第${String(volume).padStart(2, '0')}卷.md`)
    const legacyText = await readText(legacyFile)
    if (legacyText) {
      return this.parseFile(`第${String(volume).padStart(2, '0')}卷.md`, legacyText)
    }
    // 新格式：从卷范围筛选（需读全部文件后按 volume 过滤）
    const all = await this.listAll()
    return all.filter((d) => d.volume === volume)
  }

  private parseFile(fileName: string, text: string): ChapterDetail[] {
    const doc = parseDoc(text)
    const volumeFromH1 = parseVolumeNumber(doc.h1Title) ?? undefined

    // 判断文件格式：
    // 新格式文件名：细纲_第NNN章_标题.md（每章一文件）
    // 旧格式文件名：第NN卷.md（每卷一文件）
    const isPerChapterFile = /^细纲_第\d+章/.test(fileName) || /^细纲_第\d+章/.test(doc.h1Title)

    if (isPerChapterFile) {
      // 新格式：每章一文件，章号块是 H2「## 第 N 章：标题」
      let chSec = doc.sections.find((s) => parseChapterHeadingNumber(s.title) != null)
      // 从文件名提取章号（更可靠）
      let fileNameChapter = parseChapterNumber(fileName) ?? parseChapterNumber(doc.h1Title)
      // 从 H1 提取标题
      let titleFromFile = extractTitleFromH1(doc.h1Title)

      let fullBody: string
      if (!chSec) {
        // 兼容变体：H1 形如「# 细纲：第 N 章 标题」，文件内无「## 第N章」H2 章号块。
        // 此时整文件 body 作为字段源；章号/标题从文件名与 H1 兜底。
        if (fileNameChapter == null) return []
        if (!titleFromFile) titleFromFile = extractTitleFromH1Variant(doc.h1Title)
        fullBody = doc.body
        // 构造一个虚拟章号块标题供 parseChapterBlock 使用
        chSec = {
          level: 2,
          startLine: 0,
          title: `第 ${fileNameChapter} 章${titleFromFile ? '：' + titleFromFile : ''}`,
          body: doc.body
        }
      } else {
        fileNameChapter = fileNameChapter ?? parseChapterHeadingNumber(chSec.title)
        if (fileNameChapter == null) return []
        // 合并所有 H2 节的 body 作为完整字段源（含扩展节）
        fullBody = collectAllSections(doc, chSec)
      }

      const d = parseChapterBlock(chSec.title, fullBody, volumeFromH1)
      if (!d) return []
      // 文件名章号优先
      d.chapterNumber = fileNameChapter
      // 文件名标题更精确
      if (titleFromFile) d.title = titleFromFile
      // 从引用块提取卷号和节奏对齐信息
      applyReferenceBlock(doc, d)
      return [d]
    }

    // 旧格式：每卷一文件，所有 H2 都是章号块
    const chapters = doc.sections.filter((s) => parseChapterHeadingNumber(s.title) != null)
    const details: ChapterDetail[] = []
    for (const ch of chapters) {
      const d = parseChapterBlock(ch.title, ch.body, volumeFromH1)
      if (d) details.push(d)
    }
    return details
  }
}

/**
 * 解析单章细纲块。heading 形如 "第 2 章：破窗" 或 "第 30 章：变异兽王（卷终决战）"。
 * body 可含多节内容（新格式的扩展 H2 节已被合并进来）。
 */
/**
 * 纯数字值，允许尾随括号注释。
 * 技能会写「7（对齐大纲节奏标注表）」「1（0/1/2/3/3.5/4）」这类带口径说明的值，
 * 早先只认光秃秃的数字，这些章的情绪值/爽点会被整体读丢。
 */
const LEADING_NUMBER = /^\s*(\d+(?:\.\d+)?)\s*(?:[（(].*)?$/

/** 按键名前缀取字段值：容忍「节奏标注（必填，对齐节奏图谱）」这类带后缀的键 */
function findByPrefix(fields: Map<string, FieldValue>, prefix: string): FieldValue | undefined {
  const exact = fields.get(prefix)
  if (exact !== undefined) return exact
  for (const [key, value] of fields) {
    if (key.startsWith(prefix)) return value
  }
  return undefined
}

export function parseChapterBlock(heading: string, body: string, volumeDefault?: number): ChapterDetail | null {
  const chapterNumber = parseChapterNumber(heading)
  if (chapterNumber == null) return null
  // heading 形如 "第 2 章：破窗" 或 "第 30 章：变异兽王（卷终决战）"
  const titleMatch = heading.match(/[：:]\s*([^\n（(]+)/)
  const title = titleMatch ? titleMatch[1].trim() : ''
  const { fields, order } = parseBoldFields(body)
  const writingRequirementTemplateId = toStr(fields.get('写作要求模板'))
  const writingRequirementCustomText = toMultilineStr(fields.get('自定义补充要求'))
  const legacyWritingRequirements =
    toMultilineStr(fields.get('本章写作要求')) ?? toMultilineStr(fields.get('写作要求'))

  // 键名按前缀取：技能模板实际会写成「节奏标注（必填，对齐节奏图谱）」，严格等值匹配会整节读不到
  const rhythmAnn = toArr(findByPrefix(fields, '节奏标注')) ?? []
  let emotion: number | undefined
  let climax: number | undefined
  for (const line of rhythmAnn) {
    const em = line.match(/情绪值[：:]\s*(\d+(?:\.\d+)?)/)
    if (em) emotion = Number(em[1])
    const cl = line.match(/爽点类型[：:]\s*(\d+(?:\.\d+)?)/)
    if (cl) climax = Number(cl[1])
  }

  // 新格式细纲的节奏信息也可能在引用块或目标情绪/本章爽点字段中
  if (emotion === undefined) {
    const targetEmotion = toStr(fields.get('目标情绪'))
    if (targetEmotion) {
      const em = targetEmotion.match(/情绪值[：:]\s*(\d+(?:\.\d+)?)/)
      if (em) emotion = Number(em[1])
      else {
        // 兼容纯数字值，允许尾随括号注释（如「- **目标情绪**：7（对齐大纲节奏标注表）」）
        const num = targetEmotion.match(LEADING_NUMBER)
        if (num) emotion = Number(num[1])
      }
    }
  }
  if (climax === undefined) {
    const coolPointStr = toStr(fields.get('本章爽点'))
    if (coolPointStr) {
      const cl = coolPointStr.match(/爽点类型\s*(\d+(?:\.\d+)?)/)
      if (cl) climax = Number(cl[1])
    }
  }
  // 「基本信息」节里的「爽点类型」字段（纯数字）
  if (climax === undefined) {
    const coolPointType = toStr(fields.get('爽点类型'))
    if (coolPointType) {
      const cl = coolPointType.match(/爽点类型\s*(\d+(?:\.\d+)?)/)
      if (cl) climax = Number(cl[1])
      else {
        const num = coolPointType.match(LEADING_NUMBER)
        if (num) climax = Number(num[1])
      }
    }
  }
  // 最后回退：扫描 body 全文里的「- **爽点类型**：N」（纯数字值）。
  // 处理「基本信息」和「本章爽点」节里都出现「爽点类型」字段、后者覆盖前者的情形。
  if (climax === undefined) {
    const allMatches = body.matchAll(
      /^\s*-\s+\*\*爽点类型\*\*\s*[：:]\s*(\d+(?:\.\d+)?)\s*(?:[（(][^\n]*)?$/gm
    )
    for (const m of allMatches) {
      climax = Number(m[1])
      break
    }
  }
  // 「基础信息」表里的节奏锚点行：`| **节奏锚点** | ▃ 小打脸（情绪 7 / 类型 1）|`
  // 这类细纲没有任何加粗字段，节奏信息只存在于 GFM 表格里
  if (emotion === undefined || climax === undefined) {
    const anchor = body.match(
      /节奏锚点[^|\n]*\|[^|\n]*情绪\s*(\d+(?:\.\d+)?)\s*\/\s*类型\s*(\d+(?:\.\d+)?)/
    )
    if (anchor) {
      if (emotion === undefined) emotion = Number(anchor[1])
      if (climax === undefined) climax = Number(anchor[2])
    }
  }

  const detail: ChapterDetail = {
    chapterNumber,
    title,
    volume: volumeDefault,
    emotion,
    climax,
    plotSummary:
      toStr(fields.get('核心事件')) ??
      extractSectionBody(body, '核心事件') ??
      undefined,
    coolPoint:
      toStr(fields.get('爽点/打脸')) ??
      toStr(fields.get('爽点')) ??
      toStr(fields.get('本章爽点')) ??
      toStr(fields.get('爽点描述')) ??
      undefined,
    charactersAppearing: extractCharactersAppearing(fields, body),
    foreshadowings: toArr(fields.get('伏笔铺设')) ?? toArr(fields.get('伏笔埋设')),
    hook:
      toStr(fields.get('章末钩子')) ??
      toStr(fields.get('章尾钩子')) ??
      toStr(fields.get('下章钩子')) ??
      toStr(fields.get('结尾描述')) ??
      undefined,
    wordEstimate: toStr(fields.get('字数预估')) ?? toStr(fields.get('字数目标')),
    goldenLine: toStr(fields.get('金句')),
    climaxTag: toStr(fields.get('卷终反转')) ?? toStr(fields.get('关键设定')),
    writingRequirements: composeWritingRequirements(
      writingRequirementTemplateId,
      writingRequirementCustomText,
      legacyWritingRequirements
    ),
    writingRequirementTemplateId,
    writingRequirementCustomText,
    rawFields: toRawFields(fields, order)
  }
  const prose = dropDuplicatedProse(extractProseSections(body), detail.plotSummary)
  if (prose.length > 0) detail.proseSections = prose
  return detail
}

/**
 * 去掉已被结构化字段吃掉的段落，避免同一段内容在 prompt 里出现两次。
 * 典型：变体格式的 `## 核心事件` 纯段落已由 extractSectionBody 并入 plotSummary。
 */
function dropDuplicatedProse(
  sections: OutlineProseSection[],
  plotSummary: string | undefined
): OutlineProseSection[] {
  if (!plotSummary) return sections
  const normalize = (s: string): string => s.replace(/\s+/g, '')
  const summary = normalize(plotSummary)
  return sections.filter((s) => {
    const text = normalize(s.text)
    return !summary.includes(text) && !text.includes(summary)
  })
}

/** 从新格式 H1 `# 细纲_第NNN章_标题.md` 提取标题 */
function extractTitleFromH1(h1: string): string {
  // H1 形如 "细纲_第001章_痞子当场下跪.md"
  const m = h1.match(/^细纲_第\d+章[_\s]*(.+?)(?:\.md)?$/)
  return m ? m[1].trim() : ''
}

/**
 * 兼容变体 H1 提取标题。匹配形如：
 * - `细纲：第 1 章 4位女嘉宾同时指向角落发呆的他`
 * - `细纲:第1章标题`
 * 即「细纲」+ 冒号 + 「第N章」+ 标题。
 */
function extractTitleFromH1Variant(h1: string): string {
  const m = h1.match(/^细纲\s*[：:]\s*第\s*\d+\s*章\s*(.+?)\s*$/)
  return m ? m[1].trim() : ''
}

/**
 * 合并章号块及其后续扩展 H2 节的 body（新格式每章一文件，多节都在同一文件内）。
 *
 * 保留各节的 `## 标题` 行：加粗字段解析不受标题行影响，而纯段落节需要靠标题
 * 才能归组（见 extractProseSections），extractSectionBody 也依赖标题定位。
 */
function collectAllSections(
  doc: ReturnType<typeof parseDoc>,
  chapterSection: { title: string; body: string }
): string {
  // 章号块本身的内容
  let fullBody = chapterSection.body

  // 找到章号块在 sections 中的位置，合并后续非章号 H2 节
  const chIdx = doc.sections.findIndex((s) => s.title === chapterSection.title)
  if (chIdx >= 0) {
    for (let i = chIdx + 1; i < doc.sections.length; i++) {
      const sec = doc.sections[i]
      // 后续非章号 H2 节都是该章的扩展内容（如 内容概括/情节安排/人物关系/情节点序列等）
      if (parseChapterHeadingNumber(sec.title) != null) break // 遇到下一个章号块则停止
      fullBody += `\n## ${sec.title}\n${sec.body}`
    }
  }

  return fullBody
}

/**
 * 判断是否为 `- **字段**：值` 行（parseBoldFields 消费的行）。
 *
 * 必须与 parseBoldFields 用同一个文法，否则两边会对同一行给出不同判断：
 * 解析器把它当字段收走，这里却当它是散文，于是该行**既是字段又出现在正文里**。
 * 所以直接复用 md-parser 导出的常量，不要再写一份。
 */
function isBoldFieldLine(line: string): boolean {
  return BOLD_FIELD_HEAD.test(line)
}

/** 判断是否为缩进子列表项（`  - xxx` / `  1. xxx`），即加粗字段的下挂内容 */
function isSubListLine(line: string): boolean {
  return BOLD_FIELD_SUB_DASH.test(line) || BOLD_FIELD_SUB_NUM.test(line)
}

/**
 * 提取纯段落内容，按所属小节标题分组。
 *
 * 与 parseBoldFields 互补：凡被加粗字段行（及其缩进子列表）消费掉的行一律跳过，
 * 剩下的非空行就是「没有字段标记、因而此前彻底丢失」的散文内容——
 * 如技能格式里的 `## 情节安排`、`## 章首钩子`。
 *
 * 标题为空串表示该段直接挂在章号块下、没有小节归属。
 */
export function extractProseSections(body: string): OutlineProseSection[] {
  const lines = body.split(/\r?\n/)
  const groups: OutlineProseSection[] = []
  let title = ''
  let buf: string[] = []
  let inFence = false

  const flush = (): void => {
    // 段间空行保留，段首段尾的空行去掉
    const text = buf.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    if (text) groups.push({ title, text })
    buf = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith('```')) {
      inFence = !inFence
      buf.push(line)
      continue
    }
    if (inFence) {
      buf.push(line)
      continue
    }

    const heading = line.match(/^#{2,4}\s+(.+?)\s*$/)
    if (heading) {
      flush()
      title = heading[1].trim()
      continue
    }

    // 加粗字段行 + 其缩进子列表：已由 parseBoldFields 收走，跳过
    if (isBoldFieldLine(line)) {
      while (i + 1 < lines.length && isSubListLine(lines[i + 1])) i++
      continue
    }

    // `> 所属卷：…` / `> 节奏对齐：…` 是元信息引用块，已由 applyReferenceBlock 消费
    if (/^\s*>/.test(line)) continue

    if (line.trim() === '') {
      if (buf.length > 0) buf.push('')
      continue
    }
    buf.push(line.trim())
  }
  flush()

  return groups
}

/**
 * 从合并后的 body 文本里提取指定 H2 节的纯段落体。
 *
 * 变体格式（H1 用冒号、无 H2 章号块）里，`## 核心事件` 等节的体是纯段落，
 * 没有 `- **核心事件**：` 字段标记，parseBoldFields 拿不到。这里兜底：
 * 找到 `## <sectionName>` 节，取其纯文本段落（跳过字段行、子标题、子列表）。
 */
function extractSectionBody(body: string, sectionName: string): string | undefined {
  const lines = body.split(/\r?\n/)
  let inSection = false
  let foundH2 = false
  const para: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 进入目标 H2 节
    if (!inSection) {
      if (new RegExp(`^##\\s+${sectionName}\\s*$`).test(line)) {
        inSection = true
        foundH2 = true
      }
      continue
    }
    // 已在目标节内
    // 遇到下一个 H2/H3 标题则结束
    if (/^#{2,3}\s/.test(line)) break
    // 跳过字段行 `- **xxx**：`
    if (/^\s*-\s+\*\*.+?\*\*\s*[：:]/.test(line)) continue
    // 跳过数字子列表项
    if (/^\s{2,}\d+\s*[.、)]\s+/.test(line)) continue
    // 跳过连字符子列表项
    if (/^\s{2,}-\s+/.test(line)) continue
    // 跳过空行
    if (line.trim() === '') continue
    para.push(line.trim())
  }
  if (!foundH2) return undefined
  const text = para.join(' ').trim()
  return text || undefined
}

/** 从引用块/参考信息中提取卷号并应用 */
function applyReferenceBlock(doc: ReturnType<typeof parseDoc>, detail: ChapterDetail): void {
  // 引用块形如 "> 所属卷：第 1 卷"
  const body = doc.body
  const volMatch = body.match(/所属卷[：:]\s*第\s*(\d+)\s*卷/)
  if (volMatch) {
    detail.volume = parseInt(volMatch[1], 10)
  }
  // 「基本信息」节里的「卷号」字段（如「- **卷号**：第一卷」或「- **卷号**：第 3 卷」）
  if (detail.volume === undefined) {
    const allFields = parseBoldFields(doc.body).fields
    const volField = toStr(allFields.get('卷号'))
    if (volField) {
      const n = parseVolumeNumber(volField)
      if (n != null) detail.volume = n
    }
  }
  // 引用块形如 "> 节奏对齐：情绪值 7、爽点类型 2"
  const rhythmMatch = body.match(/节奏对齐[：:]\s*情绪值\s*(\d+(?:\.\d+)?)[，,、]\s*爽点类型\s*(\d+(?:\.\d+)?)/)
  if (rhythmMatch) {
    if (detail.emotion === undefined) detail.emotion = Number(rhythmMatch[1])
    if (detail.climax === undefined) detail.climax = Number(rhythmMatch[2])
  }
}

/** 从人物关系和出场顺序字段提取角色出场列表 */
function extractCharactersAppearing(
  fields: Map<string, FieldValue>,
  rawBody: string
): string[] | undefined {
  // 优先标准字段
  const standard = toArr(fields.get('角色出场'))
  if (standard && standard.length > 0) return standard

  // 新格式：从「出场顺序」字段提取角色名
  // parseBoldFields 可能只捕获了空串（子列表是数字列表未被解析），
  // 所以直接从 rawBody 的「出场顺序」段提取
  const orderSection = extractFieldSubList(rawBody, '出场顺序')
  if (orderSection) {
    const chars = parseCharacterList(orderSection)
    if (chars.length > 0) return chars
  }

  // 从 fields 的出场顺序字段提取（如果 parseBoldFields 成功捕获了子列表）
  const orderField = fields.get('出场顺序')
  if (orderField) {
    const orderText = Array.isArray(orderField) ? orderField.join('\n') : orderField
    if (orderText.trim()) {
      const chars = parseCharacterList(orderText)
      if (chars.length > 0) return chars
    }
  }

  // 从「人物关系和出场顺序」的子列表提取
  const relArr = toArr(fields.get('人物关系和出场顺序'))
  if (relArr) {
    const chars = parseCharacterList(relArr.join('\n'))
    if (chars.length > 0) return chars
  }

  return undefined
}

/**
 * 从 rawBody 中提取某 `- **字段名**：` 后的数字子列表（`  1. xxx` / `  2. xxx`）。
 * parseBoldFields 只识别 `  - xxx` 连字符子列表，数字子列表需手动提取。
 */
function extractFieldSubList(rawBody: string, fieldName: string): string | null {
  const lines = rawBody.split(/\r?\n/)
  let inField = false
  const items: string[] = []
  for (const line of lines) {
    // 进入字段区域
    if (line.includes(`**${fieldName}**`)) {
      inField = true
      continue
    }
    if (inField) {
      // 数字子列表项：  1. xxx /  2. xxx
      const m = line.match(/^\s{2,}\d+\s*[.、)]\s+(.+)$/)
      if (m) {
        items.push(m[1].trim())
        continue
      }
      // 连字符子列表也接受
      const sm = line.match(/^\s{2,}-\s+(.+)$/)
      if (sm) {
        items.push(sm[1].trim())
        continue
      }
      // 遇到下一个字段（`- **` 开头）则停止
      if (/^\s*-\s+\*\*.+?\*\*\s*[：:]/.test(line)) break
      // 遇到 H2/H3 标题则停止
      if (/^#{2,3}\s/.test(line)) break
    }
  }
  return items.length > 0 ? items.join('\n') : null
}

/** 从出场顺序文本提取角色名（匹配 "N. 角色名（...）" 或 "角色名（...）" 格式） */
function parseCharacterList(text: string): string[] {
  // 兼容单行「A → B → C」/「A -> B -> C」格式（变体格式里出场顺序常为一行）
  if (/→|->/.test(text) && !text.includes('\n')) {
    const parts = text.split(/→|->/).map((s) => s.trim()).filter(Boolean)
    const chars: string[] = []
    for (const part of parts) {
      // 去掉括号内注释
      const name = part.replace(/[（(].*$/, '').trim()
      if (name && name.length > 0 && name.length <= 10 && !name.includes('，') && !name.includes('。') && !chars.includes(name)) {
        chars.push(name)
      }
    }
    if (chars.length > 0) return chars
  }

  const chars: string[] = []
  const lines = text.split(/\n/)
  for (const line of lines) {
    // 匹配带编号的 "1. 苏九（...）" 或不带编号的 "苏九（...）"
    // 角色名是括号前的部分
    const m = line.match(/^(?:\s*\d+\s*[.、)]\s*)?(.+?)(?:\s*[（(].*)?$/)
    if (m) {
      const name = m[1].trim()
      // 排除明显的描述性文字（太长或是句子）和空行
      if (name && name.length > 0 && name.length <= 10 && !name.includes('，') && !name.includes('。') && !chars.includes(name)) {
        chars.push(name)
      }
    }
  }
  return chars
}

function toStr(v: FieldValue | undefined): string | undefined {
  if (v == null || v === '') return undefined
  return Array.isArray(v) ? v.join('；') : v
}

function toMultilineStr(v: FieldValue | undefined): string | undefined {
  if (v == null || v === '') return undefined
  return Array.isArray(v) ? v.join('\n') : v
}

function toArr(v: FieldValue | undefined): string[] | undefined {
  if (v == null) return undefined
  return Array.isArray(v) ? v : [v]
}

function toRawFields(fields: Map<string, FieldValue>, order: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const k of order) {
    const v = fields.get(k)
    if (v == null) continue
    out[k] = Array.isArray(v) ? [...v] : v
  }
  return out
}
