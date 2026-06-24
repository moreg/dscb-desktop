/** 中文文本的简单分析工具 */

/** 中文常见虚词 / 口水词 */
const FILLER = ['的', '了', '着', '过', '啊', '呢', '嘛', '吧', '哦', '嗯', '然后', '于是', '就是', '其实', '基本上', '大概']

const POSITIVE_WORDS = [
  '笑', '喜', '乐', '欢', '暖', '明', '光', '阳', '希望', '喜', '胜', '赢', '成', '破', '升', '突破',
  '温柔', '温暖', '光明', '胜利', '希望', '喜悦', '欢喜', '微笑', '大笑', '开心', '激动',
  '拥抱', '牵', '吻', '守护', '救', '帮助', '伙伴', '友人'
]
const NEGATIVE_WORDS = [
  '哭', '泪', '痛', '伤', '恨', '怒', '恨', '寒', '冷', '暗', '血', '尸', '死', '亡', '灭',
  '背叛', '杀', '残', '仇', '恨', '恐惧', '恐', '惧', '绝望', '孤独', '寂',
  '失去', '被弃', '心碎', '悲痛', '愤怒', '阴谋', '诡计', '陷害'
]
const TENSE_WORDS = [
  '急', '猛', '疾', '速', '爆', '突', '冲', '杀', '刺', '破', '爆裂', '轰鸣', '炸',
  '雷电', '火焰', '爆发', '冲撞', '冲杀', '突袭'
]
const CALM_WORDS = [
  '静', '宁', '缓', '慢', '淡', '微', '风', '月', '雪', '雾', '云', '溪',
  '宁静', '安详', '沉思', '静坐', '低语', '微风', '细雨', '远山'
]

export interface ChapterStats {
  wordCount: number
  paragraphCount: number
  sentenceCount: number
  avgSentenceLen: number
  longestParagraphLen: number
  dialogueRatio: number
  fillerRatio: number
  /** 把正文切成 N 段后每段的情绪分数（-100..100，负=消极，正=积极） */
  emotionCurve: number[]
}

function countDialogueChars(text: string): number {
  const patterns = [
    /“([^”]+)”/g,
    /"([^"\n]+)"/g,
    /「([^」]+)」/g,
    /『([^』]+)』/g
  ]
  let total = 0
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      total += countWords(match[1] ?? '')
    }
  }
  return total
}

function countOccurrences(text: string, words: string[]): number {
  let n = 0
  for (const w of words) {
    let idx = 0
    while ((idx = text.indexOf(w, idx)) >= 0) {
      n++
      idx += w.length
    }
  }
  return n
}

/** 中文按"非空白连续字符"算字数（粗略） */
export function countWords(text: string): number {
  if (!text) return 0
  // 去掉空白
  const stripped = text.replace(/\s+/g, '')
  // 中文字符按 1 算，英文/数字按 1 字算（不区分 token）
  return stripped.length
}

export function analyze(text: string, segments = 12): ChapterStats {
  const wordCount = countWords(text)
  const trimmed = text.replace(/\r/g, '')
  const paragraphs = trimmed.split(/\n+/).filter((p) => p.trim().length > 0)
  const paragraphCount = paragraphs.length
  const sentences = trimmed.split(/[。！？!?]+/).filter((s) => s.trim().length > 0)
  const sentenceCount = sentences.length
  const avgSentenceLen = sentenceCount === 0 ? 0 : Math.round(wordCount / sentenceCount)
  const longestParagraphLen = paragraphs.reduce(
    (max, p) => Math.max(max, countWords(p)),
    0
  )
  // 对话比例：成对「」/"" 的字符占总字数
  const dialogueChars = countDialogueChars(trimmed)
  const dialogueRatio = wordCount === 0 ? 0 : dialogueChars / wordCount
  // 虚词比例
  const fillerHits = countOccurrences(trimmed, FILLER)
  const fillerRatio = wordCount === 0 ? 0 : fillerHits / wordCount

  // 情绪曲线：按段数等分正文，对每段打分
  const emotionCurve: number[] = []
  if (trimmed.length === 0) {
    for (let i = 0; i < segments; i++) emotionCurve.push(0)
  } else {
    const chunkSize = Math.max(1, Math.floor(trimmed.length / segments))
    for (let i = 0; i < segments; i++) {
      const start = i * chunkSize
      const end = i === segments - 1 ? trimmed.length : (i + 1) * chunkSize
      const chunk = trimmed.slice(start, end)
      const pos = countOccurrences(chunk, POSITIVE_WORDS)
      const neg = countOccurrences(chunk, NEGATIVE_WORDS)
      const tense = countOccurrences(chunk, TENSE_WORDS)
      const calm = countOccurrences(chunk, CALM_WORDS)
      // 强度
      const intensity = Math.min(1, (tense + calm) / 20)
      // 极性
      const polarity = pos - neg
      // 归一化到 -100..100，乘以强度
      const score = Math.max(-100, Math.min(100, polarity * 4 * (0.5 + intensity)))
      emotionCurve.push(Math.round(score))
    }
  }

  return {
    wordCount,
    paragraphCount,
    sentenceCount,
    avgSentenceLen,
    longestParagraphLen,
    dialogueRatio,
    fillerRatio,
    emotionCurve
  }
}

/** 给段落数打分：返回警告级别（0=无，1=提示，2=警告） */
export function rhythmWarnings(stats: ChapterStats): { kind: 'long' | 'filler'; level: 1 | 2; msg: string }[] {
  const out: { kind: 'long' | 'filler'; level: 1 | 2; msg: string }[] = []
  if (stats.longestParagraphLen > 200) {
    out.push({
      kind: 'long',
      level: stats.longestParagraphLen > 350 ? 2 : 1,
      msg: `最长段落 ${stats.longestParagraphLen} 字${stats.longestParagraphLen > 350 ? '（建议拆分）' : '（略长）'}`
    })
  }
  if (stats.fillerRatio > 0.12) {
    out.push({
      kind: 'filler',
      level: stats.fillerRatio > 0.2 ? 2 : 1,
      msg: `虚词占比 ${(stats.fillerRatio * 100).toFixed(1)}%${stats.fillerRatio > 0.2 ? '（明显过多）' : '（偏多）'}`
    })
  }
  if (stats.avgSentenceLen > 50) {
    out.push({
      kind: 'long',
      level: 1,
      msg: `平均句长 ${stats.avgSentenceLen} 字（偏长，可考虑拆分）`
    })
  }
  return out
}
