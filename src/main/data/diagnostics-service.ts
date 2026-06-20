import { join } from 'path'
import { ProjectService } from './project-service'
import { readText } from './skill-format/md-parser'
import { parseRhythmData } from './skill-format/rhythm-html'
import { CharacterCardMdRepo } from './skill-format/character-card-md-repo'
import { ForeshadowingMdRepo } from './skill-format/foreshadowing-md-repo'
import { OutlineMdRepo } from './skill-format/outline-md-repo'
import { LocationMdRepo } from './skill-format/location-md-repo'
import { WorldviewMdRepo } from './skill-format/worldview-md-repo'
import { ChapterProgressMdRepo } from './skill-format/chapter-progress-md-repo'

export interface Diagnostic {
  severity: 'warn' | 'info'
  /** 文件相对路径，如「记忆系统/角色卡.md」 */
  file: string
  /** 人可读的问题描述 */
  message: string
  /** 修复建议 */
  hint?: string
}

/**
 * 格式体检：对项目内各 v3.2 文件做解析健康检查。
 * 只在「文件存在且有内容，但解析结果为空/异常」时报 warn——
 * 这通常意味着格式偏离规范（静默丢数据）。文件不存在（新建项目）不报。
 */
export class DiagnosticsService {
  constructor(private readonly projectService: ProjectService) {}

  async report(projectId: string): Promise<Diagnostic[]> {
    const dir = await this.projectService.resolveDir(projectId)
    const out: Diagnostic[] = []
    out.push(...(await this.checkCharacterCard(dir)))
    out.push(...(await this.checkForeshadowing(dir)))
    out.push(...(await this.checkOutline(dir)))
    out.push(...(await this.checkRhythm(dir)))
    out.push(...(await this.checkLocations(dir)))
    out.push(...(await this.checkWorldview(dir)))
    out.push(...(await this.checkChapterProgress(dir)))
    return out
  }

  /** 角色卡：有 `- **字段**` 但 0 角色 → 角色块/分类节格式问题 */
  private async checkCharacterCard(dir: string): Promise<Diagnostic[]> {
    const text = await readText(join(dir, '记忆系统', '角色卡.md'))
    if (!text || !text.includes('- **')) return []
    const count = (await new CharacterCardMdRepo(dir).list()).length
    if (count > 0) return []
    return [
      {
        severity: 'warn',
        file: '记忆系统/角色卡.md',
        message: '文件含字段但解析到 0 个角色',
        hint: '角色块须为 `### 人名（类型）`，置于 `## 主角` / `## 核心配角` / `## 核心反派` 之下'
      }
    ]
  }

  /** 伏笔：表存在（≥3 行）但 0 条 → 表头关键词不匹配（最常见） */
  private async checkForeshadowing(dir: string): Promise<Diagnostic[]> {
    const text = await readText(join(dir, '记忆系统', '伏笔追踪.md'))
    if (!text) return []
    const tableRows = text
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith('|') && !l.includes('---')).length
    if (tableRows < 3) return []
    const count = (await new ForeshadowingMdRepo(dir).list()).length
    if (count > 0) return []
    return [
      {
        severity: 'warn',
        file: '记忆系统/伏笔追踪.md',
        message: '伏笔表存在但解析到 0 条（疑似表头不匹配）',
        hint: '表头须含：编号 / 内容 / 类型 / 埋设 / 预计回收 / 实际回收 / 状态'
      }
    ]
  }

  /** 大纲：有卷标题 H3 但 0 卷 → 卷标题格式偏离 */
  private async checkOutline(dir: string): Promise<Diagnostic[]> {
    const text = await readText(join(dir, '大纲', '大纲.md'))
    if (!text) return []
    if (!/### 第\s*[一二三四五六七八九十\d]+\s*[卷部]/.test(text)) return []
    const read = await new OutlineMdRepo(dir).read()
    if (read && read.volumes.length > 0) return []
    return [
      {
        severity: 'warn',
        file: '大纲/大纲.md',
        message: '检测到卷标题但解析到 0 卷',
        hint: '卷标题须为 `### 第N卷：卷名（第X-Y章）`（中/阿数字均可，须有中文冒号和章节范围）'
      }
    ]
  }

  /** 节奏图谱：有 rhythmData 块但 0 条 → entry JS 字面量格式偏离 */
  private async checkRhythm(dir: string): Promise<Diagnostic[]> {
    const html = await readText(join(dir, '图解', '节奏图谱.html'))
    if (!html || !html.includes('rhythmData')) return []
    const entries = parseRhythmData(html)
    if (entries && entries.length > 0) return []
    return [
      {
        severity: 'warn',
        file: '图解/节奏图谱.html',
        message: 'rhythmData 块存在但解析到 0 条',
        hint: "每条须为 { chapter: N, title: '...', emotion: N, climax: N, volume: N, actualized: bool }（单引号、小写 true/false）"
      }
    ]
  }

  /** 地点：有 H2 节但 0 个 → 节标题格式问题 */
  private async checkLocations(dir: string): Promise<Diagnostic[]> {
    const text = await readText(join(dir, '记忆系统', '地点档案.md'))
    if (!text || !/^##\s/m.test(text)) return []
    const count = (await new LocationMdRepo(dir).list()).length
    if (count > 0) return []
    return [
      {
        severity: 'warn',
        file: '记忆系统/地点档案.md',
        message: '有地点节但解析到 0 个',
        hint: '每个地点须为独立的 `## N. 地名` 节'
      }
    ]
  }

  /** 世界观：有 H2 节但 0 个 */
  private async checkWorldview(dir: string): Promise<Diagnostic[]> {
    const text = await readText(join(dir, '记忆系统', '世界观设定.md'))
    if (!text || !/^##\s/m.test(text)) return []
    const count = (await new WorldviewMdRepo(dir).list()).length
    if (count > 0) return []
    return [
      {
        severity: 'warn',
        file: '记忆系统/世界观设定.md',
        message: '有世界观节但解析到 0 个',
        hint: '每个条目须为独立的 `## 节标题`'
      }
    ]
  }

  /** 章节进度：有表行但 0 条 → 表头不匹配 */
  private async checkChapterProgress(dir: string): Promise<Diagnostic[]> {
    const text = await readText(join(dir, '记忆系统', '章节进度.md'))
    if (!text) return []
    const tableRows = text
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith('|') && !l.includes('---')).length
    if (tableRows < 3) return []
    const count = (await new ChapterProgressMdRepo(dir).read()).size
    if (count > 0) return []
    return [
      {
        severity: 'warn',
        file: '记忆系统/章节进度.md',
        message: '章节进度表存在但解析到 0 条',
        hint: '表头须含：章节 / 标题 / 状态 / 字数 / 备注'
      }
    ]
  }
}
