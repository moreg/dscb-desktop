/**
 * 去 AI 味方法论 + 7 Gate prompt 构建（源自 oh-story-claudecode anti-ai-writing.md + SKILL.md）。
 *
 * 核心原则：
 * - 改味优先，不当改错；改最少字，效果最大
 * - 保留创作意图（只改"怎么说"不改"说什么"）
 * - 删除比例上限：轻度 ≤15% / 中度 ≤25% / 重度 ≤35%
 *
 * 7 个 Gate（按命中的 Gate 逐项改写，不全篇跑）：
 * - A 禁用词替换（情态/动作/表情/心理/判断/形容/过渡类）
 * - B 句式去套路（"不是A而是B"最毒 + 万能状语 + 排比）
 * - C 心理描写外化 + 重复描写去重（Show Don't Tell）
 * - D 节奏打碎（碎句号合并 + 长段落断段 + 破折号按功能改）
 * - E 对话去腔调（对话标签多样化 + 角色语气区分）
 * - F 结尾去升华（删"这一刻/他终于明白"类总结句）
 * - G 去解释腔/上帝视角/安排感（删非故事性的作者旁白，不删情节）
 *
 * 保护规则：保留创作意图与剧情功能 > 去 AI Gate。任何 Gate 都不能删伏笔/钩子/角色特征/关键信息。
 */

import type { DeslopFinding, DeslopLevel, DeslopStyleContext } from '../../../../shared/types'
import { resolveGenreVoice } from '../genre-voice'

/** 去 AI 味改写、复扫清理和单段降级改写共用的表达原则。 */
export const DESLOP_PLAIN_WRITING_RULES = `
【直白表达与描写节制】

- 写作要直白，用符合题材和人物身份的常用词把事情说清楚，文笔为剧情服务，不为显得有文采增加描写。
- 本次需要处理的文字中，删去后不影响信息、人物、关系、情绪体验或后续行动的描述，应直接删减；无必要的动作、环境铺陈、修饰和反复情绪解释也是 AI 味与水文的表现，不只是特定词语才需要处理。
- 动作有必要才写。对话已表达清楚、说话人也能辨认时直接接续；放碗、抬头、看一眼等动作按具体用途判断，不按固定间隔增删，不给每句台词配动作。
- 能删就删，不换成另一个小动作或更长的描述占位；允许直白表达必要的想法与情绪，不把心理一律改成肢体反应。保留关键行动、因果、伏笔和人物特点，不凭空新增事实，也不为简洁跳过必要过程。
`.trim()

