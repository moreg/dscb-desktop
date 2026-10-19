/** 榜单标签规则：抓取、缓存、统计和界面共用；不依赖 Node。 */
export const FANQIE_CHART_TAG_RULES_VERSION = 'live-chart-audit-v12'
const nonTagPatterns = [
  "放心(?:观看|阅读|品鉴)|推荐|值得信赖|正经小说|^别管|^后期(?:变回|恢复)|(?:游戏|现实)较(?:多|少)",
  "^取材|^全新题材$|^(?:主角|男主|女主).*(?:天赋拉满|能力拉满)$|^(.)\\1{2,}$",
  "^(?:任务需要|(?:有的|每个|各个)[世也]界)|^(?:主角|男主|女主).*全文最|^(?:第)?[世也]界[零〇一二三四五六七八九十百0-9工]+(?:$|[、:：\\s])",
  "即将(?:上线|上架|播出)|(?:漫剧|短剧|影视|动漫)改编|改编(?:漫剧|短剧|影视|动漫)|^爱是|^反向把|^(?:他|她|地)拿着|^越.*越(?:美丽|危险)|^vs$",
  "简介|正文|短小无力|保证.*精彩|大伏笔|后期文|谢谢.*喜欢|感谢.*支持",
  "^(?:又名|别名|原名|曾用名|原书名|新书名|书名|发帖求助|求助)",
  "[：:。!！?？…\\r\\n]|评分|分数|涨分|会涨|刚开分|刚出分|分刚出|低分保护",
  "作者|读者|粉丝|码字|断更|日更|更新|完本|完结文|实体|出版|标签.*(?:问题|更改|有误)",
  "本书|本文|本小说|这本|这是|这是一|正在|已有|想看|来看|来看看|移步|跳转|作话|排雷|阅读预警",
  "请|勿入|慎入|勿考究|不喜|介意|放心(?:看|食用)|不要较真|不必在意|望周知|说三遍|致歉",
  "好看|好评|霸榜|顶级文笔|题材新颖|风格多样|停不下来|熬夜|不笑算我输|来捶我|干货知识满满",
  "(?:无|非|不|0|零|任何).*ai|ai.*(?:添加|生成)|手打|纯手工|纯手搓|手工制作|古法.*(?:码字|手搓)",
  "(?:不吃|吃|给人).*压力|承重墙成精|^(?:主角|男主|女主|男女主)(?:是|会|可以|根据|真有|自带|管理|绝不)",
  "^(?:每个世界|每个小世界|第一个世界|前期主|中后期|后期(?:公路|末日)|后面会|结局|背景是|核心是)",
  "(?:有时候|会有一些|内含大量|没看过|有兴趣|已上线|已签|前卷|开始起飞|全程高能)",
  "^(?:我|他|她|这是|正在|却被)|是我的|捡到的|才知道|全靠.*想象|看塑造|写着看|随便磕|皆可磕",
  "(?:已有|前|后|第)?\\d+章|\\d+次|\\d+个月零|^孕期|^去医院",
  "^(?:不是那种|一本|可能|这个|这不是|顺便|依旧.*这一块)|^以.*为主$|^前期女主|场景多$"
]
const nonTagExact = new Set([
  "刀尖上跳舞",
  "开局拒绝死亡",
  "逐渐疯狂动物园",
  "萌宠大黄",
  "原汁原味",
  "懂得都懂",
  "不服就爆",
  "上到鹰兔",
  "下到非洲小国",
  "不必在意",
  "世界杯第一桶金",
  "主抗战执行各种任务",
  "人联是主角小弟",
  "依旧强背景",
  "兔子急了也咬人",
  "全书古法纯手搓码字",
  "全员主角只有我是路人甲",
  "全文爽爽爽",
  "全民木屋求生开启",
  "全部是编的",
  "公会赛后个播",
  "创新",
  "原剧剧情大改",
  "原著向改写剧情",
  "发展科技现代化新城市",
  "可实操",
  "吃醋醋醋醋醋",
  "在涨",
  "坏女孩不放过",
  "堪比钟离假死",
  "大部分原创",
  "太初圣地大师兄陈安",
  "女宝就是最强的",
  "好女孩不辜负",
  "好看",
  "如有不适",
  "子不类父则父厌之",
  "子若类父则父疑之",
  "实则800个心眼子",
  "对眉嬛不好",
  "尽量不降智",
  "岁数极小但辈分极大",
  "工资既忠诚",
  "左手AK右手狙",
  "已有增益不消失",
  "带图",
  "带图片",
  "弹幕戏份多",
  "微系统可以忽略",
  "恨明月高悬不独照我",
  "想干嘛就干嘛",
  "护卫型将领第一人",
  "教巳但三三阴人",
  "时间线全拆",
  "有微量佛教和克苏鲁元素",
  "有点雄竞场面哟",
  "有自己的工作",
  "有配图",
  "朱元璋全家齐全",
  "正在随机分配四人寝室",
  "注意",
  "游街批斗叫嚣的某些干部",
  "灵台方寸山大师兄",
  "灵界进入地球战斗也是有的",
  "甚至还有点小温馨",
  "男主不同意分手",
  "疯批跟糙汉是两个人",
  "看广金手指",
  "真人真事",
  "真正意义上的联合部队",
  "硅胶填充的鼻子",
  "空间椰子水治百病长神力",
  "纯炫耀",
  "老登我回来了",
  "老角色出场",
  "赘婿的新定义",
  "这不是屎TvT",
  "配图",
  "隐世宗门无极宗",
  "颜色有点多",
  "饭香全靠恁们想象",
  "黑爷眼前一黑"
])
const nonTagMatchers = nonTagPatterns.map(pattern => new RegExp(pattern, 'i'))

