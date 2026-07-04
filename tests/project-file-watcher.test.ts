import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectFileWatcher, classifyChangeForTest } from '../src/main/data/project-file-watcher'

/**
 * 文件监听器测试。fs.watch 在不同平台行为略有差异，
 * 这里用真实文件系统 + 防抖等待验证核心契约：
 * - 文件变更按 kind 归类
 * - 防抖合并短时间内多次事件
 * - webContents.send 被调用且带正确 projectId/kind
 * - stopWatching / dispose 释放资源
 */
describe('ProjectFileWatcher', () => {
  let dir: string
  let sendMock: ReturnType<typeof vi.fn>
  let windowMock: { isDestroyed: () => boolean; webContents: { send: typeof sendMock } }
  let watcher: ProjectFileWatcher

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-watch-'))
    // 预建目录结构
    await mkdir(path.join(dir, '细纲'), { recursive: true })
    await mkdir(path.join(dir, '图解'), { recursive: true })
    await mkdir(path.join(dir, '记忆系统'), { recursive: true })
    await mkdir(path.join(dir, '设定', '角色'), { recursive: true })
    await mkdir(path.join(dir, '正文'), { recursive: true })

    sendMock = vi.fn()
    windowMock = {
      isDestroyed: () => false,
      webContents: { send: sendMock }
    }
    watcher = new ProjectFileWatcher(() => windowMock as never)
  })

  afterEach(async () => {
    watcher.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  /** 等待防抖窗口（300ms）+ 余量 */
  const waitForDebounce = (ms = 500) =>
    new Promise((resolve) => setTimeout(resolve, ms))

  it('classifyChange: 细纲/节奏图谱/章节进度/角色卡/正文 正确归类', () => {
    expect(classifyChangeForTest('细纲/第01卷.md')).toBe('outline')
    expect(classifyChangeForTest('细纲/细纲_第001章_破窗.md')).toBe('outline')
    expect(classifyChangeForTest('图解/节奏图谱.html')).toBe('rhythm')
    expect(classifyChangeForTest('记忆系统/章节进度.md')).toBe('progress')
    expect(classifyChangeForTest('记忆系统/角色卡.md')).toBe('characters')
    expect(classifyChangeForTest('设定/角色/苏九.md')).toBe('characters')
    expect(classifyChangeForTest('正文/第001章.md')).toBe('prose')
  })

  it('classifyChange: 忽略临时文件和非目标路径', () => {
    expect(classifyChangeForTest('细纲/第01卷.md~')).toBeNull()
    expect(classifyChangeForTest('大纲/大纲.md')).toBeNull()
    expect(classifyChangeForTest('.git/config')).toBeNull()
    expect(classifyChangeForTest('node_modules/x/index.js')).toBeNull()
  })

  it('改细纲文件触发 outline 事件（带 projectId）', async () => {
    watcher.watchProject('proj-1', dir)
    await writeFile(path.join(dir, '细纲', '第01卷.md'), '# 第01卷\n', 'utf-8')
    await waitForDebounce()

    expect(sendMock).toHaveBeenCalledWith('project:files-changed', {
      projectId: 'proj-1',
      kind: 'outline'
    })
  })

  it('改节奏图谱触发 rhythm 事件', async () => {
    watcher.watchProject('proj-1', dir)
    await writeFile(path.join(dir, '图解', '节奏图谱.html'), '<html></html>', 'utf-8')
    await waitForDebounce()

    expect(sendMock).toHaveBeenCalledWith('project:files-changed', {
      projectId: 'proj-1',
      kind: 'rhythm'
    })
  })

  it('改角色卡触发 characters 事件', async () => {
    watcher.watchProject('proj-1', dir)
    await writeFile(path.join(dir, '记忆系统', '角色卡.md'), '# 角色卡\n', 'utf-8')
    await waitForDebounce()

    expect(sendMock).toHaveBeenCalledWith('project:files-changed', {
      projectId: 'proj-1',
      kind: 'characters'
    })
  })

  it('防抖：短时间内多次写同一文件只发一次通知', async () => {
    watcher.watchProject('proj-1', dir)
    const file = path.join(dir, '细纲', '第01卷.md')
    // 连续写 5 次（间隔远小于防抖窗口）
    for (let i = 0; i < 5; i++) {
      await writeFile(file, `# v${i}\n`, 'utf-8')
      await new Promise((r) => setTimeout(r, 30))
    }
    await waitForDebounce()

    const outlineCalls = sendMock.mock.calls.filter(
      ([, payload]) => payload.kind === 'outline'
    )
    expect(outlineCalls.length).toBe(1)
  })

  it('不同 kind 互不阻塞：细纲和角色卡各发一次', async () => {
    watcher.watchProject('proj-1', dir)
    await writeFile(path.join(dir, '细纲', '第01卷.md'), '# x\n', 'utf-8')
    await writeFile(path.join(dir, '记忆系统', '角色卡.md'), '# y\n', 'utf-8')
    await waitForDebounce()

    const kinds = sendMock.mock.calls.map(([, payload]) => payload.kind).sort()
    expect(kinds).toEqual(['characters', 'outline'])
  })

  it('stopWatching 后不再发送事件', async () => {
    watcher.watchProject('proj-1', dir)
    watcher.stopWatching()
    await writeFile(path.join(dir, '细纲', '第01卷.md'), '# x\n', 'utf-8')
    await waitForDebounce()

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('切项目：旧 watcher 释放，新项目事件带新 projectId', async () => {
    watcher.watchProject('proj-old', dir)
    watcher.watchProject('proj-new', dir)
    await writeFile(path.join(dir, '细纲', '第01卷.md'), '# x\n', 'utf-8')
    await waitForDebounce()

    expect(sendMock).toHaveBeenCalledWith('project:files-changed', {
      projectId: 'proj-new',
      kind: 'outline'
    })
    // 不应再有 proj-old 的事件
    const oldCalls = sendMock.mock.calls.filter(
      ([, payload]) => payload.projectId === 'proj-old'
    )
    expect(oldCalls.length).toBe(0)
  })

  it('窗口销毁时不发送（避免异常）', async () => {
    windowMock.isDestroyed = () => true
    watcher.watchProject('proj-1', dir)
    await writeFile(path.join(dir, '细纲', '第01卷.md'), '# x\n', 'utf-8')
    await waitForDebounce()

    expect(sendMock).not.toHaveBeenCalled()
  })
})
