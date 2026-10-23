// Isolated Electron UI smoke: fixture API only, never touches the user's novels/profile.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const electron = require('electron')
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (typeof electron === 'string') {
  const child = spawn(electron, [fileURLToPath(import.meta.url)], { cwd: repository, stdio: 'inherit', windowsHide: true })
  child.on('error', error => { console.error(error); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
} else {
  // Electron waits for the entry ESM to finish loading before emitting ready.
  // Keep app.whenReady inside an async function, not a top-level await.
  void runElectronSmoke()
}

async function runElectronSmoke() {
  const { app, BrowserWindow } = electron
  const profile = mkdtempSync(join(tmpdir(), 'prose-import-ui-'))
  app.setPath('userData', profile)
  const preload = join(profile, 'fixture.cjs')
  writeFileSync(preload, `
    const test = window.__importTest = { previews: [], commits: [], projects: [], errors: [], fail: false };
    window.addEventListener('error', e => test.errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', e => test.errors.push(String(e.reason)));
    const noop = () => () => {};
    window.api = {
      getTheme: async () => 'light', setTheme: async () => {},
      stopWatchProject: async () => {}, bindProjectWindow: async () => ({ok:true}),
      onProjectFilesChanged: noop, onAppUpdateState: noop,
      getAppUpdateState: async () => ({supported:false,status:'idle',currentVersion:'test',autoCheck:false}),
      listProjects: async () => test.projects, listChapters: async () => [],
      cancelProseImport: async () => {},
      previewProseImport: async request => {
        test.previews.push(request);
        if (test.fail) throw new Error('无法读取正文文件夹，请检查路径。');
        return { token:'fixture', suggestedName:'旧稿测试', fileCount:4, detectedCount:4,
          chapters:[{number:1,title:'初遇',source:'第001章.txt',excerpt:'第一章 初遇\\r\\n  “你好。”'}, {number:3,title:'来客',source:'第003章.md',excerpt:'第三章 来客\\n门被推开了。'}],
          duplicates:['第1章内容完全相同，仅导入一次。'], issues:['第4章存在不同版本，暂缓导入。'], missing:['第2章'] };
      },
      commitProseImport: async (token,name) => {
        test.commits.push({token,name});
        const project = {id:'imported',name,path:'E:\\\\小说库\\\\'+name,createdAt:new Date().toISOString(),lastOpenedAt:new Date().toISOString()};
        test.projects.push(project);
        return {project,importedCount:2,pendingCount:1};
      }
    };
  `)
  app.on('window-all-closed', () => {})
  let win
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const js = source => win.webContents.executeJavaScript(source)
  const check = (condition, label) => { if (!condition) throw new Error(label); console.log('PASS', label) }
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) { if (await js(expression)) return; await delay(30) }
    throw new Error('Timed out: ' + expression)
  }
  const click = async label => {
    await js(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!button || button.disabled) throw new Error('Button unavailable'); button.click(); })()`)
    await delay(40)
  }
  try {
    await app.whenReady()
    win = new BrowserWindow({ width: 1280, height: 950, show: false, webPreferences: { preload, contextIsolation: false, nodeIntegration: false, sandbox: false, offscreen: true, backgroundThrottling: false } })
    await win.loadFile(join(repository, 'out/renderer/index.html'))
    await waitFor(`document.body.textContent.includes('我的书案')`)
    await click('导入正文')
    await waitFor(`!!document.querySelector('#prose-import-name')`)
    check(await js(`document.querySelector('[aria-labelledby="prose-import-title"]').contains(document.activeElement)`), 'dialog receives keyboard focus')
    await click('选择正文文件（可多选）')
    await waitFor(`document.body.textContent.includes('可导入 2 章')`)
    check(await js(`window.__importTest.previews[0].mode === 'files'`), 'file selection invokes preview API')
    check(await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '导入 2 章').disabled`), 'partial import requires explicit acknowledgement')
    check(await js(`document.body.textContent.includes('第2章') && document.body.textContent.includes('不同版本')`), 'missing and conflicting chapters visible')
    await js(`document.querySelector('.prose-import-ack input').click()`)
    win.webContents.invalidate()
    await delay(250)
    const screenshot = join(profile, 'prose-import-preview.png')
    writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG())
    console.log('SCREENSHOT', screenshot)
    await click('导入 2 章')
    await waitFor(`document.body.textContent.includes('正文已导入')`)
    check(await js(`window.__importTest.commits.length === 1 && window.__importTest.commits[0].name === '旧稿测试'`), 'commit uses reviewed snapshot and book name')
    await click('完成，返回书案')
    await waitFor(`!document.querySelector('#prose-import-title')`)
    check(await js(`document.body.textContent.includes('旧稿测试') && document.body.textContent.includes('2 章正文')`), 'shelf refresh and completion notice')
    await click('导入正文')
    await click('选择文件夹')
    check(await js(`window.__importTest.previews.at(-1).mode === 'folder'`), 'folder selection supported')
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))`)
    await waitFor(`!document.querySelector('#prose-import-title')`)
    await click('导入正文')
    await js(`window.__importTest.fail = true`)
    await click('选择文件夹')
    check(await js(`document.querySelector('[role="alert"]')?.textContent.includes('检查路径')`), 'read failure displayed without losing the book shelf')
    check(await js(`window.__importTest.errors.length === 0`), 'no renderer exceptions')
    console.log('All prose import UI checks passed.')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally { win?.destroy(); app.exit(process.exitCode ?? 0) }
}
