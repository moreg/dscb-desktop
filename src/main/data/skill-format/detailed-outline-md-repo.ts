import { join } from 'path'
import { promises as fs } from 'fs'
import { readText, parseDoc, parseBoldFields, parseVolumeNumber, parseChapterNumber, type FieldValue } from './md-parser'
import type { ChapterDetail } from '../../../shared/types'
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
      let chSec = doc.sections.find((s) => parseChapterNumber(s.title) != null)
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
        chSec = { title: `第 ${fileNameChapter} 章${titleFromFile ? '：' + titleFromFile : ''}`, body: doc.body }
      } else {
        fileNameChapter = fileNameChapter ?? parseChapterNumber(chSec.title)
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
    const chapters = doc.sections.filter((s) => parseChapterNumber(s.title) != null)
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

  const rhythmAnn = toArr(fields.get('节奏标注')) ?? []
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
        // 兼容纯数字值（如「- **目标情绪**：7」）
        const num = targetEmotion.match(/^\s*(\d+(?:\.\d+)?)\s*$/)
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
        const num = coolPointType.match(/^\s*(\d+(?:\.\d+)?)\s*$/)
        if (num) climax = Number(num[1])
      }
    }
  }
  // 最后回退：扫描 body 全文里的「- **爽点类型**：N」（纯数字值）。
  // 处理「基本信息」和「本章爽点」节里都出现「爽点类型」字段、后者覆盖前者的情形。
  if (climax === undefined) {
    const allMatches = body.matchAll(/^\s*-\s+\*\*爽点类型\*\*\s*[：:]\s*(\d+(?:\.\d+)?)\s*$/gm)
    for (const m of allMatches) {
      climax = Number(m[1])
      break
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
  return detail
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
 * 跳过非章号 H2 节的标题行但保留其 body 内容，使 parseBoldFields 能提取扩展字段。
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
      if (parseChapterNumber(sec.title) != null) break // 遇到下一个章号块则停止
      fullBody += '\n' + sec.body
    }
  }

  return fullBody
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