export const DESLOP_SYSTEM_PROMPT = `你是一名专业的中文小说文字编辑，专门去除 AI 写作痕迹，让文字回归自然。这叫"改味"——改最少字，效果最大。

${DESLOP_PLAIN_WRITING_RULES}

铁律：
0. **语言锁定（最高优先级）**：原文是中文就必须输出中文。禁止翻译、禁止把汉字改成英文单词或拼音句子。严禁「他→He / 她→She / 我→I」、严禁把中文对话/旁白整句英译（如「直接说吧」→「Just say it」）。原文里本来没有的英文专名、英文句子一律不得新增。改味 ≠ 翻译。
1. **改味优先，不当改错**：只改"怎么说"（表达方式），不改"说什么"（情节/人设/信息）。不得凭空添加原文没有的具体时间、道具、动机、事件或结论，也不得借改写搬用其他作品的桥段、独特设定或标志性台词。遇到事实或逻辑疑点，在改动说明里提出，不靠编造信息修补。
2. **保留创作意图**：不能删除伏笔、钩子、角色特征、关键信息或必要转折。遇到冲突改为降 AI 重写或标注 [需复核]。
3. **删除比例上限**：轻度 ≤15% / 中度 ≤25% / 重度 ≤35%。超过时分段输出并标记，不得整段删除。
4. **替换语感对齐项目**：若本次提供了题材/文风（见下方"风格语境"段），替换词和句式必须符合该题材与文风；未提供时按通则：都市口语化、玄幻可稍文雅、悬疑克制留白。哪些题材虚词可以保留，以"风格语境"段列出的清单为准（该清单优先于铁律 10 的通用禁用清单）；保留时须在改动说明里写明原因。
5. **Show Don't Tell 按需使用**：需要呈现人物反应时，可用原文已有的行动、对白和可见细节；意思与情绪已经表达清楚时删去重复解释即可。允许直白写清必要的判断、打算和情绪，不把所有心理描写都改成动作、停顿或身体反应。
6. **自然、克制、有生活质感**：请以自然、克制、有生活质感的中文进行创作，避免使用模板化、泛滥的“AI味”描写和情绪填充词。不要频繁使用“顿了顿、停了停、愣了愣、怔了怔、抿了抿唇、深吸一口气、眸色一暗、嘴角勾起一抹弧度、心头一震、眼底闪过一丝”等套路表达——偶尔一处且情境贴切可以保留，成段滥用必须替换。
7. **不要为了表现情绪而机械插入动作**：先判断动作是否有必要，对白本身已经承担信息与情绪时直接接续。放碗、放杯子、抬头、看向窗外等日常动作若没有叙事用途就省略，不把“顿了顿”换成另一种随手动作。必要的行为、人物选择与反应可以保留，避免“动作＋说话”的死板单一结构，不要求每句台词前后都有动作。
8. **语言直白、简洁、准确**：用常用词把事情说清楚，避免过度修辞、空泛抒情和重复强调。过多没有必要的动作、环境、心理和修饰描述本身也是 AI 味，应按叙事用途删减。禁止为了篇幅重复堆砌、机械扩写、拆解无关动作或增加无效铺陈。保留有用途的情绪消化、关系建立、氛围与留白，不要求每段都推进主线；若删去后不影响信息、人物、关系、情绪体验或后续行动，就应删减。不得把一句简短观察扩成缺乏新增价值的长描写。
9. **标点规范与排版规范**：正文禁用破折号 ——/—、双连字符 --、省略号停顿 ……；改用句号、逗号、短句或动作断句。**台词中间严禁使用句号**：角色同一次说话中间不要用句号断句（如 ❌ “先生既然肯留下，委任今天就能签。名头先挂顾问，不领实职。军需那边管吃住，出门用车也方便。”），保持口语连贯语流，中间一律用逗号连接，整段台词只在末尾使用一个句号（✅ “先生既然肯留下，委任今天就能签，名头先挂顾问，不领实职，军需那边管吃住，出门用车也方便。”）。**正文叙述段严格单句成段**：除对话外，正文叙述一个段落只有一句话（遇句号强制换行分段），严禁在同一自然段内拼凑两个及以上句号。长句内部用逗号一气呵成，短句单独成段。
10. **改写输出自身不得引入新的 AI 味**：你在改味时禁止把一种 AI 套路换成另一种 AI 套路。改写后不得出现以下高频 AI 表达：
   - 情态比喻：仿佛 / 犹如 / 宛若 / 如同 / 一丝 / 一抹 / 些许 / 几分 / 隐约
   - 程度副词堆叠：缓缓 / 微微 / 轻轻 / 淡淡 / 不禁 / 不由得 / 不由自主 / 情不自禁
   - 表情/动作套路：眼中闪过一丝X / 嘴角勾起一抹X / 嘴角勾起一抹弧度 / 眸色一暗 / 眼底闪过一丝 / 抿了抿唇 / 顿了顿 / 停了停 / 愣了愣 / 怔了怔 / 顿了一下 / 停了一下 / 愣了一下 / 怔了一下 / 呆了一下 / 僵了一下 / 颤了一下 / 揪了一下 / 抽动了两下 / 眉头微皱 / 眉眼低垂 / 瞳孔微缩
   - 道具停止式反应节拍：手里的X停了 / 他的手停了 / 手中的动作停住 / 手停在半空 / 他的手一顿（用"停止"这个结果词代替具体反应，信息量为零）
   - 心理外露：心中涌起/升起/泛起/一动 / 心头一震 / 心下暗道 / 心底泛起 / 深吸一口气
   - 判断/过渡词：不容置疑 / 显而易见 / 毫无疑问 / 不可否认 / 不易察觉 / 自然而然
   - 句式套路："不是A，而是B" / "，带着一丝X" / "声音不大，却带着X的力量" / "声音不大。xxx听见了。"（刻意听觉反差摆拍） / "看似……实则……" / "殊不知/岂料" / "取而代之的是" / "想也不想/毫不犹豫" / "他/她知道……" / 章末"他不知道的是……" / 发声器官解构与情绪解说腔（"声音发紧" / "喉头发紧" / "话音发紧" / "声音从牙缝/喉咙里挤出来" / "话音从嗓子里挤出来" / "自己听着都陌生"等） / 机械双联报表句（如“动作A+反馈A。动作B+反馈B。”） / 严禁通过同义平替（将"顿了顿"偷换为"顿了一下/愣了一下/身子僵了一下/抽了两下"）规避审查，单章严格控制动量词（X了X / X了一下 / X了两下）总量（≤2次）
   - 升华句式：这一刻，他终于明白 / 这就是X的意义
   替换思路：先删去无用的修饰、动作和重复解释；有必要保留的信息用直白表达或原文已有的行动、对白、可见细节呈现，不为替换禁词补造小动作。改写后若仍含上述表达，视为未完成改味，须再次降 AI 直至干净。
   唯一例外：本次任务"风格语境"段若明确列出了该题材允许保留的虚词，那几个词不受本条约束（但仍需克制，同一段不得重复出现）。除该清单外，本条一律生效。
11. **三条替换通路**（处理不同对象的 AI 味，按情况选其一）：
   先判断是否需要保留这层信息，冗余内容直接删去；以下通路只整理原文已有事实，不要求增添动作、感官细节或变化过程。
   - 抽象→具体：需要表现情绪时用原文已有的行为或对白；必要的情绪也可直说，已有表达时不再补一个身体反应
   - 静态描述→可观察变化：已有变化影响当前行动时可写清变化；普通环境信息可以简写或省略，不凭空增加天气、灯光等细节
   - 作者总结→角色感知：有必要保留的信息改成角色当时可知的直白叙述或已有感知，不为去解释腔新增感官描写
12. **避免机械均匀，保留叙事完整**：根据原文重心安排句式与信息密度（该略处一笔带过，该重处保留过程），不要为了显得自然故意打乱结构、截断因果、改变人物可知信息或制造认知偏差。场景中的行动条件、人物选择、阻力与代价必须保留，不能用表面句式变化掩盖情节原地踏步。

下面是 7 道 Gate 的改写方法，你只处理命中项，其余保持原样。

注意：原文以「行号|正文」格式给出，仅供你在【改动说明】里引用行号；【改写后】段输出纯净正文，不得带行号前缀。`

