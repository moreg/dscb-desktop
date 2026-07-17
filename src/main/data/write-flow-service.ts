import type { LlmService, GenerateOptions } from './llm-service'
import type { PrevEndingState } from '../../shared/types'

// 纯解析函数从 shared/parsers re-export，供 main 测试与 renderer 共享
export {
  parseOutlineDiffJson,
  parseMemoryExtractionJson,
  parseRhythmEvaluationJson,
  parseFigureDraftJson,
  buildFigureHtml
} from '../../shared/parsers'

/**
 * 正文写作流程编排服务（Phase 12 新增）。
 * 把 SKILL.md 第 1/5/6/7 步的 LLM 调用集中在此，避免 WriteService 膨胀。
 */
export class WriteFlowService {
  constructor(private readonly llm: LlmService) {}

  /**
   * 从上一章正文末尾提取结构化结尾状态。
   * 失败时返回 { rawTail } 兜底，不抛错。
   */
  async extractEndingState(
    prevTail: string,
    chapterNumber: number,
    opts: GenerateOptions = {}
  ): Promise<PrevEndingState> {
    if (!prevTail.trim()) {
      return {
        chapterNumber,
        characterPositions: [],
        characterStates: [],
        timePoint: '',
        unfinished: [],
        suspense: '',
        props: []
      }
    }
    const prompt = [
      `请从下面这段小说上一章正文末尾，提取结构化的"章节结尾状态"。`,
      ``,
      `输出要求：严格 JSON，不要任何解释、Markdown 代码块。字段：`,
      `- characterPositions: [{ name: 角色名, location: 所在地点, action: 正在做什么 }]`,
      `- characterStates: [{ name: 角色名, emotion: 情绪状态, body: 身体状态, items: 持有物品 }]`,
      `- timePoint: 时间点（如"傍晚/子时/刚入夜"）`,
      `- unfinished: [未完成的对话/动作/事件，字符串数组]`,
      `- suspense: 章末悬念/钩子（一句话）`,
      `- props: [关键道具，字符串数组]`,
      ``,
      `------ 上一章正文末尾 ------`,
      prevTail
    ].join('\n')
    const raw = await this.llm.generateStream(prompt, {
      ...opts,
      meta: { feature: 'endingState', ...opts.meta }
    })
    return parseEndingStateJson(raw, chapterNumber, prevTail)
  }

  /**
   * 细纲对照：让 LLM 对照细纲检查正文，输出 5 种差异类型。
   * 同时给出 resolution + outlinePatch，供 UI「以正文更新细纲」一键回写。
   * 不自动落盘，由用户决策处理。
   */
  async checkOutlineStream(
    outline: string,
    content: string,
    chapterNumber: number,
    opts: GenerateOptions = {}
  ): Promise<string> {
    const prompt = [
      `请对照下面的章节细纲，检查正文是否按细纲写作。按 5 种差异类型分类输出。`,
      ``,
      `5 种差异类型：`,
      `- 类型 1 漏写：细纲有 + 正文无 + 必填项（核心事件/伏笔/钩子）缺失`,
      `- 类型 2 超纲增量：细纲无 + 正文有（新角色/新地点/新设定/新情节）`,
      `- 类型 3 细节调整：细纲 A + 正文 B，但核心要素（参与方/事件类型/结果）一致`,
      `- 类型 4 核心事件改：细纲事件 X + 正文事件 Y，任一核心要素变化`,
      `- 类型 5 结构性偏离：字数偏离 > 30% / 核心事件偏离 > 2 个 / 卷终决战提前延后`,
      ``,
      `resolution（推荐处理方向）指引：`,
      `- 类型 1 → "updateContent"（应补写/改正文，不要给 outlinePatch）`,
      `- 类型 2 → "updateOutline"（以正文为准回写细纲；必须给 outlinePatch）`,
      `- 类型 3 → "either"（默认可回写细纲；尽量给 outlinePatch，用正文表述覆盖对应字段）`,
      `- 类型 4 → "review"（需作者确认；若接受正文则给 outlinePatch，覆盖 plotSummary 等）`,
      `- 类型 5 → "review"（需作者确认；字数问题可写 wordEstimate）`,
      ``,
      `outlinePatch 可写字段（只填需要更新的）：`,
      `title, plotSummary, coolPoint, hook, charactersAppearing(字符串数组), foreshadowings(字符串数组), wordEstimate, goldenLine`,
      `- 新角色 → charactersAppearing 只列新增名`,
      `- 新伏笔 → foreshadowings`,
      `- 情节/细节变化 → plotSummary（写完整的一句话核心事件，不是 diff 片段）`,
      `- 爽点/钩子变化 → coolPoint / hook`,
      ``,
      `输出要求：严格 JSON 数组，每项 {`,
      `  type: 1-5,`,
      `  typeLabel,`,
      `  outline,`,
      `  actual,`,
      `  suggestion,  // 明确说建议「补写正文」还是「以正文更新细纲」`,
      `  priority: "P0"|"P1"|"P2",`,
      `  resolution: "updateOutline"|"updateContent"|"either"|"review",`,
      `  outlinePatch?: { ... }  // 可回写细纲时给出`,
      `}。`,
      `无差异时输出空数组 []。不要任何解释、Markdown 代码块。`,
      ``,
      `------ 本章细纲 ------`,
      outline || '（无细纲文本）',
      ``,
      `------ 本章正文 ------`,
      content
    ].join('\n')
    return this.llm.generateStream(prompt, {
      ...opts,
      meta: { feature: 'outlineCheck', ...opts.meta }
    })
  }

