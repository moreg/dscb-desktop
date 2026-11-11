import { migrateLegacyProseDefaults, NATURAL_PARAGRAPHS, DIALOGUE_PARAGRAPHS, SEMANTIC_PUNCTUATION, SCENE_DIALOGUE, PROSE_POLICY_RULES } from '../../../shared/prose-policy'
import { CHARACTER_VOICE_RULES } from './skill-contracts'
import { CHAPTER_INDEX_NOT_PROSE } from '../../../shared/strip-chapter-meta'
import { PRESS_ACTION_RULES } from './action-precision'

/**
 * 章节写作硬性规则文本。
 * 出自「正文写作」技能 SKILL.md：
 * - 依剧情和作者安排选择章末落点
 * - 三铁律（顺序/完整/边界）
 * - 自然准确的叙述（按作者认可的文风调整）
 * - 服从当前交谈的口语表达
 * - 直给原则
 * - 句段节奏与有效细节
 *
 * 这些是 system prompt 的核心约束文本，对 LLM 而言是"写作守则"。
 */

/** 历史内置全文仅用于精确迁移；不模糊匹配或改写作者自定义条款。 */
const LEGACY_CHAPTER_ENDING_RULES = `
【章末结尾硬性原则（必读，违反必须重写）】

每一章的结尾**必须**用"对话"或"事件"来写：

✓ 对话结尾：角色说关键台词（埋伏笔/造悬念/留钩子）
✓ 事件结尾：让某事突然发生（打断平静/引入新元素/反转）
✓ 对话+事件混合：最有冲击力

✗ 禁止"说教/总结/感慨"：例如"这世界就是这样""他明白了一个道理"
✗ 禁止"AI 味抒怀"：例如"他的故事，才刚刚开始""留给读者无限遐想"
✗ 禁止纯心理活动（无对话/无事件）
✗ 禁止纯动作（"他转身离开"——没有对话/事件）

对话结尾的 5 类典型示例：
- 留悬念："他刚要开口，身后突然传来一声轻笑——"
- 埋伏笔："这把剑，我迟早会亲手还给你。"
- 造冲突："再说一遍？"
- 反转："……你是青云子？！"
- 未说完："其实我本来想告诉你——"（然后不说了）

事件结尾的 5 类典型示例：
- 打断：主角正在思考，突然窗户被踹开
- 新角色登场：门外站着一个他从未见过的人
- 新发现：主角在物品上发现一行字
- 环境变化：天空突然变黑，灵气暴走
- 情感冲击：主角看到尸体，认出是故人

最有冲击力的混合结尾示例：
"我不会让你——"
话没说完，门被踹开。
门口站着的人，让所有声音都停了。
`.trim()

/** 结尾服从本章剧情、题材与作者安排，不用固定形态替代收束判断。 */
export const CHAPTER_ENDING_RULES = `
【章末结尾原则】

按本章剧情进度、题材、人称视角及作者要求选择落点。对话、事件、动作、心理或平静收束都可以，必要的情绪消化与简短总结可以保留；判断其是否承接本章并产生叙事用途，不按形式判失败。

作者或细纲明确安排的悬念、伏笔、停止位置和后章边界仍须遵守。悬念来自已有矛盾或未解决事项，不强制每章出现突发事件、反转或未说完的台词，不为制造钩子新增人物、危机或情节。

剧情点尚未写完时保留自然停点，不为收尾跳过过程；剧情已完整时自然结束，不追加空泛说教、重复解释或“故事才刚刚开始”等套话。
`.trim()

const LEGACY_ENDING_OUTPUT_LINE = '- 章末必须以"对话"或"事件"结尾，违反此条立即视为失败'
const ENDING_OUTPUT_LINE = '- 章末按剧情、题材和作者要求自然收束，对话、事件、动作、心理或平静收束均可，不为悬念硬加情节'
const LEGACY_META_OUTPUT_LINE = `- **正文禁止出现出版章号**：「第N章」「第N卷」「上一章」「本章」「下章见」都不许写，阿拉伯数字和中文数字一样。${CHAPTER_INDEX_NOT_PROSE}`
const META_OUTPUT_LINE = `- **正文禁止出现出版章号及作者告别语**：不要将「第N章」「第N卷」「上一章」「本章」等出版坐标或「下章见」「未完待续」等作者告别语写入叙述。${CHAPTER_INDEX_NOT_PROSE}故事内对白、书信、题字等正常使用这些词语时保留，不能按词面删除。`

