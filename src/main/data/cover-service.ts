import { promises as fs } from 'fs'
import { join, resolve, sep } from 'path'
import { createHash, randomUUID } from 'crypto'
import { writeJsonAtomic } from './atomic'
import { ImageService } from './image-service'
import { ProjectService } from './project-service'
import type { CoverLearningLibraryService } from './cover-learning-library'
import {
  inferGenre,
  buildCoverPrompt,
  compileCoverLearningRules,
  patchCoverPromptTypography,
  filterCoverPromptLearningRules,
  PLATFORM_STYLES
} from './skill-prompts/cover/cover-styles'
import type {
  CoverFile,
  CoverGenre,
  CoverFeedback,
  CoverGenerationMetadata,
  CoverLearningContext,
  CoverGenerationTaskState,
  UpdateCoverCropInput,
  UpdateCoverFeedbackInput,
  GenerateCoverInput
} from '../../shared/types'
import { withVisualDirection } from './cover-visual-direction'
import { withCoverChannel } from './cover-channel'
import { COVER_GENERATION_SIZE, withCoverFrameSafety } from './cover-frame'
import { decodeCoverImage, coverOutputSize, renderCoverImage, validateCoverCrop, DEFAULT_COVER_CROP } from './cover-image-output'
export { withVisualDirection } from './cover-visual-direction'
export { COVER_GENERATION_SIZE } from './cover-frame'

const COVER_DIR = '封面'
/** 由 1024×1536 居中裁切得到，不放大、不拉伸；1023:1364 精确等于 3:4。 */
export const DEFAULT_COVER_OUTPUT_SIZE = '1023x1364'
export const MAX_COVER_PROMPT_CHARACTERS = 8000

/**
 * 封面生成服务（编排 Step 1-4）。
 *
 * Step 1-1.5：题材判定（书名关键词推断）
 * Step 2：构建中文提示词（文字层 + 风格层 + 画面层，兼容旧英文手改内容）
 * Step 3：调 ImageService 出图 + 无拉伸裁成默认 3:4 + 落盘（自增版本号）+ 保存 prompt 副本
 * Step 3.5：平台上传尺寸居中裁剪（番茄 600×800）
 *
 * 产物结构（项目目录下）：
 *   封面/
 *   ├── 封面_v1.png          # 3:4 成品
 *   ├── 封面_v1_原始.png     # 完整原始画面
 *   ├── 封面_v1.prompt.txt   # 提示词副本（迭代微调用）
 *   ├── 封面_v1_上传.png     # 平台上传尺寸版（仅设了 uploadSize 时）
 *   └── 封面_v2.png ...
 */
export class CoverService {
  private feedbackTail: Promise<void> = Promise.resolve()
  private cropTail: Promise<void> = Promise.resolve()
  private readonly generationTasks = new Map<string, { state: CoverGenerationTaskState; controller: AbortController }>()
  private readonly imageValidationCache = new Map<string, string>()
  constructor(
    private readonly projectService: ProjectService,
    private readonly image: ImageService,
    private readonly learningLibrary?: CoverLearningLibraryService
  ) {}

  /**
   * 解析本次出图实际使用的提示词。
   *
   * 用户手改过（promptOverride）就保留编辑内容。空白时按平台/题材模板拼装。
   * 出图时另行应用 visualDirection；明确选定的 channel 仍约束人物性别与人物存在。
   */
  resolvePrompt(input: GenerateCoverInput): string {
    const override = input.promptOverride?.trim()
    if (override) return override

    const genre: CoverGenre = input.genreOverride ?? inferGenre(input.bookName)
    return buildCoverPrompt({
      bookName: input.bookName,
      authorName: input.authorName,
      platform: input.platform,
      channel: input.channel,
      genre,
      composition: input.composition ?? 'closeup',
      stylePreset: input.stylePreset,
      typography: input.typography,
      styleHint: input.styleHint,
      scene: input.scene,
      directionWins: Boolean(input.visualDirection?.trim()),
      visualDirection: input.visualDirection
    })
  }

  /** 构建/刷新提示词时读库；已有编辑框快照保持原样。 */
  async resolvePromptWithLibrary(input: GenerateCoverInput): Promise<string> {
    const override = input.promptOverride?.trim()
    if (override) return override
    return (await this.buildWithContext(input)).prompt
  }

