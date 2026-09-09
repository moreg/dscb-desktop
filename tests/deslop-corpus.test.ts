/**
 * 去 AI 味语料基线：拿人写 vs AI 写的真实稿子，量一遍检测器到底分不分得开。
 *
 * 这是 deslop 的标尺。没有它，「加一条规则 / 调一个阈值」是拍脑袋。
 * 语料怎么放、放什么，见 tests/fixtures/deslop-corpus/README.md。
 *
 * 每组少于 MIN_PER_GROUP 篇时自动跳过（只打印一行提示），不挡别的开发。
 * 默认只报告不判定；要让它在分离度不达标时真的失败，跑：
 *   DESLOP_CORPUS_STRICT=1 npx vitest run tests/deslop-corpus.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DeslopService } from '../src/main/data/deslop/deslop-service'
import { UNIFORMITY_THRESHOLDS } from '../src/main/data/deslop/check-uniformity'
import { STRUCTURE_DIMENSIONS } from '../src/main/data/skill-prompts/deslop/structure-judge'
import { countWords } from '../src/main/data/words'
import { LlmService } from '../src/main/data/llm-service'
import type { SecretStore } from '../src/main/data/secret-store'
import type {
  DeslopLevel,
  DeslopMetrics,
  DeslopStructureFinding,
  ProviderProtocol,
  ProvidersConfig
} from '../src/shared/types'

const CORPUS_DIR = join(__dirname, 'fixtures', 'deslop-corpus')
const MIN_PER_GROUP = 5
/** CV 指标需要足够长的稿子才出数；短样本会被计入「无效」并在报告里点名 */
const MIN_WORDS = 1500
const STRICT = process.env.DESLOP_CORPUS_STRICT === '1'
/**
 * 结构体检评测开关。默认关：它对每篇样本都要调 LLM，40 篇语料就是 40+ 次调用，
 * 会真花钱。开之前先看 README「结构体检评测」一节。
 */
const JUDGE_EVAL = process.env.DESLOP_JUDGE_EVAL === '1'
/**
 * 体检评测的整体超时（分钟），DESLOP_EVAL_TIMEOUT_MIN 可覆盖。
 *
 * CLI 协议每次调用要起一个子进程，速度差着数量级：实测单篇 codex 44s / claude 49s /
 * antigravity 59s / grok 412s。默认 90 分钟够前三个跑 40 篇，grok 得手动调到 300+。
 */
const JUDGE_EVAL_TIMEOUT_MS =
  (Number(process.env.DESLOP_EVAL_TIMEOUT_MIN) || 90) * 60 * 1000

/** 严格模式的及格线：AI 稿检出率下限 / 人写稿误伤率上限 */
const STRICT_MIN_RECALL = 0.7
const STRICT_MAX_FALSE_POSITIVE = 0.3

/** 指标方向：'low' = 越小越像 AI（CV 系列）；'high' = 越大越像 AI（密度系列） */
type Direction = 'low' | 'high'

interface MetricSpec {
  key: keyof DeslopMetrics
  label: string
  direction: Direction
  /** 当前生效的阈值，用于和推荐阈值对照；密度类没有单独阈值 */
  current?: number
}

const METRICS: MetricSpec[] = [
  { key: 'sentenceLengthCv', label: '句长 CV', direction: 'low', current: UNIFORMITY_THRESHOLDS.sentenceLengthCv },
  { key: 'paragraphLengthCv', label: '段长 CV', direction: 'low', current: UNIFORMITY_THRESHOLDS.paragraphLengthCv },
  { key: 'dialogueLengthCv', label: '对白 CV', direction: 'low', current: UNIFORMITY_THRESHOLDS.dialogueLengthCv },
  { key: 'bannedWordDensity', label: '禁用词密度', direction: 'high' },
  { key: 'parallelismCount', label: '排比命中数', direction: 'high' }
]

interface Sample {
  name: string
  group: 'human' | 'ai'
  words: number
  metrics: DeslopMetrics
  level: DeslopLevel
}

function loadGroup(group: 'human' | 'ai'): { name: string; text: string }[] {
  const dir = join(CORPUS_DIR, group)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => /\.(txt|md)$/i.test(f))
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf-8') }))
}