/** 只在提示词中迁移逐字相同的旧默认，配置原文及附加的作者规则保持不变。 */
export function normalizeLegacyEndingOverride(text: string): string {
  return text.replace(LEGACY_CHAPTER_ENDING_RULES.replace(/\n/g, '\r\n'), CHAPTER_ENDING_RULES.replace(/\n/g, '\r\n'))
    .replace(LEGACY_CHAPTER_ENDING_RULES, CHAPTER_ENDING_RULES)
    .replace(LEGACY_ENDING_OUTPUT_LINE, ENDING_OUTPUT_LINE)
    .replace(LEGACY_META_OUTPUT_LINE, META_OUTPUT_LINE)
}

/** 大纲/细纲遵守的三铁律 */
export const OUTLINE_THREE_RULES = `
【细纲遵守三铁律】
- **顺序铁律**：保持关键事件的先后与因果。细纲表述相冲突时，以情节点序列为准。
- **完整铁律**：落实必需事件、规则条件和结果。几项相关动作可写成一段连续经历，允许概述能推知的中间步骤。
- **边界铁律**：守住人物到场和知情条件、结局走向、禁区与停止位置。可以补足有用的过渡和反应，不能擅加剧情点或提前兑现后章事件。
`.trim()

/** 防剧透：按读者阅读进度控制信息揭晓。 */
export const SPOILER_RULES = `
【防剧透（违反必须重写）】

以读者读到当前位置时已获知的信息为边界。旁白、人物心理、对话和章末钩子不得提前说破尚未揭晓的反转、真实身份、伏笔答案或结局；已有揭晓安排时，保留约定的揭晓位置。允许通过人物当下能感知的动作、对话和细节留下线索，不要由叙述者替读者解释答案，也不要用“殊不知”“后来他才知道”等句式预告未来。读者已从其他视角获知的信息不算剧透。

章末钩子只呈现本章当下发生的事件或可感知线索，不预告后续章节才揭晓的答案，也不提前完成后续章节才安排的人物状态变化（排出、退去、恢复、看清、突破、揭晓、落定、兑现等）；下一章将发生的转变，本章最多写到征兆出现为止，完成、见效与反应留给下一章。
`.trim()

/** 自然准确的叙述：用文风参照与适用条件约束表达，不把常用字设为禁词。 */
export const DEAI_TECHNIQUES = `
【自然准确的叙述】
用符合本作题材和人物身份的词写清动作对象、受力与反馈。距离、幅度和时间影响判断或结果时写实数；其他细节随视角人物眼下所需交代。按具体语境判断用词，不按词语命中机械删除。

${PRESS_ACTION_RULES}
`.trim()

/**
 * 文体参考与句段节奏。
 *
 * 这几个数不是拍的，是 19 篇番茄小说榜单在榜作品实测出来的四分位区间
 * （语料与测量方法见 tests/fixtures/deslop-corpus/）。
 *
 * 这些统计只用于识别整篇极端碎句，不是让模型逐句凑长度的配额。
 * 句长随叙事用途变化，不凑字数；段落按语意组织。
 *
 * 校验方式：node scripts/style-baseline.mjs <正文目录>
 */
export const STYLE_TARGETS = `
【文体参考与句段节奏】
一句一段仍可以是一句完整的长句。短句可用于急促反应或明确停顿；按同一感知、行动及结果组织句段，不按操作次数断句，也不为合段强接逗号。
`.trim()

export const PROSE_PARAGRAPH_RULES = PROSE_POLICY_RULES