  async getPromptContext(input: GenerateCoverInput): Promise<CoverLearningContext> {
    return (await this.buildWithContext({
      ...input, promptOverride: undefined,
      learningContext: input.typographyBasePrompt ? input.learningContext : undefined
    })).context
  }

  private async buildWithContext(input: GenerateCoverInput): Promise<{ prompt: string; context: CoverLearningContext }> {
    const genre = input.genreOverride ?? inferGenre(input.bookName)
    if (input.typographyBasePrompt && input.learningContext) {
      const context = {
        ...input.learningContext,
        rules: filterCoverPromptLearningRules(input.typographyBasePrompt, input.learningContext.rules, input.typography)
      }
      const replacement = buildCoverPrompt({
        bookName: input.bookName, authorName: input.authorName, platform: input.platform, genre,
        channel: input.channel,
        composition: input.composition ?? 'closeup', stylePreset: context.resolvedStylePreset,
        typography: input.typography, scene: input.scene, styleHint: input.styleHint,
        learningRules: context.rules, visualDirection: input.visualDirection
      })
      return { prompt: patchCoverPromptTypography(input.typographyBasePrompt, replacement, input.typography, input.learningContext.rules), context }
    }
    const loaded = this.learningLibrary ? await this.learningLibrary.load() : undefined
    const learned = loaded && this.learningLibrary
      ? this.learningLibrary.resolveStyle(loaded.library, input.stylePreset, genre)
      : undefined
    const rules = loaded && this.learningLibrary
      ? compileCoverLearningRules(this.learningLibrary.getRulesForGenre(loaded.library, genre), input.typography)
      : []
    const context: CoverLearningContext = {
      libraryVersion: loaded
        ? `${loaded.library.updatedAt}@${createHash('sha256').update(JSON.stringify([learned?.definition, rules])).digest('hex').slice(0, 12)}`
        : 'builtin',
      rules,
      sourceSampleCount: loaded?.library.source.sampleCount ?? 0,
      resolvedStylePreset: learned?.key ?? input.stylePreset ?? 'auto',
      sources: [...new Set((loaded?.summary?.rules ?? [])
        .filter((rule) => rules.includes(rule.text))
        .map((rule) => `${rule.source}${rule.genre ? `:${rule.genre}` : ''}${rule.evidence?.length ? ` · ${rule.evidence.slice(0, 2).join(', ')}` : ''}`))].slice(0, 30)
    }
    if (input.learningContext && !input.typographyBasePrompt && input.learningContext.libraryVersion !== context.libraryVersion) {
      throw new Error('COVER_LIBRARY_CHANGED: 学习规则刚刚更新，请重新构建提示词')
    }
    const replacement = buildCoverPrompt({
      bookName: input.bookName,
      authorName: input.authorName,
      platform: input.platform,
      channel: input.channel,
      genre,
      composition: input.composition ?? 'closeup',
      stylePreset: learned?.key ?? input.stylePreset,
      typography: input.typography,
      styleHint: input.styleHint,
      learningPreset: learned?.definition,
      learningRules: rules,
      scene: input.scene,
      directionWins: Boolean(input.visualDirection?.trim()),
      visualDirection: input.visualDirection
    })
    return {
      prompt: input.typographyBasePrompt
        ? patchCoverPromptTypography(input.typographyBasePrompt, replacement, input.typography)
        : replacement,
      context
    }
  }

  getGenerationTask(projectId: string): CoverGenerationTaskState | null {
    const state = this.generationTasks.get(projectId)?.state
    return state ? structuredClone(state) : null
  }

  cancelGeneration(projectId: string): { ok: boolean } {
    const task = this.generationTasks.get(projectId)
    if (!task || !['preparing', 'generating'].includes(task.state.phase) || task.controller.signal.aborted) return { ok: false }
    task.controller.abort()
    return { ok: true }
  }

