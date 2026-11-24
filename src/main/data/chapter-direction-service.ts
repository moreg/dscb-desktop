import { randomUUID } from 'crypto'
import { join } from 'path'
import { promises as fs } from 'fs'
import { z } from 'zod'
import type { LlmService } from './llm-service'
import { readJson, writeJsonAtomic } from './atomic'
import { chapterDependencyHash } from './chapter-stage-cache'
import { hashProse } from './memory/prose-memory-index'
import { locateMemoryEvidence } from './memory-evidence-validator'
import { ProseRepo } from './skill-format/prose-repo'
import { DetailedOutlineMdRepo } from './skill-format/detailed-outline-md-repo'
import { DetailedOutlineWriter, withGeneratedOutlineNotes } from './skill-format/detailed-outline-writer'
import { findJsonObject } from '../../shared/json-extract'
import { readText } from './skill-format/md-parser'
import { OutlineRepository } from './outline-repository'
import { chapterDirectionSchema, renderDirection, storyEndingPolicy, assertNoUnauthorizedStoryEnding,
  assertNoUnauthorizedDirectionEnding, type ChapterDirections, type ChapterDirectionChoice } from '../../shared/chapter-directions'

const candidateSchema = z.object({ directions: z.array(chapterDirectionSchema).length(5),
  recommendedId: z.string(), recommendationReason: z.string().trim().min(1).max(2000) })
const factSchema = z.object({ text: z.string().trim().min(1).max(1200), evidence: z.string().trim().min(4).max(600) })
const outlineSchema = z.object({ events: z.array(factSchema).min(1).max(20),
  hook: factSchema, characters: z.array(factSchema).max(30), foreshadowings: z.array(factSchema).max(20) })

export interface SelectedChapterDirection {
  candidates: ChapterDirections
  choice: ChapterDirectionChoice
  plan: string
  authorInstruction: string
  targetWords: number
  sourcePlan: string
}
interface DirectionState {
  version: 1
  candidates: ChapterDirections
  selected?: SelectedChapterDirection
  generated?: { sourceHash: string; fileName: string; fileHash: string }
  completedHash?: string
  postProcessing?: { sourceHash: string }
}
const requests = new Map<string, symbol>()
const cancelled = (signal?: AbortSignal): void => { if (signal?.aborted) throw new Error('LLM_ABORTED') }
const isDirectionSourceFile = (relative: string): boolean =>
  /^(?:大纲|outlines|细纲|正文)(?:\/|$)/u.test(relative) && !/(?:^|\/)\.draft-[^/]+$/u.test(relative)

/** Candidates and adoption receipts are persisted separately from factual memory. */
export class ChapterDirectionService {
  constructor(private dir: string, private chapter: number, private llm: LlmService, private projectId: string) {}
  private file(): string { return join(this.dir, '.cache', 'chapter-directions', `${this.chapter}.json`) }
  async read(): Promise<DirectionState | null> { return readJson(this.file(), null) }

  /** True when the chapter already has an author-supplied or author-edited formal outline superseding this direction task. */
  async hasAuthorOwnedOutline(state?: DirectionState | null): Promise<boolean> {
    const current = state === undefined ? await this.read() : state
    if (!current?.selected) return false
    const repo = new DetailedOutlineMdRepo(this.dir)
    const before = await repo.readRaw(this.chapter)
    if (!before) return false
    if (current.generated) {
      return hashProse(before.text) !== current.generated.fileHash
    }
    if (before.text.includes(`方向任务：${current.selected.candidates.token}`)) return false
    const detail = await repo.readChapter(this.chapter)
    const isMeaningful = (value?: string): boolean => {
      const trimmed = value?.trim()
      return Boolean(trimmed && !/^(?:[（(]?待(?:生成|补充|填写|完善)[）)]?|无|暂无)[。.]?$/.test(trimmed))
    }
    return Boolean(detail && (
      [detail.plotSummary, detail.hook, ...(detail.foreshadowings ?? [])].some(isMeaningful) ||
      detail.proseSections?.some(section => isMeaningful(section.text) && !/^(?:本章)?写作要求$/.test(section.title.trim()))
    ))
  }