/** 仅迁移逐字相同的历史内置规则，不写回配置，不覆盖作者自定义条款。 */
const LEGACY_PARAGRAPH_DEFAULTS = [
  "- **一句一段**：每段只写一句完整的话，同一行动与其直接反馈若是两句话也必须分段，不把独立句子的句号改成逗号规避分段。对白按人物当下的语气断句，不因标点统一而抹平停顿。",
  "- **避免满屏碎句**。极短段只在符合当时节奏时使用，不规定长短句比例，完整句子按一句一段排版，不为凑段长拼接独立句子。",
  "- **整章对白占比目标 70%**。旁白约 30%，排除标点与空白按字数计算。续写合并前部观察整章，多章逐章落实；不靠寒暄、重复问答、旁白套引号或自言自语凑比例，必要行动与因果仍真实写清。",
  "- **一句一段**：每段只写一句完整的话，同一行动与其直接反馈若是两句话也必须分段，不把独立句子的句号改成逗号规避分段。对话独立成段，引号内中间不用中文句号，陈述台词结尾保留句号；多句台词拆成引号完整的独立段落，问号、感叹号按语气保留。",
  "- **整章对白占比目标 70%**。优先通过人物交谈、争执、试探与交锋推进剧情，本该说出口的话直接写出，不转述成叙述；旁白约占 30%，只补必要动作、场景变化与因果，不为凑占比添加无意义交谈。续写按已有正文与新增内容合计观察整章，批量生成逐章落实。"
]
export function normalizeLegacyParagraphOverride(text: string): string {
  let migrated = migrateLegacyProseDefaults(text)
  for (const legacy of LEGACY_PARAGRAPH_DEFAULTS) {
    migrated = migrated.replace(legacy, legacy.includes('对白') ? SCENE_DIALOGUE : NATURAL_PARAGRAPHS)
  }
  return migrated.replace("同一对引号内的中间不能出现中文句号「。」，陈述台词只在闭合引号前保留一个句号；陈述台词以句号加闭合引号收尾", SEMANTIC_PUNCTUATION)
}

/** 当前口语表达原则；旧版覆盖只替换可识别的内置示范，不改写保存的配置。 */
export const ORAL_EXPRESSION_RULES = `【真人对话特征：口语表达服从当前交谈】

跑题、改口、口误、沉默和口癖可以自然出现，但不是需要逐项植入的真人标志，也不以出现多少判断自然。先依据人物的认知、关系和当下情绪写完整发言，不为续话或区分人物故意制造说错、听错、自我纠正与答非所问。必要动作按原有事件顺序安排，不为排版搬动。`.trim()

const LEGACY_DIALOGUE_HEADING = '【真人对话特征（按需选用，不强制每段都体现）】'
const LEGACY_DIALOGUE_EXAMPLES = new Set([
  '- 会跑题："那个，我本来想说……算了，你吃饭了没？"',
  '- 会自相矛盾："你这人挺讨厌的——呃，也不是讨厌，就是……"',
  '- 会用错词/口误："我们去……不对，等等，让我先想想。"',
  '- 会突然沉默/岔开：张了张嘴，又闭上了。',
  '- 会有口癖/口头禅："啧，这事儿不好办。"'
])


const CURRENT_DIALOGUE_SENTENCES = SEMANTIC_PUNCTUATION + '\n' + DIALOGUE_PARAGRAPHS + '\n' + NATURAL_PARAGRAPHS
const LEGACY_DIALOGUE_SENTENCES = "**台词中间严禁使用句号**：同一次发言的引号内，小句之间用逗号连接，句号只保留在整段台词最末尾，末尾也可按语气使用问号或感叹号。不要把台词拆成多个引号来规避此规则；叙述句仍按句末正常分段。\n- 错误：“大家都等着看预告，结果制片助理连素材都没交齐。明川，先签字，别让全组陪你耗。”\n- 正确：“大家都等着看预告，结果制片助理连素材都没交齐，明川，先签字，别让全组陪你耗。”\n示例只说明标点，人物与事件不得移入本作；输出前检查引号内是否有非末尾句号，有则改为逗号。"
const LEGACY_DIALOGUE_FRAGMENTS: Array<[string, string]> = [
  [
    "4. 标准化收尾（\"好，就这样。\"\"嗯。\"）",
    "4. 无用途地反复用同一句话收束交流（普通的“好”“嗯”和直接回答按语境保留，不要求每次都机锋或继续加话）"
  ],
  [
    "8. 缺乏个性化词汇（按\"教育程度\"分而非按\"性格\"分）",
    "8. 缺乏人物差异（只套教育程度或性格标签；措辞应结合性格、教育经历、身份、对象、当下情绪与场景，不把其中某一项作为唯一依据）"
  ],
  [
    "- 推进剧情、暴露性格、埋伏笔/造梗、自相矛盾/跑题：允许",
    "- 必要的信息交流、情绪消化、关系变化及符合人物与场合的幽默可保留，不把造梗、跑题或自相矛盾作为互动任务。"
  ]
]

