import {
  MAX_UNIT_SEC,
  MIN_UNIT_SEC,
  PROMPT_HARD_LIMIT,
  PROMPT_SOFT_LIMIT,
  SCRIPT_SCHEMA_VERSION,
  SHOT_FIELDS,
  type BasedOn,
  type GateIssue,
  type PackageMeta,
  type PromptPackage,
  type QualityReport,
  type ScriptSettings,
  type StoryboardUnit
} from '../../shared/script-studio'
import { PACE_LABELS, paceExecution, shotDensity } from '../../shared/script-studio-planning'
import { dialogueIssues, shotDialogue } from './script-dialogue'

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 去空白后按 Unicode 码点计数，与「中文一字算一字」的口径一致。 */
export function countChars(body: string): number {
  return Array.from(body.replace(/\s/g, '')).length
}

function issue(code: string, severity: 'error' | 'warn', message: string, unitId?: string, field?: string): GateIssue {
  return { code, severity, message, ...(unitId ? { unitId } : {}), ...(field ? { field } : {}) }
}

function report(issues: GateIssue[], charCount: number, compressed: boolean): QualityReport {
  const errors = issues.filter(item => item.severity === 'error')
  const warnings = issues.filter(item => item.severity === 'warn')
  return {
    ok: errors.length === 0,
    issues,
    errors,
    warnings,
    charCount,
    softLimit: PROMPT_SOFT_LIMIT,
    hardLimit: PROMPT_HARD_LIMIT,
    compressed,
    checkedAt: new Date().toISOString()
  }
}

// ---------------------------------------------------------------------------
// 压缩：只做一轮，绝不删镜头、台词、段末钩子、焦点/光影
// ---------------------------------------------------------------------------

const FILLERS: RegExp[] = [
  /非常/g, /十分/g, /极其/g, /格外/g, /相当/g, /特别地/g, /尽可能/g, /尽量/g,
  /需要注意的是/g, /在此基础上/g, /整体而言/g, /同时，/g, /另外，/g,
  /进一步的/g, /更好地/g, /有效地/g, /适当的/g, /相应的/g, /一定程度上/g,
  /务必确保/g, /请确保/g, /尽量保持/g, /请注意/g
]

/** 受保护的行：不删除、不去空泛形容，避免丢镜头／台词／段末钩子／焦点光影。 */
const PROTECTED_LINE: RegExp[] = [
  /【段末状态】/, /「[^」]*」/, /“[^”]*”/, /"[^"]*"/, /镜头\s*\d+/, /焦点/, /光影/, /【镜头轨】/,
  /^(?:焦段|光圈|景深与焦点锁|机位|构图|运镜|主体动作\/表情|台词与语气|限制|下一段衔接)：/
]

function isProtected(line: string): boolean {
  return PROTECTED_LINE.some(pattern => pattern.test(line))
}

/**
 * 一轮确定性压缩：去重复后缀、同义限制、空泛形容、完全重复行。
 * 不调用模型、不删镜头、不删台词、不删段末钩子、不删焦点/光影。
 */
