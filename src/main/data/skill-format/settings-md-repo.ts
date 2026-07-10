import { join } from 'path'
import { promises as fs } from 'fs'
import { readText, parseDoc } from './md-parser'

/**
 * 写作前的设定上下文（来自 `设定/` 目录）。
 * 这些文件由 opening-service 在开书时创建，记录题材定位、世界观、势力、规则等强约束素材。
 * 用于让续写 LLM 知晓核心梗、金手指规则、势力格局、自创机制等。
 */
export interface SettingsContext {
  /** 题材定位全文（核心梗/卖点/读者画像/主角人设/节奏规划） */
  genrePositioning: string
  /** 世界观文件（金手指/力量体系/背景设定等，每个文件 body） */
  worldview: SettingsDoc[]
  /** 势力文件（青帮/北方军阀/日本特务机关等） */
  factions: SettingsDoc[]
  /** 项目自创规则文件（如 罗盘指认功能规则.md，顶层 .md 文件，排除题材定位） */
  customRules: SettingsDoc[]
}

export interface SettingsDoc {
  /** 文件名（不含扩展名，如「金手指」「青帮」） */
  name: string
  /** 文件 body（H1 后全部内容） */
  body: string
}

/**
 * 读取 `设定/` 目录下的设定文件，聚合为 SettingsContext。
 * - `设定/题材定位.md`：整文件 body
 * - `设定/世界观/*.md`：每个文件 body
 * - `设定/势力/*.md`：每个文件 body
 * - `设定/*.md`（顶层，排除题材定位）：自创规则
 *
 * 返回 null 表示 `设定/` 目录不存在（老项目）。
 */
export class SettingsMdRepo {
  constructor(private readonly projectDir: string) {}

  async read(): Promise<SettingsContext | null> {
    const dir = join(this.projectDir, '设定')
    let exists = true
    try {
      await fs.access(dir)
    } catch {
      exists = false
    }
    if (!exists) return null

    const [genrePositioning, worldview, factions, customRules] = await Promise.all([
      readGenrePositioning(dir),
      readSubDirDocs(dir, '世界观'),
      readSubDirDocs(dir, '势力'),
      readTopLevelRules(dir)
    ])

    // 过滤掉 body 为空的文件（项目创建时的空模板）
    const filteredWorldview = worldview.filter((w) => w.body.trim())
    const filteredFactions = factions.filter((f) => f.body.trim())
    const filteredCustomRules = customRules.filter((r) => r.body.trim())

    // 全空 → 视为无设定（避免注入空标题段）
    if (
      !genrePositioning &&
      filteredWorldview.length === 0 &&
      filteredFactions.length === 0 &&
      filteredCustomRules.length === 0
    ) {
      return null
    }

    return {
      genrePositioning,
      worldview: filteredWorldview,
      factions: filteredFactions,
      customRules: filteredCustomRules
    }
  }
}

/** 读取 题材定位.md 的 body（H1 后全部内容） */
async function readGenrePositioning(settingsDir: string): Promise<string> {
  const text = await readText(join(settingsDir, '题材定位.md'))
  if (!text) return ''
  const doc = parseDoc(text)
  return doc.body.trim()
}

/** 读取指定子目录下所有 .md 文件，每个返回 { name, body } */
async function readSubDirDocs(settingsDir: string, subDir: string): Promise<SettingsDoc[]> {
  const dir = join(settingsDir, subDir)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return []
    throw err
  }
  const docs: SettingsDoc[] = []
  for (const f of files.sort()) {
    if (!f.endsWith('.md')) continue
    const text = await readText(join(dir, f))
    if (!text) continue
    const doc = parseDoc(text)
    docs.push({
      name: f.replace(/\.md$/, ''),
      body: doc.body.trim()
    })
  }
  return docs
}

/** 读取 设定/ 顶层 .md 文件（排除 题材定位.md），归入自创规则 */
async function readTopLevelRules(settingsDir: string): Promise<SettingsDoc[]> {
  let files: string[]
  try {
    files = await fs.readdir(settingsDir)
  } catch {
    return []
  }
  const docs: SettingsDoc[] = []
  for (const f of files.sort()) {
    if (!f.endsWith('.md')) continue
    if (f === '题材定位.md') continue
    const text = await readText(join(settingsDir, f))
    if (!text) continue
    const doc = parseDoc(text)
    docs.push({
      name: f.replace(/\.md$/, ''),
      body: doc.body.trim()
    })
  }
  return docs
}