/** 只兼容历史内置示范段，保留自定义行、其他章节与空串停用的含义。 */
export function normalizeLegacyDialogueOverride(text: string): string {
  const start = text.indexOf(LEGACY_DIALOGUE_HEADING)
  if (start < 0) return text
  const contentStart = start + LEGACY_DIALOGUE_HEADING.length
  const nextHeading = text.indexOf('【', contentStart)
  const end = nextHeading < 0 ? text.length : nextHeading
  const lines = text.slice(contentStart, end).split(/\r?\n/u)
  // 多个旧示范同时出现才识别为历史内置段，避免碰到用户自写的同名标题。
  if (lines.filter(line => LEGACY_DIALOGUE_EXAMPLES.has(line.trim())).length < 3) return text
  const retained = lines.filter(line => {
    const value = line.trim()
    return value && value !== '可选特征：' && !LEGACY_DIALOGUE_EXAMPLES.has(value)
  }).join('\n')
  let normalized = text.slice(0, start) + ORAL_EXPRESSION_RULES + '\n\n' +
    (retained ? retained + '\n\n' : '') + text.slice(end)
  // 已识别的旧默认包只替换逐字相同的存量片段，未知自定义文本保持原样。
  for (const [before, after] of LEGACY_DIALOGUE_FRAGMENTS) normalized = normalized.replace(before, after)
  normalized = normalized.replace(LEGACY_DIALOGUE_SENTENCES, CURRENT_DIALOGUE_SENTENCES)
    .replace(LEGACY_DIALOGUE_SENTENCES.replace(/\n/gu, '\r\n'), CURRENT_DIALOGUE_SENTENCES)
  return normalized
}

/** 口语表达、动作位置与对话避坑要求 */
export const DIALOGUE_RULES = `
${CHARACTER_VOICE_RULES}

${ORAL_EXPRESSION_RULES}

【动作按需，不给每句台词配动作】

先判断动作有没有必要，而不是按固定间隔添加或省略。对话已把意思和情绪表达清楚、说话人也能辨认时，可以直接接下一句对白或推进事件。放碗、抬头、看一眼等随手动作，若删去后不影响信息传达、人物塑造、情绪体验或后续行动，就直接省略，不换成另一个小动作占位。动作能推进情节、呈现台词未表达的人物反应、辨认说话人或交代必要的空间与因果关系时，再保留。

【动作位置服从事件顺序】
必要动作可以位于发言前、中、后，保持原有时间顺序与因果。无用途动作直接删，不为统一排版前置动作或打断完整发言。

【机械感对话 8 大避坑模式】

1. 每句都替作者讲解剧情（人物可以直接说重点，也可以有符合性格的回避和留白）
2. 台词+重复动作（所有男主都皱眉、所有女主都抿嘴 → 模板化）
3. 排比反问（"你以为你是谁？你凭什么？你配吗？"过于机械）
4. 无用途地反复用同一句话收束交流（普通的“好”“嗯”和直接回答按语境保留，不要求每次都机锋或继续加话）
5. 形容词堆砌（"你这卑鄙无耻下流的家伙！"）
6. 为口语感硬加"啊/嘛/啧/嘶"（按人物身份与情境使用，不要求每句都有）
7. 为显得真实硬加"嗯/呃/那个/就是"或故意打断完整句（停顿与省略须有语意用途）
8. 缺乏人物差异（只套教育程度或性格标签；措辞应结合性格、教育经历、身份、对象、当下情绪与场景，不把其中某一项作为唯一依据）

【对话核心要求】

${CURRENT_DIALOGUE_SENTENCES}

不强求加废话/口癖/动作，**但禁止一直是无信息量的废话**。
- 必要的信息交流、情绪消化、关系变化及符合人物与场合的幽默可保留，不把造梗、跑题或自相矛盾作为互动任务。
- 纯凑字、重复已知信息、无意义寒暄：禁止
`.trim()

/** 生成只需要对白落笔原则；独立对白检查继续使用上面的完整规则。 */
const CHAPTER_DIALOGUE_RULES = `
【真人对话特征：说话方式服从人设】
说话跟着眼下的关系、目的、情绪和已知信息走。普通的“好”“嗯”和直接回答按语境保留；有用的问答、配合、复问和转述可以展开。避免重复确认同一件事，不为显示个性硬加机锋或冲突。

【动作位置服从事件顺序】
对白与动作按真实发生的顺序写。动作能交代说话人、阻力、空间或有意义的反应时保留，无需给每句台词配动作。
`.trim()

