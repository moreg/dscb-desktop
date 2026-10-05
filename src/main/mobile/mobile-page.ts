import { MOBILE_BRAINSTORM_CLIENT } from './mobile-brainstorm-client'
import { MOBILE_BATCH_CLIENT, MOBILE_BATCH_STYLES } from './mobile-batch-client'

export const MOBILE_PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#f7f4ed" />
  <title>大神持笔 · 手机端</title>
  <style>
    :root{color-scheme:light;--bg:#f7f4ed;--paper:#fffdf7;--paper2:#f0ebe0;--ink:#2a2620;--muted:#786f63;--line:#e2dccd;--red:#b8331f;--redSoft:#fbe8e3;--green:#4d7048;--shadow:0 4px 18px rgba(74,50,25,.09);--editorSize:17px;--editorLine:1.95;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
    [data-theme="dark"]{color-scheme:dark;--bg:#1a1815;--paper:#252320;--paper2:#2e2a26;--ink:#ece1cf;--muted:#a99b88;--line:#3a342c;--red:#d6503a;--redSoft:#3a201c;--green:#8aab78;--shadow:0 4px 18px rgba(0,0,0,.35)}
    *{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--ink)}body{padding-bottom:env(safe-area-inset-bottom)}button,input,textarea{font:inherit;color:inherit}button{touch-action:manipulation}.shell{max-width:760px;margin:0 auto;min-height:100vh}.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:10px;min-height:58px;padding:8px max(12px,env(safe-area-inset-left));background:color-mix(in srgb,var(--bg) 94%,transparent);border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}
    .dot{width:8px;height:8px;border-radius:2px;background:var(--red);display:inline-block;margin:0 7px}.back,.icon-btn{height:42px;min-width:42px;border:0;border-radius:10px;background:var(--paper2);font-weight:700}.back{font-size:22px}.grow{flex:1;min-width:0}.title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700}.subtitle{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.top-actions{display:flex;gap:7px}.content{padding:18px 14px 106px}.hint{margin:0 0 16px;color:var(--muted);font-size:13px;line-height:1.6}.list{display:grid;gap:12px}.card{width:100%;border:1px solid var(--line);border-radius:14px;background:var(--paper);padding:16px;text-align:left;box-shadow:var(--shadow)}button.card:active,.tap:active{transform:scale(.992)}.card-title{display:block;font-size:16px;font-weight:700;margin-bottom:6px}.card-desc{display:block;font-size:13px;color:var(--muted);line-height:1.6}.clamp{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}.meta{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-top:10px;font-size:12px;color:var(--muted)}.badge{padding:3px 8px;border-radius:99px;background:var(--paper2)}
    .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:18px}.stat{padding:14px 8px;text-align:center;border:1px solid var(--line);border-radius:13px;background:var(--paper)}.stat strong{display:block;font-family:Georgia,serif;font-size:20px;color:var(--red)}.stat span{font-size:11px;color:var(--muted)}.section-head{display:flex;align-items:center;justify-content:space-between;margin:20px 2px 10px}.section-head h2{margin:0;font-size:16px}.link-btn{border:0;background:transparent;color:var(--red);padding:6px}.quick-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.quick{border:1px solid var(--line);border-radius:13px;background:var(--paper);padding:15px;text-align:left}.quick strong{display:block;margin-bottom:4px}.quick span{font-size:12px;color:var(--muted)}
    .chapter-card{display:grid;grid-template-columns:44px minmax(0,1fr) 40px;align-items:center;gap:8px;padding:7px 7px 7px 13px}.chapter-open{display:contents}.chapter-num{font-family:Georgia,serif;color:var(--red);font-weight:700}.chapter-main{border:0;background:transparent;text-align:left;padding:10px 0;min-width:0}.chapter-main .card-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0}.rename{width:38px;height:38px;border:0;border-radius:9px;background:var(--paper2);color:var(--muted)}.filter,.searchbox{display:flex;gap:8px;margin-bottom:14px}.input{width:100%;height:44px;border:1px solid var(--line);border-radius:11px;background:var(--paper);padding:0 13px;outline:0}.input:focus{border-color:var(--red)}.search-button{min-width:68px;border:0;border-radius:11px;background:var(--red);color:white;font-weight:700}.empty,.error{padding:28px 18px;text-align:center;color:var(--muted);background:var(--paper);border:1px solid var(--line);border-radius:14px}.error{color:var(--red);background:var(--redSoft)}
    .bottom-nav{position:fixed;bottom:0;left:0;right:0;z-index:18;padding:5px max(7px,env(safe-area-inset-right)) calc(5px + env(safe-area-inset-bottom));background:color-mix(in srgb,var(--bg) 96%,transparent);border-top:1px solid var(--line);backdrop-filter:blur(12px)}.bottom-nav-inner{max-width:760px;margin:auto;display:grid;grid-template-columns:repeat(4,1fr)}.nav-item{height:52px;border:0;border-radius:11px;background:transparent;color:var(--muted);font-size:11px}.nav-item b{display:block;font-size:18px;line-height:20px;margin-bottom:2px}.nav-item.active{color:var(--red);background:var(--redSoft)}
    .tabs{display:flex;gap:7px;overflow:auto;padding-bottom:3px;margin-bottom:14px;scrollbar-width:none}.tab{flex:none;border:1px solid var(--line);border-radius:99px;background:var(--paper);padding:8px 13px;font-size:13px}.tab.active{border-color:var(--red);background:var(--redSoft);color:var(--red);font-weight:700}.reference{display:grid;gap:10px}.reference details{border:1px solid var(--line);border-radius:13px;background:var(--paper);padding:0 14px}.reference summary{cursor:pointer;padding:14px 0;font-weight:700}.reference-body{border-top:1px solid var(--line);padding:12px 0 15px;font-size:13px;line-height:1.75;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}.field{margin-bottom:10px}.field:last-child{margin-bottom:0}.field b{display:block;color:var(--ink);font-size:12px;margin-bottom:2px}.tags{display:flex;flex-wrap:wrap;gap:6px}.search-result{display:block}.search-result mark{background:#f4d68b;color:#3d2d13;border-radius:3px;padding:0 1px}.occurrence{color:var(--red);font-size:12px}.search-summary{margin:-3px 0 12px;font-size:12px;color:var(--muted)}
    .editor{display:flex;flex-direction:column;min-height:calc(100vh - 59px)}.editor-body{flex:1;padding:10px 10px 90px}.outline-panel{margin:0 0 10px;padding:13px 14px;border:1px solid var(--line);border-radius:12px;background:var(--paper);font-size:13px;line-height:1.65}.outline-panel h3{font-size:14px;margin:0 0 8px}.editor textarea{display:block;width:100%;min-height:calc(100vh - 170px);resize:none;border:0;outline:0;border-radius:12px;background:var(--paper);padding:18px 16px;font-family:"Source Han Serif SC","Songti SC",STSong,serif;font-size:var(--editorSize);line-height:var(--editorLine);box-shadow:inset 0 0 0 1px var(--line)}.editor-tools{display:flex;align-items:center;gap:8px;margin-bottom:10px;padding:9px;border:1px solid var(--line);border-radius:11px;background:var(--paper)}.editor-tools span{font-size:12px;color:var(--muted)}.tool-step{height:36px;min-width:42px;border:0;border-radius:8px;background:var(--paper2)}.savebar{position:fixed;bottom:0;left:0;right:0;z-index:21;padding:9px max(12px,env(safe-area-inset-right)) calc(9px + env(safe-area-inset-bottom));background:color-mix(in srgb,var(--bg) 96%,transparent);border-top:1px solid var(--line);backdrop-filter:blur(12px)}.savebar-inner{max-width:760px;margin:auto;display:flex;align-items:center;gap:9px}.save-state{flex:1;color:var(--muted);font-size:12px;line-height:1.35}.primary{min-width:96px;height:44px;border:0;border-radius:10px;background:var(--red);color:white;font-weight:700}.primary:disabled{opacity:.48}
    .ai-panel{margin:0 0 10px;padding:13px;border:1px solid color-mix(in srgb,var(--red) 45%,var(--line));border-radius:12px;background:var(--paper)}.ai-panel h3{margin:0 0 5px;font-size:15px}.ai-panel p{margin:0 0 10px;font-size:12px;line-height:1.55;color:var(--muted)}.ai-panel textarea{min-height:78px!important;padding:11px 12px!important;font-family:inherit!important;font-size:14px!important;line-height:1.55!important}.ai-actions{display:flex;gap:8px;margin-top:9px}.ai-actions button{flex:1;min-height:40px;border:0;border-radius:9px;background:var(--paper2)}.ai-actions .ai-main{background:var(--red);color:white;font-weight:700}.ai-preview{max-height:240px;overflow:auto;margin-top:10px;padding:12px;border-radius:9px;background:var(--paper2);font-family:"Source Han Serif SC","Songti SC",serif;font-size:14px;line-height:1.75;white-space:pre-wrap}.ai-loading{padding:18px 8px;text-align:center;color:var(--muted)}
    .settings-group{margin-bottom:16px;padding:15px;border:1px solid var(--line);border-radius:14px;background:var(--paper)}.settings-group h3{margin:0 0 12px;font-size:15px}.choice-row{display:flex;gap:8px}.choice{flex:1;height:42px;border:1px solid var(--line);border-radius:9px;background:var(--paper2)}.choice.active{border-color:var(--red);color:var(--red);background:var(--redSoft);font-weight:700}.setting-line{display:flex;justify-content:space-between;align-items:center}.stepper{display:flex;align-items:center;gap:8px}.stepper output{min-width:48px;text-align:center;font-size:13px}.loading{padding:60px 20px;text-align:center;color:var(--muted)}
    button{cursor:pointer;min-height:44px}button:disabled{cursor:default;opacity:.48}button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--red);outline-offset:3px}.back,.icon-btn,.rename,.tool-step,.choice{min-width:44px;height:44px}.chapter-card{grid-template-columns:40px minmax(0,1fr) 44px}.chapter-main{min-height:64px}.topbar{padding-top:max(8px,env(safe-area-inset-top));padding-right:max(12px,env(safe-area-inset-right))}.top-actions{gap:4px}.content{padding-right:max(14px,env(safe-area-inset-right));padding-left:max(14px,env(safe-area-inset-left))}.filter-options{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:14px}.filter-options .tab{min-height:44px}.editor-tools{flex-wrap:wrap}.editor-body{padding-bottom:145px}.editor textarea{font-size:max(16px,var(--editorSize));min-height:calc(100dvh - 220px)}.ai-panel textarea{font-size:16px!important}.savebar-inner{flex-wrap:wrap}.chapter-switch{display:flex;align-items:center;justify-content:space-between;gap:10px;max-width:760px;margin:0 auto 7px;font-size:12px;color:var(--muted)}.chapter-switch button{min-height:44px;border:1px solid var(--line);border-radius:9px;background:var(--paper);padding:6px 12px}.notice{padding:12px 14px;border:1px solid var(--line);border-radius:11px;background:var(--paper2);font-size:13px;line-height:1.6;margin-bottom:10px;overflow-wrap:anywhere}.notice.error{color:var(--red);background:var(--redSoft);text-align:left}.notice-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.notice-actions button{border:1px solid var(--line);border-radius:9px;background:var(--paper);padding:8px 12px}.conflict-preview{max-height:220px;overflow:auto;white-space:pre-wrap;color:var(--ink);margin:10px 0}.connection{padding:7px 14px;background:var(--redSoft);color:var(--red);font-size:12px;line-height:1.5}.resume{margin-bottom:16px}.resume .card-title{color:var(--red)}.searchbox .input{min-width:0}.search-result mark{background:#f4d68b;color:#3d2d13}.ai-actions{flex-wrap:wrap}.ai-actions button{min-height:44px;min-width:90px}.setting-line{gap:10px;flex-wrap:wrap}.editor{min-height:calc(100dvh - 59px)}.offline-label{color:var(--red)}
    .savebar{bottom:var(--keyboardInset,0px)}.keyboard-open .chapter-switch{display:none}
    .brainstorm-entry{margin-bottom:14px}.brainstorm-entry .card-title{color:var(--red)}.brain-form{display:grid;gap:14px}.brain-form label{display:grid;gap:6px;font-size:13px;font-weight:700}.brain-form label small{font-weight:400;color:var(--muted)}.brain-form textarea,.brain-export{width:100%;min-height:88px;border:1px solid var(--line);border-radius:11px;background:var(--paper);padding:11px 13px;font:inherit;font-size:16px;line-height:1.6;resize:vertical}.brain-form details>summary{padding:10px 0;color:var(--muted);font-size:13px}.brain-form details>label{margin-top:8px}.brain-toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.brain-toolbar button{flex:1;min-width:120px}.brain-card{overflow-wrap:anywhere}.brain-card h3{margin:0 0 12px;font-size:17px;line-height:1.5}.brain-card .field{font-size:14px;line-height:1.75}.brain-card .field b{font-size:12px}.brain-card .notice-actions button{flex:1;min-width:70px}.brain-export{min-height:180px}.brain-status{margin:14px 0}.brain-tabs{margin-top:20px}.brain-history summary{padding:14px 0;font-size:14px;font-weight:700}.brain-history .card{box-shadow:none;margin-top:12px}.brain-form .input{font-weight:400}.brain-form textarea{font-weight:400}.brain-toolbar .choice{padding:0 12px}.brain-current-source{font-size:12px;color:var(--muted);margin-bottom:12px;line-height:1.6}
    ${MOBILE_BATCH_STYLES}
    @media(max-width:360px){.topbar{gap:6px}.chapter-switch button{padding:6px 8px}.save-state{font-size:11px}.primary{min-width:90px}.stats{gap:6px}.stat strong{font-size:18px}}
    @media(prefers-reduced-motion:reduce){button.card:active,.tap:active{transform:none}}
    @media(prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#1a1815;--paper:#252320;--paper2:#2e2a26;--ink:#ece1cf;--muted:#a99b88;--line:#3a342c;--red:#d6503a;--redSoft:#3a201c;--green:#8aab78;--shadow:0 4px 18px rgba(0,0,0,.35)}}
  </style>
</head>
<body><main id="app" class="shell"><div class="loading">正在连接书案…</div></main>
<script>
(() => {
  'use strict';
  const root = document.getElementById('app');
  const savedSettings = (() => { try { const value = JSON.parse(localStorage.getItem('writer-mobile-settings') || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } })();
  const state = { projects: [], project: null, chapters: [], chapter: null, detail: null, detailWarning: '', content: '', savedContent: '', revision: '', dirty: false, saving: false, timer: 0, error: '', notice: '', conflict: false, latestChapter: null, storageError: false, offline: navigator.onLine === false, view: 'projects', navId: 0, transitioning: false, savePromise: null, library: null, libraryTab: 'outline', libraryFilter: '', chapterFilter: '', chapterStatus: 'all', searchResults: [], searchQuery: '', showOutline: false, showTools: false, showAi: false, aiLoading: false, aiId: 0, aiController: null, aiInstruction: '', aiProposal: null, settings: { fontSize: Math.max(16, Math.min(26, Number(savedSettings.fontSize) || 17)), lineHeight: Math.max(1.4, Math.min(2.6, Number(savedSettings.lineHeight) || 1.95)), theme: ['light','dark','system'].includes(savedSettings.theme) ? savedSettings.theme : 'system' } };
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const nl = (value) => esc(value).replace(/\n/g, '<br>');
  const request = async (path, options, timeoutMs) => {
    const controller = new AbortController();
    const external = options && options.signal;
    const abort = () => controller.abort();
    if (external) { if (external.aborted) abort(); else external.addEventListener('abort', abort, {once:true}); }
    const timeout = window.setTimeout(abort, timeoutMs || 15000);
    try {
      const response = await fetch(path, Object.assign({ credentials: 'same-origin', headers: {'Content-Type':'application/json'} }, options || {}, {signal:controller.signal}));
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { const error = new Error(response.status === 401 ? '连接已失效，请在电脑端生成新二维码并重新扫码。手机草稿仍会保留。' : body.error || '请求失败'); error.status = response.status; throw error; }
      return body;
    } catch (error) {
      if (error.status) throw error;
      if (external && external.aborted) throw error;
      const failure = new Error(controller.signal.aborted ? '连接超时，请确认电脑仍在运行后重试。' : '无法连接电脑，请检查 Wi-Fi 和电脑上的手机连接。');
      failure.status = 0;
      throw failure;
    } finally { window.clearTimeout(timeout); if (external) external.removeEventListener('abort', abort); }
  };
  const countWords = (text) => (text.match(/[\u3400-\u9fff]|[a-zA-Z0-9]+/g) || []).length;
  const formatNumber = (number) => Number(number || 0).toLocaleString('zh-CN');
  const topbar = (title, subtitle, back, actions) => {
    if (state.view === 'home') actions = '<button class="icon-btn" data-action="brainstorm" aria-label="脑洞生成">脑洞</button>' + (actions || '');
    const offlineMessage = state.view === 'mobile-batch' ? '网络已断开，任务仍由电脑运行。恢复连接后可重新读取进度。' : '网络已断开，正文会先保留在当前手机，恢复连接后重试保存。';
    return '<header class="topbar">' + (back ? '<button class="back" data-action="back" aria-label="返回">‹</button>' : '<span class="dot"></span>') + '<div class="grow"><div class="title">' + esc(title) + '</div><div class="subtitle">' + esc(subtitle || '') + '</div></div>' + (actions ? '<div class="top-actions">' + actions + '</div>' : '') + '</header><div id="connectionState" class="connection" role="status" ' + (state.offline ? '' : 'hidden') + '>' + offlineMessage + '</div>';
  };
  const nav = () => '<nav class="bottom-nav" aria-label="作品导航"><div class="bottom-nav-inner">' + [['home','⌂','首页'],['chapters','☷','章节'],['library','▤','资料'],['search','⌕','搜索']].map((item) => '<button class="nav-item ' + (state.view === item[0] ? 'active' : '') + '" ' + (state.view === item[0] ? 'aria-current="page" ' : '') + 'data-nav="' + item[0] + '"><b aria-hidden="true">' + item[1] + '</b>' + item[2] + '</button>').join('') + '</div></nav>';
  let retryAction = null;
  const beginView = (view) => { state.view = view; return ++state.navId; };
  const showError = (message, retry) => { retryAction = retry; root.innerHTML = topbar('暂时无法读取', '', !!state.project, '') + '<section class="content"><div class="error" role="alert">' + esc(message) + '<div class="notice-actions"><button data-action="retry">重新连接</button></div></div></section>' + (state.project ? nav() : ''); };
  const projectPath = (suffix) => '/api/projects/' + encodeURIComponent(state.project.id) + suffix;
  const draftKey = (projectId, number) => 'writer-mobile-draft:' + encodeURIComponent(projectId) + ':' + number;
  function readStored(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
  function persistDraft() {
    if (!state.project || !state.chapter || !state.dirty) return;
    try { localStorage.setItem(draftKey(state.project.id, state.chapter.meta.chapterNumber), JSON.stringify({content:state.content, revision:state.revision, updatedAt:Date.now()})); state.storageError = false; }
    catch { state.storageError = true; }
  }
  function scheduleSave(delay) {
    window.clearTimeout(state.timer);
    if (state.dirty && !state.conflict && !state.offline) state.timer = window.setTimeout(() => void saveChapter(false), delay == null ? 1500 : delay);
  }
  function contentChanged() {
    state.dirty = state.saving || state.content !== state.savedContent;
    persistDraft();
    if (!state.dirty) { try { localStorage.removeItem(draftKey(state.project.id,state.chapter.meta.chapterNumber)); } catch {} }
    updateSaveState(state.conflict ? '版本冲突，请先对照电脑稿' : state.offline ? '离线 · 手机草稿已保留' : state.dirty ? '等待自动保存…' : '已同步');
    scheduleSave();
  }

  function applySettings() {
    document.documentElement.style.setProperty('--editorSize', state.settings.fontSize + 'px');
    document.documentElement.style.setProperty('--editorLine', String(state.settings.lineHeight));
    if (state.settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', state.settings.theme);
    try { localStorage.setItem('writer-mobile-settings', JSON.stringify(state.settings)); } catch { /* Private browsing may disable local storage. */ }
  }

  function renderProjects() {
    beginView('projects');
    root.innerHTML = topbar('大神持笔', '选择要继续创作的作品', false, '<button class="icon-btn" data-action="refresh-projects" aria-label="刷新作品列表">↻</button>') + '<section class="content"><button class="card brainstorm-entry" data-action="brainstorm"><span class="card-title">脑洞生成</span><span class="card-desc">长篇、短篇、中篇 · 无需先建作品</span></button><p class="hint">正文与资料仍保存在电脑中，手机通过当前局域网访问。</p><div class="list">' + (state.projects.length ? state.projects.map((project) => '<button class="card" data-project="' + esc(project.id) + '"><span class="card-title">' + esc(project.name || '未命名作品') + '</span><span class="card-desc clamp">' + esc(project.description || '暂无简介') + '</span><span class="meta">' + (project.genre ? '<span class="badge">' + esc(project.genre) + '</span>' : '') + '<span>进入移动书案 ›</span></span></button>').join('') : '<div class="empty">书案中还没有可用项目</div>') + '</div></section>';
  }

  async function openProject(projectId) {
    const ticket = beginView('projects');
    root.innerHTML = '<div class="loading">正在整理移动书案…</div>';
    try {
      const result = await request('/api/projects/' + encodeURIComponent(projectId) + '/chapters');
      if (ticket !== state.navId) return;
      state.project = state.projects.find((item) => item.id === projectId) || {id: projectId, name: '作品'};
      state.chapter = null;
      state.content = '';
      state.savedContent = '';
      state.revision = '';
      state.dirty = false;
      state.conflict = false;
      state.latestChapter = null;
      state.error = '';
      state.notice = '';
      state.storageError = false;
      stopAi();
      window.clearTimeout(state.timer);
      state.chapters = (result.chapters || []).sort((a,b) => a.chapterNumber - b.chapterNumber);
      state.library = null;
      state.libraryFilter = '';
      state.chapterFilter = '';
      state.chapterStatus = 'all';
      state.searchResults = [];
      state.searchQuery = '';
      renderHome();
    } catch (error) { if (ticket === state.navId) showError(error.message, () => openProject(projectId)); }
  }

  function renderHome() {
    beginView('home');
    const totalWords = state.chapters.reduce((sum, chapter) => sum + (chapter.wordCount || 0), 0);
    const drafted = state.chapters.filter((chapter) => chapter.status !== 'outline').length;
    const recent = state.chapters.slice().sort((a,b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || b.chapterNumber - a.chapterNumber).slice(0,3);
    const last = readStored('writer-mobile-last:' + encodeURIComponent(state.project.id));
    const resume = last && state.chapters.find((chapter) => chapter.chapterNumber === last.chapterNumber);
    root.innerHTML = topbar(state.project.name || '作品', state.project.genre || '移动书案', true, '<button class="icon-btn" data-nav="settings" aria-label="写作设置">Aa</button>') + '<section class="content"><div class="stats"><div class="stat"><strong>' + state.chapters.length + '</strong><span>总章节</span></div><div class="stat"><strong>' + drafted + '</strong><span>已动笔</span></div><div class="stat"><strong>' + formatNumber(totalWords) + '</strong><span>总字数</span></div></div>' + (resume ? '<button class="card resume" data-chapter="' + resume.chapterNumber + '"><span class="card-title">接着上次写</span><span class="card-desc">第 ' + resume.chapterNumber + ' 章 · ' + esc(resume.title) + '</span></button>' : '') + '<button class="card resume" data-action="mobile-batch"><span class="card-title">一键写 10 章</span><span class="card-desc">接着待写章节生成正文，查看进度或暂停后继续</span></button><div class="quick-grid"><button class="quick tap" data-nav="chapters"><strong>继续写作</strong><span>打开章节与正文</span></button><button class="quick tap" data-nav="library"><strong>创作资料</strong><span>大纲、人物与设定</span></button><button class="quick tap" data-nav="search"><strong>全文搜索</strong><span>定位名字或情节</span></button><button class="quick tap" data-nav="settings"><strong>阅读设置</strong><span>主题、字号与行距</span></button></div><div class="section-head"><h2>最近更新</h2><button class="link-btn" data-nav="chapters">全部章节</button></div><div class="list">' + (recent.length ? recent.map(chapterCard).join('') : '<div class="empty">这个项目还没有章节</div>') + '</div></section>' + nav();
  }

  function chapterCard(chapter) {
    return '<div class="card chapter-card"><span class="chapter-num">' + String(chapter.chapterNumber).padStart(3, '0') + '</span><button class="chapter-main" data-chapter="' + chapter.chapterNumber + '"><span class="card-title">' + esc(chapter.title || ('第' + chapter.chapterNumber + '章')) + '</span><span class="meta">' + formatNumber(chapter.wordCount) + ' 字 · ' + esc(({outline:'待写',draft:'草稿',reviewed:'已审稿',published:'已发布'})[chapter.status] || chapter.status || '草稿') + '</span></button><button class="rename" data-rename="' + chapter.chapterNumber + '" aria-label="重命名第 ' + chapter.chapterNumber + ' 章">✎</button></div>';
  }

  function renderChapters(filter) {
    beginView('chapters');
    if (filter != null) state.chapterFilter = filter;
    root.innerHTML = topbar(state.project.name || '作品', state.chapters.length + ' 个章节', true, '<button class="icon-btn" data-action="mobile-batch" aria-label="一键写10章">写10章</button><button class="icon-btn" data-action="refresh-chapters" aria-label="刷新章节列表">↻</button>') + '<section class="content"><div class="filter"><input id="chapterFilter" class="input" value="' + esc(state.chapterFilter) + '" placeholder="按章号或标题筛选" aria-label="筛选章节" type="search"></div><div class="filter-options">' + [['all','全部'],['outline','待写'],['written','已写']].map((item) => '<button class="tab ' + (state.chapterStatus === item[0] ? 'active' : '') + '" data-chapter-status="' + item[0] + '" aria-pressed="' + (state.chapterStatus === item[0]) + '">' + item[1] + '</button>').join('') + '</div><p id="chapterCount" class="search-summary"></p><div class="list" id="chapterList"></div></section>' + nav();
    const input = document.getElementById('chapterFilter');
    input.addEventListener('input', () => { state.chapterFilter = input.value; updateChapterList(); });
    updateChapterList();
  }

  function updateChapterList() {
    const keyword = state.chapterFilter.trim().toLocaleLowerCase('zh-CN');
    const chapters = state.chapters.filter((chapter) => (!keyword || String(chapter.chapterNumber).includes(keyword) || String(chapter.title || '').toLocaleLowerCase('zh-CN').includes(keyword)) && (state.chapterStatus === 'all' || (state.chapterStatus === 'outline' ? chapter.status === 'outline' : chapter.status !== 'outline')));
    document.getElementById('chapterList').innerHTML = chapters.length ? chapters.map(chapterCard).join('') : '<div class="empty">没有匹配的章节</div>';
    document.getElementById('chapterCount').textContent = '显示 ' + chapters.length + ' / ' + state.chapters.length + ' 章';
  }

  async function refreshChapters() {
    const projectId = state.project.id;
    const ticket = beginView('chapters');
    root.innerHTML = topbar(state.project.name, '正在刷新章节', true, '') + '<div class="loading">正在同步电脑端章节…</div>' + nav();
    try {
      const result = await request(projectPath('/chapters'));
      if (ticket !== state.navId || state.project.id !== projectId) return;
      state.chapters = (result.chapters || []).sort((a,b) => a.chapterNumber - b.chapterNumber);
      renderChapters();
    } catch (error) { if (ticket === state.navId) showError(error.message, refreshChapters); }
  }

  async function renameChapter(number) {
    const chapter = state.chapters.find((item) => item.chapterNumber === number);
    if (!chapter) return;
    const title = window.prompt('输入新的章节标题（最多 50 字）', chapter.title || '');
    if (title == null || title.trim() === chapter.title) return;
    if (!title.trim() || title.trim().length > 50) { window.alert('章节标题应为 1—50 字'); return; }
    const ticket = state.navId;
    try {
      const result = await request(projectPath('/chapters/' + number), { method: 'PATCH', body: JSON.stringify({title: title.trim()}) });
      Object.assign(chapter, result.meta);
      if (ticket === state.navId && state.chapter && state.chapter.meta.chapterNumber === number) state.chapter.meta = result.meta;
      if (ticket === state.navId) renderChapters();
    } catch (error) { if (ticket === state.navId) window.alert(error.message); }
  }

  async function openChapter(number, locate) {
    if (state.transitioning) return;
    state.transitioning = true;
    if (!await prepareToLeave()) { state.transitioning = false; return; }
    const projectId = state.project.id;
    const ticket = beginView('editor-loading');
    root.innerHTML = '<div class="loading">正在打开正文与章纲…</div>';
    try {
      const result = await request(projectPath('/chapters/' + number));
      if (ticket !== state.navId || !state.project || state.project.id !== projectId) return;
      state.chapter = result.chapter;
      state.detail = result.detail || null;
      state.detailWarning = result.detailError || result.detailWarning || '';
      state.savedContent = result.chapter.content || '';
      state.content = state.savedContent;
      state.revision = result.revision;
      state.dirty = false;
      state.error = '';
      state.notice = '';
      state.conflict = false;
      state.latestChapter = null;
      state.showOutline = false;
      state.showTools = false;
      state.showAi = false;
      state.aiLoading = false;
      state.aiInstruction = '';
      state.aiProposal = null;
      const draft = readStored(draftKey(projectId, number));
      if (draft && typeof draft.content === 'string' && typeof draft.revision === 'string' && draft.content !== state.savedContent) {
        state.content = draft.content;
        state.revision = draft.revision;
        state.dirty = true;
        state.notice = '已恢复当前手机上未同步的草稿。';
        if (draft.revision !== result.revision) { state.conflict = true; state.error = '电脑稿已更新，手机草稿已保留，请先对照两个版本。'; state.latestChapter = result; }
      }
      try { localStorage.setItem('writer-mobile-last:' + encodeURIComponent(projectId), JSON.stringify({chapterNumber:number})); } catch {}
      renderEditor();
      if (locate) {
        const textarea = document.getElementById('prose');
        const index = state.content.toLocaleLowerCase('zh-CN').indexOf(locate.toLocaleLowerCase('zh-CN'));
        if (index >= 0) { textarea.focus({preventScroll:true}); textarea.setSelectionRange(index,index + locate.length); const lines = state.content.slice(0,index).split('\n').length - 1; textarea.scrollTop = lines * state.settings.fontSize * state.settings.lineHeight; }
      }
      scheduleSave();
    } catch (error) { if (ticket === state.navId) showError(error.message, () => openChapter(number, locate)); }
    finally { state.transitioning = false; }
  }

  function detailFields(detail) {
    if (!detail) return '<div class="hint">本章暂无细纲资料</div>';
    const rows = [['核心事件',detail.plotSummary],['爽点',detail.coolPoint],['章末钩子',detail.hook],['出场角色',(detail.charactersAppearing || []).join('、')],['伏笔',(detail.foreshadowings || []).join('、')],['字数预估',detail.wordEstimate],['写作要求',detail.writingRequirements],['金句',detail.goldenLine]];
    return rows.filter((row) => row[1]).map((row) => '<div class="field"><b>' + row[0] + '</b>' + nl(row[1]) + '</div>').join('') || '<div class="hint">本章细纲暂时没有详细字段</div>';
  }

  function renderEditor() {
    if (!state.chapter) return;
    const chapter = state.chapter;
    beginView('editor');
    const actions = '<button class="icon-btn" data-action="ai" aria-label="AI 写作助手" aria-expanded="' + state.showAi + '">AI</button><button class="icon-btn" data-action="outline" aria-label="查看本章细纲" aria-expanded="' + state.showOutline + '">纲</button><button class="icon-btn" data-action="tools" aria-label="正文显示设置" aria-expanded="' + state.showTools + '">Aa</button>';
    const tools = state.showTools ? '<div class="editor-tools"><span>字号</span><button class="tool-step" data-setting="fontSize" data-step="-1">A−</button><button class="tool-step" data-setting="fontSize" data-step="1">A+</button><span>行距</span><button class="tool-step" data-setting="lineHeight" data-step="-0.1">−</button><button class="tool-step" data-setting="lineHeight" data-step="0.1">＋</button></div>' : '';
    const outline = state.showOutline ? '<aside class="outline-panel"><h3>第 ' + chapter.meta.chapterNumber + ' 章细纲</h3>' + (state.detailWarning ? '<p class="hint">' + esc(state.detailWarning) + '</p>' : detailFields(state.detail)) + '</aside>' : '';
    const aiPanel = state.showAi ? renderAiPanel() : '';
    const index = state.chapters.findIndex((item) => item.chapterNumber === chapter.meta.chapterNumber);
    const prev = state.chapters[index - 1];
    const next = state.chapters[index + 1];
    root.innerHTML = '<div class="editor">' + topbar(chapter.meta.title || ('第' + chapter.meta.chapterNumber + '章'), '第 ' + chapter.meta.chapterNumber + ' 章 · 自动保存', true, actions) + '<section class="editor-body">' + tools + outline + '<div id="editorNotice">' + editorNotice() + '</div>' + aiPanel + '<textarea id="prose" spellcheck="false" aria-label="章节正文" placeholder="从这里开始写正文…">' + esc(state.content) + '</textarea></section><footer class="savebar"><div class="chapter-switch"><button ' + (prev ? 'data-chapter="' + prev.chapterNumber + '"' : 'disabled') + '>‹ 上一章</button><span>' + (index + 1) + ' / ' + state.chapters.length + '</span><button ' + (next ? 'data-chapter="' + next.chapterNumber + '"' : 'disabled') + '>下一章 ›</button></div><div class="savebar-inner"><span id="saveState" class="save-state" role="status" aria-live="polite"></span><button id="saveButton" class="primary" data-action="save">保存正文</button></div></footer></div>';
    const aiInput = document.getElementById('aiInstruction');
    if (aiInput) aiInput.addEventListener('input', () => { state.aiInstruction = aiInput.value; });
    const textarea = document.getElementById('prose');
    let composing = false;
    textarea.addEventListener('compositionstart', () => { composing = true; window.clearTimeout(state.timer); });
    textarea.addEventListener('compositionend', () => { composing = false; state.content = textarea.value; contentChanged(); });
    textarea.addEventListener('input', () => {
      state.content = textarea.value;
      if (composing) { state.dirty = true; persistDraft(); return; }
      contentChanged();
    });
    updateSaveState(state.error || (state.dirty ? '手机草稿待同步' : '已同步'));
  }

  function editorNotice() {
    const storage = state.storageError ? '<div class="notice error" role="alert">当前浏览器无法保留手机草稿，请先保存到电脑或下载备份，再关闭页面。</div>' : '';
    if (state.conflict) return storage + '<div class="notice error" role="alert">' + esc(state.error || '电脑稿已更新，手机草稿已保留。') + '<p>展开电脑稿对照；修改完成后可明确确认以当前稿保存。</p>' + (state.latestChapter ? '<details><summary>查看电脑端最新正文</summary><div class="conflict-preview">' + esc(state.latestChapter.chapter.content || '（空正文）') + '</div></details>' : '') + '<div class="notice-actions"><button data-action="compare">重新读取电脑稿</button><button data-action="merge">按当前稿保存</button><button data-action="download">下载手机草稿</button></div></div>';
    if (state.error) return storage + '<div class="notice error" role="alert">' + esc(state.error) + '<div class="notice-actions"><button data-action="save">重试保存</button><button data-action="download">下载手机草稿</button></div></div>';
    return storage + (state.notice ? '<div class="notice" role="status">' + esc(state.notice) + '</div>' : '');
  }

  function updateEditorNotice() {
    const notice = document.getElementById('editorNotice');
    if (notice) notice.innerHTML = editorNotice();
  }

  function renderAiPanel() {
    if (state.aiLoading) return '<aside class="ai-panel"><h3>AI 写作助手</h3><div class="ai-loading" role="status">正在结合本章细纲与人物设定落笔，请稍候…</div><div class="ai-actions"><button data-action="ai-stop">停止等待</button></div></aside>';
    if (state.aiProposal) return '<aside class="ai-panel"><h3>' + (state.aiProposal.mode === 'continue' ? '续写预览' : '重写预览') + '</h3><p>结果尚未写入正文，请确认后采用。</p><div class="ai-preview">' + esc(state.aiProposal.text) + '</div><div class="ai-actions"><button data-action="ai-cancel">放弃</button><button class="ai-main" data-action="ai-apply">采用结果</button></div></aside>';
    return '<aside class="ai-panel"><h3>AI 写作助手</h3><p>续写会追加到文末；重写会给出整章替代稿。生成结果需确认后才进入正文。</p><textarea id="aiInstruction" maxlength="2000" aria-label="AI 补充写作要求" placeholder="补充要求（续写可留空，重写必填）">' + esc(state.aiInstruction) + '</textarea><div class="ai-actions"><button data-ai-mode="continue">智能续写</button><button class="ai-main" data-ai-mode="rewrite">按要求重写</button></div></aside>';
  }

  async function runAi(mode) {
    if (!state.chapter || state.aiLoading) return;
    const instruction = state.aiInstruction.trim();
    if (mode === 'rewrite' && !instruction) { window.alert('请先输入具体的重写要求'); return; }
    const projectId = state.project.id;
    const chapterNumber = state.chapter.meta.chapterNumber;
    const baseContent = state.content;
    const ticket = ++state.aiId;
    const controller = new AbortController();
    state.aiController = controller;
    state.aiLoading = true;
    state.aiProposal = null;
    rerenderEditorPreservingCaret();
    try {
      const result = await request(projectPath('/chapters/' + chapterNumber + '?action=ai'), { method: 'POST', body: JSON.stringify({mode: mode, content: baseContent, instruction: instruction}), signal:controller.signal }, 180000);
      if (ticket !== state.aiId || state.view !== 'editor' || !state.chapter || state.project.id !== projectId || state.chapter.meta.chapterNumber !== chapterNumber) return;
      state.aiProposal = { mode: result.mode, text: result.text || '', baseContent:baseContent };
    } catch (error) {
      if (ticket === state.aiId && !controller.signal.aborted) window.alert(error.message);
    } finally {
      if (ticket === state.aiId && state.view === 'editor' && state.chapter && state.project.id === projectId && state.chapter.meta.chapterNumber === chapterNumber) { state.aiLoading = false; state.aiController = null; rerenderEditorPreservingCaret(); }
    }
  }

  function stopAi() {
    ++state.aiId;
    if (state.aiController) state.aiController.abort();
    state.aiController = null;
    state.aiLoading = false;
    state.aiProposal = null;
  }

  function applyAiProposal() {
    if (!state.aiProposal || !state.aiProposal.text) return;
    if (state.content !== state.aiProposal.baseContent && !window.confirm('生成期间正文有新的修改。采用结果可能覆盖或重复这些修改，确定采用吗？')) return;
    if (state.aiProposal.mode === 'continue') state.content = state.content.replace(/\s+$/, '') + '\n\n' + state.aiProposal.text.trim();
    else state.content = state.aiProposal.text.trim();
    state.aiProposal = null;
    state.showAi = false;
    contentChanged();
    rerenderEditorPreservingCaret();
  }

  function rerenderEditorPreservingCaret() {
    const before = document.getElementById('prose');
    const active = document.activeElement;
    const activeId = active && active.id;
    const activeStart = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
    const activeEnd = activeStart == null ? null : active.selectionEnd;
    const pageScroll = window.scrollY;
    const start = before ? before.selectionStart : state.content.length;
    const end = before ? before.selectionEnd : start;
    const scrollTop = before ? before.scrollTop : 0;
    renderEditor();
    const after = document.getElementById('prose');
    if (after) { after.setSelectionRange(start, end); after.scrollTop = scrollTop; }
    const restored = activeId && document.getElementById(activeId);
    if (restored) { restored.focus({preventScroll:true}); if (activeStart != null) restored.setSelectionRange(activeStart,activeEnd); }
    window.scrollTo(0,pageScroll);
  }

  function updateSaveState(label) {
    const node = document.getElementById('saveState');
    const button = document.getElementById('saveButton');
    if (node) node.textContent = formatNumber(countWords(state.content)) + ' 字 · ' + (state.storageError && state.dirty ? '手机备份失败，请保持页面打开' : label);
    if (button) button.disabled = state.saving || state.conflict;
    updateEditorNotice();
  }

  async function saveChapter(manual) {
    while (state.savePromise) { await state.savePromise; if (state.error) return; }
    if (!state.chapter || state.conflict || (!state.dirty && !manual)) return;
    if (state.offline) { persistDraft(); updateSaveState('离线 · 等待连接电脑'); return; }
    window.clearTimeout(state.timer);
    const projectId = state.project.id;
    const chapterNumber = state.chapter.meta.chapterNumber;
    const submittedContent = state.content;
    const submittedRevision = state.revision;
    persistDraft();
    let needsFollowUpSave = false;
    state.saving = true;
    updateSaveState('保存中…');
    const operation = (async () => { try {
      const result = await request('/api/projects/' + encodeURIComponent(projectId) + '/chapters/' + chapterNumber, { method: 'PUT', body: JSON.stringify({content: submittedContent, baseRevision: submittedRevision}) });
      if (!state.chapter || !state.project || state.project.id !== projectId || state.chapter.meta.chapterNumber !== chapterNumber) return;
      state.revision = result.revision;
      state.chapter.meta = result.meta;
      state.savedContent = submittedContent;
      const listMeta = state.chapters.find((item) => item.chapterNumber === chapterNumber);
      if (listMeta) Object.assign(listMeta, result.meta);
      needsFollowUpSave = state.content !== submittedContent;
      state.dirty = needsFollowUpSave;
      state.error = '';
      state.notice = '';
      if (state.dirty) persistDraft();
      else { try { const draft = readStored(draftKey(projectId,chapterNumber)); if (!draft || draft.content === submittedContent) localStorage.removeItem(draftKey(projectId,chapterNumber)); } catch {} }
      updateSaveState(needsFollowUpSave ? '有新修改，继续保存…' : '已保存');
    } catch (error) {
      if (!state.chapter || !state.project || state.project.id !== projectId || state.chapter.meta.chapterNumber !== chapterNumber) return;
      state.dirty = true;
      state.conflict = error.status === 409;
      state.error = state.conflict ? '电脑稿已更新，手机草稿已保留，请先对照两个版本。' : error.message;
      persistDraft();
      updateSaveState(state.error);
      if (state.conflict) void compareLatest();
    } finally {
      state.saving = false;
      const button = document.getElementById('saveButton');
      if (button) button.disabled = state.conflict;
      if (needsFollowUpSave && state.dirty) {
        window.clearTimeout(state.timer);
        scheduleSave(250);
      }
    } })();
    state.savePromise = operation;
    await operation;
    if (state.savePromise === operation) state.savePromise = null;
  }

  async function compareLatest() {
    if (!state.chapter || !state.conflict) return;
    const projectId = state.project.id;
    const number = state.chapter.meta.chapterNumber;
    try {
      const result = await request(projectPath('/chapters/' + number));
      if (state.project && state.project.id === projectId && state.chapter && state.chapter.meta.chapterNumber === number && state.conflict) { state.latestChapter = result; updateEditorNotice(); }
    } catch (error) { if (state.chapter && state.project && state.chapter.meta.chapterNumber === number && state.project.id === projectId) { state.error = '手机草稿已保留。' + error.message; updateEditorNotice(); } }
  }

  async function mergeCurrent() {
    if (!state.conflict || !state.latestChapter) { await compareLatest(); return; }
    if (!window.confirm('请确认已对照电脑稿并完成合并。以当前手机正文保存，会替换刚刚读取的电脑版本，继续吗？')) return;
    state.revision = state.latestChapter.revision;
    state.savedContent = state.latestChapter.chapter.content || '';
    state.conflict = false;
    state.latestChapter = null;
    state.error = '';
    state.dirty = true;
    persistDraft();
    await saveChapter(true);
  }

  function downloadDraft() {
    if (!state.chapter) return;
    const url = URL.createObjectURL(new Blob([state.content], {type:'text/plain;charset=utf-8'}));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = '第' + state.chapter.meta.chapterNumber + '章-手机草稿.txt';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url),1000);
  }

  async function prepareToLeave() {
    if (state.view === 'brainstorm') { stopBrainstorm(); return true; }
    if (state.view === 'mobile-batch') { leaveMobileBatch(); return true; }
    if (state.view !== 'editor') return true;
    if ((state.aiLoading || state.aiProposal) && !window.confirm('离开会放弃本次尚未采用的 AI 结果，确定离开吗？')) return false;
    persistDraft();
    if (state.dirty || state.saving) await saveChapter(false);
    if (state.dirty && !window.confirm(state.storageError ? '正文尚未同步，手机备份也未成功。请先下载草稿。仍要离开吗？' : '正文尚未同步，草稿已保留在当前手机。仍要离开吗？')) return false;
    stopAi();
    window.clearTimeout(state.timer);
    return true;
  }

  async function renderLibrary(tab) {
    const ticket = beginView('library');
    state.libraryTab = tab || state.libraryTab;
    if (!state.library) {
      root.innerHTML = topbar(state.project.name || '作品', '正在读取资料', true, '') + '<div class="loading">正在整理大纲与设定…</div>' + nav();
      try { const result = await request(projectPath('/references')); if (ticket !== state.navId) return; state.library = result.library; }
      catch (error) { if (ticket === state.navId) showError(error.message, () => renderLibrary(tab)); return; }
    }
    const tabs = [['outline','总纲'],['details','章纲'],['characters','人物'],['world','设定'],['foreshadow','伏笔']];
    root.innerHTML = topbar(state.project.name || '作品', '创作资料库', true, '<button class="icon-btn" data-action="refresh-library" aria-label="刷新创作资料">↻</button>') + '<section class="content"><div class="tabs" aria-label="资料分类">' + tabs.map((item) => '<button class="tab ' + (state.libraryTab === item[0] ? 'active' : '') + '" data-library-tab="' + item[0] + '" aria-pressed="' + (state.libraryTab === item[0]) + '">' + item[1] + '</button>').join('') + '</div><div class="filter"><input id="libraryFilter" class="input" type="search" value="' + esc(state.libraryFilter) + '" placeholder="筛选当前分类的资料" aria-label="筛选资料"></div><div id="libraryBody" class="reference">' + renderLibraryBody() + '</div></section>' + nav();
    const input = document.getElementById('libraryFilter');
    input.addEventListener('input', () => { state.libraryFilter = input.value; document.getElementById('libraryBody').innerHTML = renderLibraryBody(); });
  }

  function renderLibraryBody() {
    const lib = Object.assign({},state.library);
    const keyword = state.libraryFilter.trim().toLocaleLowerCase('zh-CN');
    const matches = (value) => !keyword || JSON.stringify(value).toLocaleLowerCase('zh-CN').includes(keyword);
    for (const key of ['details','characters','foreshadowings','worldviews','locations','items']) lib[key] = (lib[key] || []).filter(matches);
    if (state.libraryTab === 'outline') {
      if (!lib.outline || !matches(lib.outline)) return '<div class="empty">' + (keyword ? '没有匹配的总纲资料' : '暂无总纲资料') + '</div>';
      return '<div class="card"><div class="field"><b>故事梗概</b>' + nl(lib.outline.synopsis || '暂无') + '</div>' + (lib.outline.theme ? '<div class="field"><b>主题</b>' + nl(lib.outline.theme) + '</div>' : '') + (lib.outline.mainLine ? '<div class="field"><b>主线</b>' + nl(lib.outline.mainLine) + '</div>' : '') + '</div>' + (lib.outline.volumes || []).map((volume) => '<details><summary>第 ' + volume.number + ' 卷 · ' + esc(volume.name) + '</summary><div class="reference-body">第 ' + volume.chapterStart + '—' + volume.chapterEnd + ' 章</div></details>').join('');
    }
    if (state.libraryTab === 'details') return lib.details.length ? lib.details.map((detail) => '<details><summary>第 ' + detail.chapterNumber + ' 章 · ' + esc(detail.title || '未命名') + '</summary><div class="reference-body">' + detailFields(detail) + '<div class="notice-actions"><button data-chapter="' + detail.chapterNumber + '">打开本章正文</button></div></div></details>').join('') : '<div class="empty">暂无匹配的分章细纲</div>';
    if (state.libraryTab === 'characters') return lib.characters.length ? lib.characters.map((character) => '<details><summary>' + esc(character.name) + (character.role ? ' · ' + esc(character.role) : '') + '</summary><div class="reference-body">' + entityFields(character, [['身份','identity'],['性格','personality'],['能力','abilities'],['简介','synopsis']]) + '</div></details>').join('') : '<div class="empty">暂无人物资料</div>';
    if (state.libraryTab === 'foreshadow') return lib.foreshadowings.length ? lib.foreshadowings.map((item) => '<details><summary>' + esc(item.content) + '</summary><div class="reference-body"><div class="field"><b>状态</b>' + esc(({pending:'待埋设',planted:'已埋设',collected:'已回收',missed:'已错过'})[item.status] || item.status) + '</div>' + (item.plantChapter ? '<div class="field"><b>埋设章节</b>第 ' + item.plantChapter + ' 章</div>' : '') + (item.expectedCollect ? '<div class="field"><b>预计回收</b>第 ' + item.expectedCollect + ' 章</div>' : '') + (item.note ? '<div class="field"><b>备注</b>' + nl(item.note) + '</div>' : '') + '</div></details>').join('') : '<div class="empty">暂无伏笔资料</div>';
    const groups = [['世界观',lib.worldviews],['地点',lib.locations],['道具',lib.items]];
    return groups.map((group) => '<div class="section-head"><h2>' + group[0] + '</h2><span class="badge">' + group[1].length + '</span></div>' + (group[1].length ? group[1].map((item) => '<details><summary>' + esc(item.name) + '</summary><div class="reference-body">' + entityFields(item, [['分类','category'],['说明','notes']]) + '</div></details>').join('') : '<div class="empty">暂无' + group[0] + '资料</div>')).join('');
  }

  function entityFields(entity, fields) {
    let html = fields.filter((pair) => entity[pair[1]]).map((pair) => '<div class="field"><b>' + pair[0] + '</b>' + nl(Array.isArray(entity[pair[1]]) ? entity[pair[1]].join('、') : entity[pair[1]]) + '</div>').join('');
    const extras = Object.assign({}, entity.rawFields || {}, entity.customFields || {});
    html += Object.keys(extras).map((key) => '<div class="field"><b>' + esc(key) + '</b>' + nl(Array.isArray(extras[key]) ? extras[key].join('\n') : extras[key]) + '</div>').join('');
    if (entity.tags && entity.tags.length) html += '<div class="tags">' + entity.tags.map((tag) => '<span class="badge">' + esc(tag) + '</span>').join('') + '</div>';
    return html || '暂无详细资料';
  }

  function renderSearch() {
    beginView('search');
    root.innerHTML = topbar(state.project.name || '作品', '跨章节搜索正文', true, '') + '<section class="content"><form id="searchForm" class="searchbox"><input id="searchInput" class="input" type="search" enterkeyhint="search" maxlength="80" value="' + esc(state.searchQuery) + '" placeholder="输入人物、地点或一句话" aria-label="全文搜索"><button class="search-button" type="submit">搜索</button></form>' + (state.searchQuery ? '<div class="search-summary">“' + esc(state.searchQuery) + '”找到 ' + state.searchResults.length + ' 个章节' + (state.searchResults.length >= 100 ? '（最多显示前 100 章）' : '') + '</div>' : '<p class="hint">搜索范围包含当前作品的全部正文和章节标题。</p>') + '<div class="list">' + (state.searchResults.length ? state.searchResults.map((result) => '<button class="card search-result" data-chapter="' + result.chapterNumber + '" data-locate="' + esc(state.searchQuery) + '"><span class="card-title">第 ' + result.chapterNumber + ' 章 · ' + highlight(result.title,state.searchQuery) + '</span><span class="card-desc">' + highlight(result.snippet,state.searchQuery) + '</span><span class="meta"><span class="occurrence">' + result.occurrences + ' 处匹配</span><span>定位正文 ›</span></span></button>').join('') : (state.searchQuery ? '<div class="empty">没有找到相关内容</div>' : '')) + '</div></section>' + nav();
    document.getElementById('searchForm').addEventListener('submit', (event) => { event.preventDefault(); void runSearch(document.getElementById('searchInput').value); });
  }

  async function runSearch(query) {
    const clean = query.trim().slice(0,80);
    if (!clean) { state.searchQuery = ''; state.searchResults = []; renderSearch(); return; }
    const ticket = beginView('search');
    state.searchQuery = clean;
    root.innerHTML = topbar(state.project.name || '作品', '正在搜索', true, '') + '<div class="loading">正在查找全部正文…</div>' + nav();
    try { const result = await request(projectPath('/search?q=' + encodeURIComponent(clean))); if (ticket !== state.navId) return; state.searchResults = result.results || []; renderSearch(); }
    catch (error) { if (ticket === state.navId) showError(error.message, () => runSearch(clean)); }
  }

  function highlight(value, query) {
    const text = String(value || '');
    const needle = query.toLocaleLowerCase('zh-CN');
    if (!needle) return esc(text);
    const lowered = text.toLocaleLowerCase('zh-CN');
    let cursor = 0;
    let html = '';
    let index = lowered.indexOf(needle);
    while (index >= 0) { html += esc(text.slice(cursor,index)) + '<mark>' + esc(text.slice(index,index + query.length)) + '</mark>'; cursor = index + query.length; index = lowered.indexOf(needle,cursor); }
    return html + esc(text.slice(cursor));
  }

  function renderSettings() {
    beginView('settings');
    const theme = state.settings.theme;
    root.innerHTML = topbar('写作设置', '只保存在当前手机', true, '') + '<section class="content"><div class="settings-group"><h3>显示主题</h3><div class="choice-row">' + [['system','跟随系统'],['light','浅色'],['dark','深色']].map((item) => '<button class="choice ' + (theme === item[0] ? 'active' : '') + '" data-theme-choice="' + item[0] + '">' + item[1] + '</button>').join('') + '</div></div><div class="settings-group"><div class="setting-line"><h3>正文字号</h3><div class="stepper"><button class="tool-step" data-setting="fontSize" data-step="-1">−</button><output>' + state.settings.fontSize + ' px</output><button class="tool-step" data-setting="fontSize" data-step="1">＋</button></div></div></div><div class="settings-group"><div class="setting-line"><h3>正文行距</h3><div class="stepper"><button class="tool-step" data-setting="lineHeight" data-step="-0.1">−</button><output>' + state.settings.lineHeight.toFixed(2) + '</output><button class="tool-step" data-setting="lineHeight" data-step="0.1">＋</button></div></div></div><p class="hint">正文每 1.5 秒自动保存。电脑和手机同时编辑同一章时，系统会阻止旧版本覆盖新版本。</p></section>' + nav();
  }

  function changeSetting(key, step) {
    if (key === 'fontSize') state.settings.fontSize = Math.max(16, Math.min(26, state.settings.fontSize + Number(step)));
    if (key === 'lineHeight') state.settings.lineHeight = Math.max(1.4, Math.min(2.6, Math.round((state.settings.lineHeight + Number(step)) * 10) / 10));
    applySettings();
    if (state.view !== 'editor') renderSettings();
  }

  ${MOBILE_BRAINSTORM_CLIENT}
  ${MOBILE_BATCH_CLIENT}

  async function navigate(view) {
    if (!state.project) return;
    if (state.transitioning) return;
    state.transitioning = true;
    const wasBatch = state.view === 'mobile-batch';
    const canLeave = await prepareToLeave();
    state.transitioning = false;
    if (!canLeave) return;
    if (view === 'home') { if (wasBatch) void openProject(state.project.id); else renderHome(); }
    else if (view === 'chapters') { if (wasBatch) void refreshChapters(); else renderChapters(); }
    else if (view === 'library') void renderLibrary();
    else if (view === 'search') renderSearch();
    else if (view === 'settings') renderSettings();
  }

  root.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-project],[data-chapter],[data-rename],[data-action],[data-nav],[data-library-tab],[data-setting],[data-theme-choice],[data-ai-mode],[data-chapter-status],[data-brain-kind],[data-brain-tab],[data-brain-favorite],[data-brain-copy],[data-brain-download],[data-brain-history]');
    if (!target) return;
    if (handleBrainstormAction(target)) return;
    if (handleMobileBatchAction(target)) return;
    if (target.dataset.project) void openProject(target.dataset.project);
    else if (target.dataset.chapter) void openChapter(Number(target.dataset.chapter),target.dataset.locate);
    else if (target.dataset.rename) void renameChapter(Number(target.dataset.rename));
    else if (target.dataset.nav) void navigate(target.dataset.nav);
    else if (target.dataset.libraryTab) void renderLibrary(target.dataset.libraryTab);
    else if (target.dataset.setting) changeSetting(target.dataset.setting, target.dataset.step);
    else if (target.dataset.themeChoice) { state.settings.theme = target.dataset.themeChoice; applySettings(); renderSettings(); }
    else if (target.dataset.aiMode) void runAi(target.dataset.aiMode);
    else if (target.dataset.chapterStatus) { state.chapterStatus = target.dataset.chapterStatus; renderChapters(); }
    else if (target.dataset.action === 'save') void saveChapter(true);
    else if (target.dataset.action === 'ai') { if (state.aiLoading) return; state.showAi = !state.showAi; rerenderEditorPreservingCaret(); if (state.showAi) { const input = document.getElementById('aiInstruction'); if (input) input.focus({preventScroll:true}); } }
    else if (target.dataset.action === 'ai-apply') applyAiProposal();
    else if (target.dataset.action === 'ai-cancel') { state.aiProposal = null; rerenderEditorPreservingCaret(); }
    else if (target.dataset.action === 'ai-stop') { stopAi(); rerenderEditorPreservingCaret(); }
    else if (target.dataset.action === 'compare') void compareLatest();
    else if (target.dataset.action === 'merge') void mergeCurrent();
    else if (target.dataset.action === 'download') downloadDraft();
    else if (target.dataset.action === 'retry') { if (retryAction) void retryAction(); }
    else if (target.dataset.action === 'refresh-projects') void loadProjects();
    else if (target.dataset.action === 'refresh-chapters') void refreshChapters();
    else if (target.dataset.action === 'refresh-library') { state.library = null; void renderLibrary(); }
    else if (target.dataset.action === 'outline') { state.showOutline = !state.showOutline; rerenderEditorPreservingCaret(); }
    else if (target.dataset.action === 'tools') { state.showTools = !state.showTools; rerenderEditorPreservingCaret(); }
    else if (target.dataset.action === 'back') {
      if (state.transitioning) return;
      state.transitioning = true;
      const canLeave = await prepareToLeave();
      state.transitioning = false;
      if (!canLeave) return;
      if (state.view === 'brainstorm') { if (state.project) renderHome(); else renderProjects(); }
      else if (state.view === 'mobile-batch') void refreshChapters();
      else if (state.view === 'editor') { state.chapter = null; renderChapters(); }
      else if (state.view === 'home') { state.project = null; renderProjects(); }
      else renderHome();
    }
  });
  window.addEventListener('beforeunload', (event) => { persistDraft(); if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', persistDraft);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { persistDraft(); if (state.view === 'editor') void saveChapter(false); } else if (state.view === 'editor') scheduleSave(250); });
  window.addEventListener('offline', () => { state.offline = true; const banner = document.getElementById('connectionState'); if (banner) banner.hidden = false; window.clearTimeout(state.timer); persistDraft(); if (state.view === 'editor') updateSaveState('离线 · 手机草稿已保留'); });
  window.addEventListener('online', () => { state.offline = false; const banner = document.getElementById('connectionState'); if (banner) banner.hidden = true; if (state.view === 'editor') { updateSaveState(state.conflict ? '版本冲突，请先对照' : state.dirty ? '连接已恢复，正在同步…' : '已同步'); scheduleSave(250); } });
  if (window.visualViewport) {
    const adjustKeyboard = () => {
      const viewport = window.visualViewport;
      const inset = viewport.scale === 1 ? Math.max(0,window.innerHeight - viewport.height - viewport.offsetTop) : 0;
      document.documentElement.style.setProperty('--keyboardInset', (inset > 100 ? inset : 0) + 'px');
      document.documentElement.classList.toggle('keyboard-open',inset > 100);
    };
    window.visualViewport.addEventListener('resize',adjustKeyboard);
    window.visualViewport.addEventListener('scroll',adjustKeyboard);
    adjustKeyboard();
  }
  async function loadProjects() {
    const ticket = beginView('projects');
    root.innerHTML = '<div class="loading">正在连接书案…</div>';
    try { const result = await request('/api/projects'); if (ticket !== state.navId) return; state.projects = result.projects || []; renderProjects(); }
    catch (error) { if (ticket === state.navId) showError(error.message, loadProjects); }
  }
  applySettings();
  void loadProjects();
})();
</script></body></html>`

export const MOBILE_PAIRING_ERROR_PAGE = String.raw`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接失效</title><style>body{margin:0;background:#f7f4ed;color:#2a2620;font-family:system-ui;display:grid;place-items:center;min-height:100vh;padding:24px}.card{max-width:420px;background:#fffdf7;border:1px solid #e2dccd;border-radius:16px;padding:28px;text-align:center}h1{font-size:22px}p{color:#786f63;line-height:1.7}</style></head><body><div class="card"><h1>二维码已失效</h1><p>请回到电脑端“手机连接”，点击“生成新二维码”后重新扫描。</p></div></body></html>`
