import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { TeardownRepository } from '../src/main/data/teardown/teardown-repository'
import { isAllowedProductPath, splitByFileMarker } from '../src/main/data/teardown/teardown-service'
import { isSafeRelPath } from '../src/main/data/opening-markdown'

const TEST_ROOT = join(tmpdir(), `security-test-${Date.now()}`)

beforeEach(async () => {
  await fs.mkdir(TEST_ROOT, { recursive: true })
})

afterEach(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true })
})

describe('isAllowedProductPath 路径白名单（S1 防御）', () => {
  const allowed = ['章节', '剧情', '角色', '设定', '拆文报告', '文风', '概要', '快速预览']

  it('允许白名单前缀', () => {
    expect(isAllowedProductPath('剧情/节奏.md', allowed)).toBe(true)
    expect(isAllowedProductPath('章节/第1章_摘要.md', allowed)).toBe(true)
    expect(isAllowedProductPath('拆文报告.md', allowed)).toBe(true)
  })

  it('拒绝 .. 目录穿越', () => {
    expect(isAllowedProductPath('../../etc/passwd', allowed)).toBe(false)
    expect(isAllowedProductPath('章节/../../../etc/passwd', allowed)).toBe(false)
    expect(isAllowedProductPath('剧情/../..', allowed)).toBe(false)
  })

  it('拒绝绝对路径', () => {
    expect(isAllowedProductPath('/etc/passwd', allowed)).toBe(false)
    expect(isAllowedProductPath('\\Windows\\system32', allowed)).toBe(false)
  })

  it('拒绝盘符路径', () => {
    expect(isAllowedProductPath('C:\\Users\\x\\secret', allowed)).toBe(false)
    expect(isAllowedProductPath('C:/Users/x/secret', allowed)).toBe(false)
  })

  it('拒绝非白名单前缀', () => {
    expect(isAllowedProductPath('evil/path.md', allowed)).toBe(false)
    expect(isAllowedProductPath('_progress.md', allowed)).toBe(false)
  })

  it('拒绝空路径', () => {
    expect(isAllowedProductPath('', allowed)).toBe(false)
    expect(isAllowedProductPath('   ', allowed)).toBe(false)
  })

  it('前缀必须完整匹配（防 章节evil/ 绕过）', () => {
    expect(isAllowedProductPath('章节evil/secret', allowed)).toBe(false)
    expect(isAllowedProductPath('章节/x.md', allowed)).toBe(true)
  })
})

describe('splitByFileMarker + 白名单联动（S1 防御）', () => {
  it('LLM 输出恶意路径会被 isAllowedProductPath 拦截', () => {
    const md =
      '=== 文件：剧情/节奏.md ===\n正常内容\n\n' +
      '=== 文件：../../etc/passwd ===\n恶意内容'
    const sections = splitByFileMarker(md)
    expect(sections).toHaveLength(2)
    // 第一个是合法路径
    expect(isAllowedProductPath(sections[0].path, ['剧情'])).toBe(true)
    // 第二个是恶意路径，应被拦截
    expect(isAllowedProductPath(sections[1].path, ['剧情'])).toBe(false)
  })
})

describe('TeardownRepository 写路径防穿越（S1 集成）', () => {
  let repo: TeardownRepository

  beforeEach(() => {
    repo = new TeardownRepository(TEST_ROOT)
  })

  it('合法路径可写入', async () => {
    await fs.mkdir(join(TEST_ROOT, '测试书'), { recursive: true })
    await repo.writeMarkdown('测试书', '剧情/节奏.md', '内容')
    const content = await repo.readMarkdown('测试书', '剧情/节奏.md')
    expect(content).toBe('内容')
  })

  it('.. 穿越路径写入被拒绝（抛错）', async () => {
    await fs.mkdir(join(TEST_ROOT, '测试书'), { recursive: true })
    await expect(repo.writeMarkdown('测试书', '../evil.md', '恶意')).rejects.toThrow('路径越界')
    // 确认 evil.md 没被创建在父目录
    await expect(fs.access(join(TEST_ROOT, '..', 'evil.md'))).rejects.toThrow()
  })

  it('.. 穿越读取被拒绝（返回 null）', async () => {
    await fs.mkdir(join(TEST_ROOT, '测试书'), { recursive: true })
    // 先在父目录放一个文件
    await fs.writeFile(join(TEST_ROOT, 'secret.txt'), '秘密')
    // 尝试从书目录穿越读父目录
    const content = await repo.readFile('测试书', '../secret.txt')
    expect(content).toBeNull()
  })

  it('appendMarkdown 也防穿越', async () => {
    await fs.mkdir(join(TEST_ROOT, '测试书'), { recursive: true })
    await expect(repo.appendMarkdown('测试书', '../../evil.md', '恶意')).rejects.toThrow('路径越界')
  })

  it('深层 .. 被拒绝', async () => {
    await fs.mkdir(join(TEST_ROOT, '测试书'), { recursive: true })
    await expect(
      repo.writeMarkdown('测试书', '章节/../../../../etc/passwd', '恶意')
    ).rejects.toThrow('路径越界')
  })
})

describe('isSafeRelPath 设定/大纲路径白名单（C1 修复）', () => {
  const allowed = ['设定', '大纲']

  it('允许白名单前缀', () => {
    expect(isSafeRelPath('设定/核心设定.md', allowed)).toBe(true)
    expect(isSafeRelPath('设定/角色/主角.md', allowed)).toBe(true)
    expect(isSafeRelPath('大纲/大纲.md', allowed)).toBe(true)
    expect(isSafeRelPath('大纲/卷纲_第1卷.md', allowed)).toBe(true)
  })

  it('拒绝 .. 目录穿越', () => {
    expect(isSafeRelPath('../../etc/passwd', allowed)).toBe(false)
    expect(isSafeRelPath('设定/../../../etc/passwd', allowed)).toBe(false)
    expect(isSafeRelPath('大纲/../../evil.md', allowed)).toBe(false)
  })

  it('拒绝绝对路径', () => {
    expect(isSafeRelPath('/etc/passwd', allowed)).toBe(false)
    expect(isSafeRelPath('\\Windows\\system32', allowed)).toBe(false)
  })

  it('拒绝盘符路径', () => {
    expect(isSafeRelPath('C:\\Users\\x\\secret', allowed)).toBe(false)
    expect(isSafeRelPath('C:/Users/x/secret', allowed)).toBe(false)
  })

  it('拒绝非白名单前缀', () => {
    expect(isSafeRelPath('evil/path.md', allowed)).toBe(false)
    expect(isSafeRelPath('细纲/第01卷.md', allowed)).toBe(false)
  })

  it('拒绝空路径', () => {
    expect(isSafeRelPath('', allowed)).toBe(false)
    expect(isSafeRelPath('   ', allowed)).toBe(false)
  })

  it('前缀必须完整匹配（防 设定evil/ 绕过）', () => {
    expect(isSafeRelPath('设定evil/secret', allowed)).toBe(false)
    expect(isSafeRelPath('设定/x.md', allowed)).toBe(true)
  })
})