/** 写作禁区：有效叙事、原创表达、人物与因果一致性。 */
export const NEGATIVE_CONSTRAINTS = `
【写作负向限制（结合连续场景判断）】
- 避免用人物轮流复述信息、列举无关动作或配角外貌补字数。可以保留服务于体验、关系或后果的细节。
- 不用无因巧合、突然取得的便利或无故失去防备制造转折。保留行动条件与真正付出的代价。
- 无论是否提供对标书，都必须使用原创表达。参考方法服务于本作，不能搬用具体桥段、台词或独特设定，也不得只替换人名、地名、道具做同义改写。
`.trim()

/** 描写节制与情节推进：单章续写和批量生成共用，避免资料中的模板要求覆盖正文写法。 */
export const NARRATIVE_FOCUS_RULES = `
【描写取舍与场景推进】
环境、心理与停顿用来呈现人物经历、关系、氛围及取舍；已经写清的内容无需换一种方式复述。充分展开重要的反应和结果，保留人物做得到的主动行动。悬念随已有矛盾产生，不为钩子硬加突发事件或无动机的等待。
`.trim()

/** 衔接检查原则（让 LLM 自检本章开头与上一章末尾的对接） */
export const CONTINUITY_RULES = `
【衔接检查原则】
从上章的实际状态或本章已写断点接起；没有前文时按设定与作者要求进入场景。转场交代必要的时间和位置，不跳过未完成的动作。伤势、资源与关系随实际变化延续。
`.trim()

/** 输出格式与字数要求 */
export const OUTPUT_RULES = `
【输出要求】

- 直接输出小说正文。出版用章节标题和章号由章节资料保存，解释、前言或后记另行交付。正文中的书信题头、题字等按剧情和作者要求保留。
${META_OUTPUT_LINE}
- **禁止**输出写作流程说明、技能调用说明、自检旁白、计划步骤（如「我会先…」「正在调用…技能」「随后输出正文」）
- **禁止**提及 story-long-write / story-short-write 等技能名或工具名；本提示已包含全部写作规则，无需再读外部技能
- 不要使用 Markdown 格式（不要 # 标题、不要 **加粗**、不要 \`代码块\`）
- 段落之间用空行分隔
- **字数以下文"写作任务"里给出的目标为参考，剧情完整与可读性优先**。偏短时先检查是否遗漏必要行动、因果、代价或情绪变化，仅补有用途的内容；剩余剧情点已经完整落实时允许提前结束，禁止为凑字数重复堆砌、机械扩写或添加无效铺陈
- **语言风格**：文笔必须为剧情服务。用符合本作语气的语言写清场景，删去无用途的修饰与解释。
- **对白排版**：按作者要求安排分段和标点；按事件顺序写有必要的动作，不给每句台词配动作，也不为了排版挪动动作。
${ENDING_OUTPUT_LINE}
`.trim()

/**
 * 续写模式覆盖声明。
 *
 * 上面那些守则是按「从零写整章」写的：衔接检查通篇讲「本章开头」、旧版自定义输出要求
 * 可能仍把目标字数定成硬性下限。续写需要按真实剧情进度决定停点，不能将一轮输出当作整章收尾
 * （开头已写好、字数只是本次增量、章可能还没到收尾的时候），而它们又允许被用户在设置里
 * 覆盖，逐条改内置文本既盖不全也会破坏用户自定义。
 *
 * 用续写口径覆盖整章的开头、篇幅和收束规则，保留作者指定的表达方式。
 */