/**
 * 分级 → 处理的 Gate 范围（总范围）。
 * 与 passesForLevel 正交：gatesForLevel 决定「总处理范围」，passesForLevel 决定「分几遍跑」。
 *
 * 三遍法（passesForLevel）按 Gate 递进：
 * - Pass 1：Gate A + B（去表面 AI 味--禁用词、句式套路、排比）
 * - Pass 2：Gate C + D + E（深化叙事--心理外化、节奏打碎、对话腔调）
 * - Pass 3：Gate F + G（收尾--结尾去升华、去解释腔/上帝视角）
 *
 * mild 只跑 Pass1（Gate A+B）/ moderate 跑 Pass1+2（A+B+C+D）/ severe 跑全部三遍。
 */
export function gatesForLevel(level: DeslopLevel): string[] {
  switch (level) {
    case 'mild':
      return ['A', 'B'] // Pass 1
    case 'moderate':
      return ['A', 'B', 'C', 'D'] // Pass 1 + Pass 2 的 C/D（E/F/G 留给 severe）
    case 'severe':
      return ['A', 'B', 'C', 'D', 'E', 'F', 'G'] // 全 Pass
  }
}

/**
 * 三遍法映射：每遍处理哪些 Gate。
 * 与 gatesForLevel 正交——实际每遍处理的 Gate = passGates ∩ gatesForLevel(level)。
 * - mild 只跑 Pass1 / moderate 跑 Pass1+2 / severe 跑 Pass1+2+3
 */
export const PASS_GATE_MAP: Record<number, string[]> = {
  1: ['A', 'B'],
  2: ['C', 'D', 'E'],
  3: ['F', 'G']
}

/** 三遍法映射（轻度只 Pass1 / 中度 Pass1+2 / 重度 Pass1+2+3） */
export function passesForLevel(level: DeslopLevel): number[] {
  switch (level) {
    case 'mild':
      return [1]
    case 'moderate':
      return [1, 2]
    case 'severe':
      return [1, 2, 3]
  }
}

/** Gate 的固定顺序（用于把集合还原成稳定顺序的数组） */
const GATE_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G']

/**
 * 通用「原句 → 改后句」成对示例（无题材档案时注入，与题材无关）。
 * 只下禁令不给示范时，模型只能凭先验补全——而模型的先验恰恰就是 AI 味本身。
 * 有题材档案时用该题材的 replacements（GenreVoice）替换本表。
 */
const GENERIC_REPLACEMENTS: readonly [string, string][] = [
  ['他眼中闪过一丝不易察觉的失望', '他垂下眼，没接话'],
  ['她嘴角勾起一抹意味深长的弧度', '她笑了笑，没解释'],
  ['他心中涌起一股莫名的烦躁', '他把手机扣在桌上'],
  ['她不是生气，而是失望透顶', '她是失望透顶'],
  ['他的声音不大，却带着不容置疑的力量', '他说得很轻。没人再开口'],
  ['声音不大。陆沉听见了。', '陆沉转过头，视线落在他脸上。'],
  ['“先生既然肯留下，委任今天就能签。名头先挂顾问，不领实职。军需那边管吃住，出门用车也方便。”', '“先生既然肯留下，委任今天就能签，名头先挂顾问，不领实职，军需那边管吃住，出门用车也方便。”'],
  ['她感到一阵失落', '她盯着屏幕看了很久，回了一个"好"'],
  ['他缓缓站起身，微微皱眉', '他站起来，眉头皱着'],
  ['这一刻，他终于明白了她的用意', '（整句删，让读者自己体会）'],
  ['他知道，她不会回来了', '门再没响过'],
  ['空气仿佛凝固了一般', '谁都没说话']
]

/**
 * 把分级 Gate 范围扩展到「覆盖所有命中的 Gate」（不分 blocking / advisory）。
 *
 * 分级决定"改多狠"（删除比例上限），不决定"哪些问题配被修"。
 * 若不扩展：只含章末升华（Gate F）或工程词泄漏（Gate G）的正文会被判为 mild → 范围只有 A/B →
 * 一次 LLM 都不调，正文原样返回，末尾却报"复扫后仍剩 N 处 blocking"，用户点了润色等于没点；
 * 对话标签单一化（Gate E，只产 advisory）则会一直躺在扫描面板里没人管。
 *
 * 没有命中的 Gate 在 Pass 循环里本来就会跳过，所以扩展不会凭空多调 LLM。
 *
 * @param baseGates gatesForLevel(level) 的结果
 * @param hitGates 扫描结果里所有 finding 所在的 Gate
 */
export function expandGatesForFindings(
  baseGates: string[],
  hitGates: Iterable<string>
): string[] {
  const set = new Set([...baseGates, ...hitGates])
  return GATE_ORDER.filter((g) => set.has(g))
}

/** 给定 Gate 范围，返回需要跑的 Pass 序号（该 Pass 的 Gate 与范围有交集才跑） */
export function passesForGates(gates: string[]): number[] {
  return Object.keys(PASS_GATE_MAP)
    .map(Number)
    .sort((a, b) => a - b)
    .filter((p) => PASS_GATE_MAP[p].some((g) => gates.includes(g)))
}

/**
 * 改写后禁止重新引入的高频 AI 表达（铁律 10 的浓缩版，注入每次改写 prompt）。
 * 与题材允许清单（GenreVoice.allowedHedges）求差后渲染，避免"允许保留 X"与"不得出现 X"自相矛盾。
 */
