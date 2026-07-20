/**
 * 将写后自检报告转为「临时写作要求 / 按要求重写」指令文本。
 * 纯函数，供流程面板一键填入、单测共用。
 */

import type {
  ChapterSelfCheckReport,
  SelfCheckCategory,
  SelfCheckItemResult,
  SelfCheckVerdict
} from './types'

const CATEGORY_LABEL: Record<SelfCheckCategory, string> = {
  continuity: '衔接',
  plot: '剧情',
  foreshadow: '伏笔',
  power: '金手指',
  structure: '结构',
  ban: '禁项'
}

export type SelfCheckRequirementsMode = 'rewrite' | 'continue'

export interface BuildSelfCheckRequirementsOptions {
  /** rewrite：按要求重写正文；continue：续写时的临时要求 */
  mode?: SelfCheckRequirementsMode
  /** 纳入 fail + warn（默认）或仅 fail */
  includeWarn?: boolean
  /** 最多条数（默认 12） */
  maxItems?: number
  chapterNumber?: number
}

/**
 * 从自检报告生成可执行的写作约束文本。
 * 无问题项时返回空串。
 */
export function buildTempRequirementsFromSelfCheck(
  report: ChapterSelfCheckReport | null | undefined,
  opts: BuildSelfCheckRequirementsOptions = {}
): string {
  if (!report?.items?.length) return ''

  const includeWarn = opts.includeWarn !== false
  const maxItems = opts.maxItems ?? 12
  const mode = opts.mode ?? 'rewrite'
  const ch = opts.chapterNumber ?? report.chapterNumber

  const issues = pickIssueItems(report.items, includeWarn).slice(0, maxItems)
  if (issues.length === 0) return ''

  const lines: string[] = []
  if (mode === 'rewrite') {
    lines.push(`【按写后自检修订第 ${ch} 章】`)
    lines.push(
      '请在保留已写剧情与文风的前提下，针对下列未通过项修改正文。不要另起炉灶重写无关段落；能局部修补的就局部修补。'
    )
  } else {
    lines.push(`【写后自检补写要求 · 第 ${ch} 章】`)
    lines.push(
      '续写/补写时必须落实下列未通过项；与既有正文衔接，不要重复已写情节，不要抢写下一章。'
    )
  }
  lines.push('')

  let n = 1
  for (const it of issues) {
    const tag = it.verdict === 'fail' ? '必须' : '建议'
    const cat = CATEGORY_LABEL[it.category] ?? it.category
    lines.push(`${n}. 【${tag}·${cat}】${it.label}`)
    if (it.detail?.trim()) {
      lines.push(`   依据：${clip(it.detail.trim(), 160)}`)
    }
    const action = actionHint(it)
    if (action) lines.push(`   改法：${action}`)
    lines.push('')
    n++
  }

  lines.push('改完后自检：上列每一项都要在正文中有可见落地，禁止仅用旁白声称「已解决」。')
  if (mode === 'rewrite') {
    lines.push('直接输出修订后的完整本章正文（或明确改动的连续段落），不要解释过程。')
  }

  return lines.join('\n').trim() + '\n'
}

/** 是否有可生成要求的问题项 */
export function selfCheckHasActionableIssues(
  report: ChapterSelfCheckReport | null | undefined,
  includeWarn = true
): boolean {
  if (!report?.items?.length) return false
  return pickIssueItems(report.items, includeWarn).length > 0
}

function pickIssueItems(
  items: SelfCheckItemResult[],
  includeWarn: boolean
): SelfCheckItemResult[] {
  const allowed: SelfCheckVerdict[] = includeWarn ? ['fail', 'warn'] : ['fail']
  const rank: Record<SelfCheckVerdict, number> = { fail: 0, warn: 1, pass: 2, skip: 3 }
  return items
    .filter((i) => allowed.includes(i.verdict))
    .sort((a, b) => rank[a.verdict] - rank[b.verdict])
}

/** 按检查 id / 类别给可操作改法提示 */
function actionHint(item: SelfCheckItemResult): string {
  const id = item.id
  if (id === 'ending_form') {
    return '改写章末 2～4 段：用一句对话或一个突然动作/来人收束，删掉总结式旁白。'
  }
  if (id === 'ending_taboo') {
    return '删除章末说教/AI 抒怀句，换成具体事件或未说完的对话。'
  }
  if (id === 'prev_suspense') {
    return '在章首或前半段用对话/动作回应上章悬念，不要装作无事发生。'
  }
  if (id.startsWith('unfinished_')) {
    return '在正文中明确处理或推进该未完成事项（对话承诺、动作完成、或合理延后并点明）。'
  }
  if (id === 'char_position') {
    return '开头交代人物如何从上一地点移动到此处，禁止无过程瞬移。'
  }
  if (id === 'core_plot') {
    return '补写或强化本章核心事件的过程与结果，让事件在正文里真正发生。'
  }
  if (id.startsWith('due_fb_')) {
    return '在正文中明确回收该到期伏笔（对话揭示 / 物品出场 / 场景重现 / 点破），不要拖到下章。'
  }
  if (id.startsWith('early_fb_')) {
    return '删改提前揭穿未到期伏笔的句子，只保留含蓄暗示。'
  }
  if (id === 'power_bound') {
    return '收回越权能力描写，改回设定边界内的用法（能看什么、不能看什么、消耗与反噬）。'
  }
  if (id === 'volume_spoiler') {
    return '删掉属于更后章节的大事件揭晓，本章只推进当前细纲节点。'
  }
  if (id === 'meta_narration') {
    return '去掉「第N章」「下章见」「未完待续」等元叙述，改用故事内对话/事件收尾。'
  }

  switch (item.category) {
    case 'continuity':
      return '补上与上章状态/位置/悬念的衔接句。'
    case 'plot':
      return '把偏题内容压短，把核心事件写满。'
    case 'foreshadow':
      return '按伏笔表处理：到期必收，未到期勿爆。'
    case 'power':
      return '对齐金手指限制，删掉越权表述。'
    case 'structure':
      return '调整章末形态与节奏，避免空收尾。'
    case 'ban':
      return '删除抢写、元叙述或违规提前内容。'
    default:
      return '按依据项修改正文，使检查可通过。'
  }
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1) + '…'
}

/**
 * 对比改前/改后自检，生成「复检」短文案（toast / 状态条）。
 * 无 previous 时退回 next.summary。
 */
export function formatSelfCheckDelta(
  previous: ChapterSelfCheckReport | null | undefined,
  next: ChapterSelfCheckReport
): string {
  if (!previous) return next.summary
  const pf = previous.counts.fail
  const pw = previous.counts.warn
  const nf = next.counts.fail
  const nw = next.counts.warn
  // 改前本就干净：只报本次结果
  if (pf + pw === 0) return next.summary

  if (next.ok && nw === 0) {
    return `复检全部通过（此前失败 ${pf}、留意 ${pw}）`
  }
  if (next.ok && nw > 0) {
    return `复检无失败项（留意 ${nw}；此前失败 ${pf}、留意 ${pw}）`
  }
  if (nf < pf || (nf === pf && nw < pw)) {
    return `复检有改善：失败 ${pf}→${nf}，留意 ${pw}→${nw}`
  }
  if (nf > pf || nw > pw) {
    return `复检仍有问题：失败 ${nf}、留意 ${nw}（此前 ${pf}/${pw}）`
  }
  return `复检结果未变：失败 ${nf}、留意 ${nw}`
}
