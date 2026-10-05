// Opt-in Electron renderer smoke test. Uses an isolated profile and test API;
// never reads model credentials or creates actual writing projects.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const electron = require('electron')
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (typeof electron === 'string') {
  const child = spawn(electron, [fileURLToPath(import.meta.url)], { cwd: repository, stdio: 'inherit', windowsHide: true })
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow } = electron
  const profile = mkdtempSync(join(tmpdir(), 'brainstorm-ui-'))
  app.setPath('userData', profile)
  const preload = join(profile, 'fixture-preload.cjs')
  writeFileSync(preload, `
    const test = window.__brainstormTest = { calls: [], creates: [], selects: [], projects: [], aborts: 0, errors: [] };
    window.addEventListener('error', event => test.errors.push(String(event.message)));
    window.addEventListener('unhandledrejection', event => test.errors.push(String(event.reason)));
    const noopSubscribe = () => () => {};
    window.api = {
      getTheme: async () => 'light', setTheme: async () => {},
      stopWatchProject: async () => {}, bindProjectWindow: async () => ({ ok: true }),
      onProjectFilesChanged: noopSubscribe, onAppUpdateState: noopSubscribe,
      getAppUpdateState: async () => ({ supported: false, status: 'idle', currentVersion: 'test', autoCheck: false }),
      listProjects: async () => test.projects, listChapters: async () => [],
      brainstormLongStory: (input, callback) => {
        let done, fail;
        const handle = new Promise((resolve, reject) => { done = resolve; fail = reject });
        const call = { input, callback, done, fail, aborted: false };
        test.calls.push(call);
        handle.abort = async () => { call.aborted = true; test.aborts++; return { ok: true } };
        return handle;
      },
      selectDirectory: () => new Promise((done, fail) => test.selects.push({ done, fail })),
      createProject: input => new Promise((done, fail) => test.creates.push({ input, done, fail })).then(project => { test.projects.push(project); return project })
    };
  `)
  app.on('window-all-closed', () => {})
  const results = []
  let win
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const check = (condition, description) => { if (!condition) throw new Error(description); results.push(description); console.log(`PASS ${description}`) }
  const js = source => win.webContents.executeJavaScript(source)
  async function waitFor(expression, description) {
    for (let i = 0; i < 100; i++) { if (await js(expression)) return; await delay(30) }
    throw new Error(`Timed out: ${description}`)
  }
  async function click(label, scope = 'document') {
    await js(`(() => { const root = ${scope}; const button = [...root.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)}); if (!button) throw new Error('Missing button: ' + ${JSON.stringify(label)}); button.click(); })()`)
    await delay(40)
  }
  async function navigateBrainstorm() {
    await js(`document.querySelectorAll('.nav-item').forEach(el => { if (el.textContent.trim().endsWith('脑洞')) el.click() })`)
    await waitFor(`!!document.querySelector('#brainstorm-genre')`, 'brainstorm page')
    await delay(80)
  }
  async function navigateShelf() {
    await js(`document.querySelectorAll('.nav-item').forEach(el => { if (el.textContent.trim().endsWith('我的项目')) el.click() })`)
    await waitFor(`document.querySelector('.main-inner h1')?.textContent === '我的书案'`, 'project shelf')
  }
  async function setValue(selector, value) {
    await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing field'); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await delay(35)
  }
  function ideas(prefix) {
    return [1, 2, 3].map(index => ({ title: `${prefix}${index}`, premise: `角色${index}以不同能力主动破局`, hook: '开篇取回报酬与资源', mainLine: '持续探索新矛盾', progression: '资源与关系逐步积累', twist: '早期线索揭示新选择', ending: '主角保留成果并完成目标' }))
  }
  const complete = (index, payload) => js(`window.__brainstormTest.calls[${index}].done(${JSON.stringify(payload)})`)
  const token = (index, text) => js(`window.__brainstormTest.calls[${index}].callback(${JSON.stringify(text)}, false)`)
  async function run() {
    const entry = join(repository, 'out/renderer/index.html')
    if (!existsSync(entry)) throw new Error('Build missing; run npm run build first')
    await app.whenReady()
    win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { preload, contextIsolation: false, sandbox: false, nodeIntegration: false } })
    await win.loadFile(entry)
    await waitFor(`document.querySelector('.main-inner h1')?.textContent === '我的书案'`, 'app boot')
    await navigateBrainstorm()
    check(await js(`document.querySelector('.main-inner h1').textContent === '脑洞'`), 'sidebar opens independent brainstorm page')
    await setValue('#brainstorm-chapters', '0')
    await click('生成 3 个脑洞')
    check(await js(`window.__brainstormTest.calls.length === 0 && document.body.textContent.includes('整数')`), 'invalid chapters do not invoke the model')
    await setValue('#brainstorm-genre', '玄幻')
    await setValue('#brainstorm-chapters', '200')
    await setValue('#brainstorm-reference', '一个具体参考')
    await setValue('#ls-brainstorm-direction-new', '主动破局')
    await setValue('#ls-brainstorm-requirements-new', '前期有收益')
    await js(`(() => { const button = [...document.querySelectorAll('button')].find(el => el.textContent === '生成 3 个脑洞'); button.click(); button.click() })()`)
    await delay(60)
    check(await js(`window.__brainstormTest.calls.length === 1 && document.querySelector('#brainstorm-genre').disabled`), 'double generate invokes once and locks conditions')
    check(await js(`(() => { const input = window.__brainstormTest.calls[0].input; return input.genre === '玄幻' && input.targetChapters === 200 && input.direction === '主动破局' && input.requirements === '前期有收益' && input.sourceBrief === '一个具体参考' })()`), 'all author conditions reach the API')
    await token(0, '完整生成文本')
    await complete(0, { ok: true, ideas: ideas('测试脑洞') })
    await waitFor(`document.querySelectorAll('.ss-brainstorm-idea').length === 3`, 'idea cards')
    await click('收藏', `document.querySelector('.ss-brainstorm-idea')`)
    await navigateShelf()
    await navigateBrainstorm()
    check(await js(`document.querySelectorAll('.ss-brainstorm-idea').length === 3 && document.body.textContent.includes('收藏 · 1') && document.querySelector('#brainstorm-genre').value === '玄幻'`), 'navigation restores ideas favorites and conditions')
    await click('换一批')
    check(await js(`window.__brainstormTest.calls[1].input.previousIdeas.length === 3`), 'next batch sends previous fingerprints')
    await token(1, '失败前的内容')
    await complete(1, { ok: false, error: '模拟网络错误' })
    await delay(60)
    check(await js(`document.querySelectorAll('.ss-brainstorm-idea').length === 3 && document.querySelector('#ls-brainstorm-raw-new').value === '失败前的内容'`), 'failed batch retains old cards and received text')
    await click('换一批')
    await token(2, '停止前的内容')
    await click('停止生成')
    await token(2, '不该出现的迟到内容')
    await complete(2, { ok: true, ideas: ideas('迟到方案') })
    await delay(60)
    check(await js(`document.body.textContent.includes('生成已停止') && !document.body.textContent.includes('迟到方案') && document.querySelector('#ls-brainstorm-raw-new').value === '停止前的内容'`), 'stop rejects late tokens and late completion')
    await click('换一批')
    await token(3, '离开前的内容')
    await navigateShelf()
    await navigateBrainstorm()
    await token(3, '离开后的迟到内容')
    await complete(3, { ok: true, ideas: ideas('旧页面迟到方案') })
    await delay(60)
    check(await js(`window.__brainstormTest.calls[3].aborted && document.body.textContent.includes('生成已停止') && document.querySelector('#ls-brainstorm-raw-new').value === '离开前的内容'`), 'leaving aborts generation and restores partial output')
    await click('采用这个脑洞', `document.querySelector('.ss-brainstorm-idea')`)
    await waitFor(`!!document.querySelector('.dialog')`, 'adoption dialog')
    check(await js(`document.querySelector('.dialog input').value === '测试脑洞1' && window.__brainstormTest.creates.length === 0`), 'adoption prefills a dialog without creating a project')
    await click('取消', `document.querySelector('.dialog')`)
    check(await js(`!document.querySelector('.dialog') && window.__brainstormTest.creates.length === 0`), 'cancel adoption leaves projects unchanged')
    await click('采用这个脑洞', `document.querySelector('.ss-brainstorm-idea')`)
    await setValue('.dialog input', '作者手改书名')
    await click('选择', `document.querySelector('.dialog')`)
    check(await js(`[...document.querySelector('.dialog').querySelectorAll('button')].find(el => el.textContent === '创建').disabled`), 'directory selection blocks premature creation')
    await js(`window.__brainstormTest.selects[0].fail(new Error('模拟目录选择失败'))`)
    await delay(60)
    check(await js(`document.querySelector('.dialog').textContent.includes('模拟目录选择失败')`), 'directory selection failure is visible and recoverable')
    await click('创建', `document.querySelector('.dialog')`)
    await js(`window.__brainstormTest.creates[0].fail(new Error('模拟写入失败'))`)
    await delay(60)
    check(await js(`document.querySelector('.dialog input').value === '作者手改书名' && document.querySelector('.dialog').textContent.includes('模拟写入失败')`), 'creation failure retains edited draft')
    await js(`(() => { const button = [...document.querySelector('.dialog').querySelectorAll('button')].find(el => el.textContent === '创建'); button.click(); button.click() })()`)
    await delay(60)
    check(await js(`window.__brainstormTest.creates.length === 2 && document.querySelector('#brainstorm-genre').disabled`), 'retry double click creates once and locks the background')
    await js(`(() => { const input = window.__brainstormTest.creates[1].input; window.__brainstormTest.creates[1].done({ ...input, id: 'smoke-project', createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }) })()`)
    await waitFor(`!document.querySelector('.dialog') && document.body.textContent.includes('已创建')`, 'creation success')
    check(await js(`(() => { const saved = JSON.parse(localStorage.getItem('ai-writer:long-story:brainstorm:project:smoke-project')); return saved.ideas.length === 3 && saved.favorites.length === 1 && !!localStorage.getItem('ai-writer:long-story:brainstorm:new') })()`), 'created project receives ideas and favorites while source remains')
    check(await js(`document.documentElement.scrollWidth <= window.innerWidth`), 'page does not overflow horizontally at desktop width')
    await navigateShelf()
    check(await js(`document.querySelectorAll('.project-card').length === 1 && document.body.textContent.includes('作者手改书名')`), 'created metadata project appears on the shelf')
    await click('+ 落笔开篇')
    check(await js(`document.querySelector('.dialog input').value === '' && !document.querySelector('.dialog .ss-brainstorm')`), 'ordinary new project stays independent from brainstorm')
    await click('取消', `document.querySelector('.dialog')`)
    await navigateBrainstorm()
    await js(`(() => { const original = Storage.prototype.setItem; window.__brainstormTest.restoreStorage = () => { Storage.prototype.setItem = original }; Storage.prototype.setItem = function(key, value) { if (key === 'ai-writer:long-story:brainstorm:new') throw new Error('模拟存储空间不足'); return original.call(this, key, value) } })()`)
    await click('取消收藏', `document.querySelector('.ss-brainstorm-idea')`)
    check(await js(`document.body.textContent.includes('收藏更改未能保存') && document.body.textContent.includes('收藏 · 1') && JSON.parse(localStorage.getItem('ai-writer:long-story:brainstorm:new')).favorites.length === 1`), 'failed favorite persistence keeps prior saved favorite')
    await js(`window.__brainstormTest.restoreStorage()`)
    await navigateShelf()
    await js(`localStorage.setItem('ai-writer:long-story:brainstorm:new', '')`)
    await navigateBrainstorm()
    await delay(650)
    check(await js(`localStorage.getItem('ai-writer:long-story:brainstorm:new') === '' && document.body.textContent.includes('原记录保留')`), 'empty corrupt record is not silently erased on mount')
    await setValue('#ls-brainstorm-direction-new', '作者明确重新编辑')
    await delay(650)
    check(await js(`JSON.parse(localStorage.getItem('ai-writer:long-story:brainstorm:new')).direction === '作者明确重新编辑'`), 'explicit editing safely replaces an unreadable record')
    check(await js(`window.__brainstormTest.errors.length === 0`), 'no uncaught renderer errors or promise rejections')
    writeFileSync(join(profile, 'result.json'), JSON.stringify({ passed: results.length, checks: results }, null, 2))
    console.log(`RESULT ${results.length} checks passed; isolated artifacts: ${profile}`)
    win.destroy()
    app.exit(0)
  }
  void run().catch(async error => {
    console.error(`FAIL ${error.message}`)
    if (win && !win.isDestroyed()) {
      try { writeFileSync(join(profile, 'failure.png'), (await win.webContents.capturePage()).toPNG()) } catch {}
      try { writeFileSync(join(profile, 'failure.txt'), await js(`document.body.innerText`)) } catch {}
    }
    console.error(`Artifacts: ${profile}`)
    app.exit(1)
  })
}