/**
 * AUC（Mann-Whitney U）：随机取一篇 AI 稿和一篇人写稿，AI 稿得分更高的概率。
 * 0.5 = 完全分不开，1.0 = 完美分开。并列算 0.5。
 * 传入的 score 已按 direction 归一成「越大越像 AI」。
 */
function auc(aiScores: number[], humanScores: number[]): number {
  if (aiScores.length === 0 || humanScores.length === 0) return 0.5
  let wins = 0
  for (const a of aiScores) {
    for (const h of humanScores) {
      if (a > h) wins += 1
      else if (a === h) wins += 0.5
    }
  }
  return wins / (aiScores.length * humanScores.length)
}

/**
 * 用 Youden's J（检出率 − 误伤率）搜最佳切点。
 * 候选切点取所有观测值的中点，返回原始量纲的阈值和该点的命中/误伤率。
 */
function bestThreshold(
  aiValues: number[],
  humanValues: number[],
  direction: Direction
): { threshold: number; recall: number; falsePositive: number; youden: number } | null {
  const all = [...aiValues, ...humanValues].sort((a, b) => a - b)
  if (all.length < 2) return null
  const candidates: number[] = []
  for (let i = 1; i < all.length; i++) {
    if (all[i] !== all[i - 1]) candidates.push((all[i] + all[i - 1]) / 2)
  }
  if (candidates.length === 0) return null

  const isAi = (v: number, t: number): boolean => (direction === 'low' ? v < t : v > t)
  let best: { threshold: number; recall: number; falsePositive: number; youden: number } | null = null
  for (const t of candidates) {
    const recall = aiValues.filter((v) => isAi(v, t)).length / aiValues.length
    const falsePositive = humanValues.filter((v) => isAi(v, t)).length / humanValues.length
    const youden = recall - falsePositive
    if (!best || youden > best.youden) best = { threshold: t, recall, falsePositive, youden }
  }
  return best
}

