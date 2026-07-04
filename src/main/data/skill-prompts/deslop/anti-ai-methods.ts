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

export const DESLOP_SYSTEM_PROMPT = `你是一名专业的中文小说文字编辑，专门去除 AI 写作痕迹，让文字回归自然。这叫"改味"——改最少字，效果最大。

铁律：
1. **改味优先，不当改错**：只改"怎么说"（表达方式），不改"说什么"（情节/人设/信息）。
2. **保留创作意图**：不能删除伏笔、钩子、角色特征、关键信息或必要转折。遇到冲突改为降 AI 重写或标注 [需复核]。
3. **删除比例上限**：轻度 ≤15% / 中度 ≤25% / 重度 ≤35%。超过时分段输出并标记，不得整段删除。
4. **替换语感对齐项目**：若本次提供了题材/文风（见下方"风格语境"段），替换词和句式必须符合该题材与文风；未提供时按通则：都市口语化、玄幻可稍文雅、悬疑克制留白。题材词（如玄幻里的"仿佛"）若符合该题材语感，可保留并在改动说明里说明。
5. **Show Don't Tell**：优先用动作、停顿、可见反应、身体反应代替抽象解释和心理描写。
6. **标点规范**：正文禁用破折号 ——/—、双连字符 --、省略号停顿 ……；改用句号、逗号、短句或动作断句。
7. **改写输出自身不得引入新的 AI 味**：你在改味时禁止把一种 AI 套路换成另一种 AI 套路。改写后不得出现以下高频 AI 表达：
   - 情态比喻：仿佛 / 犹如 / 宛若 / 如同 / 一丝 / 一抹 / 些许 / 几分 / 隐约
   - 程度副词堆叠：缓缓 / 微微 / 轻轻 / 淡淡 / 不禁 / 不由得 / 不由自主 / 情不自禁
   - 表情套路：眼中闪过一丝X / 嘴角勾起一抹X / 眉头微皱 / 眉眼低垂 / 瞳孔微缩
   - 心理外露：心中涌起/升起/泛起/一动 / 心头一震 / 心下暗道 / 心底泛起 / 深吸一口气
   - 判断/过渡词：不容置疑 / 显而易见 / 毫无疑问 / 不可否认 / 不易察觉 / 自然而然
   - 句式套路："不是A，而是B" / "，带着一丝X" / "声音不大，却带着X的力量" / "他/她知道……" / 章末"他不知道的是……"
   - 升华句式：这一刻，他终于明白 / 这就是X的意义
   替换思路：用具体动作、身体反应、可见细节、短句断句代替。改写后若仍含上述表达，视为未完成改味，须再次降 AI 直至干净。
8. **三条替换通路**（处理不同对象的 AI 味，按情况选其一）：
   - 抽象→具体：情绪词换成动作/身体反应（"愤怒"→"攥紧拳头"）
   - 静态描述→可观察变化：把静态描写改成变化过程（"天空很暗"→"天色压下来，街灯先亮了"）
   - 作者总结→角色感知：把全知叙述改成角色视角的具体感知（"房间很压抑"→"她推门进去，呼吸顿了一下"）
9. **本质洞察**：AI 味的本质不是"写得差"，而是"统计平均感"——均匀、完整、对称。重度改写时优先破坏这三性：让句式不对称、让叙述带主观偏差、让信息不均匀分布（该略处一笔带过，该重处细写）。越想写"有东西"的段落，越要少写。

下面是 7 道 Gate 的改写方法，你只处理命中项，其余保持原样。

注意：原文以「行号|正文」格式给出，仅供你在【改动说明】里引用行号；【改写后】段输出纯净正文，不得带行号前缀。`

