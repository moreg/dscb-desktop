// Opt-in real Chromium UI checks with an isolated browser and an in-memory API.
// Run: PLAYWRIGHT_MODULE=/path/to/playwright node scripts/web-mobile-smoke.mjs
// Optional CHROMIUM_PATH selects a system browser. No project or model calls leave this fixture.
import { createRequire } from 'node:module'
import { createServer } from 'vite'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ configFile: resolve('vite.web-renderer.config.ts'),
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'mobile-smoke-fixture',
    resolveId(id) { if (id === 'virtual:mobile-smoke') return '\0virtual:mobile-smoke' },
    load(id) {
      if (id !== '\0virtual:mobile-smoke') return
      return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import App from '/src/App.tsx'; import WebGate from '/src/web-gate.tsx';
        import '/src/design.css'; import { installWebViewport } from '/src/web-viewport.ts';
        if (window.__DSCB_WEB__) { document.documentElement.classList.add('dscb-web'); installWebViewport(); }
        createRoot(document.getElementById('root')).render(React.createElement(location.search.includes('login') ? WebGate : App));`
    },
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__mobile-smoke.html')) return next()
      const html = await vite.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body><div id="root"></div><script type="module" src="/@id/__x00__virtual:mobile-smoke"></script></body></html>')
      res.setHeader('Content-Type', 'text/html'); res.end(html)
    }) }
  }]
})
let browser
const output = process.env.MOBILE_SMOKE_OUTPUT || '/tmp/dscb-mobile-smoke'
const passed = []

async function checkRefinement(page, width) {
  const panel = page.locator('.refinement-panel')
  await panel.getByRole('tab', { name: '精修设置' }).click()
  await panel.getByLabel('补充要求', { exact: false }).fill('保留结果，让表达更自然。')
  await panel.getByRole('button', { name: '生成精修候选', exact: true }).click()
  await panel.locator('#refinement-result:not([hidden])').waitFor()
  check(await panel.getByRole('button', { name: '采用并保存', exact: true }).isEnabled(), `${width}: verified candidate opens in comparison tab`)
  await panel.getByRole('button', { name: '完整对比', exact: true }).click()
  check(await panel.locator('.refinement-full').isVisible(), `${width}: full manuscript comparison available`)
  check(await panel.locator('.refinement-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${width}: comparison has no horizontal overflow`)
  await page.screenshot({ path: `${output}/refinement-result-${width}.png` })
  await panel.getByRole('tab', { name: '精修设置' }).click()
  check(await panel.getByLabel('补充要求', { exact: false }).inputValue() === '保留结果，让表达更自然。', `${width}: settings survive tab switching`)
  await panel.getByLabel('主要目标', { exact: false }).selectOption('detection')
  await panel.getByLabel('标黄原文 1', { exact: false }).waitFor()
  await page.screenshot({ path: `${output}/refinement-detection-${width}.png` })
  await panel.getByLabel('主要目标', { exact: false }).selectOption('expression')
  await page.evaluate(() => { window.__refineReject = true })
  await panel.getByRole('button', { name: '重新生成候选', exact: true }).click()
  await panel.locator('#refinement-result:not([hidden])').waitFor()
  check(await panel.getByRole('button', { name: '采用并保存', exact: true }).isDisabled(), `${width}: rejected candidate cannot be adopted wholesale`)
  await panel.getByRole('tab', { name: '精修设置' }).focus()
  await page.keyboard.press('ArrowRight')
  check(await panel.getByRole('tab', { name: '候选对照' }).getAttribute('aria-selected') === 'true', `${width}: comparison tabs support keyboard navigation`)
  if (width > 1024) {
    const bounds = await panel.boundingBox()
    await page.mouse.move(bounds.x + 100, bounds.y + 25); await page.mouse.down()
    await page.mouse.move(bounds.x + 100, 990); await page.mouse.up()
    const moved = await panel.boundingBox()
    check(moved.y + moved.height <= 1000, 'desktop dragging keeps footer inside the viewport')
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    await page.screenshot({ path: `${output}/refinement-dark.png` })
  }
}

