/**
 * 正文里的出版章号。
 *
 * 模型常把提示词里的「第 N 章」检索坐标抄进叙述（「与第九章检测所用样本」）。
 * 书名、经卷、笔记和「读到 / 翻到」后面的章号是故事内文献，保留。
 */

const CHAPTER_NUMBER = String.raw`(?:\d{1,4}|[一二三四五六七八九十百千零两]{1,12})`

const IN_WORLD_BEFORE =
  /(?:书|经|卷|篇|册|典|课|信|日记|笔记|手稿|卷宗|档案|教材|课本|《[^》\n]{1,40}》)的?\s*$/

const IN_WORLD_VERB =
  /(?:翻到|翻开|读到|看到|看见|念到|诵到|写着|印着|载于|出自|引自|见于|讲到)\s*$/

const TAIL_PHRASES = ['请看下回分解', '请看下回', '未完待续', '下章见'] as const

/** 写进系统提示和记忆块，告诉模型章号标签不能进正文。 */
export const CHAPTER_INDEX_NOT_PROSE =
  '提示词里的「第 N 章」只是检索坐标，禁止写入正文。回指旧事时用故事里的时间、地点、人物和事件，不要写章号。'

function chapterRef(): RegExp {
  return new RegExp(String.raw`第\s*${CHAPTER_NUMBER}\s*章(?!节)(?:\s*[里中内时])?`, 'g')
}

function relativeRef(): RegExp {
  return /(?:上|下|前)一章(?!节)(?:\s*[里中内时])?|本章(?!节)(?:\s*[里中内时])?/g
}

function headingRef(): RegExp {
  return new RegExp(String.raw`^第\s*${CHAPTER_NUMBER}\s*章(?:\s*[：:]\s*\S{1,20})?\s*$`)
}

function keepInWorld(whole: string, offset: number): boolean {
  const before = whole.slice(Math.max(0, offset - 24), offset)
  return IN_WORLD_BEFORE.test(before) || IN_WORLD_VERB.test(before)
}

function isChapterHeadingLine(line: string): boolean {
  return headingRef().test(line.trim())
}

/** 第一处会改写的出版章号；没有则返回 null。供写后自检使用。 */
export function findPublishedChapterLeak(text: string): string | null {
  if (!text) return null
  for (const line of text.split('\n')) {
    if (isChapterHeadingLine(line)) return line.trim()
  }
  for (const phrase of TAIL_PHRASES) {
    if (text.includes(phrase)) return phrase
  }
  for (const re of [chapterRef(), relativeRef()]) {
    let match: RegExpExecArray | null
    while ((match = re.exec(text))) {
      if (!keepInWorld(text, match.index)) return match[0]
    }
  }
  return null
}

/**
 * 把出版章号改成故事内的「先前」。
 * 「与第九章检测所用样本」→「与先前检测所用样本」。
 * 「他翻开《验尸录》第九章」保持原样。
 */
export function stripPublishedChapterRefs(text: string): string {
  if (!text || !findPublishedChapterLeak(text)) return text
  const lines = text.split('\n').filter((line) => !isChapterHeadingLine(line))
  let out = lines.join('\n')
  for (const phrase of TAIL_PHRASES) out = out.replaceAll(phrase, '')
  for (const re of [chapterRef(), relativeRef()]) {
    out = out.replace(re, (match, offset: number, whole: string) => (
      keepInWorld(whole, offset) ? match : '先前'
    ))
  }
  return out.replace(/。{2,}/g, '。').replace(/，{2,}/g, '，')
}