/** 分级 → 处理的 Gate 范围 */
export function gatesForLevel(level: DeslopLevel): string[] {
  switch (level) {
    case 'mild':
      return ['A', 'B'] // 只过 Gate A + B
    case 'moderate':
      return ['A', 'B', 'C', 'D', 'G']
    case 'severe':
      return ['A', 'B', 'C', 'D', 'E', 'F', 'G'] // 全 Gate + 重点段落重写
  }
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

/**
 * 构建改写 prompt（Phase 3，逐 Gate 改写）。
 * 只把命中的 Gate 说明 + 命中的 finding 注入，不全篇跑。
 * styleContext 注入项目题材与文风档案，让 LLM 替换语感对齐项目而非套通用模板。
 */
export function buildDeslopPrompt(
  text: string,
  level: DeslopLevel,
  findings: DeslopFinding[],
  gatesToProcess: string[],
  styleContext?: DeslopStyleContext
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

  const gateDescriptions = gatesToProcess.map((g) => GATE_METHODS[g]).join('\n\n')

  const findingSummary = gatesToProcess
    .map((g) => {
      const list = findingsByGate.get(g) ?? []
      if (list.length === 0) return ''
      const samples = list.slice(0, 8).map((f) => `  - 第${f.line}行: ${f.excerpt}`).join('\n')
      return `### Gate ${g} 命中项（${list.length} 处）\n${samples}`
    })
    .filter(Boolean)
    .join('\n\n')

  const styleSection = buildStyleSection(styleContext)

  return `## 任务：去 AI 味改写（${LEVEL_NAMES[level]}，删除比例上限 ${Math.round(maxDeleteRatio * 100)}%）

### 改写原则
- 只改"怎么说"，不改"说什么"
- 命中的 Gate 逐项改写，未命中的保持原样
- 删除比例不得超过 ${Math.round(maxDeleteRatio * 100)}%；超时分段输出标记 [需复核]，不得整段删
- 保留伏笔/钩子/角色特征/关键信息/必要转折
- 替换语感必须对齐下方"风格语境"段；与该题材语感相符的词（如玄幻的"仿佛"）可保留并在改动说明里说明原因
- **改写后不得引入新的 AI 味**：禁止用另一种 AI 套路替换原套路。改写后不得出现"仿佛/犹如/宛若/一丝/一抹/缓缓/微微/轻轻/淡淡/不禁/不由得/眼中闪过/嘴角勾起/心中涌起/深吸一口气/不是A而是B/，带着一丝X/这一刻他终于明白"等高频 AI 表达。改后仍含上述表达视为未完成，须再次降 AI 直至干净。

${styleSection}
### 本次处理的 Gate 及改写方法
${gateDescriptions}

${findingSummary || '（无具体命中项，按 Gate 通则整体降 AI）'}

### 输出格式（严格按此结构）

【改写后】
（完整改写后的正文，单换行符，对话独立成行，无破折号/省略号）

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
  styleContext?: DeslopStyleContext
): string {
  const maxDeleteRatio = level === 'mild' ? 0.15 : level === 'moderate' ? 0.25 : 0.35
  const gatesTouched = Array.from(new Set(remainingFindings.map((f) => f.gate)))
  const gateDescriptions = gatesTouched.map((g) => GATE_METHODS[g]).join('\n\n')
  const findingSummary = remainingFindings
    .slice(0, 12)
    .map((f) => `  - 第${f.line}行 [${f.gate}/${f.type}]: ${f.excerpt}`)
    .join('\n')
  const styleSection = buildStyleSection(styleContext)

  return `## 任务：二次清理（第 ${round} 轮，删除比例上限 ${Math.round(maxDeleteRatio * 100)}%）

这是上一轮去 AI 味改写后的复扫结果。原文已改过一轮，但仍有 ${remainingFindings.length} 处 AI 味残留。**只改这些残留项，其余已经改好的部分保持原样不动**，不要重新通篇改写。

### 改写原则
- 只改下方命中的残留 finding，未命中部分必须与原文逐字一致，不得改动
- 改写后不得引入新的 AI 味（禁用词清单见系统 prompt 铁律 7）
- 保留伏笔/钩子/角色特征/关键信息/必要转折
- 替换语感对齐下方"风格语境"段

${styleSection}

### 本次需处理的 Gate 及方法
${gateDescriptions || '（无具体 Gate 说明，按通则降 AI）'}

### 残留 finding（${remainingFindings.length} 处，逐项改写）
${findingSummary}

### 输出格式（严格按此结构）

【改写后】
（完整改写后的正文，单换行符，对话独立成行，无破折号/省略号。未命中部分必须与原文逐字一致。）

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
    return '### 风格语境\n（未提供项目题材与文风档案，按通则处理：都市口语化、玄幻可稍文雅、悬疑克制留白）'
  }

  const lines: string[] = ['### 风格语境（替换语感必须对齐本段；与之相符的词可保留）']
  if (hasGenre) {
    lines.push(`- 题材：${styleContext!.genre}`)
    // 解析题材对应的语感档案，注入语气词和替换示例，让改写对齐题材而非套通用模板
    const voice = resolveGenreVoice(styleContext!.genre)
    if (voice.allowedHedges?.length) {
      lines.push(`- 该题材允许保留的虚词：${voice.allowedHedges.join('、')}`)
    }
    if (voice.suggestedParticles?.length) {
      lines.push(`- 建议主动使用的题材语气词（替换现代通腔）：${voice.suggestedParticles.join('、')}`)
    }
  }
  if (s?.identifiedStyle?.trim()) lines.push(`- 文风标识：${s.identifiedStyle}`)
  if (s?.tone?.length) lines.push(`- 语感/语气：${s.tone.join('；')}`)
  if (s?.sentencePatterns?.length) lines.push(`- 句式偏好：${s.sentencePatterns.join('；')}`)
  if (s?.vocabularyPreferences?.length) lines.push(`- 词汇偏好：${s.vocabularyPreferences.join('；')}`)
  if (s?.styleConstraints?.length) lines.push(`- 写作手法约束：${s.styleConstraints.join('；')}`)
  if (s?.plotConstraints?.length) lines.push(`- 剧情/题材约束：${s.plotConstraints.join('；')}`)
  return lines.join('\n')
}