  async generate(input: GenerateCoverInput): Promise<CoverFile> {
    const previous = this.generationTasks.get(input.projectId)
    if (previous && ['preparing', 'generating', 'saving'].includes(previous.state.phase)) {
      throw new Error('COVER_GENERATION_IN_PROGRESS: 本项目已有封面正在生成，请等待完成或取消当前任务')
    }
    const now = new Date().toISOString()
    const task = {
      controller: new AbortController(),
      state: { id: randomUUID(), projectId: input.projectId, phase: 'preparing', startedAt: now, updatedAt: now } as CoverGenerationTaskState
    }
    this.generationTasks.set(input.projectId, task)
    try {
      const cover = await this.generateNow(input, task.controller.signal, (phase) => {
        task.state = { ...task.state, phase, updatedAt: new Date().toISOString() }
      })
      task.state = { ...task.state, phase: 'completed', cover, updatedAt: new Date().toISOString() }
      return cover
    } catch (error) {
      const cancelled = task.controller.signal.aborted
      task.state = { ...task.state, phase: cancelled ? 'cancelled' : 'failed', error: cancelled ? '封面生成已取消' : String(error instanceof Error ? error.message : error), updatedAt: new Date().toISOString() }
      if (cancelled) throw new Error('COVER_GENERATION_CANCELLED: 封面生成已取消', { cause: error })
      throw error
    }
  }

  private async generateNow(
    input: GenerateCoverInput, signal: AbortSignal, setPhase: (phase: CoverGenerationTaskState['phase']) => void
  ): Promise<CoverFile> {
    const dir = await this.resolveCoverDir(input.projectId)
    signal.throwIfAborted()
    // Step 1.5：题材判定
    const genre: CoverGenre = input.genreOverride ?? inferGenre(input.bookName)
    const platform = PLATFORM_STYLES[input.platform]

    // Step 2：保留编辑框内容，应用明确的画面方向后，再锁定所选频道的人物性别与人物存在。
    const resolved = input.promptOverride?.trim()
      ? { prompt: input.promptOverride.trim(), context: input.learningContext }
      : await this.buildWithContext(input)
    const prompt = withCoverFrameSafety(withCoverChannel(
      withVisualDirection(resolved.prompt, input.visualDirection, input.channel), input.channel
    ))
    if (prompt.length > MAX_COVER_PROMPT_CHARACTERS) {
      throw new Error(`COVER_PROMPT_TOO_LONG: 实际出图提示词共 ${prompt.length} 字符，超过 ${MAX_COVER_PROMPT_CHARACTERS} 字符预算。请精简提示词或停用部分学习规则后重建；当前内容已完整保留。`)
    }
    const generationMetadata: CoverGenerationMetadata = {
      promptSource: input.promptSource ?? (input.promptOverride?.trim() ? 'edited' : 'template'),
      generatedAt: new Date().toISOString(),
      genre,
      platform: input.platform,
      channel: input.channel,
      stylePreset: resolved.context?.resolvedStylePreset ?? input.stylePreset,
      learningContext: resolved.context ? {
        ...resolved.context,
        // 手改可以删除规则；只记录实际仍在最终提示词里的建议。
        rules: resolved.context.rules.filter((rule) => prompt.includes(rule))
      } : undefined
    }

    // Step 3：出图（参考图路径需校验在项目目录内 + 图片扩展名，防任意文件读取外传）
    const safeRefPath = input.refImagePath
      ? await this.validateRefImagePath(input.projectId, input.refImagePath)
      : undefined
    signal.throwIfAborted()
    setPhase('generating')
    const b64 = safeRefPath
      ? await this.image.edit(prompt, COVER_GENERATION_SIZE, safeRefPath, signal)
      : await this.image.generate(prompt, COVER_GENERATION_SIZE, signal)
    signal.throwIfAborted()
    setPhase('saving')
    const original = await decodeCoverImage(b64)
    const outputSize = coverOutputSize(original.width, original.height)
    const master = await renderCoverImage(original.png, outputSize)
    const upload = platform.uploadSize ? await renderCoverImage(original.png, platform.uploadSize) : undefined
    const warnings: string[] = []
    if (original.width < 600 || original.height < 800) warnings.push(`原图仅 ${original.width}×${original.height} 像素，清晰度不足；主成品保留实际分辨率。`)
    const visibleShare = Math.min((original.width / original.height) / 0.75, 0.75 / (original.width / original.height))
    if (visibleShare < 0.85) warnings.push('原图比例与 3:4 差异较大，请预览裁剪，或选择保留全图。')

    // 正式文件只在完整解码、处理成功后提交；占位锁与成品分开。
    const { version, fullPath, lockPath } = await this.acquireUniqueCoverPath(dir)
    const fileName = fullPath.split(sep).pop() ?? '封面.png'
    const originalFileName = `封面_v${version}_原始.png`
    const [outputWidth, outputHeight] = outputSize.split('x').map(Number)
    Object.assign(generationMetadata, {
      storageVersion: 2, originalFileName, sourceWidth: original.width, sourceHeight: original.height,
      outputWidth, outputHeight, crop: { ...DEFAULT_COVER_CROP }, warnings
    })
    const staged = new Map<string, Buffer | string>([
      [`封面_v${version}.metadata.json`, JSON.stringify(generationMetadata, null, 2)],
      [`封面_v${version}.prompt.txt`, prompt],
      [originalFileName, original.png]
    ])
    if (safeRefPath) staged.set(`封面_v${version}.ref.txt`, safeRefPath)
    if (upload) staged.set(`封面_v${version}_上传.png`, upload)
    staged.set(fileName, master)
    try {
      await this.commitNewCover(dir, version, staged)
    } finally {
      await fs.unlink(lockPath).catch(() => undefined)
    }
    const stat = await fs.stat(fullPath)
    return {
      fileName,
      relPath: `${COVER_DIR}/${fileName}`,
      version,
      isUploadSize: false,
      size: stat.size,
      genre,
      generationMetadata,
      originalFileName,
      warnings,
      createdAt: stat.mtime.toISOString()
    }
  }

