import { promises as fs } from 'fs'
import { join, resolve, sep } from 'path'
import { ImageService } from './image-service'
import { ProjectService } from './project-service'
import {
  inferGenre,
  buildCoverPrompt,
  PLATFORM_STYLES
} from './skill-prompts/cover/cover-styles'
import type {
  CoverFile,
  CoverGenre,
  CoverPlatform,
  GenerateCoverInput
} from '../../shared/types'

const COVER_DIR = '封面'

/**
 * 封面生成服务（编排 Step 1-4）。
 *
 * Step 1-1.5：题材判定（书名关键词推断）
 * Step 2：构建英文提示词（文字层 + 风格层 + 画面层）
 * Step 3：调 ImageService 出图 + 落盘（自增版本号）+ 保存 prompt 副本
 * Step 3.5：平台上传尺寸居中裁剪（番茄 600×800）
 *
 * 产物结构（项目目录下）：
 *   封面/
 *   ├── 封面_v1.png          # 原图
 *   ├── 封面_v1.prompt.txt   # 提示词副本（迭代微调用）
 *   ├── 封面_v1_上传.png     # 平台上传尺寸版（仅设了 uploadSize 时）
 *   └── 封面_v2.png ...
 */
export class CoverService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly image: ImageService
  ) {}

  async generate(input: GenerateCoverInput): Promise<CoverFile> {
    // Step 1.5：题材判定
    const genre: CoverGenre = input.genreOverride ?? inferGenre(input.bookName)
    const platform = PLATFORM_STYLES[input.platform]

    // Step 2：构建提示词
    const composition = input.composition ?? 'closeup'
    const prompt = buildCoverPrompt({
      bookName: input.bookName,
      authorName: input.authorName,
      platform: input.platform,
      genre,
      composition,
      styleHint: input.styleHint
    })

    // Step 3：出图（参考图路径需校验在项目目录内 + 图片扩展名，防任意文件读取外传）
    const size = this.sizeForPlatform(input.platform)
    const safeRefPath = input.refImagePath
      ? await this.validateRefImagePath(input.projectId, input.refImagePath)
      : undefined
    const b64 = safeRefPath
      ? await this.image.edit(prompt, size, safeRefPath)
      : await this.image.generate(prompt, size)

    // 落盘（原子自增版本号：用独占创建确保并发不覆盖）
    const dir = await this.resolveCoverDir(input.projectId)
    const { version, fullPath } = await this.acquireUniqueCoverPath(dir)
    const fileName = fullPath.split(sep).pop() ?? '封面.png'
    const pngBuffer = Buffer.from(b64, 'base64')
    await fs.writeFile(fullPath, pngBuffer)

    // 保存提示词副本（迭代微调用）
    await fs.writeFile(join(dir, `封面_v${version}.prompt.txt`), prompt, 'utf-8')

    // 图生图：保存参考图路径
    if (safeRefPath) {
      await fs.writeFile(join(dir, `封面_v${version}.ref.txt`), safeRefPath, 'utf-8')
    }

    // Step 3.5：平台上传尺寸居中裁剪
    if (platform.uploadSize) {
      const uploadName = `封面_v${version}_上传.png`
      await this.cropToUploadSize(fullPath, join(dir, uploadName), platform.uploadSize)
    }

    const stat = await fs.stat(fullPath)
    return {
      fileName,
      relPath: `${COVER_DIR}/${fileName}`,
      version,
      isUploadSize: false,
      size: stat.size,
      genre,
      createdAt: stat.mtime.toISOString()
    }
  }

  /**
   * 原子地获取唯一封面文件路径（防并发覆盖）。
   * 用 fs.open('wx') 独占创建占位文件，已存在则版本号+1 重试（上限 100）。
   * @returns 版本号 + 绝对路径（占位文件已创建，调用方写入内容即可）
   */
  private async acquireUniqueCoverPath(dir: string): Promise<{ version: number; fullPath: string }> {
    const baseVersion = await this.nextVersion(dir)
    for (let v = baseVersion; v < baseVersion + 100; v++) {
      const fullPath = join(dir, `封面_v${v}.png`)
      try {
        // 'wx' = 独占创建：文件已存在则抛 EEXIST，保证原子性
        const fh = await fs.open(fullPath, 'wx')
        await fh.close()
        return { version: v, fullPath }
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code !== 'EEXIST') throw err
        // 文件已存在（并发或残留），尝试下一版本号
      }
    }
    throw new Error('封面版本号自增失败（超过 100 次重试）')
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
        // 从同名 prompt.txt 推断题材（无则默认 urban）
        const genre = await this.readGenreFromPrompt(dir, name)
        out.push({
          fileName: name,
          relPath: `${COVER_DIR}/${name}`,
          version: parseInt(match[1], 10),
          isUploadSize: !!match[2],
          size: stat.size,
          genre,
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

  /** 下一个版本号（找现有最大 +1） */
  private async nextVersion(dir: string): Promise<number> {
    try {
      const entries = await fs.readdir(dir)
      let max = 0
      for (const name of entries) {
        const m = name.match(/^封面_v(\d+)\.png$/)
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

  /** 平台出图尺寸（番茄 3:4，其他 2:3） */
  private sizeForPlatform(platform: CoverPlatform): string {
    return platform === 'fanqie' ? '768x1024' : '1024x1536'
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

  /**
   * 居中裁剪 + 缩放到平台上传尺寸（如番茄 600×800）。
   * 用 skia-canvas：先缩放填满（保持比例），再居中裁切到精确像素。
   * 不变形，避免平台二次裁切掉书名/笔名。
   */
  private async cropToUploadSize(srcPath: string, outPath: string, targetSize: string): Promise<void> {
    const [wStr, hStr] = targetSize.split('x')
    const targetW = parseInt(wStr, 10)
    const targetH = parseInt(hStr, 10)
    if (!Number.isFinite(targetW) || !Number.isFinite(targetH)) return

    const { Canvas, loadImage } = await import('skia-canvas')
    const image = await loadImage(srcPath)
    const srcW = image.width
    const srcH = image.height
    if (srcW === 0 || srcH === 0) return

    // 计算缩放：取较大的缩放比，保证填满目标框
    const scale = Math.max(targetW / srcW, targetH / srcH)
    const scaledW = Math.round(srcW * scale)
    const scaledH = Math.round(srcH * scale)

    const canvas = new Canvas(targetW, targetH)
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, targetW, targetH)
    // 居中绘制（缩放后超出部分被 canvas 边界裁掉）
    const dx = Math.round((targetW - scaledW) / 2)
    const dy = Math.round((targetH - scaledH) / 2)
    ctx.drawImage(image, dx, dy, scaledW, scaledH)

    const buf = await canvas.toBuffer('png')
    await fs.writeFile(outPath, buf as Uint8Array)
  }
}
