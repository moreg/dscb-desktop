import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { SettingsRepository } from '../src/main/data/settings-repository'

describe('SettingsRepository.getCostAlert / setCostAlert (P13-C)', () => {
  let repo: SettingsRepository
  let settingsFile: string

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-sca-'))
    settingsFile = path.join(dir, 'settings.json')
    repo = new SettingsRepository(settingsFile)
  })

  it('getCostAlert returns defaults when no settings file', async () => {
    const cfg = await repo.getCostAlert()
    expect(cfg).toEqual({ enabled: true, warning: 10, exceeded: 30, blockOnExceeded: false })
  })

  it('setCostAlert persists enabled + warning + exceeded + blockOnExceeded', async () => {
    const next = await repo.setCostAlert({ enabled: false, warning: 5, exceeded: 15, blockOnExceeded: true })
    expect(next).toEqual({ enabled: false, warning: 5, exceeded: 15, blockOnExceeded: true })
    // 重新读取应保持
    const again = await repo.getCostAlert()
    expect(again).toEqual({ enabled: false, warning: 5, exceeded: 15, blockOnExceeded: true })
  })

  it('setCostAlert partial update preserves unspecified fields', async () => {
    await repo.setCostAlert({ warning: 20, exceeded: 50, blockOnExceeded: true })
    const next = await repo.setCostAlert({ warning: 5 })
    expect(next.warning).toBe(5)
    // exceeded 应保留 50，enabled 应保留默认 true，blockOnExceeded 应保留 true
    expect(next.exceeded).toBe(50)
    expect(next.enabled).toBe(true)
    expect(next.blockOnExceeded).toBe(true)
  })

  it('setCostAlert accepts blockOnExceeded boolean (P14-C)', async () => {
    const next = await repo.setCostAlert({ blockOnExceeded: true })
    expect(next.blockOnExceeded).toBe(true)
    const again = await repo.setCostAlert({ blockOnExceeded: false })
    expect(again.blockOnExceeded).toBe(false)
  })

  it('setCostAlert sanitizes non-numeric warning (rejected)', async () => {
    const next = await repo.setCostAlert({ warning: NaN })
    expect(next.warning).toBe(10) // 默认值保留
  })

  it('setCostAlert sanitizes negative warning (rejected)', async () => {
    const next = await repo.setCostAlert({ warning: -5 })
    expect(next.warning).toBe(10) // 默认值保留（不写入负值）
  })

  it('setCostAlert accepts 0 warning (边界值)', async () => {
    const next = await repo.setCostAlert({ warning: 0, exceeded: 10 })
    expect(next.warning).toBe(0)
  })

  it('setCostAlert sanitizes non-positive exceeded (rejected)', async () => {
    const next = await repo.setCostAlert({ exceeded: 0 })
    expect(next.exceeded).toBe(30) // 默认值保留
  })

  it('setCostAlert accepts Infinity (Number.isFinite 兜底)', async () => {
    const next = await repo.setCostAlert({ warning: Infinity })
    // Infinity 不是 finite，被丢弃
    expect(next.warning).toBe(10)
  })

  it('getCostAlert 修复非法配置（warning >= exceeded）→ 返回默认值', async () => {
    // 手动写入非法配置
    await writeFile(settingsFile, JSON.stringify({
      costAlert: { enabled: true, warning: 100, exceeded: 50, blockOnExceeded: true }
    }))
    const cfg = await repo.getCostAlert()
    expect(cfg).toEqual({ enabled: true, warning: 10, exceeded: 30, blockOnExceeded: false })
  })

  it('getCostAlert 修复负数 warning → 返回默认值', async () => {
    await writeFile(settingsFile, JSON.stringify({
      costAlert: { enabled: true, warning: -5, exceeded: 30, blockOnExceeded: true }
    }))
    const cfg = await repo.getCostAlert()
    expect(cfg).toEqual({ enabled: true, warning: 10, exceeded: 30, blockOnExceeded: false })
  })

  it('getCostAlert accepts valid edge case (warning = 0, exceeded = 1)', async () => {
    await writeFile(settingsFile, JSON.stringify({
      costAlert: { enabled: false, warning: 0, exceeded: 1, blockOnExceeded: false }
    }))
    const cfg = await repo.getCostAlert()
    expect(cfg).toEqual({ enabled: false, warning: 0, exceeded: 1, blockOnExceeded: false })
  })

  it('getCostAlert returns defaults on partial config (costAlert field missing)', async () => {
    await writeFile(settingsFile, JSON.stringify({
      theme: 'dark',
      dailyWordGoal: 5000
      // costAlert 字段完全缺失
    }))
    const cfg = await repo.getCostAlert()
    expect(cfg).toEqual({ enabled: true, warning: 10, exceeded: 30, blockOnExceeded: false })
  })

  it('getCostAlert returns defaults when costAlert is empty object', async () => {
    await writeFile(settingsFile, JSON.stringify({
      costAlert: {} // 空对象 → 全部用默认值
    }))
    const cfg = await repo.getCostAlert()
    expect(cfg).toEqual({ enabled: true, warning: 10, exceeded: 30, blockOnExceeded: false })
  })

  it('getCostAlert accepts warning === exceeded - 1 (边界)', async () => {
    await writeFile(settingsFile, JSON.stringify({
      costAlert: { enabled: true, warning: 9.99, exceeded: 10 }
    }))
    const cfg = await repo.getCostAlert()
    expect(cfg.warning).toBe(9.99)
    expect(cfg.exceeded).toBe(10)
  })

  it('完整集成: create → get → update 持久化', async () => {
    // 1. 初始默认
    expect(await repo.getCostAlert()).toEqual({ enabled: true, warning: 10, exceeded: 30, blockOnExceeded: false })
    // 2. 第一次更新
    await repo.setCostAlert({ warning: 50, exceeded: 100, blockOnExceeded: true })
    expect(await repo.getCostAlert()).toEqual({ enabled: true, warning: 50, exceeded: 100, blockOnExceeded: true })
    // 3. 第二次更新（只改 enabled）
    await repo.setCostAlert({ enabled: false })
    expect(await repo.getCostAlert()).toEqual({ enabled: false, warning: 50, exceeded: 100, blockOnExceeded: true })
  })
})