const REINTRODUCTION_BAN_LIST = [
  '仿佛', '犹如', '宛若', '一丝', '一抹', '缓缓', '微微', '轻轻', '淡淡',
  '不禁', '不由得', '眼中闪过', '嘴角勾起', '心中涌起', '深吸一口气',
  '不是A而是B', '，带着一丝X', '这一刻他终于明白'
]

/** 取该题材允许保留的虚词集合（无题材/无档案时为空集） */
function allowedHedgesFor(styleContext?: DeslopStyleContext): Set<string> {
  const genre = styleContext?.genre
  if (!genre || genre === '通用') return new Set()
  return new Set(resolveGenreVoice(genre).allowedHedges ?? [])
}

/** 渲染「改写后不得引入新 AI 味」这一条，题材允许保留的虚词从清单中剔除 */
function buildReintroductionBanLine(styleContext?: DeslopStyleContext): string {
  const allowed = allowedHedgesFor(styleContext)
  const words = REINTRODUCTION_BAN_LIST.filter((w) => !allowed.has(w))
  const exception =
    allowed.size > 0
      ? `本清单已剔除本题材允许保留的虚词（${Array.from(allowed).join('、')}），那几个词可按"风格语境"段的许可克制使用。`
      : ''
  return `- **改写后不得引入新的 AI 味**：禁止用另一种 AI 套路替换原套路。改写后不得出现"${words.join('/')}"等高频 AI 表达。${exception}改后仍含上述表达视为未完成，须再次降 AI 直至干净。`
}

/** buildDeslopPrompt / buildCleanupPrompt 的可选项：用户配置的 Gate 方法覆盖 + 禁用词表 */
export interface DeslopPromptOverrides {
  /** 用户覆盖的 Gate 方法文本（key = Gate 字母，如 'A'）；缺 key = 用 GATE_METHODS 默认 */
  textOverrides?: Partial<Record<string, string>>
  /** 用户配置的禁用词表（注入 prompt，让 LLM 改写时规避）；缺省 = 不额外注入 */
  bannedWords?: string[]
  /**
   * 结构均匀度提示（describeUniformity 的输出）。这类问题是整篇的分布特征，
   * 没有行号可挂，所以不走 finding 列表，单独作为一段全局要求注入。
   */
  uniformityNote?: string
}

/**
 * 构建改写 prompt（Phase 3，逐 Gate 改写）。
 * 只把命中的 Gate 说明 + 命中的 finding 注入，不全篇跑。
 * styleContext 注入项目题材与文风档案，让 LLM 替换语感对齐项目而非套通用模板。
 * textOverrides/bannedWords 注入用户在设置里编辑过的 Gate 方法和禁用词表。
 */
export function buildDeslopPrompt(
  text: string,
  level: DeslopLevel,
  findings: DeslopFinding[],
  gatesToProcess: string[],
  styleContext?: DeslopStyleContext,
  overrides?: DeslopPromptOverrides
): string {
  const maxDeleteRatio = level === 'mild' ? 0.15 : level === 'moderate' ? 0.25 : 0.35

  // 按命中 Gate 分组 finding
  const findingsByGate = new Map<string, DeslopFinding[]>()
  for (const f of findings) {
    if (!gatesToProcess.includes(f.gate)) continue
    const list = findingsByGate.get(f.gate) ?? []
    list.push(f)
    findingsByGate.set(f.gate, list)
  }

  const gateDescriptions = gatesToProcess
    .map((g) => overrides?.textOverrides?.[g] ?? GATE_METHODS[g])
    .join('\n\n')

  const findingSummary = gatesToProcess
    .map((g) => {
      const list = findingsByGate.get(g) ?? []
      if (list.length === 0) return ''
      // 命中项全部列出（上限 30 防超长）：截断到 8 条时模型只改看到的，漏改的成了"改了个寂寞"
      const samples = list
        .slice(0, 30)
        .map((f) => `  - 第${f.line}行: ${f.excerpt}`)
        .join('\n')
      const overflow = list.length > 30 ? `\n  …另 ${list.length - 30} 处同类问题，按同一 Gate 方法一并处理` : ''
      return `### Gate ${g} 命中项（${list.length} 处，须逐条处理）\n${samples}${overflow}`
    })
    .filter(Boolean)
    .join('\n\n')

  const styleSection = buildStyleSection(styleContext)
  const bannedWordsSection = buildBannedWordsSection(overrides?.bannedWords)
  const uniformitySection = overrides?.uniformityNote
    ? `### 全篇节奏（结构均匀度告警）
本篇实测：${overrides.uniformityNote}。
这不是某一行的问题，是整篇排得太齐——AI 稿最稳定的特征。改写时在不动情节的前提下拉开落差：
- 该短的短到底：把一句话单独成段，把「嗯。」「不知道。」这类应答留成一句
- 该长的别切碎：连续动作可以合成一个长句，不要每个动作都断成一句
- 不要每段都收束：允许一段停在半途，下一段接着说
注意：这是节奏要求，不是让你增删情节，删除比例上限照旧。

`
    : ''

  return `## 任务：去 AI 味改写（${LEVEL_NAMES[level]}，删除比例上限 ${Math.round(maxDeleteRatio * 100)}%）

### 改写原则
- **语言锁定**：全文保持中文。禁止英译、禁止「他→He」等中英混写替换；改味不是翻译
- 只改"怎么说"，不改"说什么"
- 命中的 Gate 逐项改写；未命中的段落必须与原文逐字一致——不要因为"顺手"重写没毛病的句子，那样会把个人风格磨平
- 删除比例不得超过 ${Math.round(maxDeleteRatio * 100)}%；超时分段输出标记 [需复核]，不得整段删
- 保留伏笔/钩子/角色特征/关键信息/必要转折
- 替换语感必须对齐下方"风格语境"段；该段若列出了允许保留的虚词，以那份清单为准，保留时在改动说明里写明原因
${buildReintroductionBanLine(styleContext)}

${DESLOP_PLAIN_WRITING_RULES}

${styleSection}
${bannedWordsSection}${uniformitySection}### 本次处理的 Gate 及改写方法
${gateDescriptions}

${findingSummary || '（无具体命中项，按 Gate 通则整体降 AI）'}

### 输出格式（严格按此结构）

【改写后】
（完整改写后的正文；改写处自然段之间用空行分隔，对话独立成段，无破折号/省略号；未命中部分保留原文排版，不为统一格式改动无关段落）

【改动说明】
逐条说明每一处改动，每条四要素，禁止写"Gate A 改了 N 处"这种统计句：
- 第N行｜原句：… → 改后：… ｜理由：（一句话，说清为什么这处要改、为什么这样改，结合上下文而非套通则）
- 第N行｜原句：… → 改后：… ｜理由：…

要求：
- 一处改动一条，不要把多处合并成一条
- 行号对应【待改写原文】的行号（从 1 开始）
- "理由"必须指向这一处的具体上下文（情节/语感/角色/节奏），不得照搬 Gate 通则原话（如"出现即替换为具体动作/白描"）
- 未改动的 Gate 也不要写；如果某 Gate 命中但整体未改，说明原因

### 待改写原文（带行号，【改动说明】里的行号以此为准）
${numberLines(text)}

只输出【改写后】和【改动说明】两段，不要解释。`
}

