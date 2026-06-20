import { join } from 'path'
import { readText } from './md-parser'
import { parseRhythmData } from './rhythm-html'
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
}
