import type { LlmService, GenerateOptions } from './llm-service'
import type { AuditSeverity, AuditViolation, CustomReviewCheck, ReviewCheckId } from '../../shared/types'

/**
 * LLM 深度审稿流程编排服务（M3 新增）。
 *
 * 跑「正文审核」技能里必须靠语义理解的检查项：
 * 角色崩坏 / 逻辑漏洞 / 剧情降智 / 情绪断崖 / 钩子强度分级 /
 * 文风匹配度 / 爽点分析 / 引文语气矛盾。
 *
 * 与 WriteFlowService 同构：每个检查一次 LLM 调用，返回 JSON findings，
 * 失败兜底为空 findings（不阻断主流程）。调用方决定哪些 checkId 启用。
 */

/** LLM 单次返回的发现项（与 AuditViolation 对齐，category 由 runDeepReview 统一填 llm_review） */
interface RawFinding {
  checkId: ReviewCheckId
  severity: AuditSeverity
  message: string
  snippet?: string
  offset?: number
  suggestion?: string
}

/** 单次 LLM 调用的输入描述（每类检查一个） */
interface CheckSpec {
  checkId: ReviewCheckId
  /** prompt 头：告诉 LLM 这一项查什么、怎么判 */
  instruction: string
}

/** 8 类 LLM 检查的 prompt 规格表。 */
const CHECK_SPECS: Record<ReviewCheckId, CheckSpec> = {
  character_breakdown: {
    checkId: 'character_breakdown',
    instruction: `检查「角色崩坏人设」：角色行为是否与其性格设定严重不符（如沉稳角色突然鲁莽、狠辣角色突然圣母）。
对照下方角色卡，列出行为与设定不符之处。`
  },
  logic_hole: {
    checkId: 'logic_hole',
    instruction: `检查「逻辑漏洞/逻辑断层」：前后矛盾、时间线混乱、因果关系不衔接、人物行为动机不明确。
只列可证实的硬伤，不评价文学性。`
  },
  low_iq_plot: {
    checkId: 'low_iq_plot',
    instruction: `检查「剧情降智」：角色是否做出明显不符合其智商/阅历的决策（如高手犯低级错误、聪明人被拙劣骗局骗过）。
只列缺乏合理铺垫的降智决策。`
  },
  emotion_cliff: {
    checkId: 'emotion_cliff',
    instruction: `检查「情绪断崖」：是否存在情绪基调的突兀切换（如悲伤场景突然搞笑、紧张时刻强行煽情），破坏情绪连贯性。`
  },
  hook_grade: {
    checkId: 'hook_grade',
    instruction: `评估「章末钩子强度」：根据本章结尾判定钩子等级。
- strong：悬念/冲突/反转强，吸引继续阅读
- weak：有悬念但不够强烈，或仅伏笔型
- none：无钩子，事件结束后正常收尾
若不是 strong，请说明可如何加强。`
  },
  style_match: {
    checkId: 'style_match',
    instruction: `评估「文风匹配度」：语言风格/叙事节奏/对话腔调是否匹配本作题材（见下方题材定位）。
列出明显偏离题材风格的段落（如爽文写得像散文、搞笑文突然正经）。`
  },
  cool_point: {
    checkId: 'cool_point',
    instruction: `分析「爽点」（仅爽文题材）：打脸爽/装逼爽/逆袭爽是否到位（铺垫充分、高潮干脆、情绪释放完整）。
若本作非爽文题材，输出空数组。
若爽点不足，指出缺哪类爽点。`
  },
  quote_contradiction: {
    checkId: 'quote_contradiction',
    instruction: `检查「引文语气/动作/情绪矛盾」：对话内容与配套的语气/动作/神态/情绪描述是否矛盾。
例如"我恨你！"她温柔地说；"别过来！"他纹丝不动地站着。`
  },
  // 算法类 checkId 不会走到这里，占位满足 Record 完整性
  meta_break: { checkId: 'meta_break', instruction: '' },
  pov_mix: { checkId: 'pov_mix', instruction: '' },
  repetition: { checkId: 'repetition', instruction: '' },
  quote_count: { checkId: 'quote_count', instruction: '' },
  dash_fragment: { checkId: 'dash_fragment', instruction: '' },
  long_sentence: { checkId: 'long_sentence', instruction: '' },
  comma_stack: { checkId: 'comma_stack', instruction: '' },
  ellipsis_abuse: { checkId: 'ellipsis_abuse', instruction: '' },
  long_paragraph: { checkId: 'long_paragraph', instruction: '' },
  dialogue_tag: { checkId: 'dialogue_tag', instruction: '' },
  sensitive: { checkId: 'sensitive', instruction: '' }
}

/** LLM 类 checkId 集合（用于过滤掉算法类占位） */
const LLM_CHECK_IDS: ReadonlySet<ReviewCheckId> = new Set([
  'character_breakdown',
  'logic_hole',
  'low_iq_plot',
  'emotion_cliff',
  'hook_grade',
  'style_match',
  'cool_point',
  'quote_contradiction'
])

