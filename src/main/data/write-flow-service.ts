import { READER_NOTE_BOUNDARY } from '../../shared/prose-policy'
import type { LlmService, GenerateOptions } from './llm-service'
import type { Foreshadowing, PrevEndingState } from '../../shared/types'
import { foreshadowingsBeforeChapter } from '../../shared/foreshadowing-state'
import { findJsonObject } from '../../shared/json-extract'
import { repairMissingMemoryEvidence } from './memory-evidence-repair'
import { parseOutlineDiffJson } from '../../shared/parsers'
import type { MemoryExtraction } from '../../shared/types'

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

  async verifyForeshadowingRepair(input: {
    original: string; candidate: string; inserted: readonly string[]; outline: string;
    partialChapter?: boolean; tempContext?: string
  }, opts: GenerateOptions = {}): Promise<void> {
    const prompt = [
      '核验伏笔补写是否引入新问题。只评价下方明确列出的新增段落，不把原正文已有的问题当成本次补写造成的问题。',
      '核对新增内容与原文的因果、人物认知、时间地点、设定是否一致，以及是否抢写后续情节、提前揭底。',
      '作者临时要求优先于细纲；明确延期或限制揭示时服从该要求。',
      ...(input.partialChapter ? ['本轮尚未收尾，只允许补已推进场景的遗漏，不要求实现后续场景、回收或章末任务。'] : []),
      '严格JSON：{"passed":true,"issues":[]}；有新问题则passed=false，issues为[{"message":"具体问题","evidence":"新增段落中可定位的连续原文"}]。',
      '必须引用实际新增文字作为证据；不以旧审稿报告的措辞变化判断新问题。',
      '------ 作者要求 ------', input.tempContext ?? '（无临时要求）',
      '------ 原细纲 ------', input.outline,
      '------ 原正文（只读基线） ------', input.original,
      '------ 全部新增段落 ------', JSON.stringify(input.inserted),
      '------ 补写候选整章 ------', input.candidate
    ].join('\n')
    const raw = await this.llm.generateStream(prompt, { ...opts,
      meta: { ...opts.meta, feature: 'foreshadowRepairVerify' } })
    const obj = findJsonObject(raw)
    this.assertForeshadowingVerification(input, obj)
  }

  private assertForeshadowingVerification(input: { candidate: string; inserted: readonly string[] }, obj: Record<string, unknown> | null | undefined): void {
    if (!obj || typeof obj.passed !== 'boolean' || !Array.isArray(obj.issues) ||
      (obj.passed && obj.issues.length) || (!obj.passed && !obj.issues.length)) {
      throw new Error('伏笔补写专项核验未返回有效结论')
    }
    if (obj.passed) return
    const messages: string[] = []
    for (const issue of obj.issues) {
      if (!issue || typeof issue.message !== 'string' || !issue.message.trim() ||
        typeof issue.evidence !== 'string' || !issue.evidence.trim() || !input.candidate.includes(issue.evidence) ||
        !input.inserted.some((addition) => addition.includes(issue.evidence) || issue.evidence.includes(addition))) {
        throw new Error('伏笔补写专项核验缺少新增正文证据')
      }
      messages.push(issue.message)
    }
    throw new Error(`伏笔补写引入新的剧情偏离：${messages.join('；')}`)
  }

  async repairMemoryEvidence(content: string, extraction: MemoryExtraction, opts: GenerateOptions = {}): Promise<MemoryExtraction> {
    return repairMissingMemoryEvidence(content, extraction, (prompt) => this.llm.generateStream(prompt, {
      ...opts, maxTokens: 4096, meta: { ...opts.meta, feature: 'memoryEvidenceRepair' }
    }))
  }

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
      `输出紧凑 JSON，不缩进。各字段使用准确短语，保留全部有原文依据的结尾状态、持有关系、未完成事项及信息来源，不为缩短输出遗漏事实。`,
      `没有依据的情绪、身体、位置或时间用空字符串表示，不逐人反复解释“未明确/未描写”。characterStates.items 必须是字符串，多件物品用顿号连接。`,
      `只记录结尾仍有效的状态；已经完成的历史动作不能写成仍在进行。转述、请求、计划、待核事项保留其性质，不升级为已发生事实，不从常识补出位置或持有物。`,
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
    opts: GenerateOptions & { partialChapter?: boolean; repairVerification?: { original: string; inserted: readonly string[] } } = {}
  ): Promise<string> {
    const { partialChapter, tempContext, repairVerification, ...llmOpts } = opts
    const prompt = [
      `请对照下面的章节细纲，检查正文是否按细纲写作。按 5 种差异类型分类输出。`,
      ...(tempContext?.trim() ? [
        '本轮作者临时写作要求具有最高优先级；与细纲冲突时按作者要求核对。明确暂缓、延期或限制揭示的内容不能误报为漏写。',
        '------ 本轮作者要求 ------', tempContext, '------ 以下为核对规则 ------'
      ] : []),
      ...(partialChapter ? [
        '本轮是尚未收尾的分轮续写。只核对已经推进的场景和已发生情节点中本应出现的伏笔；尚未写到的后续场景、回收和章末钩子不是遗漏。',
        '不能为了完成整章计划把后续伏笔提前埋入或揭底；不确定任务是否已到本轮执行位置时不报漏写。'
      ] : []),
      ``,
      `5 种差异类型：`,
      `- 类型 1 漏写：细纲有 + 正文无 + 必填项（核心事件/伏笔/钩子）缺失`,
      `- 类型 2 超纲增量：细纲无 + 正文有（新角色/新地点/新设定/新情节）`,
      `- 类型 3 细节调整：细纲 A + 正文 B，但核心要素（参与方/事件类型/结果）一致`,
      `- 类型 4 核心事件改：细纲事件 X + 正文事件 Y，任一核心要素变化`,
      `- 类型 5 结构性偏离：字数偏离 > 30% / 核心事件偏离 > 2 个 / 卷终决战提前延后`,
      `禁止事项与必填事件必须区分：“不得X”“不提前揭晓Y”“现有证据尚不能确认某身份”是边界约束，只要正文没有违反就已满足，不要求角色复述禁令，也不要求提及尚未进入本章调查的嫌疑人。`,
      `例如“本章不提前确认赵伯是内应”，正文未提赵伯且未确认内应身份即满足，不能报漏写，更不能建议补写伏笔、让角色提前点名怀疑赵伯。只有细纲明确要求某人当场说明、否认、承诺等实际事件时，才核对那次交流是否发生。`,
      `伏笔必须逐条对照本章细纲：计划埋设、强化、部分揭示、完整回收分别核验，不能以关键词或道具出现代替任务完成。`,
      `每条遗漏伏笔独立输出类型1，outline 写原任务的编号与完整要求，suggestion 明确标记「补写伏笔」；已完成项不报遗漏。`,
      `预计回收日期不等于本章强制回收任务，细纲明确暂缓、延期或不揭底时尊重原安排。`,
      `检查新增伏笔段落是否引入人物认知、时间地点或因果矛盾，是否超出本章揭示范围；提前揭底或矛盾按P1及以上报告。`,
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
      repairVerification ? '细纲差异数组放入下方联合输出的 diffs 字段，无差异时 diffs=[]。' : `无差异时输出空数组 []。不要任何解释、Markdown 代码块。`,
      ...(repairVerification ? [
        '同时独立核验伏笔补写是否引入新问题。只评价明确列出的新增段落，不把原正文已有的问题当成本次补写造成的问题。',
        '逐项核对新增内容与原文的因果、人物认知、时间地点、设定是否一致，以及是否抢写后续情节、提前揭底。',
        '作者临时要求优先于细纲；明确延期或限制揭示时服从该要求。部分续写仅允许补已推进场景，不要求后续回收与章末任务。',
        '两套结论分别填写：diffs 必须完整覆盖全章五类差异与逐条伏笔；verification 仅评价新增段落。不得以其中一项通过代替另一项。',
        'verification 的问题必须引用实际新增文字作证据，不以旧审稿报告的措辞变化判断新问题。',
        '最终严格输出对象 {"diffs":[上述完整差异项],"verification":{"passed":true或false,"issues":[{"message":"具体问题","evidence":"新增段落中的连续原文"}]}}。',
        'verification.passed=true 时 issues 必须为空；有新问题则 passed=false 且 issues 非空。缺少任何一套结论均视为核验未完成。',
        '------ 原正文（只读基线） ------', repairVerification.original,
        '------ 全部新增段落 ------', JSON.stringify(repairVerification.inserted)
      ] : []),
      ``,
      `------ 本章细纲 ------`,
      outline || '（无细纲文本）',
      ``,
      `------ 本章正文 ------`,
      content
    ].join('\n')
    return this.llm.generateStream(prompt, {
      ...llmOpts,
      meta: { feature: 'outlineCheck', ...opts.meta }
    })
  }

  async reviewForeshadowingRepair(input: {
    original: string; candidate: string; inserted: readonly string[]; outline: string; chapterNumber: number;
    partialChapter?: boolean; tempContext?: string
  }, opts: GenerateOptions = {}, onFallback?: (stage: 'outline' | 'verify') => void): Promise<import('../../shared/types').OutlineDiffReport> {
    const checkOpts = { ...opts, partialChapter: input.partialChapter, tempContext: input.tempContext }
    const raw = await this.checkOutlineStream(input.outline, input.candidate, input.chapterNumber, {
      ...checkOpts, maxTokens: 8192,
      repairVerification: { original: input.original, inserted: input.inserted }
    })
    if (opts.signal?.aborted) throw new Error('LLM_ABORTED')
    const obj = findJsonObject(raw)
    const verification = obj?.verification
    const report = obj && Array.isArray(obj.diffs)
      ? parseOutlineDiffJson(JSON.stringify(obj.diffs), input.chapterNumber) : null
    // 即使另一套输出损坏，也不能通过回退重试抹掉已有的实质否决。
    if (verification && typeof verification === 'object' && !Array.isArray(verification)) {
      const verdict = verification as Record<string, unknown>
      if (verdict.passed === false && Array.isArray(verdict.issues) && verdict.issues.length) {
        this.assertForeshadowingVerification(input, verdict)
      }
    }
    if (report && report.checked !== false && verification && typeof verification === 'object' && !Array.isArray(verification)) {
      const verdict = verification as Record<string, unknown>
      if (typeof verdict.passed === 'boolean' && Array.isArray(verdict.issues) &&
        (verdict.passed ? verdict.issues.length === 0 : verdict.issues.length > 0)) {
        this.assertForeshadowingVerification(input, verdict)
        return { ...report, checked: true, hasOutline: true }
      }
    }
    // 联合输出不完整时按原流程分别核对，不能把缺失结论当作通过。
    if (opts.signal?.aborted) throw new Error('LLM_ABORTED')
    const legacyReport = !obj ? parseOutlineDiffJson(raw, input.chapterNumber) : null
    if (!legacyReport || legacyReport.checked === false) onFallback?.('outline')
    const checked = legacyReport && legacyReport.checked !== false ? legacyReport : parseOutlineDiffJson(
      await this.checkOutlineStream(input.outline, input.candidate, input.chapterNumber, checkOpts), input.chapterNumber)
    if (checked.checked === false) throw new Error(`伏笔补写复核未完成：${checked.error || '细纲对照失败'}`)
    if (opts.signal?.aborted) throw new Error('LLM_ABORTED')
    onFallback?.('verify')
    await this.verifyForeshadowingRepair(input, opts)
    if (opts.signal?.aborted) throw new Error('LLM_ABORTED')
    return { ...checked, checked: true, hasOutline: true }
  }

  /**
   * 记忆提取：让 LLM 从正文提取新增角色/地点/情节/伏笔/状态变化。
   * 提取结果由 MemoryWriter 按混合策略应用。
   */
  async extractMemoryStream(
    content: string,
    chapterNumber: number,
    knownCharacters: string[],
    opts: GenerateOptions = {},
    knownForeshadowings: Foreshadowing[] = []
  ): Promise<string> {
    // 空提取会替换同章自动记忆，不能在漏掉中段的情况下声称提取完整。
    if (content.length > 40_000) throw new Error('记忆提取正文超过 40000 字符，请分章后同步；未清理原有记忆')
    const body = content
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
      `- newPlotPoints: [{ title, event, coolPoint?, evidence }]（本章核心情节）`,
      `- characterStateChanges: [{ name, field, oldValue, newValue, evidence }]（既有角色的状态或设定变化）`,
      `  field 优先用标准名：伤势 / 情绪 / 位置 / 当前状态 / 身份 / 性格 / 能力 / 境界 / 外貌 / 关系 / 持有物`,
      `  若本章揭晓了身份真相、性格侧面、能力边界、外貌特征、关系质变，也必须写入（不要只记伤势）`,
      `  道具转移必须记录交出者与接收者各自的实际持有变化，区分借用、保管与所有权，销毁/耗尽不可记成仍可使用。关系按方向记录，不能推导对方也信任。`,
      `  对明确的知情变化用 field=知情，写清角色知道/不知/怀疑/误信哪件事以及信息来源；不能因旁白揭晓或同伴得知就记成全员知道。`,
      `- collectedForeshadowings: [{ foreshadowingId, content, chapter, evidence }]（本章完整回收的既有伏笔，沿用下表编号和原内容，chapter 必须为 ${chapterNumber}）`,
      `完整回收必须回答原伏笔的核心疑问或兑现原承诺。再次出现道具、回忆、线索强化、部分揭示和细纲的计划回收都不能标成完整回收；不确定则输出空数组。无对应编号时不得编造或借用相似伏笔。`,
      `以下是待核对的伏笔台账，只提供原始问题，不是回收已发生的证据：`,
      JSON.stringify(foreshadowingsBeforeChapter(knownForeshadowings, chapterNumber).filter((f) =>
        f.status !== 'collected' && f.status !== 'missed'
      ).map((f) => ({ id: f.id, content: f.content, status: f.status, plantChapter: f.plantChapter }))),
      `- settingsPatches: [{ target, fileName, op, sectionTitle?, title?, content, reason?, confidence?, evidence }]`,
      `  正文揭晓的可复用设定增量（只增不改旧文）。target: worldview|faction|relation|customRule|geography`,
      `  fileName 如「力量体系」「金手指」「青帮」；op: append_h2|append_bullet；confidence: high|medium|low`,
      `  例：新境界、金手指新规则、新势力名、常驻地理。题材定位/核心卖点不要放这里。`,
      `- settingsSuggestions: [{ topic, reason, suggestedPath }]（仅建议手改底稿，如题材定位；可空）`,
      `evidence 必须逐字引用本章连续原文（至少6字符），保留主体、动作、结果及否定词。不能只引用名字或道具名；不能截掉“没有”“打算”等词来制造既成事实。`,
      `evidence 字段值不要额外套中文引号或补标点：直接复制正文片段；只有正文原本存在的引号才能保留。`,
      READER_NOTE_BOUNDARY,
      `先找到支持该条事实的连续原句，再填写记忆内容；不得先概括事实再凭印象编写引文。每条只记证据能直接支持的一件事，优先引用包含主体和动作结果的最短完整小句，不拼接多处原文，不带入无关的后续猜测。`,
      `否定事实也是事实：正文写“拒绝交出账册”，应记“拒绝交出账册”，不能记为“交出账册”。准备动作与计划结果必须分开，不能把“准备出城”记成“已经出城”。`,
      `只提取已经实际发生的变化；传闻、台词里的猜测、谎言、计划、梦境和假设不能直接更新客观状态。无法确认时留空或写入 settingsSuggestions，不补造。`,
      `无新增时对应字段输出空数组。不要任何解释、Markdown 代码块。字段值尽量简短，避免冗长复述正文。`,
      ``,
      `------ 第 ${chapterNumber} 章正文 ------`,
      body
    ].join('\n')
    return this.llm.generateStream(prompt, {
      ...opts,
      // 默认 8192 对「多数组 JSON」在部分模型上仍会被 max_tokens 截断；提取单独抬高
      maxTokens: opts.maxTokens ?? 12_288,
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
    const obj = findJsonObject(raw)
    if (!obj) return fallback
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