  /** Returns the pending selected direction unless already completed or superseded by an author-owned outline. */
  async readActiveSelected(): Promise<SelectedChapterDirection | undefined> {
    const state = await this.read()
    if (!state?.selected || state.completedHash) return undefined
    if (await this.hasAuthorOwnedOutline(state)) return undefined
    return state.selected
  }
  async readPlan(): Promise<string> {
    const outlineDir = join(this.dir, '大纲')
    const primary = await readText(join(outlineDir, '大纲.md'))
    const extra: string[] = []
    try {
      for (const f of (await fs.readdir(outlineDir)).sort()) {
        if (!f.endsWith('.md') || f === '大纲.md') continue
        const text = (await readText(join(outlineDir, f))).trim()
        if (text) extra.push(text)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const combined = [primary.trim(), ...extra].filter(Boolean).join('\n\n')
    return combined || JSON.stringify(await new OutlineRepository(this.dir).readMain() ?? '')
  }

  async fingerprint(existingText: string, instruction: string): Promise<string> {
    const key = await chapterDependencyHash(this.dir, ['chapter-directions-v1', this.chapter, existingText.trimEnd(), instruction.trim()],
      relative => !isDirectionSourceFile(relative))
    if (!key) throw new Error('DIRECTION_CONTEXT_UNAVAILABLE: 无法核对大纲和前文版本，请检查项目文件。')
    return key
  }

  async generate(context: string, existingText: string, instruction: string, missingPreviousProse: boolean,
    signal?: AbortSignal, force = false, knownContextHash?: string): Promise<ChapterDirections> {
    cancelled(signal)
    const contextHash = knownContextHash ?? await this.fingerprint(existingText, instruction)
    const state = await this.read()
    if (!force && state?.candidates.contextHash === contextHash) return state.candidates
    const task = Symbol('directions')
    const key = this.file()
    requests.set(key, task)
    try {
      let feedback = ''
      let maxTokens = 8192
      for (let attempt = 0; attempt < 2; attempt++) {
        cancelled(signal)
        const prompt = [
          `为第 ${this.chapter} 章规划恰好五个不同的写作方向，并推荐其中一个。只规划本章，不写小说正文。`,
          '根据完整总纲、当前阶段与可用前文规划。五个方向须在行动、冲突或信息推进上有实际差异，不能只换措辞。',
          '每项写清承接点、主要冲突、场面张力（双方此刻各自的顾虑、隐瞒或想争取的事，避免写成照本宣科的交接）、实际推进、本章停止位置、章末悬念和与大纲的关系；不提前兑现后章核心事件。只定核心冲突与推进骨架，不把反复试错实验、内部算账盘点、道具转手微操或反派降智配合排进方向。',
          '紧扣本章【节奏图谱对齐】的情绪值与爽点等级、总纲本章节点及【角色状态追踪】中主角已生效的实力/金手指优势（如已累积的属性加成、等级、关键底牌）：高潮或爽点章必须将核心交锋、实力反差与爽点兑现作为推进重心，严禁把辞职交接、清点杂物、赶路住宿、入职登记、程序化面试问答当成主要推进。涉及已知人物时直接使用角色档案或大纲中的真实姓名（如管事、首领、对手已有姓名则直呼其名），不降级为无名岗位代称。',
          '各项简明扼要（每字段 1—2 句话、80 字以内），直奔核心干货，不写修辞铺陈；输出前自检五项均承接可用事实、符合总纲阶段和人物动机、不提前揭示后章事件、不未经授权安排全书终局。',
          '事实只能来自已有正文和有效记忆。细纲、大纲都是计划；缺失上一章正文时，不虚构其实际结尾和此前经历。只有大纲也可直接从合理切入点规划，不要求先补前章。',
          storyEndingPolicy(instruction),
          '推荐理由结合本书的主线、人物动机、节奏及伏笔时机，不以完结作为默认目标。',
          '仅输出 JSON：{"directions":[{"id":"a","title":"名称","connection":"承接点","conflict":"冲突","tension":"双方此刻的顾虑或暗中盘算","progression":"本章推进","ending":"本章落点","hook":"章末悬念","outlineReason":"符合大纲的理由"}],"recommendedId":"a","recommendationReason":"推荐理由"}。directions 必须恰好五项，id 唯一，recommendedId 必须引用其中一个。',
          '【可用上下文，计划与事实须区分】', context,
          '【作者本次要求】', instruction || '无额外要求。', feedback
        ].join('\n\n')
        try {
          const value = candidateSchema.parse(findJsonObject(await this.llm.generateStream(prompt, {
            signal, maxTokens, systemPrompt: '你是小说剧情规划编辑，依据作品资料规划，严格输出 JSON。',
            meta: { feature: 'chapterDirections', projectId: this.projectId, chapterNumber: this.chapter }
          })))
          cancelled(signal)
          if (new Set(value.directions.map(d => d.id)).size !== 5 || !value.directions.some(d => d.id === value.recommendedId)) {
            throw new Error('五个方向的标识必须唯一，且必须推荐其中一项。')
          }
          if (value.directions.some((d, i) => value.directions.some((other, j) => j < i &&
            (d.title === other.title || d.progression === other.progression)))) throw new Error('五个方向须有实际差异，不能重复。')
          for (const direction of value.directions) assertNoUnauthorizedDirectionEnding(direction, instruction)
          if (await this.fingerprint(existingText, instruction) !== contextHash || requests.get(key) !== task) {
            throw new Error('DIRECTION_CONTEXT_CHANGED: 前文、大纲或生成任务已变化，请重新生成方向。')
          }
          const candidates: ChapterDirections = { ...value, token: randomUUID(), chapterNumber: this.chapter, contextHash, missingPreviousProse }
          await writeJsonAtomic(this.file(), { version: 1, candidates } satisfies DirectionState)
          return candidates
        } catch (error) {
          cancelled(signal)
          if (/DIRECTION_CONTEXT_|LLM_ABORTED|LLM_RATE_LIMIT/.test((error as Error).message) || attempt === 1) throw error
          if ((error as Error).message === 'LLM_OUTPUT_TRUNCATED') maxTokens = 12288
          feedback = `【重新生成要求】上次结果无效：${(error as Error).message}。请保持每项简明扼要，修正并重新输出完整的五个方向 JSON。`
        }
      }
      throw new Error('未能生成有效的五个方向。')
    } finally { if (requests.get(key) === task) requests.delete(key) }
  }

  async select(choice: ChapterDirectionChoice, existingText: string, instruction: string, targetWords: number,
    signal?: AbortSignal): Promise<SelectedChapterDirection> {
    cancelled(signal)
    const state = await this.read()
    if (!state || state.candidates.token !== choice.token ||
      state.candidates.contextHash !== await this.fingerprint(existingText, instruction)) {
      throw new Error('DIRECTION_CONTEXT_CHANGED: 方向对应的前文或大纲已变化，请重新生成方向。')
    }
    const direction = state.candidates.directions.find(d => d.id === choice.directionId)
    if (!direction) throw new Error('DIRECTION_NOT_FOUND: 请选择本次候选中的一个方向。')
    const selected: SelectedChapterDirection = { candidates: state.candidates, choice, plan: renderDirection(direction, choice.adjustment),
      authorInstruction: [instruction, choice.adjustment?.trim()].filter(Boolean).join('\n\n'), targetWords, sourcePlan: await this.readPlan() }
    cancelled(signal)
    if (state.candidates.contextHash !== await this.fingerprint(existingText, instruction)) throw new Error('DIRECTION_CONTEXT_CHANGED: 采用方向期间资料已变化，请重新生成。')
    await writeJsonAtomic(this.file(), { ...state, selected, completedHash: undefined, postProcessing: undefined })
    return selected
  }

  async verify(content: string, selected: SelectedChapterDirection, signal?: AbortSignal, partial = false): Promise<void> {
    cancelled(signal)
    assertNoUnauthorizedStoryEnding(content, selected.authorInstruction)
    const raw = findJsonObject(await this.llm.generateStream([
      '核验本章实际正文是否大体落实作者选择的方向、遵守大纲边界，并检查是否未经授权写成全书完结。',
      storyEndingPolicy(selected.authorInstruction),
      partial ? '本轮为章内分轮续写，只核对已经写到的部分，不要求后续事件及章末任务全部完成。' : '本章已完成，核对选定方向的核心主线推进是否成立、是否越界进入后章核心事件。',
      '选定方向是写前大方向参考，不是逐条验收清单。只拦实质性硬伤（完全写偏成另一个无关剧情、提前兑现后章核心事件、违背作者明确禁令、或未经授权写成全书完结）。合理细化或微调过程细节、道具/文书载体、人物分工、以及换用同样自然且留有后续空间的章末悬念，均属于正常创作发挥，应判 passed=true 且 issues=[]；不要为次要细节差异拒稿。不能凭事后反向生成的细纲认定正文合格。',
      '只输出 JSON：{"completed":true,"passed":true,"issues":[]}；确有上述实质性硬伤才 passed=false，issues 为说明硬伤及正文原句的字符串数组。',
      '【选定方向】', selected.plan, '【作者要求】', selected.authorInstruction, '【实际正文】', content
    ].join('\n\n'), { signal, maxTokens: 4096, meta: { feature: 'chapterDirectionReview', projectId: this.projectId, chapterNumber: this.chapter } }))
    cancelled(signal)
    const result = z.object({ completed: z.literal(true), passed: z.boolean(), issues: z.array(z.string()).max(12) }).parse(raw)
    if (!result.passed || result.issues.length) throw new Error(`LONGFORM_CONFLICT: 选定方向或禁止主动完结核验未通过：${result.issues.join('；') || '请重新核对本章。'}`)
  }

  /** Full delivery is a durable phase; retries must not infer it again from word count. */
  async beginPostProcessing(content: string, selected: SelectedChapterDirection, signal?: AbortSignal): Promise<void> {
    cancelled(signal)
    const state = await this.read()
    if (state?.selected?.candidates.token !== selected.candidates.token || await new ProseRepo(this.dir).read(this.chapter) !== content) {
      throw new Error('DIRECTION_CONTEXT_CHANGED: 交稿任务或正文已变化，请核对当前保存稿。')
    }
    await writeJsonAtomic(this.file(), { ...state, postProcessing: { sourceHash: hashProse(content) } })
  }

  /** Builds an evidence-backed actual outline, never the unchosen or unwritten plans. */
  async createOutline(content: string, title: string, selected: SelectedChapterDirection, signal?: AbortSignal): Promise<void> {
    cancelled(signal)
    if (content.length > 40000) throw new Error('正文超过 40000 字符，请分章后生成细纲。')
    const state = await this.read()
    if (!state?.selected || state.selected.candidates.token !== selected.candidates.token) {
      throw new Error('DIRECTION_CONTEXT_CHANGED: 当前章节方向任务已变化，未写入细纲。')
    }
    const sourceHash = hashProse(content)
    const repo = new DetailedOutlineMdRepo(this.dir)
    const before = await repo.readRaw(this.chapter)
    const previousHash = hashProse(before?.text ?? '')
    const ownOrphan = before?.text.includes(`方向任务：${selected.candidates.token}`) === true
    if (ownOrphan && !state.generated && before) {
      if (before.text.includes(`正文哈希：${sourceHash}`)) {
        await writeJsonAtomic(this.file(), { ...state, generated: { sourceHash, fileName: before.fileName, fileHash: previousHash } })
        return
      }
    }
    if (state.generated && before) {
      if (hashProse(before.text) !== state.generated.fileHash) throw new Error('DIRECTION_CONTEXT_CHANGED: 自动细纲已被作者修改，请按现有细纲核对后再同步。')
      if (state.generated.sourceHash === sourceHash) return
    } else if (before && !ownOrphan) {
      const existingSummary = (await repo.readChapter(this.chapter))?.plotSummary?.trim()
      if (existingSummary && !/^(?:[（(]?待(?:生成|补充|填写|完善)[）)]?|无|暂无)[。.]?$/.test(existingSummary)) {
        throw new Error('DIRECTION_CONTEXT_CHANGED: 用户已补入细纲，请按新细纲重新核对。')
      }
    }
    let facts: z.infer<typeof outlineSchema> | undefined
    let feedback = ''
    let maxTokens = 8192
    for (let attempt = 0; attempt < 2; attempt++) {
      cancelled(signal)
      try {
        facts = outlineSchema.parse(findJsonObject(await this.llm.generateStream([
          '根据最终正文反向整理本章细纲，只记录本章实际发生的事件、人物行动结果、伏笔变化与实际章末落点。',
          '不得补写情节或把猜测、传闻、计划写成事实。每项 evidence 必须连续逐字引用正文，text 是忠实概括。',
          '只输出 JSON：{"events":[{"text":"按发生顺序概括事件","evidence":"正文原句"}],"hook":{"text":"实际章末落点","evidence":"结尾原句"},"characters":[{"text":"实际出场人物姓名","evidence":"人物出现的原句"}],"foreshadowings":[{"text":"实际埋设、强化或回收的伏笔，保留性质","evidence":"正文原句"}]}。没有的数组输出 []，events 至少一项。',
          '【本章最终正文】', content, feedback
        ].join('\n\n'), { signal, maxTokens, meta: { feature: 'chapterOutlineFromProse', projectId: this.projectId, chapterNumber: this.chapter } })))
        for (const fact of [...facts.events, facts.hook, ...facts.characters, ...facts.foreshadowings]) {
          if (!locateMemoryEvidence(content, fact.evidence)) throw new Error('反向细纲缺少可定位的正文原句。')
        }
        break
      } catch (error) {
        cancelled(signal)
        if (attempt === 1) throw error
        if ((error as Error).message === 'LLM_OUTPUT_TRUNCATED') {
          maxTokens = 12288
          feedback = '【修正要求】上次输出达到长度上限被截断，请精简每条 text 和 evidence（只取能支撑该条的最短连续短句，合并细碎事件），重新输出完整 JSON。'
        } else {
          feedback = `【修正要求】${(error as Error).message}，请重新输出完整 JSON。`
        }
      }
    }
    if (!facts) throw new Error('未能根据正文生成有效细纲。')
    const safeTitle = (title || `第${this.chapter}章`).replace(/[<>:"/\\|?*\r\n]/g, '').slice(0, 80)
    const fileName = `细纲_第${String(this.chapter).padStart(3, '0')}章_${safeTitle}.md`
    const notes = [
      `> 来源：正文反向生成；正文哈希：${sourceHash}；方向任务：${selected.candidates.token}。`, '',
      '### 实际事件顺序', '',
      ...facts.events.map((f, i) => `${i + 1}. ${f.text}\n\n> 正文依据：${f.evidence}`), '',
      '### 实际章末落点', '', facts.hook.text, '', `> 正文依据：${facts.hook.evidence}`
    ].join('\n')
    const body = withGeneratedOutlineNotes([`# ${fileName}`, '', `## 第 ${this.chapter} 章：${safeTitle}`, '',
      `- **核心事件**：${facts.events.map(f => f.text).join('；')}`,
      `- **章末钩子**：${facts.hook.text}`, `- **角色出场**：${facts.characters.map(f => f.text).join('、') || '无'}`,
      `- **伏笔铺设**：${facts.foreshadowings.map(f => f.text).join('；') || '无'}`,
      `- **字数预估**：约${content.replace(/\s/g, '').length}字`, ''
    ].join('\n'), notes)
    cancelled(signal)
    if (hashProse(await new ProseRepo(this.dir).read(this.chapter)) !== sourceHash ||
      hashProse((await repo.readRaw(this.chapter))?.text ?? '') !== previousHash ||
      (await this.read())?.selected?.candidates.token !== selected.candidates.token) {
      throw new Error('DIRECTION_CONTEXT_CHANGED: 正文、细纲或任务已变化，未写入反向细纲。')
    }
    // Existing placeholders/legacy chapters are updated in place to preserve their extra fields.
    if (before) {
      await new DetailedOutlineWriter(this.dir).update(this.chapter, {
        plotSummary: facts.events.map(f => f.text).join('；'), hook: facts.hook.text,
        charactersAppearing: facts.characters.map(f => f.text), foreshadowings: facts.foreshadowings.map(f => f.text),
        wordEstimate: `约${content.replace(/\s/g, '').length}字`, generatedNotes: notes
      })
    } else {
      await fs.mkdir(join(this.dir, '细纲'), { recursive: true })
      const temporary = join(this.dir, '细纲', `${fileName}.${randomUUID()}.tmp`)
      try {
        await fs.writeFile(temporary, body, { encoding: 'utf8', flag: 'wx' })
        // Atomic exclusive publication: a concurrently supplied author file is never replaced.
        await fs.link(temporary, join(this.dir, '细纲', fileName))
      } finally { await fs.rm(temporary, { force: true }) }
    }
    const saved = await repo.readRaw(this.chapter)
    if (!saved) throw new Error('反向细纲保存后无法读取，请补跑本章处理。')
    await writeJsonAtomic(this.file(), { ...state, generated: { sourceHash, fileName: saved.fileName, fileHash: hashProse(saved.text) } })
  }

  async complete(content: string): Promise<void> {
    const state = await this.read()
    const sourceHash = hashProse(content)
    if (!state?.selected || state.generated?.sourceHash !== sourceHash) {
      throw new Error('DIRECTION_CONTEXT_CHANGED: 当前正文尚无同版本反向细纲，请补跑本章处理。')
    }
    await writeJsonAtomic(this.file(), { ...state, completedHash: sourceHash, postProcessing: undefined })
  }
}