/**
 * 构建二次清理 prompt（Phase 3.6，复扫后对剩余 blocking finding 再改一轮）。
 *
 * 与 buildDeslopPrompt 的区别：
 * - 明确告知 LLM 这是第 N 轮清理，原文已改过一轮
 * - 只处理复扫后的剩余 blocking，不重新通篇改写
 * - 强调未命中部分必须与原文逐字一致，防止过度改写
 */
export function buildCleanupPrompt(
  text: string,
  level: DeslopLevel,
  remainingFindings: DeslopFinding[],
  round: number,
  styleContext?: DeslopStyleContext,
  overrides?: DeslopPromptOverrides
): string {
  const maxDeleteRatio = level === 'mild' ? 0.15 : level === 'moderate' ? 0.25 : 0.35
  const gatesTouched = Array.from(new Set(remainingFindings.map((f) => f.gate)))
  const gateDescriptions = gatesTouched
    .map((g) => overrides?.textOverrides?.[g] ?? GATE_METHODS[g])
    .join('\n\n')
  const findingSummary = remainingFindings
    .slice(0, 12)
    .map((f) => `  - 第${f.line}行 [${f.gate}/${f.type}]: ${f.excerpt}`)
    .join('\n')
  const styleSection = buildStyleSection(styleContext)
  const bannedWordsSection = buildBannedWordsSection(overrides?.bannedWords)

  return `## 任务：二次清理（第 ${round} 轮，删除比例上限 ${Math.round(maxDeleteRatio * 100)}%）

这是上一轮去 AI 味改写后的复扫结果。原文已改过一轮，但仍有 ${remainingFindings.length} 处 AI 味残留。**只改这些残留项，其余已经改好的部分保持原样不动**，不要重新通篇改写。

### 改写原则
- **语言锁定**：保持中文，禁止把中文改成英文或「他→He」类替换
- 只改下方命中的残留 finding，未命中部分必须与原文逐字一致，不得改动
${buildReintroductionBanLine(styleContext)}
- 保留伏笔/钩子/角色特征/关键信息/必要转折
- 替换语感对齐下方"风格语境"段

${DESLOP_PLAIN_WRITING_RULES}

${styleSection}
${bannedWordsSection}
### 本次需处理的 Gate 及方法
${gateDescriptions || '（无具体 Gate 说明，按通则降 AI）'}

### 残留 finding（${remainingFindings.length} 处，逐项改写）
${findingSummary}

### 输出格式（严格按此结构）

【改写后】
（完整改写后的正文；改写处自然段之间用空行分隔，对话独立成段，无破折号/省略号。未命中部分含排版必须与原文逐字一致。）

【改动说明】
逐条说明每一处改动，每条四要素：
- 第N行｜原句：… → 改后：… ｜理由：（一句话，说清为什么这处要改、为什么这样改）

### 待改写原文（带行号，【改动说明】里的行号以此为准）
${numberLines(text)}

只输出【改写后】和【改动说明】两段，不要解释。`
}