export function buildContinueModeRules(mode: 'extend' | 'finish', hasChapterOutline = false): string {
  const lines: string[] = []
  lines.push('【续写模式】')
  lines.push('')
  lines.push(
    '本次**不是**从零写整章：本章的开头与前部已经写好了（见下文【本章已写正文前部】）。你的任务是**只输出接在前部之后的新正文**，一个字都不要重写前部。'
  )
  lines.push('')
  lines.push('以下只调整续写的接缝、范围、篇幅与收束；文风、对白和排版遵守作者明确要求。')
  lines.push(
    '- **承接已发生的变化**：接着前部末尾尚未解决的问题写；已确认的价格、身份、结果与态度不重新问答，不让同一批配角再轮流震惊。保留会改变条件、关系或决定的追问。延续前部的次数、库存、金钱与能力结算规则，不把尚未满足的扣减条件当作已经发生。不要把核对清单输出到正文。'
  )
  lines.push(
    '- **衔接检查 / "本章开头必须对接上一章"**：开头已经写好，禁止重写、复述或另起一个开头。本次只需让新写的第一句紧接【本章已写正文前部】末尾的时间、地点、人物状态。上一章的悬念与未完成事项，若前部已经回应过就不要再回应一遍。'
  )
  lines.push(
    '- **接缝起手（第一句写法）**：前部末尾若有未完成句子、台词或引号，先从断点续完，保留语法、说话人和语意，不得插入动作或另起一句打断；若末句已经完整，才根据情境接下一句对白、行动、感知或反应。不要复述前文末尾台词，也不要用泛化过渡拖延回应；不强制动作起手。'
  )
  if (hasChapterOutline) {
    lines.push('- **按细纲承接**：结合前部判断关键事件是已发生、进行中还是未开始。先续完进行中的关键情节，按因果向下写。可合写相关步骤，保留必需事件和结果。')
  }
  lines.push(
    '- **质量高于字数**：上文或自定义规则若仍要求"字数硬性下限 / 宁可写超也不要写不够"，本次一律改为篇幅参考。仅补足有叙事用途的内容，禁止为字数重复堆砌、机械扩写、无效铺陈或凭空新增事件；剩余剧情点已完整落实时可以提前结束，关键剧情尚未落实时不得只因字数已够而省略。'
  )
  if (mode === 'finish') {
    lines.push(
      '- **"目标字数是硬性下限 / 宁可写超也不要写不够"**：本次**不适用**。本章篇幅已接近参考目标，下文给出的字数仅供收尾参考，不能据字数认定剧情完成；为凑字数拉长反而是错。'
    )
    lines.push(
      '- **章末选择**：剩余剧情尚需展开时保留自然停点，不得跳点压缩；剧情完整后按题材与作者要求收束本章，对话、事件、动作、心理或平静收束均可，不强制悬念或突发事件。'
    )
  } else {
    lines.push(
      '- **目标字数**：下文给出的是**本次要新增**的篇幅参考，不是整章字数；已写前部不计入。情节已完整时允许少于参考字数，不得把字数缺口当作添加填充内容的理由。'
    )
    lines.push(
      '- **章末选择**：到达本章的自然停点时，按剧情、题材和作者要求收束，对话、事件、动作、心理或平静收束均可。若剧情点还没写完，本次应自然停在剧情推进中，**不要强行收尾**，也不要为了收尾而跳过没写的剧情点或硬加悬念。'
    )
  }
  return lines.join('\n').trim()
}

/** 可被用户在设置里覆盖的写作规则小节 key（题材定位与禁用高频词为目录驱动，不在此列） */
export type ChapterRuleKey =
  | 'output'
  | 'outline'
  | 'spoiler'
  | 'continuity'
  | 'ending'
  | 'style_targets'
  | 'deai'
  | 'dialogue'
  | 'negative'
  | 'narrative_focus'

/** 一条可编辑规则小节：UI 用 title+defaultText 展示与恢复默认，prompt 拼装用 key 取生效文本 */
export interface ChapterRuleSection {
  key: ChapterRuleKey
  title: string
  /** 内置默认正文（用户未覆盖时使用） */
  text: string
}

/**
 * 写作规则小节注册表——UI（标题 + 默认正文）与 buildSystemPrompt（取生效正文）的单一事实源。
 * 顺序即 prompt 中的呈现顺序。
 */
export const CHAPTER_RULE_SECTIONS: ChapterRuleSection[] = [
  { key: 'output', title: '输出要求', text: OUTPUT_RULES },
  { key: 'outline', title: '细纲遵守', text: OUTLINE_THREE_RULES },
  { key: 'spoiler', title: '防剧透', text: SPOILER_RULES },
  { key: 'continuity', title: '衔接检查', text: CONTINUITY_RULES },
  { key: 'ending', title: '章末收束', text: CHAPTER_ENDING_RULES },
  { key: 'deai', title: '自然准确的叙述', text: DEAI_TECHNIQUES },
  { key: 'style_targets', title: '句段节奏', text: STYLE_TARGETS },
  { key: 'dialogue', title: '对话规则', text: CHAPTER_DIALOGUE_RULES },
  { key: 'negative', title: '写作负向限制', text: NEGATIVE_CONSTRAINTS },
  { key: 'narrative_focus', title: '描写节制与情节推进', text: NARRATIVE_FOCUS_RULES }
]