export function isSelectableTag(value: string): boolean {
  const tag = value.trim().replace(/^[【[（(]+/, '').trim()
  return !!tag && !nonTagExact.has(tag) && !nonTagMatchers.some(pattern => pattern.test(tag))
}

export function introTags(intro: string): string[] {
  const tags: string[] = []
  for (const block of intro.matchAll(/(?:【[^【】\r\n]+】[\s+＋、,，]*)+/g)) {
    const groups = [...block[0].matchAll(/【([^【】\r\n]+)】/g)].map(match => match[1])
    const prefix = intro.slice(0, block.index).trim()
      .replace(/【[^【】]*】/g, '').trim()
      .replace(/[（(][^）)]*[）)]/g, '').trim()
      .replace(/[^。\n]*评分[^。\n]*(?:。|$)/g, '').trim()
      .replace(/又名[：:]\s*《[^》]+》|(?:标签|题材)[：:]/g, '').trim()
    const suffix = intro.slice(block.index + block[0].length).trim()
    if ((prefix && suffix) || /^[=＝]/.test(suffix) || /[=＝]$/.test(intro.slice(0, block.index).trimEnd())) continue
    for (let group of groups) {
      if (/[+＋]/.test(group) && !/[，,：:。.!！?？…—=]/.test(group)) {
        group = group.split(/[+＋]/).filter(isSelectableTag).join('+')
      }
      if (/作者|本书|本文|本小说|看文|毒点|已做修改|已.*重置|任务需要|(?:有的|每个|各个)[世也]界/.test(group)) continue
      // 带逗号的剧情、作者说明整段排除，避免拆出看似正常的形容词。
      if (/[,，]/.test(group) && group.split(/[,，]/).some(part => !isSelectableTag(part))) continue
      if (/[：:。.!！?？…—=]|评分|分数|涨分|会涨|手打|首发|全网唯一|无AI|无ai|模拟开始|模拟结束|模拟完成|推演完成|叮|获得|奖励|选项|以下|你|您|他们|她们|^(?:我|他|她|看着|于是|综合属性|跳下去|棺材里面|亲一下|招待客人|欢愉值)/.test(group)) continue
      for (const value of group.split(/[+＋,，、/|｜;；\s]+/)) {
        if (/^[\u4e00-\u9fffA-Za-z0-9]{1,12}$/.test(value) && !/^\d+$/.test(value)) tags.push(value)
      }
    }
  }
  return [...new Set(tags)].filter(isSelectableTag)
}

/** 来源标签单独保存，不把简介标签写回其中，避免换简介后残留旧标签。 */
export function cleanSourceTags(raw: unknown): string[] {
  const values = typeof raw === 'string' ? raw.split(/[,，、/|]/) : Array.isArray(raw) ? raw : []
  return [...new Set(values.filter((tag): tag is string => typeof tag === 'string')
    .map(tag => tag.trim()).filter(isSelectableTag))]
}

export function chartBookTags(book: { genre?: string; tags?: unknown; intro?: string }): string[] {
  return cleanSourceTags([book.genre ?? '', ...cleanSourceTags(book.tags), ...introTags(book.intro ?? '')])
}
