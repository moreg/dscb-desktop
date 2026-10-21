const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const root = process.env.TENCHAPTER_LIVE_DIR
if (!root) throw new Error('Explicit isolated test root required')
app.setPath('userData', path.join(root, 'profile'))
const pid = process.pid
const entityScenario = process.env.TENCHAPTER_SCENARIO === 'entity-write'
// An explicit retry fixture may use a different genuinely extracted prop. Never
// synthesize extraction results or create cards from the test driver.
const retryPlanFile = path.join(root, 'entity-retry-plan.json')
const retryPlan = fs.existsSync(retryPlanFile) ? JSON.parse(fs.readFileSync(retryPlanFile, 'utf8')) : null
const entityTargets = retryPlan?.targetNames || ['松木信匣', '青布封套']
let chapter = 1, stage = '', sequence = 0, windowRef
const log = (event, extra = {}) => {
  fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ event, pid, chapter, stage, time: new Date().toISOString(), ...extra }) + '\n')
}
const fetchActual = global.fetch
// Observe the real atomic commit without replacing its output. Hold the writer
// immediately after the second target card exists, until the OS kills this process.
const renameActual = fs.promises.rename.bind(fs.promises)
fs.promises.rename = async (from, to) => {
  const result = await renameActual(from, to)
  if (entityScenario && chapter === 4 && !fs.existsSync(path.join(root, 'kill-result-entity.json'))) {
    const projectFile = path.join(root, 'project.json')
    if (fs.existsSync(projectFile)) {
      const p = JSON.parse(fs.readFileSync(projectFile, 'utf8'))
      const dir = path.join(p.path, '记忆', '道具')
      if (entityTargets.map(name => path.join(dir, name + '.md')).includes(String(to))) {
        log('actual-entity-atomic-commit', { file: path.relative(p.path, String(to)) })
        if (entityTargets.every(name => fs.existsSync(path.join(dir, name + '.md')))) {
          fs.writeFileSync(path.join(root, 'crash-ready-entity.json'), JSON.stringify({ pid, chapter, file: String(to), time: Date.now(), phase: 'entity committed, writer not returned' }))
          await new Promise(() => {})
        }
      }
    }
  }
  return result
}
const handleActual = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => handleActual(channel, async (...args) => {
  if (channel === 'write:generateBatch' || channel === 'write:resumeBatch') {
    chapter = args[1].fromChapter
    log('batch-request', { channel, input: args[1] })
  }
  const result = await listener(...args)
  if (channel === 'write:generateBatch' || channel === 'write:resumeBatch') {
    log('batch-result', { channel, result })
    fs.writeFileSync(path.join(root, 'batch-result.json'), JSON.stringify(result, null, 2))
  }
  return result
})
global.fetch = async (input, init) => {
  let body
  try { body = JSON.parse(init?.body) } catch {}
  const id = `${pid}-${String(++sequence).padStart(4, '0')}`
  if (body?.messages) {
    const text = body.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n')
    const kind = /你是番茄小说风格的资深中文网文作者/.test(text) ? 'chapter'
      : text.includes('请从下面的小说正文中提取本章新增的记忆信息') ? 'memory'
      : text.includes('长期一致性') ? 'longform' : 'other'
    const checkedChapter = text.match(/核对第\s*(\d+)\s*章的长期一致性/)
    fs.writeFileSync(path.join(root, 'calls', id + '-request.json'), JSON.stringify({ pid, chapter: checkedChapter ? Number(checkedChapter[1]) : chapter, stage, kind, body }, null, 2))
    log('model-start', { id, kind })
    if (!entityScenario && kind === 'memory' && chapter === 4 && !fs.existsSync(path.join(root, 'kill-result.json'))) {
      fs.writeFileSync(path.join(root, 'crash-ready.json'), JSON.stringify({ pid, chapter, id, time: Date.now() }))
      windowRef?.webContents.executeJavaScript('JSON.stringify(localStorage)').then(data => fs.writeFileSync(path.join(root, 'storage-before-kill.json'), data)).catch(() => {})
    }
    if (!entityScenario && chapter === 7 && /请根据第\s*7\s*章的实际正文生成供后续章节续写使用的章节概要/.test(text) &&
        !fs.existsSync(path.join(root, 'kill-result-7.json'))) {
      fs.writeFileSync(path.join(root, 'crash-ready-seven.json'), JSON.stringify({ pid, chapter, id, time: Date.now() }))
    }
  }
  const response = await fetchActual(input, init)
  if (body?.messages) {
    response.clone().text().then(text => {
      fs.writeFileSync(path.join(root, 'calls', id + '-response.txt'), text)
      log('model-end', { id, status: response.status })
    }).catch(error => log('model-body-error', { id, error: error.message }))
  }
  return response
}