export function compressBody(body: string): string {
  const seen = new Set<string>()
  const lines: string[] = []
  let inShotTrack = false
  for (const rawLine of body.split('\n')) {
    if (rawLine === '【镜头轨】') inShotTrack = true
    if (rawLine === '【声音轨】') inShotTrack = false
    // 先保护镜头、原台词与段末状态，再处理重复标点/短句。
    if (inShotTrack || isProtected(rawLine) || /【段末状态】/.test(lines[lines.length - 1] ?? '')) {
      lines.push(rawLine); continue
    }
    let line = rawLine.replace(/[ \t]+/g, ' ').trimEnd()
    // 去重复后缀（同一短句以逗号/句号连续重复出现时只保留一次）
    line = line.replace(/([^，。；、\n]{4,30})，\1(?=[，。；。]|$)/g, '$1')
    // 合并重复标点
    line = line.replace(/([，。；、])\1+/g, '$1')
    const protectedLine = isProtected(line)
    if (!protectedLine) {
      for (const filler of FILLERS) line = line.replace(filler, '')
      // 同义限制叠加时只留一次
      line = line.replace(/(保持一致|保持统一|请勿修改|不要改动)([，。；])?\s*\1/g, '$1$2')
    }
    line = line.replace(/[ \t]+/g, ' ').trim()
    const key = line.replace(/[，。；、：\s]/g, '')
    if (!protectedLine && key && seen.has(key)) continue
    if (!protectedLine && key) seen.add(key)
    lines.push(line)
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ---------------------------------------------------------------------------
// C 导演轨：9 段顺序，按需段整段省略
// ---------------------------------------------------------------------------

const NO_REF_LINE = '本段不使用参考图，按以下文字描述生成画面。'

function shotLine(shot: Record<string, string | undefined>, index: number, unit: StoryboardUnit, mode: 'A' | 'B' | 'C'): string {
  const values = SHOT_FIELDS.map(field => (shot[field] ?? '').trim())
  const [
    focalLength, aperture, focus, position, composition, movement,
    action, dialogue, lighting, constraints, transition
  ] = values
  const label = shot.functionLabel?.trim() || `呈现${Array.from(action || unit.dramaticAction).slice(0, 12).join('')}`
  if (mode === 'A') return `镜头${index}：${label}\n` + SHOT_FIELDS.map((field, at) =>
    `${['焦段', '光圈', '景深与焦点锁', '机位', '构图', '运镜', '主体动作/表情', '台词与语气', '光影', '限制', '下一段衔接'][at]}：${shot[field] ?? ''}`).join('\n')
  const line = `${index}｜${label}｜镜头/焦点：${focalLength}，${aperture}；${focus}；机位${position}，${composition}；运镜${movement}｜动作/台词：${action}；${dialogue}｜光影/转接：${lighting}；${constraints}；${transition}`
  return mode === 'B' ? `${line}\n摄影机执行锁：${movement}；焦点对象：${focus}；保持与禁止：${constraints}` : line
}

/** P0 无参考图：参考-连续性声明整段省略。 */
function referenceSection(unit: StoryboardUnit): string[] {
  if (!unit.assetRefs.length) return []
  return ['【参考-连续性声明】', `可用参考素材：${unit.assetRefs.join('、')}；${unit.continuity}`]
}

/** 风格暂定时整段省略，不写「未启用」。 */
function styleSection(settings: ScriptSettings): string[] {
  const style = settings.visualStyle.trim()
  if (!/CG|UE5|MetaHuman|动捕|3A|游戏过场|禁止真人|实时渲染|二次元|动漫|漫画|水墨|动画|定格|赛璐璐/i.test(style)) return []
  return ['【风格锁定】', `全段统一为：${style}。人物外貌、服装与场景材质只按已给文字描述，不推断未写明的外貌。`]
}

function buildBody(unit: StoryboardUnit, settings: ScriptSettings): string {
  const mode = chooseMode(unit, settings).mode
  const blocks: string[][] = [
    [
      '【特别注意】',
      '只按以下文字描述生成画面；台词逐字照搬，不改写、不增删；焦点与光影必须按镜头轨执行；段末状态只写可见画面。'
    ],
    ['【素材锚定】', NO_REF_LINE],
    referenceSection(unit),
    styleSection(settings),
    [
      '【场景锚定】',
      `场景：${unit.dramaticAction}。`,
      ...(!styleSection(settings).length && settings.visualStyle.trim() && !/^(暂定|待定|未定|无)$/.test(settings.visualStyle.trim())
        ? [`视觉表达：${settings.visualStyle.trim()}。`] : []),
      `首帧：${unit.firstFrame}。`,
      `人物位置：${unit.characterPositions}。`
    ],
    ['【镜头轨】', paceExecution(unit), ...unit.shots.map((shot, index) => shotLine(shot, index + 1, unit, mode))],
    [
      '【声音轨】',
      '环境声：场景内可见动作对应的环境声，与画面同步。',
      '对白原声：镜头轨中的台词按原样录制；无对白处不添加人声。',
      '同步音效：道具与身体动作产生的同步音效，不叠加额外音源。',
      '不生成背景音乐。'
    ],
    [
      '【硬锁】',
      '禁止额外人物、路人、群演进入画面；禁止复制同一道具；禁止字幕与水印；不得改写台词；不得新增剧情。'
    ],
    ['【段末状态】', unit.lastFrame]
  ]
  return blocks
    .filter(block => block.length > 0)
    .map(block => block.join('\n'))
    .join('\n\n')
}

function chooseMode(unit: StoryboardUnit, settings: ScriptSettings): { mode: 'A' | 'B' | 'C'; recommended: 'A' | 'B' | 'C'; reason: string } {
  const complex = /一镜到底|遮挡转场|多人调度|多人走位|打斗|追逐|格斗|声音叙事/.test(
    unit.dramaticAction + unit.characterPositions + unit.shots.map(s => s.cameraMovement).join(' '))
  const recommended = complex ? 'B' : 'C'
  return { mode: settings.promptMode === 'auto' ? recommended : settings.promptMode ?? 'C',
    recommended, reason: complex ? '本段存在复杂摄影机或动作/多人调度，推荐导演执行增强版。' : '普通剧情段采用导演轨纯净版，保留控制信息并减少重复。' }
}

function buildMeta(unit: StoryboardUnit, settings: ScriptSettings, basedOn: BasedOn): PackageMeta {
  return {
    projectId: basedOn.projectId,
    projectName: basedOn.projectName,
    versionId: basedOn.versionId,
    versionNumber: basedOn.versionNumber,
    contentFingerprint: basedOn.contentFingerprint,
    scriptFingerprint: basedOn.scriptFingerprint,
    storyboardFingerprint: basedOn.storyboardFingerprint,
    sourceFingerprint: basedOn.sourceFingerprint,
    unitId: unit.id,
    scriptRevision: basedOn.scriptRevision,
    durationSec: unit.durationSec,
    aspectRatio: settings.aspectRatio,
    resolution: settings.resolution,
    taskType: '文生视频',
    mode: chooseMode(unit, settings).mode,
    recommendedMode: chooseMode(unit, settings).recommended,
    modeReason: chooseMode(unit, settings).reason,
    paceTier: unit.paceTier,
    paceReason: unit.paceReason,
    paceExecution: paceExecution(unit),
    boundaryPlan: unit.boundaryPlan || unit.continuity,
    enhancementAdvice: unit.enhancementAdvice ?? [],
    visualStyle: settings.visualStyle,
    platform: settings.platform,
    schemaVersion: SCRIPT_SCHEMA_VERSION,
    stale: basedOn.stale,
    ...(basedOn.staleReason ? { staleReason: basedOn.staleReason } : {}),
    generatedAt: basedOn.generatedAt
  }
}

/**
 * 第 3 步：本地确定性纯函数，把结构化分镜构建为视频提示词包。
 * 元信息单独返回，绝不进入 body；超过软限时自动压缩一轮，超过硬限由质量闸门硬阻断。
 */
export function buildPromptPackage(unit: StoryboardUnit, settings: ScriptSettings, basedOn: BasedOn): PromptPackage {
  let body = buildBody(unit, settings)
  let compressed = false
  if (countChars(body) > PROMPT_SOFT_LIMIT) {
    body = compressBody(body)
    compressed = true
  }
  const charCount = countChars(body)
  const meta = buildMeta(unit, settings, { ...basedOn, unitId: unit.id })
  const draft: PromptPackage = {
    unitId: unit.id,
    meta,
    body,
    charCount,
    quality: report([], charCount, compressed),
    sourceShots: unit.shots.map(shot => ({ ...shot })),
    durationSec: unit.durationSec
  }
  return { ...draft, quality: validatePackage(draft) }
}

/** 只沿镜头边界拆分，原镜头与对白逐字保留；单镜超限保留硬阻断。 */
export function buildPromptPackages(unit: StoryboardUnit, settings: ScriptSettings, basedOn: BasedOn): PromptPackage[] {
  const original = buildPromptPackage(unit, settings, basedOn)
  const speechSeconds = (shots: typeof unit.shots): number => Math.ceil(shots.reduce((n, s) => n +
    shotDialogue(s).join('').replace(/\s/g, '').length, 0) / 4 * 1.2 * 2) / 2
  if (original.charCount <= PROMPT_HARD_LIMIT && speechSeconds(unit.shots) <= unit.durationSec) return [original]
  const groups: typeof unit.shots[] = []
  let group: typeof unit.shots = []
  for (const shot of unit.shots) {
    const next = [...group, shot]
    const draft = buildPromptPackage({ ...unit, shots: next }, settings, basedOn)
    if (group.length && (draft.charCount > PROMPT_SOFT_LIMIT || speechSeconds(next) > MAX_UNIT_SEC)) {
      groups.push(group); group = [shot]
    } else group = next
  }
  if (group.length) groups.push(group)
  if (groups.length === 1 && speechSeconds(group) <= unit.durationSec) return [original]
  let offset = 0
  const durations = groups.map(shots => Math.max(MIN_UNIT_SEC,
    Math.round(unit.durationSec * shots.length / unit.shots.length * 2) / 2, speechSeconds(shots)))
  const total = durations.reduce((n, s) => n + s, 0)
  return groups.map((shots, i) => {
    const previous = offset > 0 ? unit.shots[offset - 1] : null
    offset += shots.length
    const fragment: StoryboardUnit = { ...unit, id: groups.length > 1 ? `${unit.id}-part-${i + 1}` : unit.id,
      durationSec: durations[i], shots, suggestedShotCount: shots.length,
      firstFrame: previous?.nextTransition || unit.firstFrame,
      lastFrame: i === groups.length - 1 ? unit.lastFrame : shots[shots.length - 1].nextTransition }
    const pkg = buildPromptPackage(fragment, settings, basedOn)
    pkg.meta.splitFromUnitId = unit.id
    pkg.meta.splitNotice = `按镜头边界生成 ${groups.length} 个连续单元，保留全部镜头与原台词；总时长 ${total} 秒（原单元 ${unit.durationSec} 秒），请按新时长复核剪辑。`
    pkg.quality = validatePackage(pkg)
    return pkg
  })
}

// ---------------------------------------------------------------------------
// 质量闸门
// ---------------------------------------------------------------------------

const ABSTRACT_PSYCHOLOGY = /内心|心中|思绪|意识到|感到|感慨|回忆起|仿佛|似乎|潜意识|情绪翻涌|纠结不已/
const FAST_SPEECH = /极快语速|快速念完|语速极快|加快语速|一口气念完/
const MATERIAL_REF = /@\s*(?:图片|图|Image|image|视频|素材)\s*\d+|@图片N|@图N|@ImageN|@视频N/
const PARAM_IN_BODY = /9:16|16:9|1080p|720p|4[kK]|分辨率|时长|任务类型|模式\s*[ABC]|文生视频|图生视频|帧率|fps|码率|时间码|timecode|第\s*\d+\s*秒/
const MANAGEMENT_SPEECH = /未启用|不使用上一段|不继承|无则删除|没有则删除|不替代|普通段不强制|接下一段|承接下一段|接分镜\s*\d+|本段为/
const VAGUE_FIELD = /^(注意|保持|合适|适当|统一|自然|合理|氛围|感觉)/

/** 提取「」/“”里的台词；没有引号时把非语气描述当作台词字数。 */
function dialogueText(field: string): string[] {
  return shotDialogue({ dialogueAndTone: field })
}

function dialogueChars(field: string): number {
  const quoted = dialogueText(field).join('')
  if (quoted) return Array.from(quoted.replace(/\s/g, '')).length
  if (/无对白/.test(field)) return 0
  // 没用引号包住台词时保守按字段全文估算，避免漏掉「把台词拉快」的情况
  const stripped = field.replace(/语气[^，。；]*$/, '').trim()
  return Array.from(stripped.replace(/\s/g, '')).length
}

/** 分镜结构闸门：4–15 秒、0.5 倍数、11 字段、可执行性、台词时长、慢镜头、暂定项。 */
export function validateStoryboard(units: StoryboardUnit[], settings?: ScriptSettings, sourceBody?: string, partial = false): QualityReport {
  const issues: GateIssue[] = []
  if (!units.length) issues.push(issue('UNITS_EMPTY', 'error', '分镜没有单元，请重新生成'))
  units.forEach((unit, unitIndex) => {
    const uid = unit.id || `unit-${unitIndex + 1}`
    const duration = unit.durationSec
    if (!Number.isFinite(duration) || duration < MIN_UNIT_SEC || duration > MAX_UNIT_SEC || !isHalfStep(duration)) {
      issues.push(issue('UNIT_DURATION', 'error',
        `单元 ${uid} 时长必须介于 ${MIN_UNIT_SEC}—${MAX_UNIT_SEC} 秒且为 0.5 秒倍数，当前为 ${duration}`, uid))
    }
    if (!unit.shots.length) issues.push(issue('SHOT_MISSING', 'error', `单元 ${uid} 没有镜头`, uid))
    const density = shotDensity(unit.paceTier, duration)
    if (unit.shots.length < density[0]) issues.push(issue('SHOT_DENSITY_LOW', 'warn', `单元 ${uid} 的${PACE_LABELS[unit.paceTier]}建议 ${density[0]}—${density[1]} 镜，当前 ${unit.shots.length} 镜，请确认信息增量与停顿功能`, uid))
    if (duration >= 10 && unit.shots.length <= 2 && !unit.slowMotionPurpose?.trim()) {
      issues.push(issue('SLOW_FUNCTION_MISSING', 'warn', `单元 ${uid} 超过10秒仅有1—2镜，需说明慢节奏白名单理由和功能`, uid))
    }
    unit.shots.forEach((shot, shotIndex) => {
      for (const field of SHOT_FIELDS) {
        const value = (shot[field] ?? '').trim()
        if (!value) {
          issues.push(issue('SHOT_FIELD_EMPTY', 'error', `单元 ${uid} 镜头 ${shotIndex + 1} 的 ${field} 为空`, uid, field))
        } else if (VAGUE_FIELD.test(value) && value.length < 8) {
          issues.push(issue('FIELD_NOT_EXECUTABLE', 'warn', `单元 ${uid} 镜头 ${shotIndex + 1} 的 ${field} 过于空泛，请写成可执行指令`, uid, field))
        }
        if (ABSTRACT_PSYCHOLOGY.test(value)) {
          issues.push(issue('ABSTRACT_PSYCHOLOGY', 'warn', `单元 ${uid} 镜头 ${shotIndex + 1} 的 ${field} 含抽象心理词，请转成可见画面`, uid, field))
        }
        if (FAST_SPEECH.test(value)) {
          issues.push(issue('FAST_SPEECH', 'error', `单元 ${uid} 镜头 ${shotIndex + 1} 禁止用「极快语速」压缩台词，请延长单元、拆段或回剧本精简`, uid, field))
        }
      }
      const movement = (shot.cameraMovement ?? '')
      if (/慢镜头|慢动作|升格|slow motion/i.test(movement)) {
        if (unit.durationSec < 6) {
          issues.push(issue('SLOW_MOTION_DURATION', 'error', `单元 ${uid} 使用慢镜头但时长不足 6 秒，慢镜头无法成立`, uid))
        } else {
          issues.push(issue('SLOW_MOTION_FUNCTION', 'warn', `单元 ${uid} 的慢镜头属于运镜功能，请确认时长与动作幅度匹配`, uid))
        }
      }
      const chars = dialogueChars(shot.dialogueAndTone ?? '')
      if (chars > 0) {
        const required = Math.ceil((chars / 4) * 1.2)
        if (required > unit.durationSec) {
          issues.push(issue('DIALOGUE_TOO_LONG', 'warn',
            `单元 ${uid} 镜头 ${shotIndex + 1} 台词约 ${chars} 字，按 4 字/秒需约 ${required} 秒，超过单元 ${unit.durationSec} 秒；建议延长单元、拆段或回剧本精简台词，禁止用极快语速`, uid))
        }
      }
      const assetText = unit.assetRefs.join(' ') + ' ' + Object.values(shot).join(' ')
      if (MATERIAL_REF.test(assetText)) {
        issues.push(issue('UNDEFINED_ASSET', 'error', `单元 ${uid} 出现未定义的素材编号`, uid))
      }
    })
    if (!unit.assetRefs.length) {
      issues.push(issue('NO_REFERENCE_IMAGE', 'warn', `单元 ${uid} 无参考图，画面依据文字描述生成`, uid))
    }
    if (/推断|猜测|大概外貌|可能长相|暂定/.test(unit.firstFrame + unit.lastFrame + unit.continuity)) {
      issues.push(issue('INFERRED_APPEARANCE', 'warn', `单元 ${uid} 含推断外貌或暂定描述，请只写可见内容`, uid))
    }
  })
  if (sourceBody !== undefined) issues.push(...dialogueIssues(units, sourceBody, partial))
  if (settings && !partial) {
    const total = units.reduce((sum, u) => sum + u.durationSec, 0)
    if (Math.abs(total - settings.targetDurationSec) > Math.max(4, settings.targetDurationSec * 0.1)) {
      issues.push(issue('TARGET_DURATION_MISMATCH', 'warn', `分镜总时长 ${total} 秒，与单集目标 ${settings.targetDurationSec} 秒偏差超过10%，请核对剧情覆盖与对白时长`))
    }
  }
  if (settings && (!settings.visualStyle.trim() || /^(暂定|待定|未定|无)$/.test(settings.visualStyle.trim()))) {
    issues.push(issue('STYLE_TENTATIVE', 'warn', '视觉风格暂定，风格锁定段已整段省略'))
  }
  return report(issues, 0, false)
}

function isHalfStep(value: number): boolean {
  return Math.abs(value * 2 - Math.round(value * 2)) < 1e-9
}

/** 提示词包闸门：硬阻断为 error，警告可继续。 */
export function validatePackage(pkg: PromptPackage): QualityReport {
  const issues: GateIssue[] = []
  const uid = pkg.unitId
  const body = pkg.body
  const charCount = countChars(body)

  if (charCount > PROMPT_HARD_LIMIT) {
    issues.push(issue('PROMPT_TOO_LONG', 'error',
      `提示词正文 ${charCount} 字，超过 ${PROMPT_HARD_LIMIT} 字硬上限；单镜或当前模板无法继续沿镜头边界拆分，请精简非台词描述或调整模板`, uid))
  } else if (charCount > PROMPT_SOFT_LIMIT) {
    issues.push(issue('PROMPT_SOFT_EXCEEDED', 'warn', `提示词正文 ${charCount} 字，超过 ${PROMPT_SOFT_LIMIT} 字软上限，已压缩一轮`, uid))
  }

  if (!pkg.sourceShots.length) {
    issues.push(issue('SHOT_MISSING', 'error', '提示词包没有对应镜头，无法校验 11 字段', uid))
  }
  let dialogueAt = 0
  let shotAt = 0
  pkg.sourceShots.forEach((shot, index) => {
    for (const field of SHOT_FIELDS) {
      if (!(shot[field] ?? '').trim()) {
        issues.push(issue('SHOT_FIELD_EMPTY', 'error', `镜头 ${index + 1} 的 ${field} 为空`, uid, field))
      } else {
        const found = body.indexOf(shot[field].trim(), shotAt)
        if (found < 0) issues.push(issue('SHOT_CONTENT_LOST', 'error', `镜头 ${index + 1} 的 ${field} 在正文中丢失或顺序变化`, uid, field))
        else shotAt = found + shot[field].trim().length
      }
    }
    const field = shot.dialogueAndTone ?? ''
    // 同时核对说话人、语气、重复次数和顺序，不能只检测某句是否出现过。
    const found = body.indexOf(field, dialogueAt)
    if (field && found < 0) issues.push(issue('DIALOGUE_REWRITTEN', 'error', `镜头 ${index + 1} 的对白与语气未按原顺序逐字保留`, uid))
    if (found >= 0) dialogueAt = found + field.length
    if (/无对白/.test(field)) {
      if (!body.includes('无对白')) issues.push(issue('DIALOGUE_REWRITTEN', 'error', '无对白镜头在正文中丢失「无对白」', uid))
    } else {
      for (const line of dialogueText(field)) {
        if (!body.includes(line)) {
          issues.push(issue('DIALOGUE_REWRITTEN', 'error', `台词未在正文逐字保留：${line.slice(0, 30)}`, uid))
        }
      }
    }
  })
  const speechChars = pkg.sourceShots.flatMap(shotDialogue).join('').replace(/\s/g, '').length
  if (speechChars / 4 * 1.2 > pkg.durationSec) issues.push(issue('DIALOGUE_DURATION', 'error',
    `本单元台词约 ${speechChars} 字，含表演停顿的自然语速所需时长超过 ${pkg.durationSec} 秒，请按对白节拍拆分或回台词精修，禁止强行提速`, uid))
  if (pkg.meta.splitNotice) issues.push(issue('SPLIT_REVIEW', 'warn', pkg.meta.splitNotice, uid))

  if (!Number.isFinite(pkg.durationSec) || pkg.durationSec < MIN_UNIT_SEC ||
    pkg.durationSec > MAX_UNIT_SEC || !isHalfStep(pkg.durationSec)) {
    issues.push(issue('UNIT_DURATION', 'error',
      `单元时长必须介于 ${MIN_UNIT_SEC}—${MAX_UNIT_SEC} 秒且为 0.5 秒倍数，当前为 ${pkg.durationSec}`, uid))
  }

  if (MATERIAL_REF.test(body)) issues.push(issue('UNDEFINED_ASSET', 'error', '正文出现未定义的素材编号（@图片N 等）', uid))
  const withoutAnchor = body.replace(NO_REF_LINE, '')
  if (body.includes(NO_REF_LINE) && (MATERIAL_REF.test(body) || /使用参考图|按参考图生成/.test(withoutAnchor))) {
    issues.push(issue('ASSET_ROLE_CONFLICT', 'error', '素材职责冲突：既声明不使用参考图又引用了参考图', uid))
  }
  if (MANAGEMENT_SPEECH.test(body)) issues.push(issue('MANAGEMENT_SPEECH', 'error', '正文含管理话术，请整段删除', uid))
  if (PARAM_IN_BODY.test(body)) issues.push(issue('PARAM_IN_BODY', 'error', '正文内嵌了平台参数/时长/分辨率/任务类型/时间码，参数必须外置', uid))
  if (FAST_SPEECH.test(body)) issues.push(issue('FAST_SPEECH', 'error', '正文禁止「极快语速」，请延长单元、拆段或回剧本精简', uid))

  const withoutNoBgm = body.replace(/不生成背景音乐/g, '')
  if (/背景音乐|配乐|BGM|bgm/.test(withoutNoBgm)) {
    issues.push(issue('BGM_IN_BODY', 'error', '正文不得要求生成背景音乐/配乐', uid))
  } else if (!body.includes('不生成背景音乐')) {
    issues.push(issue('BGM_IN_BODY', 'error', '声音轨必须明确写「不生成背景音乐」', uid))
  }

  if (pkg.sourceShots.every(shot => !(shot.nextTransition ?? '').trim()) || !body.includes('【段末状态】')) {
    issues.push(issue('NO_VISIBLE_TRANSITION', 'error', '正文缺少可见衔接或段末状态', uid))
  } else {
    const tail = body.split('【段末状态】')[1]?.trim() ?? ''
    if (!tail) issues.push(issue('NO_VISIBLE_TRANSITION', 'error', '段末状态为空，必须写可见画面', uid))
  }

  if (!body.includes('禁止额外人物') || !body.includes('禁止复制同一道具') || !body.includes('禁止字幕')) {
    issues.push(issue('EXTRA_CAST_PROP_RISK', 'error', '硬锁缺少额外人物/复制道具/字幕水印的禁止项', uid))
  }
  if (!body.includes('焦点') || !body.includes('光影')) {
    issues.push(issue('FOCUS_LIGHTING_LOST', 'error', '压缩后丢失焦点或光影描述', uid))
  }
  if (ABSTRACT_PSYCHOLOGY.test(body)) {
    issues.push(issue('ABSTRACT_PSYCHOLOGY', 'warn', '正文含抽象心理词，请转成可见画面', uid))
  }
  return report(issues, charCount, pkg.quality?.compressed ?? false)
}

// ---------------------------------------------------------------------------
// Markdown 导出（导出前二次闸门）
// ---------------------------------------------------------------------------

export interface RenderMarkdownResult {
  ok: boolean
  markdown: string
  issues: GateIssue[]
}

function staleLabel(stale: boolean, reason?: string): string {
  if (!stale) return '最新（基于当前正式稿与分镜）'
  return `已过期（基于旧版本）${reason ? ` · ${reason}` : ''}`
}

/** 中文 Markdown：头部含项目、版本、指纹、生成时间、过期状态；正文放纯净代码块。 */
export function renderMarkdown(
  packages: PromptPackage[],
  context: { projectName?: string; generatedAt?: string } = {}
): RenderMarkdownResult {
  const gateIssues: GateIssue[] = []
  for (const pkg of packages) {
    const result = validatePackage(pkg)
    gateIssues.push(...result.errors)
  }
  if (gateIssues.length) return { ok: false, markdown: '', issues: gateIssues }

  const first = packages[0]
  if (!first) return { ok: false, markdown: '', issues: [issue('PACKAGES_EMPTY', 'error', '没有可导出的提示词包')] }
  const name = context.projectName?.trim() || first.meta.projectName || '剧本创作'
  const generatedAt = context.generatedAt || first.meta.generatedAt || new Date().toISOString()
  const lines: string[] = [
    `# 视频提示词包 · ${name}`,
    '',
    `- 项目：${name}`,
    `- 剧本版本：v${first.meta.versionNumber}（${first.meta.versionId}）`,
    `- 内容指纹：\`${first.meta.contentFingerprint}\``,
    `- 剧本指纹：\`${first.meta.scriptFingerprint}\``,
    `- 分镜指纹：\`${first.meta.storyboardFingerprint}\``,
    `- 来源指纹：\`${first.meta.sourceFingerprint}\``,
    `- 生成时间：${generatedAt}`,
    `- 过期状态：${staleLabel(packages.some(pkg => pkg.meta.stale), first.meta.staleReason)}`,
    `- 模式：${[...new Set(packages.map(pkg => pkg.meta.mode))].join(' / ')} · 任务类型：${first.meta.taskType}`,
    '',
    '> 元信息与纯净正文分离：以下参数仅供填写平台表单，不得复制进提示词正文。',
    ''
  ]
  packages.forEach((pkg, index) => {
    const quality = validatePackage(pkg)
    lines.push(
      `## 第 ${index + 1} 段 · ${pkg.unitId}`,
      '',
      '### 元信息',
      '',
      `- 时长：${pkg.meta.durationSec} 秒`,
      `- 画幅：${pkg.meta.aspectRatio}`,
      `- 分辨率：${pkg.meta.resolution}`,
      `- 任务类型：${pkg.meta.taskType}`,
      `- 模式：${pkg.meta.mode}`,
      `- 模板推荐：${pkg.meta.recommendedMode ?? pkg.meta.mode}；${pkg.meta.modeReason ?? ''}`,
      `- 节奏档位：${pkg.meta.paceTier ? PACE_LABELS[pkg.meta.paceTier] : '旧版未记录'}；${pkg.meta.paceReason ?? ''}`,
      `- 节奏执行：${pkg.meta.paceExecution ?? ''}`,
      `- 连续性建议：${pkg.meta.boundaryPlan ?? ''}`,
      `- 按需增强建议：${pkg.meta.enhancementAdvice?.join('；') || '当前无额外建议'}`,
      ...(pkg.meta.splitNotice ? [`- 拆段交接：${pkg.meta.splitNotice}`] : []),
      `- 视觉风格：${pkg.meta.visualStyle || '暂定'}`,
      `- 平台：${pkg.meta.platform}`,
      `- 版本：v${pkg.meta.versionNumber}`,
      `- 指纹：\`${pkg.meta.storyboardFingerprint}\``,
      `- 过期状态：${staleLabel(pkg.meta.stale, pkg.meta.staleReason)}`,
      '',
      '### 质量结果',
      '',
      `- 结果：${quality.ok ? '通过' : '阻断'}`,
      `- 字数：${pkg.charCount} / ${PROMPT_HARD_LIMIT}`,
      `- 压缩：${quality.compressed ? '已压缩一轮' : '未压缩'}`,
      `- 错误：${quality.errors.length}；警告：${quality.warnings.length}`,
      ...quality.warnings.map(item => `  - 警告：${item.message}`),
      '',
      '### 纯净正文',
      '',
      '```text',
      pkg.body,
      '```',
      ''
    )
  })
  return { ok: true, markdown: lines.join('\n'), issues: [] }
}