const LEVEL_NAMES: Record<DeslopLevel, string> = {
  mild: '轻度',
  moderate: '中度',
  severe: '重度'
}

/** 7 个 Gate 的改写方法（注入 prompt） */
export const GATE_METHODS: Record<string, string> = {
  A: `**Gate A：禁用词替换**
把 AI 高频词替换为具体动作/白描。常见替换：
- "仿佛/犹如/宛若" → 删掉或直接描述
- "缓缓/微微/轻轻/淡淡" → 删（多余修饰）
- "眼中闪过一丝X" → "他垂下眼" / "他笑了一下，没到眼底"
- "嘴角勾起一抹X" → 具体动作
- "心中涌起一股X" → 身体反应（攥紧拳头/呼吸急促）
- "深吸一口气" → 删或换具体呼吸描写
- "不容置疑/显而易见" → 删（判断词）`,
  B: `**Gate B：句式去套路**
- "不是A，而是B"（最毒）→ 直接写 B，或用更自然的表达
- "，带着一丝X"（万能状语）→ 拆短句或换动作
- "声音不大，却带着X的力量" → 直接写声音特征
- "他/她知道……" → 用行为展示认知
- 连续 3+ 句同结构排比 → 保留最强一条，删其余`,
  C: `**Gate C：心理描写外化 + 重复描写去重**
- "他感到愤怒" → "攥紧了拳头" / "声音压低"（Show Don't Tell）
- "她感到一丝失落" → 外化表现（沉默/转身/动作迟疑）
- 相邻段反复表达同一信息/动作/情绪 → 合并去重；改后变薄则恢复有功能的信息，不新增情节
- **具体感知后禁止追加复述比喻**：已给出具体感知（声音/画面/触感），不要再追加"仿佛/犹如/像"把感知翻译一遍。比喻没增加新信息，只是在解释已传达的东西——删掉比喻，让感知自己说话。
  例："她攥紧了衣角，仿佛要把那张纸攥碎" → "她攥紧了衣角"（攥紧已传达力度，复述比喻冗余）
  判断标准：删掉比喻后读者是否仍能感受到？能，就删。`,
  D: `**Gate D：节奏打碎**
- 碎句号（连续 6+ 短句无呼吸）→ 合并成中长句，补回画面与连接
- 长段落（>200 字）→ 按镜头/新动作/新线索/视线切换断段
- 破折号 —— → 按功能改：打断→动作 beat/短句，拖长音→省略或动作，插入说明→逗号/冒号（勿一律改句号）`,
  E: `**Gate E：对话去腔调**
- 对话标签单一（"道/说"占比过高）→ 动作替代标签、省略标签
- 角色语气区分：主角与配角口头禅/句式差异
- 审判式/压制式/信息差式/推拉式对话模式的优化
- **对话内容本身去书面化**：角色说话别像写文章——允许不完整句、被打断、改口、重复、口头禅。真人说话不会每句都工整长句，别让角色背稿子。`,
  F: `**Gate F：结尾去升华**
- "这一刻，她终于明白了……" → 直接删除
- "他不知道的是，更大的风暴即将来临" → 用具体钩子物件/事件收束
- "这就是X的意义" → 删，让读者自己体会
- 章末预告式空泛升华 → 改为具体悬念`,
  G: `**Gate G：去解释腔/上帝视角/安排感**
- 删非故事性的作者旁白/解说（不是删情节）
- "他这么做的原因是……" → 删，让行为自己说话
- 上帝视角剧透/软评判 → 删或改为角色视角的限制性叙述
- "作为AI/我无法继续/此处省略"（元信息泄漏）→ 重写本句
- 工程词（细纲/情节点/本章）漏进正文 → 删除
- **动作后不点破效果**：写了动作后，不要用作者口吻解释这个动作"造成了什么效果/让谁如何"。改用其他人物的可见反应（沉默/退后半步/没人接话/看了过来）来表现效果，让读者自己感受。
  例："他猛地站起来，让所有人都愣住了" → "他猛地站起来。半晌没人说话。"（删"让所有人都愣住了"，改用"没人说话"表现）
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
  return match[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'))
}

/** 把原文渲染成「行号|正文」格式，供 LLM 在【改动说明】里引用行号 */
export function numberLines(text: string): string {
  const lines = text.split(/\r?\n/)
  // 行号右对齐到 4 位，避免长短不一干扰 LLM
  const width = String(lines.length).length
  return lines.map((l, i) => `${String(i + 1).padStart(width, ' ')}|${l}`).join('\n')
}