  /**
   * 原子地获取唯一封面文件路径（防并发覆盖）。
   * 用独占锁预留版本，失败不会留下被列表当作成品的 PNG。
   */
  private async acquireUniqueCoverPath(dir: string): Promise<{ version: number; fullPath: string; lockPath: string }> {
    const baseVersion = await this.nextVersion(dir)
    for (let v = baseVersion; v < baseVersion + 100; v++) {
      const fullPath = join(dir, `封面_v${v}.png`)
      const lockPath = join(dir, `封面_v${v}.lock`)
      try {
        // 'wx' = 独占创建：文件已存在则抛 EEXIST，保证原子性
        const fh = await fs.open(lockPath, 'wx')
        await fh.close()
        try {
          await fs.access(fullPath)
          await fs.unlink(lockPath)
          continue
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            await fs.unlink(lockPath).catch(() => undefined)
            throw error
          }
        }
        return { version: v, fullPath, lockPath }
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code !== 'EEXIST') throw err
        // 文件已存在（并发或残留），尝试下一版本号
      }
    }
    throw new Error('封面版本号自增失败（超过 100 次重试）')
  }

  private async commitNewCover(dir: string, version: number, files: Map<string, Buffer | string>): Promise<void> {
    const stage = await fs.mkdtemp(join(dir, '.cover-staging-'))
    const moved: string[] = []
    const marker = join(dir, `封面_v${version}.complete.json`)
    try {
      for (const [name, bytes] of files) await fs.writeFile(join(stage, name), bytes)
      await fs.writeFile(join(stage, 'commit.json'), JSON.stringify({ files: [...files.keys()] }), 'utf8')
      for (const name of files.keys()) {
        await fs.rename(join(stage, name), join(dir, name))
        moved.push(name)
      }
      // 提交标记最后出现；新格式版本在此之前不进入历史列表。
      await fs.rename(join(stage, 'commit.json'), marker)
    } catch (error) {
      await Promise.all(moved.map((name) => fs.unlink(join(dir, name)).catch(() => undefined)))
      await fs.unlink(marker).catch(() => undefined)
      throw error
    } finally {
      await fs.rm(stage, { recursive: true, force: true })
    }
  }

  /** 列出项目内全部封面（含 _上传 版） */
  async list(projectId: string): Promise<CoverFile[]> {
    const dir = await this.resolveCoverDir(projectId)
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return []
    }
    const out: CoverFile[] = []
    for (const name of entries) {
      if (!name.endsWith('.png')) continue
      const match = name.match(/^封面_v(\d+)(_上传)?\.png$/)
      if (!match) continue
      try {
        const stat = await fs.stat(join(dir, name))
        const version = parseInt(match[1], 10)
        const generationMetadata = await this.readSidecar<CoverGenerationMetadata>(dir, version, 'metadata')
        if (!await this.isCommittedCover(dir, version, generationMetadata)) continue
        if (!await this.isReadableImage(join(dir, name), `${stat.size}:${stat.mtimeMs}`)) continue
        const feedback = await this.readSidecar<CoverFeedback>(dir, version, 'feedback')
        // 从同名 prompt.txt 推断题材（无则默认 urban）
        const genre = await this.readGenreFromPrompt(dir, name)
        out.push({
          fileName: name,
          relPath: `${COVER_DIR}/${name}`,
          version,
          isUploadSize: !!match[2],
          size: stat.size,
          genre: generationMetadata?.genre ?? genre,
          generationMetadata,
          originalFileName: generationMetadata?.originalFileName,
          warnings: generationMetadata?.warnings,
          feedback,
          createdAt: stat.birthtime.toISOString()
        })
      } catch (err) {
        console.warn(`[cover-service] list 跳过异常封面文件 ${name}:`, err)
      }
    }
    return out.sort((a, b) => b.version - a.version || (a.isUploadSize ? 1 : -1))
  }

  /** 读取封面为 base64 data URL（前端预览）。防路径穿越 */
  async readAsDataURL(projectId: string, fileName: string): Promise<string | null> {
    const dir = await this.resolveCoverDir(projectId)
    const full = resolve(dir, fileName)
    // 防路径穿越：解析后必须以封面目录为前缀（含分隔符）
    if (full !== dir && !full.startsWith(dir + sep)) return null
    try {
      const buf = await fs.readFile(full)
      return `data:image/png;base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  }

  /** 解析并校验封面文件绝对路径，供系统资源管理器定位文件。 */
  async resolveCoverFile(projectId: string, fileName: string): Promise<string> {
    const dir = await this.resolveCoverDir(projectId)
    const full = resolve(dir, fileName)
    if (full === dir || !full.startsWith(dir + sep)) {
      throw new Error('非法封面文件路径')
    }
    if (!/^封面_v\d+(?:_上传|_原始)?\.png$/.test(fileName)) {
      throw new Error('非法封面文件名')
    }
    await fs.access(full)
    return full
  }

  private async isCommittedCover(dir: string, version: number, metadata?: CoverGenerationMetadata): Promise<boolean> {
    try {
      await fs.access(join(dir, `封面_v${version}.updating`))
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
    }
    if (metadata?.storageVersion !== 2) return true
    const marker = await this.readSidecar<{ files?: unknown }>(dir, version, 'complete')
    if (!Array.isArray(marker?.files) || !marker.files.includes(`封面_v${version}.png`) || marker.files.length > 12) return false
    for (const name of marker.files) {
      if (typeof name !== 'string' || !name.startsWith(`封面_v${version}`) || /[/\\]|\.\./.test(name)) return false
      try { await fs.access(join(dir, name)) } catch { return false }
    }
    return true
  }

  private async isReadableImage(path: string, fingerprint: string): Promise<boolean> {
    if (this.imageValidationCache.get(path) === fingerprint) return true
    try {
      const { loadImage } = await import('skia-canvas')
      const image = await loadImage(path)
      if (!image.width || !image.height) return false
      if (this.imageValidationCache.size >= 200) this.imageValidationCache.clear()
      this.imageValidationCache.set(path, fingerprint)
      return true
    } catch {
      return false
    }
  }

  async updateCrop(input: UpdateCoverCropInput): Promise<CoverFile> {
    const task = this.cropTail.then(() => this.updateCropNow(input))
    this.cropTail = task.then(() => undefined, () => undefined)
    return task
  }

  private async updateCropNow(input: UpdateCoverCropInput): Promise<CoverFile> {
    if (['preparing', 'generating', 'saving'].includes(this.getGenerationTask(input.projectId)?.phase ?? '')) {
      throw new Error('COVER_GENERATION_IN_PROGRESS: 请等待当前封面生成完成后再调整裁剪')
    }
    if (!/^封面_v\d+(?:_上传)?\.png$/.test(input.fileName)) throw new Error('非法封面文件名')
    await this.resolveCoverFile(input.projectId, input.fileName)
    const version = Number(input.fileName.match(/^封面_v(\d+)/)?.[1])
    const dir = await this.resolveCoverDir(input.projectId)
    const metadata = await this.readSidecar<CoverGenerationMetadata>(dir, version, 'metadata')
    if (!metadata?.originalFileName || metadata.originalFileName !== `封面_v${version}_原始.png`) {
      throw new Error('COVER_NO_ORIGINAL: 这个旧版本没有保留原始图片，无法重新裁剪')
    }
    if (!await this.isCommittedCover(dir, version, metadata)) throw new Error('COVER_NOT_COMMITTED: 封面版本尚未完整保存')
    const sourcePath = await this.resolveCoverFile(input.projectId, metadata.originalFileName)
    const original = await decodeCoverImage((await fs.readFile(sourcePath)).toString('base64'))
    const crop = validateCoverCrop({
      offsetX: input.offsetX ?? 0.5, offsetY: input.offsetY ?? 0.5, fit: input.fit ?? 'cover'
    })
    const targetSize = coverOutputSize(original.width, original.height)
    const files = new Map<string, Buffer | string>([[`封面_v${version}.png`, await renderCoverImage(original.png, targetSize, crop)]])
    const platform = metadata.platform ? PLATFORM_STYLES[metadata.platform] : undefined
    if (platform?.uploadSize) files.set(`封面_v${version}_上传.png`, await renderCoverImage(original.png, platform.uploadSize, crop))
    const changed = { ...metadata, crop, cropUpdatedAt: new Date().toISOString() }
    files.set(`封面_v${version}.metadata.json`, JSON.stringify(changed, null, 2))
    await this.replaceCoverFiles(dir, version, files)
    const cover = (await this.list(input.projectId)).find((item) => item.fileName === input.fileName)
    if (!cover) throw new Error('封面文件不存在')
    return cover
  }

  private async replaceCoverFiles(dir: string, version: number, files: Map<string, Buffer | string>): Promise<void> {
    const stage = await fs.mkdtemp(join(dir, '.cover-crop-'))
    const lock = join(dir, `封面_v${version}.updating`)
    const replaced: string[] = []
    let locked = false
    try {
      const handle = await fs.open(lock, 'wx')
      await handle.close()
      locked = true
      for (const [name, data] of files) {
        await fs.copyFile(join(dir, name), join(stage, `${name}.backup`))
        await fs.writeFile(join(stage, name), data)
      }
      for (const name of files.keys()) {
        await fs.rename(join(stage, name), join(dir, name))
        replaced.push(name)
      }
    } catch (error) {
      for (const name of replaced.reverse()) await fs.copyFile(join(stage, `${name}.backup`), join(dir, name))
      throw error
    } finally {
      if (locked) await fs.unlink(lock).catch(() => undefined)
      await fs.rm(stage, { recursive: true, force: true })
    }
  }

  /** 同一版本的原图与上传图共用反馈，保留原因和实际学习规则来源。 */
  async updateFeedback(input: UpdateCoverFeedbackInput): Promise<CoverFile> {
    const task = this.feedbackTail.then(() => this.updateFeedbackNow(input))
    this.feedbackTail = task.then(() => undefined, () => undefined)
    return task
  }

  private async updateFeedbackNow(input: UpdateCoverFeedbackInput): Promise<CoverFile> {
    await this.resolveCoverFile(input.projectId, input.fileName)
    if (!['adopted', 'rejected', 'unrated'].includes(input.status)) throw new Error('非法封面反馈状态')
    const version = Number(input.fileName.match(/^封面_v(\d+)/)?.[1])
    const dir = await this.resolveCoverDir(input.projectId)
    const feedback: CoverFeedback = {
      status: input.status,
      reason: input.reason?.trim().slice(0, 1000) ?? '',
      updatedAt: new Date().toISOString()
    }
    const metadata = await this.readSidecar<CoverGenerationMetadata>(dir, version, 'metadata')
    const genre = metadata?.genre ?? await this.readGenreFromPrompt(dir, `封面_v${version}.png`)
    await this.learningLibrary?.recordFeedback({
      id: `${input.projectId}/封面_v${version}`,
      genre,
      status: feedback.status,
      reason: feedback.reason,
      libraryVersion: metadata?.learningContext?.libraryVersion ?? 'unknown',
      rules: metadata?.learningContext?.rules ?? []
    })
    await writeJsonAtomic(join(dir, `封面_v${version}.feedback.json`), feedback)
    const cover = (await this.list(input.projectId)).find((item) => item.fileName === input.fileName)
    if (!cover) throw new Error('封面文件不存在')
    return cover
  }

  private async readSidecar<T>(dir: string, version: number, suffix: string): Promise<T | undefined> {
    try {
      return JSON.parse(await fs.readFile(join(dir, `封面_v${version}.${suffix}.json`), 'utf-8')) as T
    } catch {
      return undefined
    }
  }

  /* =========================================================
     私有辅助
     ========================================================= */

  private async resolveCoverDir(projectId: string): Promise<string> {
    const projectDir = await this.projectService.resolveDir(projectId)
    const dir = join(projectDir, COVER_DIR)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  /**
   * 校验参考图路径安全：必须在项目目录内 + 图片扩展名。
   * 防止 refImagePath 读取项目外的敏感文件（如 .ssh/id_rsa）并上传到外部 API。
   * @returns 校验通过的绝对路径；不通过抛错
   */
  private async validateRefImagePath(projectId: string, refImagePath: string): Promise<string> {
    const projectDir = await this.projectService.resolveDir(projectId)
    const full = resolve(projectDir, refImagePath)
    // 必须在项目目录内（防路径穿越读敏感文件）
    if (full !== projectDir && !full.startsWith(projectDir + sep)) {
      throw new Error('参考图必须在项目目录内')
    }
    // 必须位于受信任的图片子目录（封面/ 或 素材/），收紧 exfiltration 面
    const rel = full.slice(projectDir.length).replace(/^[\\/]/, '')
    const allowedDirs = ['封面', '素材']
    const topDir = rel.split(/[/\\]/)[0]
    if (!allowedDirs.includes(topDir)) {
      throw new Error('参考图必须位于「封面/」或「素材/」目录内')
    }
    // 必须是图片扩展名
    if (!/\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(full)) {
      throw new Error('参考图必须是图片格式（png/jpg/jpeg/webp/gif/bmp）')
    }
    // 文件必须存在
    try {
      await fs.access(full)
    } catch {
      throw new Error('参考图文件不存在')
    }
    return full
  }

  /** 源图、上传图或旁注仍存在时也保留该版本号，避免覆盖旧版本残留。 */
  private async nextVersion(dir: string): Promise<number> {
    try {
      const entries = await fs.readdir(dir)
      let max = 0
      for (const name of entries) {
        const m = name.match(/^封面_v(\d+)(?:[._]|$)/)
        if (m) {
          const v = parseInt(m[1], 10)
          if (v > max) max = v
        }
      }
      return max + 1
    } catch {
      return 1
    }
  }

  /** 从 prompt.txt 第一行推断题材（简化：扫 tag 关键词） */
  private async readGenreFromPrompt(dir: string, pngName: string): Promise<CoverGenre> {
    try {
      const promptName = pngName.replace(/\.png$/, '.prompt.txt')
      const content = await fs.readFile(join(dir, promptName), 'utf-8')
      if (/xianxia/i.test(content)) return 'xianxia'
      if (/ancient Chinese romance/i.test(content)) return 'ancient_romance'
      if (/modern romance/i.test(content)) return 'modern_romance'
      if (/mystery|noir/i.test(content)) return 'mystery'
      if (/sci-fi|cyberpunk/i.test(content)) return 'scifi'
      if (/western.*fantasy|medieval/i.test(content)) return 'western_fantasy'
      if (/historical.*war|battlefield/i.test(content)) return 'historical'
      if (/supernatural|horror|ghostly/i.test(content)) return 'supernatural'
      if (/anime|light novel|moe/i.test(content)) return 'light_novel'
      return 'urban'
    } catch {
      return 'urban'
    }
  }

}
