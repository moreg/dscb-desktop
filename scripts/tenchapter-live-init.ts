import { app } from 'electron'
import { promises as fs } from 'fs'
import { join, resolve, sep } from 'path'
import assert from 'node:assert/strict'
import { SecretStore } from '../src/main/data/secret-store'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { SettingsRepository } from '../src/main/data/settings-repository'
import { createWritingProject } from '../tests/helpers/writing-project'

export async function initialize(root: string, originalProfile: string) {
  const profile = join(root, 'profile')
  if (await fs.stat(join(root, 'project.json')).catch(() => null)) {
    const existing = JSON.parse(await fs.readFile(join(root, 'project.json'), 'utf8'))
    assert(existing.name === '十章实战进程恢复测试' &&
      resolve(existing.path).toLowerCase().startsWith((resolve(profile, 'projects') + sep).toLowerCase()),
    'Only the isolated ten-chapter test project may be resumed')
    return
  }
  const source = await new SecretStore(join(originalProfile, 'config', 'providers.enc')).read()
  const provider = source.providers.find(p => p.id === source.activeId)
  if (!provider || provider.protocol !== 'openai') throw new Error('实测要求已配置的默认 OpenAI 兼容 HTTP 模型')
  await new SecretStore(join(profile, 'config', 'providers.enc')).write({ activeId: provider.id,
    providers: [provider], featureRouting: Object.fromEntries(['chapter', 'refine', 'review', 'humanize', 'opening', 'auxiliary', 'ask']
      .map(k => [k, { providerId: provider.id }])) })
  const settings = new SettingsRepository(join(profile, 'config', 'settings.json'))
  const projects = new ProjectService(join(profile, 'projects'), new LibraryRepository(join(profile, 'library.json')), settings)
  const project = await createWritingProject(projects, { name: '十章实战进程恢复测试', genre: '悬疑', targetChapters: 1000, chapterWordCount: 1200 })
  const dir = project.path
  const plan = '全书主线：陆安和弟弟陆宁追查母亲余清莲失踪，必须循证找到母亲。前十章仅获得北塔账册中指向母亲去处的新线索，不得救回母亲、抓获赵伯或完成全书终局。第1-3章无人确认内应身份；第4章陆安独自读到签押密信才确认赵伯是内应，陆宁未见信而不知；第7章陆安当面交信解释后陆宁才知情。沈禾不知道赵伯身份，除非正文发生明确告知。铜钥匙第1章交沈禾保管，第5章当面取回，第8章用于开账柜；托管不是赠送。各章安排是未来计划，必须以此前实际成稿为历史。'
  await fs.writeFile(join(dir, '大纲', '大纲.md'), `# 北塔寻信\n\n## 主线剧情走向\n\n${plan}`)
  await fs.writeFile(join(dir, '设定', '核心设定.md'), '# 核心设定\n写实古代河港悬疑，无超自然力量。母亲失踪，兄弟从渡口查起，核心物证为铜钥匙、签押密信、北塔账册。出场固定为陆安、陆宁、沈禾；赵伯仅在信件中提及。信息必须有来源，猜测不等于证实。对白围绕现场分歧、核实证据与具体行动，自然推进，不额外发明同音人物。')
  for (const [name, role] of [['陆安', '26岁，哥哥，谨慎，会核对账目，目标是寻找失踪母亲余清莲。'],
    ['陆宁', '20岁，弟弟，行动快，易急躁，目标是与哥哥找母亲；开篇不知道内应身份。'],
    ['沈禾', '渡口船主，28岁，与兄弟有旧交，只知道渡口的具体通行情形，开篇不知道内应身份。']]) {
    await fs.writeFile(join(dir, '设定', '角色', `${name}.md`), `# ${name}\n\n## 基本信息\n- **姓名**：${name}\n- **首次出场**：第1章\n- **身份**：${role}`)
  }
  const plots = [
    ['渡口托管一把铜钥匙', '陆安、陆宁在渡口与沈禾会合，母亲失踪留下铜钥匙；陆安为避搜查当面将钥匙托付沈禾保管，明确不是赠送，约好取回。三人只查母亲去向，尚不知道内应身份；章末决定核对渡船登记。'],
    ['船票背面留下了疑点', '承接托管钥匙，陆安与陆宁核对母亲搭船留下的票根，沈禾提供登船时刻，发现登记有一处涂改。只能怀疑有人动手脚，不能确认赵伯是内应。兄弟决定找涂改前的副页。'],
    ['旧簿夹层藏着一封信', '三人在渡口库房找到登记副页，陆宁负责在外守门，陆安发现封口完好的信件。检查信封来源而不读其秘密内容；章末陆安带信回小屋，准备单独拆阅。不得提前揭晓赵伯身份。'],
    ['独自拆信认出了签押', '陆安独自在小屋拆信，核对赵伯签押和旧账，明确确认赵伯是内应。陆宁始终在渡口看守行李，没有看到信、没有收到消息，仍不知内应身份。陆安暂藏真相，决定先取钥匙去北塔核查母亲账册。沈禾也未获告知。'],
    ['当面取回托管的钥匙', '陆安与陆宁向沈禾取回第1章托管的铜钥匙，沈禾当面交还，核验钥匙无更换，持有者由沈禾变回陆安。陆宁还不知道赵伯身份，只知道要找母亲账册，不能凭空说出密信细节。'],
    ['北塔外墙找到了旧路', '兄弟带钥匙到北塔外，核对楼墙旧痕与渡口登记路线，确认一条入塔路线，不开账柜。陆宁对哥哥隐瞒信息有所疑问，只能怀疑，不知赵伯身份。章末陆安决定把已经核实的真相告诉弟弟。沈禾留在渡口，不参与私谈。'],
    ['把签押密信交给弟弟', '陆安在僻静处将第4章密信当面递给陆宁，解释签押与账目，陆宁读信复核后才确认赵伯是内应。认知变化必须写出完整信息路径；沈禾不在场，仍未获告知。兄弟决定共同取账册证实母亲去向。'],
    ['铜钥匙终于打开账柜', '兄弟按已确认路线进入北塔，以陆安持有的铜钥匙打开旧账柜，取出母亲曾经经手的账册。两人已知赵伯身份但尚未找到母亲。不凭一把钥匙打开所有机关，不销毁账册。'],
    ['账页上的旧地名被改了', '兄弟核对账册与船票，发现母亲相关的一处地名被改动，用墨痕和登记日期定位到改动前的旧地名。只查出下一处调查方向，不能确认母亲已获救，不能突然带她登场。'],
    ['带着账册离开北塔', '兄弟将真实账册与密信妥善带离北塔，确认下一步沿旧地名查母亲下落。沈禾在渡口接应，兄弟只告知需要赶路，未向她揭露赵伯身份。章末寻母仍未完成，钥匙和账册仍由陆安保管，不能大结局。']
  ]
  if (process.env.TENCHAPTER_SCENARIO === 'entity-write') {
    plots[3][1] += ' 本章在小屋实际使用两件明确命名的新道具：松木信匣用于暂放拆阅前的原信，青布封套用于装好拆阅后的原信。两者是普通收纳物，没有额外秘密或机关；必须写出实际使用过程，命名保持准确，不能只在计划中提及。'
  }
  for (const [i, [title, plot]] of plots.entries()) {
    const n = i + 1
    await fs.writeFile(join(dir, '细纲', `细纲_第${String(n).padStart(3, '0')}章_${title}.md`),
      `# 细纲\n\n## 第 ${n} 章：${title}\n\n- **核心事件**：${plot}\n- **出场人物**：陆安、陆宁${[1,2,3,5,10].includes(n) ? '、沈禾' : ''}\n- **字数**：1200字\n- **写作要求**：只展开本章事件，不能抢写后章，不重复已经完成的交接或认知揭晓；此前正文为事实，本章细纲为计划。`)
  }
  await fs.writeFile(join(dir, '图解', '节奏图谱.html'), `<html><script>const rhythmData = ${JSON.stringify(plots.map(([title], i) => ({
    chapter: i + 1, title, emotion: 5, climax: 1, volume: 1, actualized: false
  })))};</script></html>`)
  await fs.writeFile(join(root, 'project.json'), JSON.stringify(project, null, 2))
  await fs.writeFile(join(root, 'model.json'), JSON.stringify({ label: provider.label, model: provider.model,
    protocol: provider.protocol, note: '全部路由仅在隔离profile指向既有默认模型；实际主程序启动，所有默认写后服务启用。' }, null, 2))
  console.log('ISOLATED_PROJECT_READY', project.id, app.getPath('userData'))
}
