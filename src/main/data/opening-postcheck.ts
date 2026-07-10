/**
 * 开书生成后处理 — 逻辑自洽 6 项检查（确定性，不调 LLM）。
 * 源自《小说立项》技能 SKILL.md「生成后处理 → 工序 B：逻辑自洽」。
 *
 * 6 项硬性检查：
 * 1. 章号格式：表格/条目中必须是阿拉伯 `第 1 章`，禁用 `第一章`
 * 2. 节奏图谱对齐：细纲情绪值/爽点类型与 rhythmData 差异 ≤ 1
 * 3. 伏笔编号合法：FB-NNN 三位零填充；类型在 5 类枚举中
 * 4. 角色名一致：细纲出现的新角色名必须与 设定/角色/*.md 文件名对得上
 * 5. 力量体系自洽：细纲内等级/技能/功法在 设定/世界观/力量体系.md 有定义
 * 6. 卷终情绪 = 10：每卷末尾章节情绪值 = 10（与 rhythmData 对账）
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { readText, parseDoc, findSection, parseTable } from './skill-format/md-parser'
import { OutlineMdRepo, extractRhythmFromText } from './skill-format/outline-md-repo'
import type { RhythmEntry } from '../../shared/types'

export type CheckSeverity = 'blocking' | 'advisory'

export interface ConsistencyViolation {
  /** 检查项编号 1-6 */
  check: number
  /** 检查项名称 */
  checkName: string
  /** 严重程度：blocking = 必须修才能进入下一步；advisory = 警告 */
  severity: CheckSeverity
  /** 违规文件相对路径（如「细纲/细纲_第001章_测试.md」），无具体文件时为空 */
  file: string
  /** 违规详情 */
  detail: string
  /** 建议修复方式 */
  fix: string
}

export interface ConsistencyReport {
  /** 是否全部通过（无 blocking 违规） */
  passed: boolean
  /** 违规清单 */
  violations: ConsistencyViolation[]
  /** 检查统计 */
  stats: {
    total: number
    blocking: number
    advisory: number
  }
}

const VALID_FB_TYPES = ['道具', '身世', '感情', '设定', '势力']
const VALID_FB_STATES = ['未回收', '已埋设', '已回收', '已错过']

/**
 * 执行 6 项逻辑自洽检查。
 * @param dir 项目根目录
 * @returns 检查报告
 */
export async function checkOpeningConsistency(dir: string): Promise<ConsistencyReport> {
  const violations: ConsistencyViolation[] = []

  // 6 项检查并行执行
  const [v1, v2, v3, v4, v5, v6] = await Promise.all([
    checkChapterNumberFormat(dir),
    checkRhythmAlignment(dir),
    checkForeshadowingIds(dir),
    checkCharacterNames(dir),
    checkPowerSystem(dir),
    checkVolumeEndEmotion(dir)
  ])
  violations.push(...v1, ...v2, ...v3, ...v4, ...v5, ...v6)

  const blocking = violations.filter((v) => v.severity === 'blocking').length
  const advisory = violations.filter((v) => v.severity === 'advisory').length
  return {
    passed: blocking === 0,
    violations,
    stats: { total: violations.length, blocking, advisory }
  }
}

/* =========================================================
   检查 1：章号格式（必须阿拉伯，禁用中文数字）
   ========================================================= */