const check = (value, message) => { assert.ok(value, message); passed.push(message); console.log(`PASS ${message}`) }
try {
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__mobile-smoke.html`
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] })
  await mkdir(output, { recursive: true })
  for (const [width, height, touch, desktop] of [[320, 740, true, false], [390, 844, true, false], [844, 390, true, false], [1440, 1000, false, false], [390, 844, false, true]]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', error => { errors.push(error.message); console.error('BROWSER', error.message) })
    await page.addInitScript(({ desktop }) => {
      window.__DSCB_WEB__ = !desktop
      window.__mobileSaved = []
      const meta = { schemaVersion: 1, chapterNumber: 1, title: '院门交接', status: 'draft', wordCount: 16, updatedAt: new Date().toISOString() }
      const project = { id: 'test-project', name: '手机写作测试', genre: '玄幻', status: 'ongoing', createdAt: '', updatedAt: '', lastOpenedAt: '' }
      let content = '林远推开院门，将账册放在守门人的桌上。'
      const api = {
        getTheme: () => 'light', getProject: () => project, listProjects: () => [project], listChapters: () => [meta],
        bindProjectWindow: () => ({ ok: true }), watchProject: () => true,
        getAppUpdateState: () => ({ supported: false, status: 'idle', currentVersion: 'test', autoCheck: false }),
        getChapter: () => ({ content, meta }), getChapterRepairProposal: () => null,
        updateChapterContent: (_p, _n, text) => { content = text; window.__mobileSaved.push(text); return meta },
        getPomodoroConfig: () => ({ focus: 25, brk: 5 }), getDailyWordGoal: () => 3000,
        getWriteAuditConfig: () => ({ mode: 'off' }), getCostAlertConfig: () => ({ enabled: false }),
        getUsageSummary: () => ({ today: { cost: 0 }, month: { cost: 0 }, total: { cost: 0 } }),
        listProviders: () => ({ activeId: null, providers: [], featureRouting: {} }),
        readDraft: () => null, loadRefinement: () => null, getChapterSummary: () => null,
        refineChapter: (input, action) => Object.assign(Promise.resolve(action === 'plan' ? { ok: true, plan: '保留交接结果，减少直白解释。' } : { ok: true, candidate: {
          version: 1, id: 'ui-candidate', input, baseRevision: '', contextHash: '', candidate: input.content + '\n\n他合上账册，等对方先开口。',
          changes: ['调整句式，让行动自然衔接。'], attempts: 1, status: window.__refineReject ? 'rejected' : 'ready', updatedAt: '',
          verdict: { passed: !window.__refineReject, factsPreserved: !window.__refineReject, goalMet: true,
            assessment: window.__refineReject ? '候选包含待确认的行为变化，请对照后决定。' : '保留原文信息，句式与衔接更自然。',
            issues: window.__refineReject ? ['存在待确认改动'] : [], evidence: [{ before: input.content, after: '他合上账册，等对方先开口。', reason: '调整接话节奏。' }] }
        } }), { abort: async () => ({ ok: true }) }),
        auditChapter: () => ({ violations: [], counts: { error: 0, warn: 0, info: 0 }, wordCount: 16 }),
        getReviewRules: () => ({ config: { enabled: false }, custom: [] }), getAutoPostWritePipeline: () => 'off',
        getWritingRequirementTemplates: () => [], getDeslopRules: () => ({}), getRhythm: () => [],
        getAppVersion: () => 'test', getAutoMemorySync: () => false,
        getChapterVersions: () => [], listChapterVersions: () => []
      }
      window.api = new Proxy(api, { get: (target, key) => {
        if (String(key).startsWith('on')) return () => () => {}
        if (key === 'refineChapter') return target[key]
        if (key in target) return async (...args) => target[key](...args)
        return async () => []
      } })
    }, { desktop })
    if (desktop) await page.route('**/web-flag.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }))
    await page.route('**/api/session', route => route.fulfill({ status: 401, body: '{}' }))
    if (!desktop && width === 320) {
      await page.goto(url + '?login'); await page.locator('.web-gate-card').waitFor()
      const login = await page.locator('.web-gate-card').boundingBox()
      check(login.x >= 0 && login.x + login.width <= width + 1, '320: login fits narrow viewport')
    }
    await page.goto(url)
    await page.locator('.project-grid').waitFor()
    if (width <= 1024 && !desktop) {
      await page.locator('.web-mobile-menu').tap()
      check(await page.locator('main').evaluate(el => el.inert), `${width}: navigation isolates background`)
      check(await page.locator('.web-mobile-close').evaluate(el => el === document.activeElement), `${width}: menu focuses close button`)
      await page.keyboard.press('Shift+Tab')
      check(await page.locator('.sidebar').evaluate(el => el.contains(document.activeElement)), `${width}: navigation traps focus`)
      await page.keyboard.press('Escape')
      check(await page.locator('.web-mobile-menu').evaluate(el => el === document.activeElement), `${width}: closing menu restores focus`)
      const card = page.locator('.project-grid').locator('.project-card').first()
      await card.click()
      await page.locator('.chapter-row').first().click()
      await page.locator('textarea.editor-text').waitFor()
      check(await page.locator('.chapter-workbench').evaluate(el => el.querySelector('.chapter-main-pane').getBoundingClientRect().top <= el.querySelector('.chapter-side-block').getBoundingClientRect().top), `${width}: prose precedes reference panels`)
      check(await page.locator('.chapter-main-pane').evaluate(el => el.querySelector('textarea.editor-text').getBoundingClientRect().top < el.querySelector('.chapter-outline-panel-above').getBoundingClientRect().top), `${width}: outline follows prose`)
      check(await page.locator('.mobile-tools-toggle').isVisible(), `${width}: compact editor tools`)
      check(!await page.getByRole('button', { name: '📜 历史版本', exact: true }).isVisible(), `${width}: secondary tools initially collapsed`)
      await page.getByRole('button', { name: '写正文 ↓', exact: true }).click()
      await page.locator('textarea.editor-text').fill('手机端编辑后保存的正文。')
      await page.locator('.editor-toolbar').getByRole('button', { name: '保存 ·', exact: true }).click()
      await page.waitForFunction(() => window.__mobileSaved.includes('手机端编辑后保存的正文。'), null, { timeout: 15000 })
      check(await page.locator('.main-content').evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${width}: editor has no horizontal overflow`)
      await page.screenshot({ path: `${output}/editor-${width}.png` })
      if (width === 390) {
        await page.setViewportSize({ width: 1200, height: 900 })
        await page.waitForFunction(() => !document.documentElement.classList.contains('dscb-mobile'))
        check(!await page.locator('.mobile-tools-toggle').isVisible(), 'resizing to wide web hides mobile tools')
        await page.setViewportSize({ width, height })
        await page.waitForFunction(() => document.documentElement.classList.contains('dscb-mobile'))
        check(await page.locator('textarea.editor-text').inputValue() === '手机端编辑后保存的正文。', 'rotation preserves manuscript')
      }
      await page.getByRole('button', { name: '流程面板', exact: true }).click()
      await page.locator('.chapter-flow-panel').waitFor()
      await page.locator('.chapter-flow-panel').evaluate(el => { el.style.left = '900px'; el.style.top = '900px' })
      const flow = await page.locator('.chapter-flow-panel').boundingBox()
      check(flow.x >= 0 && flow.x + flow.width <= width + 1 && flow.y + flow.height <= height + 1, `${width}: flow panel overrides stale desktop position`)
      await page.locator('.chapter-flow-panel').getByRole('button', { name: '收起', exact: true }).click()
      await page.locator('.mobile-tools-toggle').click()
      await page.getByRole('button', { name: '📜 历史版本', exact: true }).click()
      await page.locator('.chapter-versions-layout').waitFor()
      check(await page.locator('.chapter-versions-layout').evaluate(el => getComputedStyle(el).flexDirection === 'column'), `${width}: version preview stacks vertically`)
      await page.locator('.dialog-overlay').getByRole('button', { name: '✕', exact: true }).click()
      await page.getByRole('button', { name: '收起工具', exact: true }).click()
      await page.getByRole('button', { name: '精修正文', exact: true }).click()
      await page.locator('.refinement-panel').waitFor()
      const panel = await page.locator('.refinement-panel').boundingBox()
      check(panel.x >= 0 && panel.x + panel.width <= width + 1 && panel.y + panel.height <= height + 1, `${width}: refinement fits the viewport`)
      await page.screenshot({ path: `${output}/refinement-${width}.png` })
      await checkRefinement(page, width)

      // Deterministic keyboard viewport simulation; physical IME behavior still needs device testing.
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 250 })
        window.visualViewport.dispatchEvent(new Event('resize'))
      })
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--web-viewport-height') === '250px')
      const keyboardPanel = await page.locator('.refinement-panel').boundingBox()
      check(keyboardPanel.height <= 251, `${width}: refinement follows keyboard viewport`)
      check(await page.locator('.refinement-body').evaluate(el => el.clientHeight > 60), `${width}: keyboard leaves a scrollable comparison area`)
      check(await page.locator('.refinement-footer').evaluate(el => { const panel = el.closest('.refinement-panel').getBoundingClientRect(); return el.getBoundingClientRect().bottom <= panel.bottom + 1 }), `${width}: keyboard keeps actions reachable`)
    } else {
      check(await page.locator('.web-mobile-bar').count() === 0, `${desktop ? 'Electron' : 'wide web'}: desktop navigation preserved`)
      await page.locator('.project-card').first().click()
      await page.locator('.chapter-row').first().click()
      await page.locator('textarea.editor-text').waitFor()
      check(!await page.locator('.mobile-tools-toggle').isVisible(), `${desktop ? 'Electron' : 'wide web'}: editor toolbar unchanged`)
      if (!desktop) {
        await page.getByRole('button', { name: '精修正文', exact: true }).click()
        await checkRefinement(page, width)
      }
    }
    check(errors.length === 0, `${width}${desktop ? ' Electron' : ''}: no runtime errors (${errors.join('; ')})`)
    await context.close()
  }
  console.log(`${passed.length} mobile UI checks passed. Screenshots: ${output}`)
} finally { await browser?.close(); await server.close() }