/** 把风格语境渲染成 prompt 段落；无任何信息时返回占位说明 */
function buildStyleSection(styleContext?: DeslopStyleContext): string {
  const hasGenre = styleContext?.genre && styleContext.genre !== '通用'
  const s = styleContext?.style
  const hasStyle =
    s && (
      (s.identifiedStyle?.trim()) ||
      (s.tone?.length && s.tone.length > 0) ||
      (s.sentencePatterns?.length && s.sentencePatterns.length > 0) ||
      (s.vocabularyPreferences?.length && s.vocabularyPreferences.length > 0) ||
      (s.styleConstraints?.length && s.styleConstraints.length > 0) ||
      (s.plotConstraints?.length && s.plotConstraints.length > 0)
    )

  if (!hasGenre && !hasStyle) {
    return [
      '### 风格语境',
      '（未提供项目题材与文风档案，按通则处理：都市口语化、玄幻可稍文雅、悬疑克制留白）',
      renderReplacementsBlock(GENERIC_REPLACEMENTS)
    ].join('\n')
  }

  const lines: string[] = ['### 风格语境（替换语感必须对齐本段；与之相符的词可保留）']
  let genreReplacements: readonly [string, string][] | undefined
  if (hasGenre) {
    lines.push(`- 题材：${styleContext!.genre}`)
    // 解析题材对应的语感档案，注入语气词和替换示例，让改写对齐题材而非套通用模板
    const voice = resolveGenreVoice(styleContext!.genre)
    if (voice.allowedHedges?.length) {
      lines.push(
        `- 该题材允许保留的虚词（不受"改写后不得引入新 AI 味"清单约束，但仍需克制：同一段不得重复出现，能删则删）：${voice.allowedHedges.join('、')}`
      )
    }
    if (voice.suggestedParticles?.length) {
      lines.push(`- 建议主动使用的题材语气词（替换现代通腔）：${voice.suggestedParticles.join('、')}`)
    }
    genreReplacements = voice.replacements
  }
  if (s?.identifiedStyle?.trim()) lines.push(`- 文风标识：${s.identifiedStyle}`)
  if (s?.tone?.length) lines.push(`- 语感/语气：${s.tone.join('；')}`)
  if (s?.sentencePatterns?.length) lines.push(`- 句式偏好：${s.sentencePatterns.join('；')}`)
  if (s?.vocabularyPreferences?.length) lines.push(`- 词汇偏好：${s.vocabularyPreferences.join('；')}`)
  if (s?.styleConstraints?.length) lines.push(`- 写作手法约束：${s.styleConstraints.join('；')}`)
  if (s?.plotConstraints?.length) lines.push(`- 剧情/题材约束：${s.plotConstraints.join('；')}`)
  // 成对示例优先用题材档案的（语感对齐）；题材未匹配到档案时退回通用表
  lines.push(renderReplacementsBlock(genreReplacements?.length ? genreReplacements : GENERIC_REPLACEMENTS))
  return lines.join('\n')
}

/** 把「原句 → 改后句」成对示例渲染成 prompt 段（改味的正锚点，比禁令清单有效） */
function renderReplacementsBlock(replacements: readonly [string, string][]): string {
  const rows = replacements
    .slice(0, 15)
    .map(([from, to]) => `  - "${from}" → "${to}"`)
    .join('\n')
  return `- 替换示例（左 AI 味 → 右自然，仅作语感参照）：示例中的动作和细节不代表本作事实，不照搬，不凭空新增；原文意思已清楚时优先删去冗余描述，不另补动作。\n${rows}`
}

/**
 * 把用户配置的禁用词表渲染成 prompt 段落。
 * 无配置（undefined）时返回空串——让系统 prompt 里的铁律 7 内置清单接管。
 * 用户显式配置（含空数组）时，注入"本项目禁用词清单"，让 LLM 改写时规避。
 */
function buildBannedWordsSection(bannedWords?: string[]): string {
  if (!bannedWords || bannedWords.length === 0) return ''
  const words = bannedWords.slice(0, 200).join('、')
  return `### 本项目禁用词清单（改写时一并规避，冗余则删除，必要信息用直白表达保留，不强行补动作）
${words}

`
}

const LEVEL_NAMES: Record<DeslopLevel, string> = {
  mild: '轻度',
  moderate: '中度',
  severe: '重度'
}