async function checkChapterNumberFormat(dir: string): Promise<ConsistencyViolation[]> {
  const violations: ConsistencyViolation[] = []
  const scanDirs = ['大纲', '细纲', '追踪']
  // 中文数字章号正则：第一章 ~ 第九章，第一十章（10），第二十章，第三十一章 等
  // 注意：不能误伤「第1卷：第一卷名」这种卷名里的中文数字，只匹配章号模式
  const chineseChapterRe = /第[一二三四五六七八九十百零〇两]+章(?!节)/g

  for (const sub of scanDirs) {
    const subDir = join(dir, sub)
    let files: string[]
    try {
      files = await fs.readdir(subDir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      const filePath = join(subDir, f)
      const text = await readText(filePath)
      if (!text) continue
      const matches = [...text.matchAll(chineseChapterRe)]
      if (matches.length > 0) {
        const unique = [...new Set(matches.map((m) => m[0]))]
        violations.push({
          check: 1,
          checkName: '章号格式',
          severity: 'blocking',
          file: `${sub}/${f}`,
          detail: `发现 ${matches.length} 处中文数字章号：${unique.slice(0, 5).join('、')}${unique.length > 5 ? '…' : ''}`,
          fix: '批量替换为阿拉伯数字（如「第一章」→「第 1 章」）'
        })
      }
    }
  }
  return violations
}

/* =========================================================
   检查 2：节奏图谱对齐（细纲情绪值/爽点类型与 rhythmData 差异 ≤ 1）
   ========================================================= */

async function checkRhythmAlignment(dir: string): Promise<ConsistencyViolation[]> {
  const violations: ConsistencyViolation[] = []

  // 读取节奏图谱 HTML 的 rhythmData
  const rhythmHtml = await readText(join(dir, '图解', '节奏图谱.html'))
  if (!rhythmHtml) return violations
  const rhythmEntries = parseRhythmFromHtml(rhythmHtml)
  if (rhythmEntries.length === 0) return violations

  // 读取细纲目录下每章的情绪值/爽点类型
  const xiDir = join(dir, '细纲')
  let files: string[]
  try {
    files = await fs.readdir(xiDir)
  } catch {
    return violations
  }

  const chapterFiles = files.filter((f) => f.startsWith('细纲_第') && f.endsWith('.md'))
  for (const f of chapterFiles) {
    const m = f.match(/第(\d+)章/)
    if (!m) continue
    const chapter = parseInt(m[1], 10)
    const text = await readText(join(xiDir, f))
    if (!text) continue
    const rhythmMark = parseRhythmMarkFromChapter(text)
    if (!rhythmMark) continue

    const expected = rhythmEntries.find((e) => e.chapter === chapter)
    if (!expected) continue

    const emotionDiff = Math.abs(rhythmMark.emotion - expected.emotion)
    if (emotionDiff > 1) {
      violations.push({
        check: 2,
        checkName: '节奏图谱对齐',
        severity: 'advisory',
        file: `细纲/${f}`,
        detail: `第 ${chapter} 章情绪值差异 ${emotionDiff}（细纲 ${rhythmMark.emotion} vs 节奏图谱 ${expected.emotion}）`,
        fix: '修改细纲情绪值对齐节奏图谱，或同步更新节奏图谱'
      })
    }
    if (rhythmMark.climax !== expected.climax) {
      violations.push({
        check: 2,
        checkName: '节奏图谱对齐',
        severity: 'advisory',
        file: `细纲/${f}`,
        detail: `第 ${chapter} 章爽点类型不一致（细纲 ${rhythmMark.climax} vs 节奏图谱 ${expected.climax}）`,
        fix: '修改细纲爽点类型对齐节奏图谱，或同步更新节奏图谱'
      })
    }
  }
  return violations
}

/* =========================================================
   检查 3：伏笔编号合法（FB-NNN 三位零填充 + 类型枚举）
   ========================================================= */

async function checkForeshadowingIds(dir: string): Promise<ConsistencyViolation[]> {
  const violations: ConsistencyViolation[] = []
  const text = await readText(join(dir, '追踪', '伏笔.md'))
  if (!text) return violations

  const doc = parseDoc(text)
  // 伏笔表在顶层或 H2 下，用 parseTable 找
  const { headers, rows } = parseTable(doc.body)
  if (headers.length < 4) return violations

  const idxId = headers.findIndex((h) => h.includes('编号'))
  const idxType = headers.findIndex((h) => h.includes('类型'))
  const idxState = headers.findIndex((h) => h.includes('状态'))
  if (idxId < 0) return violations

  const fbIdRe = /^FB-(\d{3})$/
  for (const row of rows) {
    const id = (row[idxId] || '').trim()
    if (!id || id === '—') continue
    if (!fbIdRe.test(id)) {
      violations.push({
        check: 3,
        checkName: '伏笔编号合法',
        severity: 'advisory',
        file: '追踪/伏笔.md',
        detail: `伏笔编号「${id}」不符合 FB-NNN 三位零填充格式`,
        fix: '改为 FB-001 格式（三位零填充）'
      })
    }
    if (idxType >= 0) {
      const type = (row[idxType] || '').trim()
      if (type && !VALID_FB_TYPES.includes(type)) {
        violations.push({
          check: 3,
          checkName: '伏笔编号合法',
          severity: 'advisory',
          file: '追踪/伏笔.md',
          detail: `伏笔「${id}」类型「${type}」不在 5 类枚举（${VALID_FB_TYPES.join('/')}）中`,
          fix: `改为 5 类之一：${VALID_FB_TYPES.join(' / ')}`
        })
      }
    }
    if (idxState >= 0) {
      const state = (row[idxState] || '').trim()
      if (state && !VALID_FB_STATES.includes(state)) {
        violations.push({
          check: 3,
          checkName: '伏笔编号合法',
          severity: 'advisory',
          file: '追踪/伏笔.md',
          detail: `伏笔「${id}」状态「${state}」不在 4 类枚举（${VALID_FB_STATES.join('/')}）中`,
          fix: `改为 4 类之一：${VALID_FB_STATES.join(' / ')}`
        })
      }
    }
  }
  return violations
}

/* =========================================================
   检查 4：角色名一致（细纲新角色名必须在 设定/角色/*.md 存在）
   ========================================================= */

async function checkCharacterNames(dir: string): Promise<ConsistencyViolation[]> {
  const violations: ConsistencyViolation[] = []

  // 读取 设定/角色/ 下所有角色文件名
  const charDir = join(dir, '设定', '角色')
  let charFiles: string[]
  try {
    charFiles = await fs.readdir(charDir)
  } catch {
    return violations
  }
  const knownNames = new Set(
    charFiles
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
  )
  if (knownNames.size === 0) return violations

  // 读取细纲，提取「角色出场」字段中的角色名
  const xiDir = join(dir, '细纲')
  let xiFiles: string[]
  try {
    xiFiles = await fs.readdir(xiDir)
  } catch {
    return violations
  }

  for (const f of xiFiles) {
    if (!f.startsWith('细纲_第') || !f.endsWith('.md')) continue
    const text = await readText(join(xiDir, f))
    if (!text) continue
    // 提取「角色出场」行后的角色名（粗略：- **角色A**、角色A：等）
    const charSection = extractField(text, '角色出场')
    if (!charSection) continue
    // 简单策略：检查已知角色名是否被提到（反向验证更稳）
    // 这里做正向：提取 `- **角色名**` 或行首角色名，看是否在 knownNames
    const nameMatches = [...charSection.matchAll(/[-•]\s\*\*([^*]+)\*\*/g)]
    for (const m of nameMatches) {
      const name = m[1].trim()
      // 排除「按出场顺序」等描述性文字
      if (name.length < 2 || name.length > 10) continue
      if (/出场|顺序|顺序/.test(name)) continue
      if (!knownNames.has(name) && !isCommonRoleWord(name)) {
        violations.push({
          check: 4,
          checkName: '角色名一致',
          severity: 'advisory',
          file: `细纲/${f}`,
          detail: `细纲提到角色「${name}」但在 设定/角色/ 下无对应文件`,
          fix: `在 设定/角色/${name}.md 补建角色文件，或修正细纲中的角色名`
        })
      }
    }
  }
  return violations
}

/* =========================================================
   检查 5：力量体系自洽（细纲等级/技能/功法在力量体系.md 有定义）
   ========================================================= */

async function checkPowerSystem(dir: string): Promise<ConsistencyViolation[]> {
  const violations: ConsistencyViolation[] = []
  const powerText = await readText(join(dir, '设定', '世界观', '力量体系.md'))
  if (!powerText) return violations

  // 从力量体系提取等级名称（表格中的名称列）
  const powerDoc = parseDoc(powerText)
  const levelSection = findSection(powerDoc, '等级划分')
  const { headers, rows } = parseTable(levelSection?.body ?? powerDoc.body)
  const idxName = headers.findIndex((h) => h.includes('名称'))
  const knownLevels = new Set<string>()
  if (idxName >= 0) {
    for (const row of rows) {
      const name = (row[idxName] || '').trim()
      if (name && name.length >= 2) knownLevels.add(name)
    }
  }
  if (knownLevels.size === 0) return violations

  // 扫描细纲，检查是否提到力量等级（子串匹配）
  const xiDir = join(dir, '细纲')
  let xiFiles: string[]
  try {
    xiFiles = await fs.readdir(xiDir)
  } catch {
    return violations
  }

  for (const f of xiFiles) {
    if (!f.startsWith('细纲_第') || !f.endsWith('.md')) continue
    const text = await readText(join(xiDir, f))
    if (!text) continue
    // 检查细纲中提到的等级词是否在力量体系里
    // 粗略：找「突破到 X」「晋升 X」「X 境」「X 级」模式
    const levelMentions = [...text.matchAll(/(?:突破到|晋升|突破|达到)\s*([^\s，。、]{2,6})(?:境|级|阶|层)/g)]
    for (const m of levelMentions) {
      const level = m[1].trim()
      let found = false
      for (const known of knownLevels) {
        if (known.includes(level) || level.includes(known)) {
          found = true
          break
        }
      }
      if (!found) {
        violations.push({
          check: 5,
          checkName: '力量体系自洽',
          severity: 'advisory',
          file: `细纲/${f}`,
          detail: `细纲提到等级「${level}」但在 设定/世界观/力量体系.md 未定义`,
          fix: `在力量体系.md 补充「${level}」定义，或修正细纲用词`
        })
      }
    }
  }
  return violations
}

/* =========================================================
   检查 6：卷终情绪 = 10（每卷末尾章节 emotion 必须为 10）
   ========================================================= */

async function checkVolumeEndEmotion(dir: string): Promise<ConsistencyViolation[]> {
  const violations: ConsistencyViolation[] = []

  // 从大纲.md 或节奏图谱获取每卷的末尾章节
  const outlineRepo = new OutlineMdRepo(dir)
  const parsed = await outlineRepo.read()
  if (!parsed || parsed.volumes.length === 0) return violations

  // 读取节奏图谱 rhythmData
  const rhythmHtml = await readText(join(dir, '图解', '节奏图谱.html'))
  if (!rhythmHtml) return violations
  const rhythmEntries = parseRhythmFromHtml(rhythmHtml)
  if (rhythmEntries.length === 0) return violations

  for (const vol of parsed.volumes) {
    if (!vol.chapterEnd) continue
    const endEntry = rhythmEntries.find((e) => e.chapter === vol.chapterEnd)
    if (!endEntry) continue
    if (endEntry.emotion !== 10) {
      violations.push({
        check: 6,
        checkName: '卷终情绪=10',
        severity: 'advisory',
        file: '图解/节奏图谱.html',
        detail: `第 ${vol.number} 卷末尾（第 ${vol.chapterEnd} 章）情绪值为 ${endEntry.emotion}，应为 10`,
        fix: '修改卷终章节情绪值为 10，或调整卷的章节范围'
      })
    }
    if (endEntry.climax !== 4) {
      violations.push({
        check: 6,
        checkName: '卷终情绪=10',
        severity: 'advisory',
        file: '图解/节奏图谱.html',
        detail: `第 ${vol.number} 卷末尾（第 ${vol.chapterEnd} 章）爽点类型为 ${endEntry.climax}，应为 4（卷终决战）`,
        fix: '修改卷终章节爽点类型为 4'
      })
    }
  }
  return violations
}

/* =========================================================
   辅助函数
   ========================================================= */

/** 从节奏图谱 HTML 解析 rhythmData 数组 */
function parseRhythmFromHtml(html: string): RhythmEntry[] {
  const entries: RhythmEntry[] = []
  // 匹配 { chapter: 1, title: '...', emotion: 5, climax: 1, volume: 1, actualized: false }
  const re = /\{\s*chapter:\s*(\d+)\s*,\s*title:\s*(?:"([^"]*)"|'([^']*)')\s*,\s*emotion:\s*(\d+(?:\.\d+)?)\s*,\s*climax:\s*(\d+(?:\.\d+)?)\s*,\s*volume:\s*(\d+)\s*,\s*actualized:\s*(true|false)\s*\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    entries.push({
      chapter: parseInt(m[1], 10),
      title: m[2] ?? m[3] ?? '',
      emotion: Number(m[4]),
      climax: Number(m[5]),
      volume: parseInt(m[6], 10),
      actualized: m[7] === 'true'
    })
  }
  return entries
}