/** 中文字符占两格，按码点补空格会错位，报告列对不齐 */
function padLabel(label: string, width: number): string {
  const displayWidth = [...label].reduce((n, ch) => n + (/[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1), 0)
  return label + ' '.repeat(Math.max(0, width - displayWidth))
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`
}

function describeSpread(values: number[]): string {
  if (values.length === 0) return '无有效样本'
  const sorted = [...values].sort((a, b) => a - b)
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
  const median = sorted[Math.floor(sorted.length / 2)]
  const lo = sorted[0].toFixed(3)
  const hi = sorted[sorted.length - 1].toFixed(3)
  return `n=${sorted.length} 均值 ${mean.toFixed(3)} 中位 ${median.toFixed(3)} 范围 [${lo}, ${hi}]`
}


/** 走本机 CLI 登录态的协议：不需要 baseUrl / apiKey，model 也可空（走 CLI 默认） */
const CLI_PROTOCOLS = new Set<string>(['codex', 'claude', 'grok', 'antigravity'])

/**
 * 从环境变量拼一个 LlmService。
 *
 * 不复用 app 的 SecretStore：那个走 Electron safeStorage，vitest 里根本起不来。
 * 这里塞一个只实现 read() 的桩——LlmService 解析 provider 时只用得到它。
 *
 * HTTP 协议缺 baseUrl/model 就返回 null（拿空配置去撞 401 没意义）；
 * CLI 协议靠本机登录态，两个都不需要，只要协议名对就能跑。
 */
function evalLlmFromEnv(): LlmService | null {
  const baseUrl = (process.env.DESLOP_EVAL_BASE_URL ?? '').trim()
  const model = (process.env.DESLOP_EVAL_MODEL ?? '').trim()
  const apiKey = (process.env.DESLOP_EVAL_API_KEY ?? '').trim()
  const protocol = ((process.env.DESLOP_EVAL_PROTOCOL ?? 'openai').trim() || 'openai') as ProviderProtocol
  if (!CLI_PROTOCOLS.has(protocol) && (!baseUrl || !model)) return null

  const cfg: ProvidersConfig = {
    activeId: 'corpus-eval',
    providers: [{ id: 'corpus-eval', label: 'corpus-eval', baseUrl, model, apiKey, protocol }]
  }
  const secret = { read: async (): Promise<ProvidersConfig> => cfg } as unknown as SecretStore
  return new LlmService(secret)
}

/** 一篇样本的体检结果，按千字归一——不归一的话比的是篇幅不是结构 */
interface JudgeOutcome {
  name: string
  group: 'human' | 'ai'
  words: number
  findingsPerKiloWord: number
  byDimension: Record<string, number>
  /** 原始条目：报告要把人写组的误报逐条打出来，只给数量没法拿去改 prompt */
  findings: DeslopStructureFinding[]
  unparsedChunks: number
  chunks: number
}

describe('去 AI 味语料基线', () => {
  const rawHuman = loadGroup('human')
  const rawAi = loadGroup('ai')
  const enough = rawHuman.length >= MIN_PER_GROUP && rawAi.length >= MIN_PER_GROUP

  it('语料充足时报告分离度（不足则跳过）', async () => {
    if (!enough) {
      console.log(
        `\n[deslop-corpus] 跳过：human ${rawHuman.length} 篇 / ai ${rawAi.length} 篇，每组需要至少 ${MIN_PER_GROUP} 篇。\n` +
          `  往 ${CORPUS_DIR} 下的 human/ 和 ai/ 里放稿子后重跑。放什么、怎么配平见同目录 README.md。\n`
      )
      expect(enough).toBe(false)
      return
    }

    const svc = new DeslopService({} as unknown as LlmService)
    const samples: Sample[] = []
    for (const group of ['human', 'ai'] as const) {
      for (const { name, text } of group === 'human' ? rawHuman : rawAi) {
        const report = await svc.scan(text)
        samples.push({ name, group, words: countWords(text), metrics: report.metrics, level: report.level })
      }
    }

    const ai = samples.filter((s) => s.group === 'ai')
    const human = samples.filter((s) => s.group === 'human')

    const lines: string[] = []
    lines.push('')
    lines.push('══════ 去 AI 味语料基线报告 ══════')
    lines.push(`样本：人写 ${human.length} 篇 / AI ${ai.length} 篇`)

    const tooShort = samples.filter((s) => s.words < MIN_WORDS)
    if (tooShort.length > 0) {
      lines.push(
        `⚠️ ${tooShort.length} 篇不足 ${MIN_WORDS} 字，CV 指标多半取不到值，结论会偏：` +
          tooShort.map((s) => `${s.group}/${s.name}(${s.words}字)`).join('、')
      )
    }

    lines.push('')
    lines.push('── 单指标分离度（AUC 0.5=分不开 1.0=完美）──')
    for (const spec of METRICS) {
      const pick = (list: Sample[]): number[] =>
        list.map((s) => s.metrics[spec.key]).filter((v): v is number => typeof v === 'number')
      const aiVals = pick(ai)
      const humanVals = pick(human)
      const skipped = ai.length + human.length - aiVals.length - humanVals.length

      if (aiVals.length === 0 || humanVals.length === 0) {
        lines.push(`${padLabel(spec.label, 14)} 样本不足，跳过（${skipped} 篇取不到值）`)
        continue
      }

      const sign = spec.direction === 'low' ? -1 : 1
      const a = auc(
        aiVals.map((v) => v * sign),
        humanVals.map((v) => v * sign)
      )
      const verdict = a < 0.6 ? '没用，别参与判档' : a < 0.75 ? '有信号，只能当一票' : '够强，可单独当判据'
      const skipNote = skipped > 0 ? `（${skipped} 篇取不到值）` : ''
      lines.push(`${padLabel(spec.label, 14)} AUC ${a.toFixed(3)}  ${verdict}${skipNote}`)
      lines.push(`             AI   ${describeSpread(aiVals)}`)
      lines.push(`             人写 ${describeSpread(humanVals)}`)

      const best = bestThreshold(aiVals, humanVals, spec.direction)
      if (best) {
        const drift = spec.current !== undefined && Math.abs(best.threshold - spec.current) > 0.05
        const cmp = spec.current === undefined ? '' : `（当前 ${spec.current}${drift ? ' ← 建议改' : ' ✔ 基本对'}）`
        lines.push(
          `             推荐阈值 ${best.threshold.toFixed(3)}${cmp}  检出 ${pct(best.recall)} / 误伤 ${pct(best.falsePositive)}`
        )
      }
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThanOrEqual(1)
    }

    // 最终要看的是整体判档：单指标 AUC 再好，判档不准也没用
    const flagged = (s: Sample): boolean => s.level !== 'mild'
    const recall = ai.filter(flagged).length / ai.length
    const falsePositive = human.filter(flagged).length / human.length
    const levelTable = (list: Sample[]): string =>
      (['mild', 'moderate', 'severe'] as const)
        .map((l) => `${l} ${list.filter((s) => s.level === l).length}`)
        .join(' / ')

    lines.push('')
    lines.push('── classify 整体判档（判为非 mild = 判定有 AI 味）──')
    lines.push(`AI  ：${levelTable(ai)}   → 检出率 ${pct(recall)}`)
    lines.push(`人写：${levelTable(human)}   → 误伤率 ${pct(falsePositive)}`)
    lines.push(
      recall - falsePositive < 0.3
        ? '⚠️ 检出率减误伤率 < 0.3：当前判据基本没有区分力，别在这个基础上继续加规则。'
        : `区分力（检出 − 误伤）= ${(recall - falsePositive).toFixed(2)}`
    )
    lines.push(STRICT ? '模式：严格（不达标即失败）' : '模式：只报告（加 DESLOP_CORPUS_STRICT=1 可让它真的失败）')
    lines.push('══════════════════════════════════')
    lines.push('')
    console.log(lines.join('\n'))

    if (STRICT) {
      expect(recall).toBeGreaterThanOrEqual(STRICT_MIN_RECALL)
      expect(falsePositive).toBeLessThanOrEqual(STRICT_MAX_FALSE_POSITIVE)
    }
  })

  /**
   * 结构体检评测：判定器判得准不准，同样得有数才知道。
   * 判据是「人写的稿子应该比 AI 稿被报出更少的结构问题」——如果两组数量差不多，
   * 说明判定器在编，不能信。默认跳过，它要真调 LLM。
   */
  it(
    '结构体检判定器的区分力（需 DESLOP_JUDGE_EVAL=1 + provider 环境变量）',
    async () => {
      if (!JUDGE_EVAL) {
        console.log(
          '\n[deslop-corpus] 结构体检评测已跳过（默认关，它会真调 LLM 花钱）。' +
            '开启方式见 tests/fixtures/deslop-corpus/README.md。\n'
        )
        return
      }
      if (!enough) {
        console.log(`
[deslop-corpus] 结构体检评测跳过：语料不足（每组需要至少 ${MIN_PER_GROUP} 篇）。\n`)
        return
      }
      const llm = evalLlmFromEnv()
      if (!llm) {
        console.log(
          '\n[deslop-corpus] 结构体检评测跳过：缺 provider 配置。' +
            'HTTP 协议至少要设 DESLOP_EVAL_BASE_URL 和 DESLOP_EVAL_MODEL；' +
            'CLI 协议（codex/claude/grok/antigravity）只需 DESLOP_EVAL_PROTOCOL。见 README。\n'
        )
        return
      }

      const svc = new DeslopService(llm)
      const total = rawHuman.length + rawAi.length
      console.log(`
[deslop-corpus] 开始结构体检评测：${total} 篇，每篇至少 1 次 LLM 调用。长文会按块拆得更多。\n`)

      const outcomes: JudgeOutcome[] = []
      for (const group of ['human', 'ai'] as const) {
        for (const { name, text } of group === 'human' ? rawHuman : rawAi) {
          const report = await svc.judgeStructure(text)
          const words = countWords(text)
          const byDimension: Record<string, number> = {}
          for (const f of report.findings) byDimension[f.dimension] = (byDimension[f.dimension] ?? 0) + 1
          outcomes.push({
            name,
            group,
            words,
            findingsPerKiloWord: words > 0 ? (report.findings.length / words) * 1000 : 0,
            byDimension,
            findings: report.findings,
            unparsedChunks: report.unparsedChunks,
            chunks: report.chunks
          })
        }
      }

      const ai = outcomes.filter((o) => o.group === 'ai')
      const human = outcomes.filter((o) => o.group === 'human')
      const lines: string[] = []
      lines.push('')
      lines.push('══════ 结构体检判定器评测 ══════')

      const unparsed = outcomes.reduce((n, o) => n + o.unparsedChunks, 0)
      const chunks = outcomes.reduce((n, o) => n + o.chunks, 0)
      if (unparsed > 0) {
        lines.push(
          `⚠️ ${chunks} 块里 ${unparsed} 块没解析出 JSON（${pct(unparsed / chunks)}）。` +
            '比例高说明这个模型撑不住结构化输出，下面的数都要打折看。'
        )
      }

      const aiRate = ai.map((o) => o.findingsPerKiloWord)
      const humanRate = human.map((o) => o.findingsPerKiloWord)
      const overall = auc(aiRate, humanRate)
      lines.push('')
      lines.push('── 总体：每千字报出的结构问题数 ──')
      lines.push(`AI   ${describeSpread(aiRate)}`)
      lines.push(`人写 ${describeSpread(humanRate)}`)
      lines.push(
        `AUC ${overall.toFixed(3)}  ` +
          (overall < 0.6
            ? '⚠️ 判定器分不开两组 —— 它在编，别信它的清单'
            : overall < 0.75
              ? '有区分力，但清单里会混进不少误报'
              : '判定器可信')
      )

      lines.push('')
      lines.push('── 分维度（哪几条真的有判别力）──')
      for (const d of STRUCTURE_DIMENSIONS) {
        const rate = (o: JudgeOutcome): number =>
          o.words > 0 ? ((o.byDimension[d.id] ?? 0) / o.words) * 1000 : 0
        const a = auc(ai.map(rate), human.map(rate))
        const aiHits = ai.reduce((n, o) => n + (o.byDimension[d.id] ?? 0), 0)
        const humanHits = human.reduce((n, o) => n + (o.byDimension[d.id] ?? 0), 0)
        const note =
          aiHits + humanHits === 0
            ? '两组都没报过 —— 这一维等于没生效，检查 prompt'
            : a < 0.6
              ? '没区分力，考虑从 prompt 里拿掉'
              : a < 0.75
                ? '有信号'
                : '强'
        lines.push(`${padLabel(d.name, 20)} AUC ${a.toFixed(3)}  AI ${aiHits} 条 / 人写 ${humanHits} 条  ${note}`)
      }

      // 稀疏是这类判定器的常态：条数少的时候 AUC 全靠个别样本撑，必须把绝对量摆出来
      const aiTotal = ai.reduce((n, o) => n + o.findings.length, 0)
      const humanTotal = human.reduce((n, o) => n + o.findings.length, 0)
      const silent = outcomes.filter((o) => o.findings.length === 0).length
      lines.push('')
      lines.push('── 信号强度（AUC 好看但条数少 = 结论建立在个别样本上）──')
      lines.push(
        `总条数：AI ${aiTotal} 条 / 人写 ${humanTotal} 条    一条没报的样本：${silent}/${outcomes.length}`
      )
      if (aiTotal + humanTotal < outcomes.length) {
        lines.push('⚠️ 平均每篇不到 1 条：判定器过于保守，AUC 再高也撑不住，先放宽 prompt 再谈阈值。')
      }

      const fp = human.flatMap((o) => o.findings.map((f) => ({ o, f })))
      if (fp.length > 0) {
        lines.push('')
        lines.push(`── 人写组被报出的 ${fp.length} 条（= 判定器的误报样本，改 prompt 时当反例）──`)
        for (const { o, f } of fp.slice(0, 20)) {
          lines.push(`[${f.dimension}] ${o.name} 第${f.line}行  ${f.excerpt}`)
          lines.push(`   why: ${f.why}`)
        }
      }

      const tp = ai.flatMap((o) => o.findings.map((f) => ({ o, f })))
      if (tp.length > 0) {
        lines.push('')
        lines.push(`── AI 组被报出的 ${tp.length} 条（= 真阳性，看它抓的是不是真问题）──`)
        for (const { o, f } of tp.slice(0, 20)) {
          lines.push(`[${f.dimension}] ${o.name} 第${f.line}行  ${f.excerpt}`)
          lines.push(`   why: ${f.why}`)
        }
      }
      lines.push('══════════════════════════════════')
      lines.push('')
      console.log(lines.join('\n'))

      expect(overall).toBeGreaterThanOrEqual(0)
      expect(overall).toBeLessThanOrEqual(1)
    },
    JUDGE_EVAL_TIMEOUT_MS
  )
})