export interface DeepReviewContext {
  chapterNumber: number
  /** 题材（中文，注入 style_match / cool_point 判断） */
  genre?: string
  /** 启用的 LLM 检查项；为空 = 全部 LLM 项都跑 */
  enabledChecks?: ReviewCheckId[]
  /** 角色卡文本（character_breakdown 对照用），可为空 */
  characterCards?: string
  /** 章节细纲文本（logic_hole 对照用），可为空 */
  outline?: string
  /** 用户自定义的 LLM 检查项（type=llm），由调用方从 settings 透传 */
  customLlmChecks?: CustomReviewCheck[]
}

export class ReviewFlowService {
  constructor(private readonly llm: LlmService) {}

  /**
   * 跑深度审稿：按 enabledChecks 串行调用启用的 LLM 检查，汇总 findings。
   * 每项失败兜底为空（不抛错），整体永不 reject。
   * 返回的 AuditViolation 全部 category='llm_review'，ruleId=checkId。
   */
  async runDeepReview(
    content: string,
    ctx: DeepReviewContext,
    opts: GenerateOptions = {}
  ): Promise<AuditViolation[]> {
    const want =
      ctx.enabledChecks && ctx.enabledChecks.length > 0
        ? ctx.enabledChecks.filter((c) => LLM_CHECK_IDS.has(c))
        : [...LLM_CHECK_IDS]

    const all: AuditViolation[] = []
    for (const checkId of want) {
      const spec = CHECK_SPECS[checkId]
      if (!spec || !spec.instruction) continue
      try {
        const findings = await this.runOneCheck(spec, content, ctx, opts)
        for (const f of findings) {
          all.push({
            category: 'llm_review',
            severity: f.severity,
            message: f.message,
            snippet: f.snippet,
            offset: f.offset,
            ruleId: f.checkId,
            suggestion: f.suggestion
          })
        }
      } catch (err) {
        // 单项失败不影响其他项；继续
        console.warn(`[runDeepReview] check ${checkId} failed:`, err)
      }
    }
    return all
  }

  /** 单次 LLM 调用：跑一个检查项，解析 JSON findings。失败兜底空数组。 */
  private async runOneCheck(
    spec: CheckSpec,
    content: string,
    ctx: DeepReviewContext,
    opts: GenerateOptions
  ): Promise<RawFinding[]> {
    const prompt = [
      `你是一名网文审稿员。请只做下面这一项检查，不要做其他检查。`,
      ``,
      `## 检查任务`,
      spec.instruction,
      ``,
      ctx.genre ? `## 本作题材\n${ctx.genre}` : '',
      ctx.characterCards ? `## 角色卡（对照用）\n${ctx.characterCards}` : '',
      ctx.outline ? `## 本章细纲（对照用）\n${ctx.outline}` : '',
      ``,
      `## 输出要求`,
      `严格 JSON，不要任何解释、Markdown 代码块：`,
      `{`,
      `  "findings": [`,
      `    {`,
      `      "checkId": "${spec.checkId}",`,
      `      "severity": "error" | "warn" | "info",`,
      `      "message": "一句话说明问题（≤40字）",`,
      `      "snippet": "命中原文片段（可选，≤60字）",`,
      `      "offset": 数字或null（命中位置在全文中的大致字符偏移，不确定给null）,`,
      `      "suggestion": "具体修改建议（可选）"`,
      `    }`,
      `  ]`,
      `}`,
      `无问题输出 {"findings": []}。`,
      ``,
      `## 本章正文`,
      content.length > 6000 ? content.slice(0, 6000) + '\n…（后文略）' : content
    ]
      .filter((l) => l !== '')
      .join('\n')

    const raw = await this.llm.generateStream(prompt, {
      ...opts,
      meta: { feature: `deepReview:${spec.checkId}`, ...opts.meta }
    })
    return parseFindingsJson(raw, spec.checkId)
  }
}

/**
 * 解析 LLM 返回的 JSON findings。失败/空兜底为空数组。
 * 容错：抽第一个 {...} 块；findings 非数组返回空。
 */
export function parseFindingsJson(raw: string, fallbackCheckId: ReviewCheckId): RawFinding[] {
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return []
    const obj = JSON.parse(m[0])
    if (!Array.isArray(obj.findings)) return []
    const out: RawFinding[] = []
    for (const f of obj.findings) {
      if (!f || typeof f !== 'object') continue
      const severity = normalizeSeverity(f.severity)
      const message = typeof f.message === 'string' ? f.message.trim() : ''
      if (!message) continue
      out.push({
        checkId: (typeof f.checkId === 'string' ? f.checkId : fallbackCheckId) as ReviewCheckId,
        severity,
        message,
        snippet: typeof f.snippet === 'string' && f.snippet.trim() ? f.snippet.trim() : undefined,
        offset: typeof f.offset === 'number' && Number.isFinite(f.offset) ? Math.max(0, Math.floor(f.offset)) : undefined,
        suggestion:
          typeof f.suggestion === 'string' && f.suggestion.trim() ? f.suggestion.trim() : undefined
      })
    }
    return out
  } catch {
    return []
  }
}

function normalizeSeverity(v: unknown): AuditSeverity {
  if (v === 'error' || v === 'warn' || v === 'info') return v
  return 'warn'
}