/** 从细纲内容解析节奏标注（情绪值/爽点类型） */
function parseRhythmMarkFromChapter(text: string): { emotion: number; climax: number } | null {
  const emotionMatch = text.match(/情绪值[：:]\s*(\d+)/)
  const climaxMatch = text.match(/爽点类型[：:]\s*(\d+(?:\.\d+)?)/)
  if (!emotionMatch && !climaxMatch) return null
  return {
    emotion: emotionMatch ? parseInt(emotionMatch[1], 10) : 0,
    climax: climaxMatch ? Number(climaxMatch[1]) : 0
  }
}

/** 从 Markdown 提取某字段的值（粗略：找到 `- **字段**：` 后到下一个 `- **` 或行尾） */
function extractField(text: string, fieldName: string): string {
  // 转义 fieldName 中的正则特殊字符，防止 regex injection / ReDoS
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`-\\s*\\*\\*${escaped}[（(]?[^)）]*[)）]?[）)]?\\s*[：:]([^]*?)(?=\\n-\\s*\\*\\*|$)`, 'm')
  const m = text.match(re)
  return m ? m[1] : ''
}

/** 常见角色描述词（非角色名），不报违规 */
function isCommonRoleWord(word: string): boolean {
  const common = ['主角', '配角', '反派', '路人', '所有人', '众人', '大家', '旁白', '未知', '神秘人']
  return common.includes(word)
}
