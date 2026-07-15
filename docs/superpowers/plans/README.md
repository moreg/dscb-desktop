# 历史实现计划（plans）

本目录保存 **2026-06 起分阶段落地** 时的实现日志（TDD 步骤、当时文件路径）。

**请勿当作当前数据布局的权威说明。**

| 以这些文档为准 | 内容 |
|----------------|------|
| 仓库根 `README.md` | v4 项目目录、开发/打包 |
| `docs/md-format-spec.md` | Markdown 解析契约 |
| `docs/superpowers/specs/2026-06-17-desktop-app-design.md` | 设计 Spec（§5 已更新为 v4） |

常见过时路径对照：

| 计划中的旧路径 | 当前（v4） |
|----------------|------------|
| `chapters/NNN.md` | `正文/第NNN章 标题.md` |
| `memory/characters.json` | `记忆/人物/<名>.md` |
| `memory/relationships.json` | `记忆/关系/<A>__<B>.md` |
| `memory/foreshadowings.json` | `追踪/伏笔.md` |
| `outlines/*.json` | `大纲/大纲.md`、`细纲/第NN卷.md` |
| `记忆系统/*` | 迁移源；新建项目不再创建 |
| 开书向导 / OpeningService | 已移除 |
| 章节版本 `NNN.versions.json` | 暂未开放 |
