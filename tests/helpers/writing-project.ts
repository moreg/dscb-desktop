import { promises as fs } from 'fs'
import { join } from 'path'
import { writeTextAtomic } from '../../src/main/data/atomic'
import type { ProjectService } from '../../src/main/data/project-service'
import type { CreateProjectDataInput, ProjectMeta } from '../../src/shared/types'

/** Tests for an already planned novel explicitly prepare its writing files. */
export async function createWritingProject(service: ProjectService, input: CreateProjectDataInput): Promise<ProjectMeta> {
  const project = await service.create(input)
  await writeWritingSkeleton(project.path, input)
  return project
}

async function writeWritingSkeleton(dir: string, input: CreateProjectDataInput): Promise<void> {
  const now = new Date().toISOString()
  const today = now.slice(0, 10)
  const header = `**版本**：v1.0（${today} 创建）\n**修改记录**\n- v1.0（${today}）：初版\n\n`
  const genre = input.genre ?? '未指定'
  const tc = input.targetChapters ?? ''
  const cwc = input.chapterWordCount ?? ''
  const desc = input.description ?? ''
  const outlineBody =
    `# 《${input.name}》大纲\n\n` +
    `## 基本信息\n` +
    `- **题材**：${genre}\n` +
    (tc ? `- **预计章节数**：${tc} 章\n` : '') +
    (cwc ? `- **每章字数**：约 ${cwc} 字\n` : '') +
    (desc ? `- **简介**：${desc}\n` : '') +
    `\n## 主线剧情走向\n\n（待生成）\n`

  // ===== 设定 / 计划 / 写作产物 =====
  await fs.mkdir(join(dir, '设定', '世界观'), { recursive: true })
  await fs.mkdir(join(dir, '设定', '角色'), { recursive: true })
  await fs.mkdir(join(dir, '设定', '势力'), { recursive: true })
  await fs.mkdir(join(dir, '大纲'), { recursive: true })
  await fs.mkdir(join(dir, '细纲'), { recursive: true })
  await fs.mkdir(join(dir, '图解'), { recursive: true })
  await fs.mkdir(join(dir, '正文'), { recursive: true })
  await fs.mkdir(join(dir, '追踪'), { recursive: true })
  await fs.mkdir(join(dir, '对标'), { recursive: true })
  await fs.mkdir(join(dir, '资料'), { recursive: true })

  // ===== 记忆/（v4：取代 v3 的 记忆系统/ + chapters/）=====
  await fs.mkdir(join(dir, '记忆', '人物'), { recursive: true })
  await fs.mkdir(join(dir, '记忆', '地点'), { recursive: true })
  await fs.mkdir(join(dir, '记忆', '世界观'), { recursive: true })
  await fs.mkdir(join(dir, '记忆', '时间线'), { recursive: true })
  await fs.mkdir(join(dir, '记忆', '剧情点'), { recursive: true })
  await fs.mkdir(join(dir, '记忆', '关系'), { recursive: true })
  await fs.mkdir(join(dir, '记忆', '伏笔'), { recursive: true })
  await fs.mkdir(join(dir, '记忆', '道具'), { recursive: true })

  // 初始文件（含细纲生成依赖的核心设定 + 追踪表头，便于后续 append 行）
  await writeTextAtomic(join(dir, '大纲', '大纲.md'), header + outlineBody)
  await writeTextAtomic(
    join(dir, '设定', '核心设定.md'),
    header +
      `# 核心设定\n\n` +
      `## 基本信息\n` +
      `- **书名**：${input.name}\n` +
      `- **题材**：${genre}\n` +
      (tc ? `- **预计章节数**：${tc} 章\n` : '') +
      (cwc ? `- **每章字数**：约 ${cwc} 字\n` : '') +
      (desc ? `- **简介**：${desc}\n` : '') +
      `\n## 核心设定\n\n（待完善）\n`
  )
  await writeTextAtomic(join(dir, '设定', '题材定位.md'), header + `# 题材定位\n`)
  await writeTextAtomic(join(dir, '设定', '世界观', '背景设定.md'), header + `# 背景设定\n`)
  await writeTextAtomic(join(dir, '设定', '世界观', '力量体系.md'), header + `# 力量体系\n`)
  await writeTextAtomic(join(dir, '设定', '世界观', '金手指.md'), header + `# 金手指\n`)
  await writeTextAtomic(join(dir, '设定', '关系.md'), header + `# 角色关系\n`)
  await writeTextAtomic(
    join(dir, '追踪', '伏笔.md'),
    header +
      `# 伏笔追踪\n\n` +
      `| 伏笔编号 | 伏笔内容 | 伏笔类型 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 |\n` +
      `|---|---|---|---|---|---|---|\n`
  )
  await writeTextAtomic(
    join(dir, '追踪', '时间线.md'),
    header +
      `# 时间线\n\n` +
      `| 章节 | 事件名 | 时间跨度 | 涉及角色 | 详细描述 |\n` +
      `|---|---|---|---|---|\n`
  )
  await writeTextAtomic(
    join(dir, '追踪', '角色状态.md'),
    header +
      `# 角色状态快照\n\n` +
      `| 角色 | 当前实力 | 当前立场 | 当前目标 | 关键道具 | 关系快照 | 更新章节 |\n` +
      `|---|---|---|---|---|---|---|\n`
  )
  await writeTextAtomic(
    join(dir, '追踪', '上下文.md'),
    header +
      `# 上下文（日更进度摘要）\n\n` +
      `| 日期 | 章节 | 进度摘要 | 下一章目标 | 阻塞点 |\n` +
      `|---|---|---|---|---|\n`
  )
  await writeTextAtomic(
    join(dir, '追踪', '问题记录.md'),
    header +
      `# 问题记录\n\n` +
      `| 日期 | 问题描述 | 原因分析 | 修正方案 | 状态 |\n` +
      `|---|---|---|---|---|\n`
  )
  await writeTextAtomic(join(dir, '追踪', '索引.md'), TRACKING_INDEX_TEMPLATE)

  await writeTextAtomic(join(dir, '记忆', '索引.md'), MEMORY_INDEX_TEMPLATE)

}

const MEMORY_INDEX_TEMPLATE = `# 记忆索引

> 此目录由 app 自动维护，来源于 设定/、追踪/、细纲/。
> 建议在 app「记忆中心」操作；如需手改，编辑后请点 🔄 刷新。

## 人物（0）
## 地点（0）
## 世界观（0）
## 时间线（0）
## 剧情点（0）
## 关系（0）
## 伏笔（0）
## 道具（0）

## 最近更新

- （暂无）
`

const TRACKING_INDEX_TEMPLATE = `# 追踪索引

> 写作过程中的实时状态：伏笔、时间线、角色状态、上下文、问题记录。

| 文件 | 用途 | 最近更新 |
|------|------|----------|
| 伏笔.md | 伏笔埋设与回收表 | — |
| 时间线.md | 历史事件与小说事件对照 | — |
| 角色状态.md | 角色当前实力/立场/关系 | — |
| 上下文.md | 日更进度备注（阻塞/下一章目标；章级记忆见 记忆/剧情点） | — |
| 问题记录.md | 待处理问题 | — |
`