  /**
   * 记忆提取：让 LLM 从正文提取新增角色/地点/情节/伏笔/状态变化。
   * 提取结果由 MemoryWriter 按混合策略应用。
   */
  async extractMemoryStream(
    content: string,
    chapterNumber: number,
    knownCharacters: string[],
    opts: GenerateOptions = {}
  ): Promise<string> {
    const prompt = [
      `请从下面的小说正文中提取本章新增的记忆信息。`,
      ``,
      `已知人物（不要重复提取）：${knownCharacters.join('、') || '（空）'}`,
      ``,
      `输出要求：严格 JSON，字段：`,
      `- newCharacters: [{ name, role, identity, personality, appearance?, abilities? }]（本章首次登场；外貌/能力有则填）`,
      `- newLocations: [{ name, category, notes, scope? }]（新地点；scope=scene 场景点 / world 常驻地理）`,
      `- newItems: [{ name, category, notes }]（本章首次出现的新道具/物品，如法宝、兵器、灵物、信物）`,
      `- newForeshadowings: [{ content, expectedCollect?, note? }]（本章新埋设的伏笔）`,
      `- newPlotPoints: [{ title, event, coolPoint? }]（本章核心情节）`,
      `- characterStateChanges: [{ name, field, oldValue, newValue }]（既有角色的状态或设定变化）`,
      `  field 优先用标准名：伤势 / 情绪 / 位置 / 当前状态 / 身份 / 性格 / 能力 / 境界 / 外貌 / 关系 / 持有物`,
      `  若本章揭晓了身份真相、性格侧面、能力边界、外貌特征、关系质变，也必须写入（不要只记伤势）`,
      `- collectedForeshadowings: [{ content, chapter }]（本章回收的伏笔）`,
      `- settingsPatches: [{ target, fileName, op, sectionTitle?, title?, content, reason?, confidence? }]`,
      `  正文揭晓的可复用设定增量（只增不改旧文）。target: worldview|faction|relation|customRule|geography`,
      `  fileName 如「力量体系」「金手指」「青帮」；op: append_h2|append_bullet；confidence: high|medium|low`,
      `  例：新境界、金手指新规则、新势力名、常驻地理。题材定位/核心卖点不要放这里。`,
      `- settingsSuggestions: [{ topic, reason, suggestedPath }]（仅建议手改底稿，如题材定位；可空）`,
      `无新增时对应字段输出空数组。不要任何解释、Markdown 代码块。`,
      ``,
      `------ 第 ${chapterNumber} 章正文 ------`,
      content
    ].join('\n')
    return this.llm.generateStream(prompt, {
      ...opts,
      meta: { feature: 'memoryExtract', ...opts.meta }
    })
  }

