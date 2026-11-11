import type { MemoryExtraction } from '../../../shared/types'
import type { CharacterStateSnapshot, ItemStateSnapshot } from './tracking-md-repo'

/** 字段名归一：同义映射到标准名（预览与写入共用） */
export function normalizeStateField(field: string): string {
  const f = field.trim()
  const map: Record<string, string> = {
    伤: '伤势',
    受伤: '伤势',
    伤势情况: '伤势',
    情绪状态: '情绪',
    心情: '情绪',
    所在: '位置',
    所在地: '位置',
    地点: '位置',
    状态: '当前状态',
    现状: '当前状态',
    人设: '性格',
    性格特点: '性格',
    能力境界: '境界',
    修为: '境界',
    功法: '能力',
    长相: '外貌',
    相貌: '外貌',
    关系网: '关系',
    人物关系: '关系',
    物品: '持有物',
    随身: '持有物',
    定位: '角色定位',
    role: '角色定位',
    identity: '身份',
    personality: '性格',
    abilities: '能力',
    appearance: '外貌'
  }
  return map[f] ?? f
}

export function escapeTableCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

/** 字段 → 角色状态表列 */
export function mapFieldToStateColumn(
  field: string
): StateColumn | null {
  const f = normalizeStateField(field)
  if (['伤势', '当前状态', '能力', '境界', '金手指', '实力'].includes(f)) return 'power'
  if (['情绪', '立场'].includes(f)) return 'stance'
  if (f === '目标') return 'goal'
  if (['持有物', '物品'].includes(f)) return 'items'
  if (['关系', '关系网'].includes(f)) return 'relations'
  if (f === '性格') return 'personality'
  if (f === '角色定位') return 'role'
  if (f === '身份') return 'identity'
  return null
}

type StateColumn = 'power' | 'stance' | 'goal' | 'items' | 'relations' | 'personality' | 'role' | 'identity'

export function renderStateHistory(
  chapter: number,
  changes: MemoryExtraction['characterStateChanges'],
  prior: Map<string, CharacterStateSnapshot>,
  legacy = false
): string {
  const byName = new Map<string, { field: string; value: string }[]>()
  for (const c of changes) {
    const name = c.name?.trim()
    const value = String(c.newValue ?? '').trim()
    if (!name || !value) continue
    const list = byName.get(name) ?? []
    list.push({ field: normalizeStateField(c.field || '状态'), value })
    byName.set(name, list)
  }
  const snapshots: CharacterStateSnapshot[] = []
  const logs: string[] = []
  for (const [name, fields] of byName) {
    const state: CharacterStateSnapshot = { name, power: '-', stance: '-', goal: '-', items: '-', relations: '-', ...prior.get(name), updateChapter: chapter }
    const columns = new Map<StateColumn, string[]>()
    for (const f of fields) {
      const column = (legacy && ['性格', '角色定位', '身份'].includes(f.field) ? null : mapFieldToStateColumn(f.field)) ?? 'power'
      columns.set(column, [...(columns.get(column) ?? []), f.value])
      logs.push(`| 第 ${chapter} 章 | ${escapeTableCell(name)} | ${escapeTableCell(`${f.field}：${f.value}`)} |`)
    }
    for (const [column, values] of columns) state[column] = [...new Set(values)].join('；')
    snapshots.push(state)
  }
  if (!snapshots.length) return ''
  return [
    `## 自动历史快照（第 ${chapter} 章）`, '',
    legacy ? '| 角色 | 当前实力 | 当前立场 | 当前目标 | 关键道具 | 关系快照 | 更新章节 |' : '| 角色 | 当前实力 | 当前立场 | 当前目标 | 关键道具 | 关系快照 | 性格 | 角色定位 | 身份 | 更新章节 |',
    legacy ? '|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|---|---|---|---|',
    ...snapshots.map((s) => `| ${[s.name, s.power, s.stance, s.goal, s.items, s.relations,
      ...(!legacy ? [s.personality || '-', s.role || '-', s.identity || '-'] : []), `第 ${chapter} 章`].map(escapeTableCell).join(' | ')} |`),
    '', `## 自动状态变更（第 ${chapter} 章）`, '',
    '| 章节 | 角色 | 变更内容 |', '|---|---|---|', ...logs, ''
  ].join('\n')
}

/** 字段名归一：物品状态表同义映射（提取提示词与写入共用口径） */
export function normalizeItemStateField(field: string): string {
  const f = field.trim()
  const map: Record<string, string> = {
    外观: '材质外观', 材质: '材质外观', 外形: '材质外观', 形制: '材质外观', 质地: '材质外观',
    持有: '持有者', 持有人: '持有者', 持有物: '持有者', 归属: '持有者',
    位置: '所在位置', 所在: '所在位置', 封存: '所在位置', 存放: '所在位置',
    现状: '状态', 情况: '状态'
  }
  return map[f] ?? f
}

type ItemStateColumn = 'material' | 'holder' | 'location' | 'status'

function mapItemFieldToColumn(field: string): ItemStateColumn {
  const f = normalizeItemStateField(field)
  if (f === '材质外观') return 'material'
  if (f === '持有者') return 'holder'
  if (f === '所在位置') return 'location'
  return 'status'
}

export function renderItemStateHistory(
  chapter: number,
  changes: NonNullable<MemoryExtraction['itemStateChanges']>,
  prior: Map<string, ItemStateSnapshot>
): string {
  const byName = new Map<string, { field: string; value: string }[]>()
  for (const c of changes) {
    const name = c.name?.trim()
    const value = String(c.newValue ?? '').trim()
    if (!name || !value) continue
    const list = byName.get(name) ?? []
    list.push({ field: normalizeItemStateField(c.field || '状态'), value })
    byName.set(name, list)
  }
  const snapshots: ItemStateSnapshot[] = []
  const logs: string[] = []
  for (const [name, fields] of byName) {
    const state: ItemStateSnapshot = { name, material: '-', holder: '-', location: '-', status: '-', ...prior.get(name), updateChapter: chapter }
    const columns = new Map<ItemStateColumn, string[]>()
    for (const f of fields) {
      const column = mapItemFieldToColumn(f.field)
      columns.set(column, [...(columns.get(column) ?? []), f.value])
      logs.push(`| 第 ${chapter} 章 | ${escapeTableCell(name)} | ${escapeTableCell(`${f.field}：${f.value}`)} |`)
    }
    for (const [column, values] of columns) state[column] = [...new Set(values)].join('；')
    snapshots.push(state)
  }
  if (!snapshots.length) return ''
  return [
    `## 自动历史快照（第 ${chapter} 章）`, '',
    '| 物品 | 材质外观 | 当前持有者 | 所在位置 | 状态 | 更新章节 |',
    '|---|---|---|---|---|---|',
    ...snapshots.map((s) => `| ${[s.name, s.material, s.holder, s.location, s.status, `第 ${chapter} 章`].map(escapeTableCell).join(' | ')} |`),
    '', `## 自动状态变更（第 ${chapter} 章）`, '',
    '| 章节 | 物品 | 变更内容 |', '|---|---|---|', ...logs, ''
  ].join('\n')
}