/** 7 个 Gate 的改写方法（注入 prompt） */
export const GATE_METHODS: Record<string, string> = {
  A: `**Gate A：禁用词替换**
先判断命中词所在描述是否有叙事用途，冗余就直接删除；需要保留的信息用直白表达或原文已有的行为、对白呈现，不强行改成动作。常见处理：
- "仿佛/犹如/宛若" → 删掉或直接描述
- "缓缓/微微/轻轻/淡淡" → 删（多余修饰）
- "眼中闪过一丝X / 眼底闪过一丝" → "他垂下眼" / "他笑了一下，没到眼底" / 直接移开视线（避免套路）
- "嘴角勾起一抹X / 嘴角勾起一抹弧度" → 具体生活化动作，或直接删除
- "心中涌起一股X / 心头一震" → 必要情绪可直说，已有对白或行为表达时删去；不凭空新增攥手、呼吸等身体反应
- "深吸一口气" → 删或换具体呼吸描写
- "不容置疑/显而易见" → 删（判断词）
- "顿了顿 / 停了停 / 愣了愣 / 怔了怔" → 没有必要就省略，让对白直接接续；只有原文已有且确有用途的行动才保留，不换成放杯子、抬头等另一个小动作
- "手里的X停了 / 他的手停了 / 手停在半空 / 手一顿" → 若删掉这句不损失任何信息，直接删；确有失误或动作变化时只写原文已有事实，不凭空编造失误或速率变化
- "抿了抿唇 / 眸色一暗" → 替换为自然、克制、有生活质感的中文，或直接删除

成对示例（只参照表达幅度，动作须有原文依据和叙事用途，否则删去冗余，不照搬示例事实）：
- ❌ "他眼中闪过一丝不易察觉的失望" → ✓ "他垂下眼，没接话"
- ❌ "她嘴角勾起一抹意味深长的弧度" → ✓ "她笑了笑，没解释"
- ❌ "心中涌起一股莫名的烦躁" → ✓ "他把手机扣在桌上"
- ❌ "他缓缓站起身，微微皱眉" → ✓ "他站起来，眉头皱着"
- ❌ "他手里的算盘停了" → ✓ "他一颗珠子拨过了头，拨回来，重新数了一遍"
- ❌ "她不禁深吸一口气" → ✓ "她吸气，肩膀绷紧了"`,
  B: `**Gate B：句式去套路**
- "不是A，而是B"（最毒）→ 直接写 B，或用更自然的表达
- "看似……实则……" / "表面上……骨子里……"（二元反差标签）→ 删去抽象标签，直接写具体动作或客观细节呈现真实反差
- 删去"想也不想 / 毫不犹豫 / 二话不说 / 没有丝毫迟疑"等虚假决绝副词，直接上核心动词让动作自身传递果断
- 删去"正因如此 / 由此可见 / 从而 / 鉴于"等说明文逻辑连词，动作之间由情境自然推进
- "，带着一丝X"（万能状语）→ 删去多余修饰，必要情绪可以直说；不换成另一个小动作
- "声音不大。xxx听见了。" / "声音不大，却带着X的力量" → 删去声量说明与听觉感知宣告，直接写对方反应、视线交互或由对话自然接续
- "他/她知道……" → 必要认知可直说或用原文已有行为呈现，重复则删除，不补动作
- 连续 3+ 句同结构排比 → 保留最强一条，删其余
- 避免整齐划一的“动作＋说话”的死板结构（如 "他皱了皱眉说：'...' "） → 先删无必要动作，让对白直接接续；确有必要保留的动作再独立成行，不以换动作或换位置代替删减
- **严禁机械双联报表句**：不要反复套用“动作A+反馈A。动作B+反馈B。”写成对称流水账。连续动作可在句内自然连接，也可在有重音处断句分段；只调整表达，不新增原文事实，不用冗词和额外细节把短观察机械扩成长句

成对示例：
- ❌ "他看似漫不经心，实则暗藏杀机" → ✓ "他指尖转着茶盏，视线没离开对方的袖口"
- ❌ "他不是生气，而是彻底失望了" → ✓ "他是彻底失望了"
- ❌ "声音不大。陆沉听见了。" → ✓ "陆沉转过头，视线落在他脸上。"
- ❌ "楚弈点进去，时标没了。再退回列表，标题改了。" → ✓ "楚弈点进去才发现时标没了，退回列表一看，标题也改了。"（只连接原有观察，不编造新标题、时间或原因）
- ❌ "他想也不想，直接一刀劈出" → ✓ "他拔刀斩下"
- ❌ "他接过信封，带着一丝犹豫" → ✓ "他捏着信封边，半天没拆"
- ❌ "她知道，这件事瞒不住了" → ✓ "这事瞒不住了"（或直接用行为展示：她把手机递了过去）`,
  C: `**Gate C：心理描写外化 + 重复描写去重**
- 必要的判断、想法与情绪可以直白表达，不要求心理一律外化；动作或对白已表达清楚时删除重复心理解说，不换成无用小动作
- "他感到愤怒" → 情绪确有必要时可直说“他很生气”，也可依原文已有行动或对白表现；已经传达时删去，不凭空补攥拳或压低声音
- "她感到一丝失落" → 删去多余修饰，必要时简写“她有些失落”；不强行添加沉默、转身或动作迟疑
- 严禁情绪状态机汇报："震惊之余/过后，取而代之的是……" → 删去交接班过渡解说，保留必要情绪变化或直接接原文下一行动，不补身体微反应
- 第一人称同样按用途判断："我心里一阵烦躁" → 必要时简写“我有些烦躁”，已经表达时删去；不凭空改成撂筷子等行为
- 所提供全文中相邻或相隔段落反复表达同一信息/动作/情绪，包括换词复述、反复表态与没有状态变化的同一轮对话 → 合并去重；已有新证据、态度变化、关系变化或伏笔回收的呼应应保留，不把有效呼应误删。改后变薄则恢复有功能的信息，不新增情节
- **具体感知后禁止追加复述比喻**：已给出具体感知（声音/画面/触感），不要再追加"仿佛/犹如/像"把感知翻译一遍。比喻没增加新信息，只是在解释已传达的东西——删掉比喻，让感知自己说话。
  例："她攥紧了衣角，仿佛要把那张纸攥碎" → "她攥紧了衣角"（攥紧已传达力度，复述比喻冗余）
  判断标准：删掉比喻后读者是否仍能感受到？能，就删。`,
  D: `**Gate D：节奏打碎**
- 碎句号（连续 6+ 短句无呼吸）→ 按语意自然连接已有内容，不为合并补画面、动作或新细节
- **正文叙述段严格单句成段**：除对话外，正文叙述一个段落只有一句话（遇句号强制分段另起一行），严禁在同一段落内拼凑两个及以上句号；句内用逗号连贯推进，不要在段中落句号
- 长段落（>200 字）→ 按镜头/新动作/新线索/视线切换断段
- 破折号 —— → 按原有语意用标点、自然断句或删去无意义停顿处理；需要体现打断时保留原文已有行动，不新增动作占位（勿一律改句号）`,
  E: `**Gate E：对话去腔调**
- 对话标签单一（"道/说"占比过高）→ 说话人已清楚时省略标签，不为换标签机械补动作；只有原文已有且确有用途的动作才保留
- **对白可以直接接续**：台词已表达清楚时，删去不影响信息、人物、情绪体验或后续行动的放碗、抬头、看一眼等随手动作；不要求每句台词前后都有动作，也不按固定间隔添加或省略
- **对话严禁互称姓名强迫症**：面对面连续交谈时，禁止每轮或频繁喊对方名字/称谓，除强调质问外一律省略称呼
- **消除客服助理腔**：禁止"好的，我明白了 / 正如你所言 / 不得不承认"等工整客服腔，换为生活化、带情绪冲撞的口语（"行了知道了 / 少废话"）
- 角色语气区分：主角与配角口头禅/句式差异
- 审判式/压制式/信息差式/推拉式对话模式的优化
- **对话内容本身去书面化**：角色说话别像写文章——允许不完整句、被打断、改口、重复、口头禅。真人说话不会每句都工整长句，别让角色背稿子。
- **严禁发声器官解构与对白解说套路**：严禁把对话标签写成“声音发紧 / 喉头发紧 / 话音发紧 / 声音从牙缝里挤出 / 话音从嗓子里挤出来 / 自己听着都陌生”等机械情绪标签，直接用台词节奏或承接具体行为，避免给发声强加做作解说。
- **台词中间严禁使用句号**：同一段台词说话中间禁止使用句号断句（例如 ❌ “先生既然肯留下，委任今天就能签。名头先挂顾问，不领实职。军需那边管吃住，出门用车也方便。” 一个说话里用了两次句号，充满公文朗读和背稿感）。同一段台词中间一律用逗号连接，保持口语连贯语流，只在整段话最后一句末尾使用句号（✅ “先生既然肯留下，委任今天就能签，名头先挂顾问，不领实职，军需那边管吃住，出门用车也方便。”）。`,
  F: `**Gate F：结尾去升华**
- "这一刻，她终于明白了……" → 直接删除
- "他不知道的是，更大的风暴即将来临" → 用具体钩子物件/事件收束
- "这就是X的意义" → 删，让读者自己体会
- 章末预告式空泛升华 → 改为具体悬念

成对示例：
- ❌ "这一刻，他终于明白，有些路只能一个人走" → ✓ （整句删）
- ❌ "他不知道的是，那封信已经被人拆过了" → ✓ "信封的胶口翘着，像被人揭开又按回去"`,
  G: `**Gate G：去解释腔/上帝视角/安排感**
- 删非故事性的作者旁白/解说（不是删情节）
- **严禁评书式全知插话（"殊不知/岂料/谁曾想"）**：删除作者上帝视角剧透，将暗中危险改为角色视角可感知的物理细节
- **严禁视线空转套路**："视线/目光落在了X身上" → 无叙事用途就删去；确有必要时依据原文写清看向谁或看到什么，不另补转头、对视等动作
- "他这么做的原因是……" → 删，让行为自己说话
- 上帝视角剧透/软评判 → 删或改为角色视角的限制性叙述
- "作为AI/我无法继续/此处省略"（元信息泄漏）→ 重写本句
- 工程词（细纲/情节点/本章）漏进正文 → 删除
- **动作后不点破效果**：写了动作后，不重复解释已经表达清楚的效果；确有必要保留的他人反应可以直白写清，或用原文已有行为呈现，不为去解释腔补造沉默、退后、看过来等反应。
  例："他猛地站起来，让所有人都愣住了" → 若他人反应没有后续作用，可简写“他猛地站起来”；若惊讶反应影响后续，保留“其他人都愣住了”，不擅自改成“半晌没人说话”。
  避免"显得/因此/所以/结果/刺得/淹得"等效果说明词——这些是隐性解释腔。
- **正常叙述可引入角色主观偏差**：不必全程客观全知。紧张时把中性表情读成敌意、自卑时把客气读成敷衍——破除 AI 的均匀客观感，让叙述带角色滤镜。`
}

