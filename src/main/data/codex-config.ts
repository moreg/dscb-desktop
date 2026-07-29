import { readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { ReasoningEffort } from '../../shared/types'

const VALID_EFFORTS = new Set<ReasoningEffort>(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
const DEFAULT_EFFORT: ReasoningEffort = 'medium'

export function codexConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml')
}

/** 读取 Codex CLI 全局默认思考强度；未设置或异常值时回退 medium。 */
export async function getCodexReasoningEffort(path = codexConfigPath()): Promise<ReasoningEffort> {
  try {
    const content = await readFile(path, 'utf8')
    const match = content.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m)
    const value = match?.[1] as ReasoningEffort | undefined
    return value && VALID_EFFORTS.has(value) ? value : DEFAULT_EFFORT
  } catch {
    return DEFAULT_EFFORT
  }
}

/**
 * 更新 Codex CLI 全局 config.toml，尽量保留其它配置与注释。
 * 此设置会影响同一用户登录态下的所有 Codex CLI / app-server 调用。
 */
export async function setCodexReasoningEffort(
  effort: ReasoningEffort,
  path = codexConfigPath()
): Promise<ReasoningEffort> {
  if (!VALID_EFFORTS.has(effort)) throw new Error('CODEX_REASONING_EFFORT_INVALID')
  let content = ''
  try {
    content = await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
  }
  const line = `model_reasoning_effort = "${effort}"`
  const next = /^\s*model_reasoning_effort\s*=.*$/m.test(content)
    ? content.replace(/^\s*model_reasoning_effort\s*=.*$/m, line)
    : `${content}${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`
  await writeFile(path, next, 'utf8')
  return effort
}
