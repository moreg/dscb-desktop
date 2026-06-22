import { join } from 'path'
import { readText } from './md-parser'
import { parseRhythmData, serializeRhythmData } from './rhythm-html'
import { writeTextAtomic } from '../atomic'
import type { RhythmEntry } from '../../../shared/types'

/**
 * 读取节奏图谱。真相源：`图解/节奏图谱.html` 的 rhythmData 数组。
 * 这是逐章 标题/情绪值/爽点/volume/actualized 的唯一机器可读源。
 */
export class RhythmHtmlRepo {
  constructor(private readonly projectDir: string) {}

  async read(): Promise<RhythmEntry[] | null> {
    const file = join(this.projectDir, '图解', '节奏图谱.html')
    const text = await readText(file)
    if (!text) return null
    return parseRhythmData(text)
  }

  /**
   * 回填某章的实际情绪值，并把 actualized 置为 true。
   * 外科手术式：只替换 rhythmData 块，html 其余部分原样保留。
   * 返回回写前的情绪值；若章节不存在返回 null。
   */
  async updateEmotion(
    chapter: number,
    newEmotion: number
  ): Promise<{ previousEmotion: number; newEmotion: number } | null> {
    const file = join(this.projectDir, '图解', '节奏图谱.html')
    const text = await readText(file)
    if (!text) return null
    const entries = parseRhythmData(text)
    if (!entries) return null
    const idx = entries.findIndex((e) => e.chapter === chapter)
    if (idx < 0) return null
    const previousEmotion = entries[idx].emotion
    entries[idx] = {
      ...entries[idx],
      emotion: newEmotion,
      actualized: true
    }
    const next = serializeRhythmData(text, entries)
    if (next === text) return null
    await writeTextAtomic(file, next)
    return { previousEmotion, newEmotion }
  }
}