app.on('web-contents-created', (_event, wc) => {
  const actualSend = wc.send.bind(wc)
  wc.send = (channel, ...args) => {
    const payload = args[0]
    if (channel === 'write:batchGenerationStage') { chapter = payload.chapterNumber; stage = payload.stage; log('stage') }
    if (channel === 'write:batchChapterComplete') {
      log('chapter-complete', { result: payload.result, number: payload.chapter })
      fs.writeFileSync(path.join(root, `chapter-${payload.chapter}-result.json`), JSON.stringify(payload.result, null, 2))
    }
    return actualSend(channel, ...args)
  }
  wc.on('did-finish-load', async () => {
    if (!wc.getURL().startsWith('file:')) return
    windowRef = BrowserWindow.fromWebContents(wc)
    const p = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'))
    if (!wc.getURL().includes('projectId=')) {
      const url = new URL(wc.getURL()); url.searchParams.set('projectId', p.id)
      setTimeout(() => { if (!wc.isDestroyed()) wc.loadURL(url.toString()).catch(error => log('navigation-error', { error: error.message })) }, 100)
      return
    }
    const restarting = fs.existsSync(path.join(root, 'kill-result.json')) || fs.existsSync(path.join(root, 'kill-result-entity.json'))
    log('renderer-loaded', { restarting })
    let opened = false, launched = false, editing = false
    const poll = setInterval(async () => {
      if (wc.isDestroyed()) { clearInterval(poll); return }
      try {
        if (entityScenario && retryPlan && !restarting && !fs.existsSync(path.join(root, 'entity-retry-prepared.json'))) {
          if (editing) return
          editing = true
          const prepared = await wc.executeJavaScript(`(async () => {
            const id=${JSON.stringify(p.id)}, plan=${JSON.stringify(retryPlan)};
            const chapter=await window.api.getChapter(id,4);
            const item=(await window.api.listMemoryEntities(id,'item')).find(x=>x.name===plan.protectedName);
            if(!item) throw new Error('缺少真实提取的待保护实体');
            await window.api.updateMemoryEntity(id,'item',item.id,{notes:plan.prepareProtectedNotes});
            const replace=value=>typeof value==='string'?plan.prepareReplacements.reduce((s,[a,b])=>s.replaceAll(a,b),value):Array.isArray(value)?value.map(replace):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v)])):value;
            const outline=(await window.api.listDetailedOutline(id)).find(x=>x.chapterNumber===4);
            await window.api.updateDetailedOutline(id,4,replace(outline));
            const content=replace(chapter.content);
            if(content===chapter.content) throw new Error('准备修订未改变真实正文');
            await window.api.updateChapterContent(id,4,content);
            return {oldProse:chapter.content,editedProse:content,protectedItemId:item.id};
          })()`)
          fs.writeFileSync(path.join(root,'entity-retry-prepared.json'),JSON.stringify({pid,time:new Date().toISOString(),...prepared},null,2))
          log('entity-fixture-revised-through-app-ipc')
          editing = false
        }
        if (entityScenario && restarting && !fs.existsSync(path.join(root, 'author-edits.json'))) {
          if (editing) return
          editing = true
          const edited = await wc.executeJavaScript(`(async () => {
            const id = ${JSON.stringify(p.id)};
            const replacements=${JSON.stringify(retryPlan?.replacements || [['松木信匣','桐木信匣'],['青布封套','棉布封套']])};
            const obsoleteName=${JSON.stringify(retryPlan?.obsoleteName || '松木信匣')}, protectedName=${JSON.stringify(retryPlan?.protectedName || '青布封套')};
            const replace = value => typeof value === 'string' ? replacements.reduce((s,[a,b])=>s.replaceAll(a,b),value)
              : Array.isArray(value) ? value.map(replace) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v)])) : value;
            const chapter = await window.api.getChapter(id,4);
            if (!replacements.every(([a])=>chapter.content.includes(a))) throw new Error('作者修订前缺少实际道具');
            const content = replace(chapter.content);
            const items = await window.api.listMemoryEntities(id,'item');
            const protectedItem = items.find(x=>x.name===protectedName);
            const obsoleteItem = items.find(x=>x.name===obsoleteName);
            if (!protectedItem || !obsoleteItem) throw new Error('两张实际新增卡片尚未落盘');
            const protectedNotes = ${JSON.stringify(retryPlan?.protectedNotes || '作者手动保留资料：第4章初稿曾使用青布封套；修订稿已改为棉布封套。此卡作为创作历史留档，不作为当前正文事实。')};
            await window.api.updateMemoryEntity(id,'item',protectedItem.id,{notes:protectedNotes});
            const chars = await window.api.listCharacters(id);
            const character = chars.find(x=>x.name==='陆安');
            const beforePosition = character?.customFields?.['位置'];
            if (!character || typeof beforePosition!=='string' || !beforePosition) throw new Error('缺少前章已更新的位置字段');
            const protectedPosition = '第3章观察留档：'+beforePosition+'；作者手动校订保留，非第4章当前位置。';
            await window.api.updateCharacter(id,character.id,{customFields:{位置:protectedPosition}});
            const outlines = await window.api.listDetailedOutline(id);
            const outline = outlines.find(x=>x.chapterNumber===4);
            if (!outline) throw new Error('缺少实际第4章细纲');
            await window.api.updateDetailedOutline(id,4,replace(outline));
            await window.api.updateChapterContent(id,4,content);
            return {chapterNumber:4,replacements,obsoleteName,protectedName,oldProse:chapter.content,editedProse:content,protectedItemId:protectedItem.id,
              obsoleteItemId:obsoleteItem.id,protectedNotes,characterId:character.id,beforePosition,protectedPosition,
              itemsAfter:await window.api.listMemoryEntities(id,'item'),charactersAfter:await window.api.listCharacters(id)};
          })()`)
          const protectedFileHash = createHash('sha256').update(fs.readFileSync(path.join(p.path,'记忆','道具','青布封套.md'))).digest('hex')
          const fixturePreparation = fs.existsSync(path.join(root,'entity-retry-prepared.json')) ? JSON.parse(fs.readFileSync(path.join(root,'entity-retry-prepared.json'),'utf8')) : undefined
          fs.writeFileSync(path.join(root, 'author-edits.json'), JSON.stringify({pid,time:new Date().toISOString(),...edited,protectedFileHash,fixturePreparation},null,2))
          log('author-edits-through-app-ipc', { chapter:4 })
          editing = false
        }
        const commandFile = path.join(root, 'command.json')
        if (fs.existsSync(commandFile)) {
          const command = JSON.parse(fs.readFileSync(commandFile, 'utf8'))
          fs.unlinkSync(commandFile)
          if (command.action === 'quit') { app.quit(); return }
          if (command.action === 'eval') {
            const result = await wc.executeJavaScript(command.code)
            fs.writeFileSync(path.join(root, 'command-result.json'), JSON.stringify({ id: command.id, result }, null, 2))
          }
        }
        const state = await wc.executeJavaScript(`(() => {
          const buttons = [...document.querySelectorAll('button')].map(b=>({text:b.textContent.trim(),disabled:b.disabled}));
          return {buttons, text:document.body.innerText, storage:JSON.stringify(localStorage)};
        })()`)
        fs.writeFileSync(path.join(root, 'ui-current.json'), JSON.stringify(state, null, 2))
        if (!opened) {
          const target = state.buttons.find(b => b.text === '⚡ 一键写 10 章' && !b.disabled)
          if (target) {
            await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='⚡ 一键写 10 章').click()`)
            opened = true; log('open-ten-chapter-dialog'); return
          }
        } else if (!launched) {
          const target = state.buttons.find(b => !b.disabled && /^(重试第 \d+ 章检查|继续.*章|从第.*章|一键写 10 章)$/.test(b.text))
          if (target) {
            if (restarting) fs.writeFileSync(path.join(root, 'storage-after-restart.json'), state.storage)
            if (restarting) fs.writeFileSync(path.join(root, `storage-after-restart-${pid}.json`), state.storage)
            if (restarting) fs.writeFileSync(path.join(root, `restored-ui-${pid}.png`), (await wc.capturePage()).toPNG())
            await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(target.text)}).click()`)
            launched = true; log(restarting ? 'resume-ui-click' : 'start-ui-click', { button: target.text })
          }
        }
        if (launched && !state.buttons.some(b => /生成中|停止/.test(b.text)) && /已完成|等待|重试|继续/.test(state.text)) {
          fs.writeFileSync(path.join(root, 'ui-settled.json'), JSON.stringify(state, null, 2))
        }
      } catch (error) { log('ui-poll-error', { error: error.message }) }
    }, 1500)
  })
})

app.whenReady().then(async () => {
  await require(path.join(root, 'init.cjs')).initialize(root, process.env.LONGFORM_USER_DATA)
  log('actual-main-start')
  require(process.env.TENCHAPTER_APP_MAIN)
}).catch(error => { log('fatal', { error: error.message }); app.exit(1) })