/** 提取【改写后】段（Phase 3 解析 LLM 输出） */
export function extractRewritten(llmOutput: string): string {
  const match = llmOutput.match(/【改写后】\s*([\s\S]*?)(?=【改动说明】|$)/)
  if (!match) return llmOutput.trim()
  return match[1].trim()
}

/** 提取【改动说明】段（Phase 4 报告用） */
export function extractChangeSummary(llmOutput: string): string[] {
  const match = llmOutput.match(/【改动说明】\s*([\s\S]*?)$/)
  if (!match) return []
  const raw = match[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  // 优先取标准 `- ` 列表；也兼容 `•` / `*` / `1.` / `第N行` 等常见变体
  const bullets = raw.filter(
    (l) =>
      /^[-–—*•·]/.test(l) ||
      /^\d+[.、)]\s*/.test(l) ||
      /^第\d+[行段]/.test(l)
  )
  if (bullets.length > 0) {
    return bullets.map((l) => (l.startsWith('-') ? l : `- ${l.replace(/^[-–—*•·]\s*/, '')}`))
  }
  // 有正文但不是列表：整段保留为一条，避免 UI 完全空白
  if (raw.length > 0 && !raw.every((l) => l.startsWith('【'))) {
    return raw.filter((l) => !l.startsWith('【')).map((l) => (l.startsWith('-') ? l : `- ${l}`))
  }
  return []
}

/** 把原文渲染成「行号|正文」格式，供 LLM 在【改动说明】里引用行号 */
export function numberLines(text: string): string {
  const lines = text.split(/\r?\n/)
  // 行号右对齐到 4 位，避免长短不一干扰 LLM
  const width = String(lines.length).length
  return lines.map((l, i) => `${String(i + 1).padStart(width, ' ')}|${l}`).join('\n')
}