  /**
   * 节奏评估：让 LLM 从正文评估实际情绪值（0-10）。
   * 评估结果由 WriteService 与细纲预期值对比，差异 ≤1 自动回写。
   * LLM 输出含 expectedEmotion（透传）+ actualEmotion + reason，方便 renderer 直接解析。
   */
  async evaluateRhythmStream(
    content: string,
    chapterNumber: number,
    expectedEmotion: number,
    opts: GenerateOptions = {}
  ): Promise<string> {
    const prompt = [
      `请评估下面小说章节正文的实际情绪强度（读者感受的爽感/紧张/兴奋程度）。`,
      ``,
      `细纲预期情绪值：${expectedEmotion} / 10`,
      `（0=平淡/铺垫，5=一般推进，8=高潮，10=卷终决战级）`,
      ``,
      `输出要求：严格 JSON：`,
      `- expectedEmotion: ${expectedEmotion}（透传，便于解析）`,
      `- actualEmotion: 0-10 的数字（可一位小数），表示实际情绪值`,
      `- reason: 一句话说明依据（≤30 字）`,
      `不要任何解释、Markdown 代码块。`,
      ``,
      `------ 第 ${chapterNumber} 章正文 ------`,
      content.length > 6000 ? content.slice(0, 6000) + '\n…（后文略）' : content
    ].join('\n')
    return this.llm.generateStream(prompt, {
      ...opts,
      meta: { feature: 'rhythmEval', ...opts.meta }
    })
  }

  /**
   * 图解生成：让 LLM 判断本章是否为关键转折点，若是则生成 Mermaid 图解。
   * 输出 JSON 含 shouldGenerate/type/topic/reason/mermaid，由 renderer 解析。
   */
  async generateFigureStream(
    content: string,
    chapterNumber: number,
    opts: GenerateOptions = {}
  ): Promise<string> {
    const prompt = [
      `请判断下面这章正文是否满足"关键转折点"条件，如果满足则生成 Mermaid 图解。`,
      ``,
      `触发条件（任一满足即生成）：`,
      `1. 关键战斗（双方站位、力量对比、胜负关键）`,
      `2. 势力变化（各方势力的关系与分布）`,
      `3. 角色突破（角色成长路线图）`,
      `4. 关系网变化（主要角色关系网）`,
      `5. 重大剧情线（剧情时间线/因果链）`,
      `6. 关键伏笔回收（伏笔因果链）`,
      ``,
      `输出要求：严格 JSON：`,
      `{`,
      `  "shouldGenerate": true/false,`,
      `  "type": "战斗|势力|突破|关系|剧情|伏笔回收",`,
      `  "topic": "主题描述（如林风vs赵乾）",`,
      `  "reason": "为什么触发",`,
      `  "mermaid": "graph TD\\n    A[事件1] --> B[事件2]"`,
      `}`,
      `不触发时 shouldGenerate=false，其他字段留空。不要任何解释、Markdown 代码块。`,
      ``,
      `------ 第 ${chapterNumber} 章正文 ------`,
      content.length > 6000 ? content.slice(0, 6000) + '\n…（后文略）' : content
    ].join('\n')
    return this.llm.generateStream(prompt, {
      ...opts,
      meta: { feature: 'figureGen', ...opts.meta }
    })
  }
}

/** 解析 LLM 输出的结尾状态 JSON，失败兜底 */
export function parseEndingStateJson(
  raw: string,
  chapterNumber: number,
  prevTail: string
): PrevEndingState {
  const fallback: PrevEndingState = {
    chapterNumber,
    characterPositions: [],
    characterStates: [],
    timePoint: '',
    unfinished: [],
    suspense: '',
    props: [],
    rawTail: prevTail
  }
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return fallback
    const obj = JSON.parse(m[0])
    return {
      chapterNumber,
      characterPositions: Array.isArray(obj.characterPositions) ? obj.characterPositions : [],
      characterStates: Array.isArray(obj.characterStates) ? obj.characterStates : [],
      timePoint: typeof obj.timePoint === 'string' ? obj.timePoint : '',
      unfinished: Array.isArray(obj.unfinished) ? obj.unfinished : [],
      suspense: typeof obj.suspense === 'string' ? obj.suspense : '',
      props: Array.isArray(obj.props) ? obj.props : []
    }
  } catch {
    return fallback
  }
}

