// Injected into the mobile page's existing closure; shares its authenticated request and UI helpers.
export const MOBILE_BRAINSTORM_CLIENT = String.raw`
  const brainKinds = {long:'长篇',short:'短篇',medium:'中篇'};
  const savedBrainKind = readStored('writer-mobile-brainstorm-kind');
  const brain = {kind:typeof savedBrainKind === 'string' && Object.prototype.hasOwnProperty.call(brainKinds,savedBrainKind) ? savedBrainKind : 'long', records:{}, tab:'current', generating:false, controller:null, requestId:0, error:'', notice:'', storageWarning:'', copyPreview:''};
  const brainKey = (kind) => 'writer-mobile-brainstorm:' + kind;
  const brainFields = (kind) => kind === 'long' ? [['premise','故事设定'],['hook','开篇钩子'],['mainLine','长期主线'],['progression','成长与多卷推进'],['twist','关键反转与伏笔'],['ending','终局']] : [['premise','故事设定'],['hook','开篇钩子'],['twist','关键反转'],['ending','结局']];
  const brainIdeaKey = (idea) => JSON.stringify([idea.title,idea.premise].map((text) => text.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]/gu,'')));
  const newBrainId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,10);
  function validBrainIdea(idea,kind) {
    if (!idea || typeof idea !== 'object' || Array.isArray(idea)) return false;
    const limits = kind === 'long' ? {title:120,premise:800,hook:600,mainLine:800,progression:800,twist:600,ending:600} : {title:120,premise:3000,hook:1500,twist:1500,ending:1500};
    return Object.keys(limits).every((key) => typeof idea[key] === 'string' && !!idea[key].trim() && idea[key].length <= limits[key]);
  }
  function brainForm(value,kind) {
    const source = value && typeof value === 'object' ? value : {};
    const text = (key,limit) => typeof source[key] === 'string' ? source[key].slice(0,limit) : '';
    return {genre:text('genre',200),direction:text('direction',2000),requirements:text('requirements',10000),sourceBrief:text('sourceBrief',10000),targetChapters:source.targetChapters == null ? '' : String(source.targetChapters).slice(0,8),targetWords:source.targetWords == null ? (kind === 'medium' ? '30000' : '8000') : String(source.targetWords).slice(0,8)};
  }
  function brainRecord() {
    if (brain.records[brain.kind]) return brain.records[brain.kind];
    const saved = readStored(brainKey(brain.kind));
    const value = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    const ideas = (entries) => Array.isArray(entries) ? entries.filter((idea) => validBrainIdea(idea,brain.kind)).slice(0,3) : [];
    const record = {form:brainForm(value.form,brain.kind),source:brainForm(value.source,brain.kind),ideas:ideas(value.ideas),history:[],favorites:[],previousIdeas:[],raw:typeof value.raw === 'string' ? value.raw.slice(0,200000) : '',status:['completed','failed','stopped'].includes(value.status) ? value.status : value.status === 'generating' ? 'stopped' : 'idle',warning:typeof value.warning === 'string' ? value.warning.slice(0,2000) : '',error:typeof value.error === 'string' ? value.error.slice(0,2000) : ''};
    if (Array.isArray(value.history)) record.history = value.history.filter((batch) => batch && typeof batch.id === 'string' && typeof batch.createdAt === 'number' && ideas(batch.ideas).length).slice(0,5).map((batch) => ({id:batch.id,createdAt:batch.createdAt,source:brainForm(batch.source,brain.kind),ideas:ideas(batch.ideas)}));
    if (Array.isArray(value.favorites)) {
      const seen = new Set();
      record.favorites = value.favorites.filter((entry) => {
        if (!entry || !validBrainIdea(entry.idea,brain.kind)) return false;
        const key = brainIdeaKey(entry.idea); if (seen.has(key)) return false; seen.add(key); return true;
      }).slice(0,30).map((entry) => ({idea:entry.idea,source:brainForm(entry.source,brain.kind)}));
    }
    if (Array.isArray(value.previousIdeas)) record.previousIdeas = value.previousIdeas.filter((idea) => idea && typeof idea.title === 'string' && idea.title.trim() && idea.title.length <= 120 && typeof idea.premise === 'string' && idea.premise.trim() && idea.premise.length <= (brain.kind === 'long' ? 800 : 3000)).slice(-30).map((idea) => ({title:idea.title,premise:idea.premise}));
    brain.records[brain.kind] = record;
    return record;
  }
  function persistBrainstorm() {
    try {
      localStorage.setItem(brainKey(brain.kind),JSON.stringify(Object.assign({version:1},brainRecord())));
      localStorage.setItem('writer-mobile-brainstorm-kind',JSON.stringify(brain.kind));
      brain.storageWarning = '';
    } catch { brain.storageWarning = '当前浏览器无法保存脑洞记录，请复制或下载需要保留的方案。'; }
  }
  function brainSource(form) {
    return brainKinds[brain.kind] + ' · ' + (form.genre || '自由题材') + ' · ' + (brain.kind === 'long' ? form.targetChapters ? form.targetChapters + ' 章' : '未限定章数' : form.targetWords + ' 字');
  }
  function brainNotice() {
    const record = brainRecord();
    const status = brain.generating ? '<div class="notice" role="status">正在由电脑生成三个方案。可以停止生成；离开页面会停止本次请求，保留已有方案。</div>' : record.status === 'stopped' ? '<div class="notice" role="status">生成已停止，已有方案和收藏已保留。</div>' : '';
    const error = brain.error || record.error || (record.status === 'failed' ? '上次生成未完成，已有方案保留，可查看原文后重试。' : '');
    return (brain.storageWarning ? '<div class="notice error" role="alert">' + esc(brain.storageWarning) + '</div>' : '') + (error ? '<div class="notice error" role="alert">' + esc(error) + '</div>' : '') + status + (record.warning ? '<div class="notice">' + esc(record.warning) + '</div>' : '') + (brain.notice ? '<div class="notice" role="status">' + esc(brain.notice) + '</div>' : '');
  }
  function updateBrainNotice() { const node = document.getElementById('brainNotice'); if (node) node.innerHTML = brainNotice(); }
  async function openBrainstorm() {
    if (state.transitioning) return;
    state.transitioning = true;
    const canLeave = await prepareToLeave();
    state.transitioning = false;
    if (!canLeave) return;
    brain.error = ''; brain.notice = ''; brain.copyPreview = '';
    renderBrainstorm();
  }
  function renderBrainstorm() {
    beginView('brainstorm');
    const record = brainRecord();
    const form = record.form;
    const disabled = brain.generating ? ' disabled' : '';
    root.innerHTML = topbar('脑洞生成','使用电脑端的开局 / 大纲模型',true,'') + '<section class="content"><p class="hint">先选篇幅，再填写你想写的方向。无需先创建作品；结果保存在当前手机浏览器，可复制或下载。</p><div class="choice-row">' + Object.keys(brainKinds).map((kind) => '<button class="choice ' + (kind === brain.kind ? 'active' : '') + '" data-brain-kind="' + kind + '" aria-pressed="' + (kind === brain.kind) + '"' + disabled + '>' + brainKinds[kind] + '</button>').join('') + '</div><form id="brainForm" class="brain-form" style="margin-top:16px"><label for="brainGenre">题材<input id="brainGenre" class="input" maxlength="200" placeholder="可留空，如都市、玄幻、悬疑" value="' + esc(form.genre) + '"' + disabled + '></label><label for="brainDirection">创作方向<textarea id="brainDirection" maxlength="2000" placeholder="你想写的人物处境、能力或核心冲突"' + disabled + '>' + esc(form.direction) + '</textarea></label>' + (brain.kind === 'long' ? '<label for="brainChapters">预计章数<small>可留空，填写时为 1—100000 的整数</small><input id="brainChapters" class="input" type="number" inputmode="numeric" min="1" max="100000" placeholder="留空，自由规划连载规模" value="' + esc(form.targetChapters) + '"' + disabled + '></label>' : '<label for="brainWords">全文目标字数<small>1000—120000 字</small><input id="brainWords" class="input" type="number" inputmode="numeric" min="1000" max="120000" value="' + esc(form.targetWords) + '"' + disabled + '></label>') + '<label for="brainRequirements">额外要求<textarea id="brainRequirements" maxlength="10000" placeholder="文风、情绪体验、结局偏好等，可留空"' + disabled + '>' + esc(form.requirements) + '</textarea></label><details><summary>已有想法或简介参考（可选）</summary><label for="brainSource">简介参考<textarea id="brainSource" maxlength="10000" placeholder="输入已有想法，生成时作为参考"' + disabled + '>' + esc(form.sourceBrief) + '</textarea></label></details><div class="brain-toolbar"><button class="primary" id="brainGenerate" type="submit"' + disabled + '>' + (brain.generating ? '正在生成…' : record.ideas.length ? '换一批' : '生成 3 个脑洞') + '</button>' + (brain.generating ? '<button class="choice" type="button" data-action="brain-stop">停止生成</button>' : '') + '</div></form><div id="brainNotice" class="brain-status">' + brainNotice() + '</div><div class="tabs brain-tabs" aria-label="脑洞记录">' + [['current','本批方案'],['history','历史 · ' + record.history.length],['favorites','收藏 · ' + record.favorites.length]].map((item) => '<button class="tab ' + (brain.tab === item[0] ? 'active' : '') + '" data-brain-tab="' + item[0] + '" aria-pressed="' + (brain.tab === item[0]) + '"' + disabled + '>' + item[1] + '</button>').join('') + '</div><div id="brainResults" class="list">' + renderBrainResults() + '</div>' + (brain.copyPreview ? '<div class="section-head"><h2>可复制文本</h2></div><textarea id="brainCopyPreview" class="brain-export" readonly aria-label="脑洞可复制文本">' + esc(brain.copyPreview) + '</textarea><p class="hint">长按复制，或点击方案上的「下载」。</p>' : '') + (record.raw ? '<details class="brain-history"><summary>查看最近收到的模型原文</summary><textarea class="brain-export" readonly aria-label="脑洞生成原文">' + esc(record.raw) + '</textarea><div class="notice-actions"><button data-action="brain-download-raw">下载原文</button></div></details>' : '') + '</section>' + (state.project ? nav() : '');
    const bind = (id,key) => { const input = document.getElementById(id); if (input) input.addEventListener('input', () => { record.form[key] = input.value; persistBrainstorm(); updateBrainNotice(); }); };
    for (const pair of [['brainGenre','genre'],['brainDirection','direction'],['brainRequirements','requirements'],['brainSource','sourceBrief'],['brainChapters','targetChapters'],['brainWords','targetWords']]) bind(pair[0],pair[1]);
    document.getElementById('brainForm').addEventListener('submit', (event) => { event.preventDefault(); void runBrainstorm(); });
  }
  function renderBrainIdea(idea,key) {
    const saved = brainRecord().favorites.some((entry) => brainIdeaKey(entry.idea) === brainIdeaKey(idea));
    return '<article class="card brain-card"><h3>' + esc(idea.title) + '</h3>' + brainFields(brain.kind).map((pair) => '<div class="field"><b>' + pair[1] + '</b>' + nl(idea[pair[0]]) + '</div>').join('') + '<div class="notice-actions"><button data-brain-favorite="' + key + '" aria-pressed="' + saved + '">' + (saved ? '取消收藏' : '收藏') + '</button><button data-brain-copy="' + key + '">复制</button><button data-brain-download="' + key + '">下载</button></div></article>';
  }
  function renderBrainResults() {
    const record = brainRecord();
    if (brain.tab === 'favorites') return record.favorites.length ? record.favorites.map((entry,index) => renderBrainIdea(entry.idea,'favorite:' + index)).join('') : '<div class="empty">还没有收藏，喜欢的方案可点「收藏」。</div>';
    if (brain.tab === 'history') return record.history.length ? record.history.map((batch,index) => '<details class="card brain-history"><summary>' + esc(new Date(batch.createdAt).toLocaleString('zh-CN')) + ' · ' + batch.ideas.length + ' 个方案</summary><p class="brain-current-source">' + esc(brainSource(batch.source)) + '</p>' + batch.ideas.map((idea,ideaIndex) => renderBrainIdea(idea,'history:' + index + ':' + ideaIndex)).join('') + '</details>').join('') : '<div class="empty">成功生成后保留最近 5 批历史。</div>';
    return record.ideas.length ? '<p class="brain-current-source">本批条件：' + esc(brainSource(record.source)) + '</p>' + record.ideas.map((idea,index) => renderBrainIdea(idea,'current:' + index)).join('') : '<div class="empty">生成后在这里查看方案。已有方案会保留到新一批成功返回。</div>';
  }
  function brainIdeaEntry(key) {
    const record = brainRecord();
    const parts = String(key).split(':');
    const index = Number(parts[1]);
    if (!Number.isInteger(index) || index < 0) return null;
    if (parts[0] === 'current' && record.ideas[index]) return {idea:record.ideas[index],source:record.source};
    if (parts[0] === 'favorite') return record.favorites[index] || null;
    const batch = parts[0] === 'history' && record.history[index];
    const idea = batch && batch.ideas[Number(parts[2])];
    return idea ? {idea:idea,source:batch.source} : null;
  }
  async function runBrainstorm() {
    if (brain.generating || state.view !== 'brainstorm') return;
    const record = brainRecord();
    const form = record.form;
    const kind = brain.kind;
    const input = {kind:kind,genre:form.genre.trim(),direction:form.direction.trim(),requirements:form.requirements.trim(),sourceBrief:form.sourceBrief.trim(),previousIdeas:record.previousIdeas.slice(-30),variationSeed:newBrainId()};
    if (kind === 'long' && form.targetChapters.trim()) {
      const number = Number(form.targetChapters);
      if (!Number.isInteger(number) || number < 1 || number > 100000) { brain.error = '预计章数需为 1—100000 的整数，或留空。'; updateBrainNotice(); return; }
      input.targetChapters = number;
    } else if (kind !== 'long') {
      const number = Number(form.targetWords);
      if (!Number.isInteger(number) || number < 1000 || number > 120000) { brain.error = '全文目标需为 1000—120000 的整数。'; updateBrainNotice(); return; }
      input.targetWords = number;
    }
    const source = Object.assign({},form);
    const ticket = ++brain.requestId;
    const controller = new AbortController();
    brain.controller = controller; brain.generating = true; brain.error = ''; brain.notice = ''; brain.copyPreview = ''; brain.tab = 'current'; record.status = 'generating'; record.warning = ''; record.error = '';
    persistBrainstorm(); renderBrainstorm();
    try {
      const result = await request('/api/brainstorm',{method:'POST',body:JSON.stringify(input),signal:controller.signal},300000);
      if (ticket !== brain.requestId || kind !== brain.kind || state.view !== 'brainstorm') return;
      if (typeof result.rawText === 'string') record.raw = result.rawText.slice(0,200000);
      if (!result.ok || !Array.isArray(result.ideas) || !result.ideas.length || result.ideas.length > 3 || !result.ideas.every((idea) => validBrainIdea(idea,kind))) {
        record.status = 'failed'; brain.error = result.error || '未收到完整方案，已有方案保留；可查看模型原文后重试。'; record.error = brain.error;
      } else {
        record.ideas = result.ideas;
        record.source = source;
        record.status = 'completed'; record.warning = result.warning || '';
        record.history = [{id:newBrainId(),createdAt:Date.now(),source:source,ideas:result.ideas},...record.history].slice(0,5);
        const fingerprints = new Map();
        for (const idea of [...record.previousIdeas,...result.ideas]) { const key = brainIdeaKey(idea); fingerprints.delete(key); fingerprints.set(key,{title:idea.title,premise:idea.premise}); }
        record.previousIdeas = [...fingerprints.values()].slice(-30);
      }
    } catch (error) {
      if (ticket === brain.requestId && !controller.signal.aborted) { record.status = 'failed'; brain.error = error.message; record.error = brain.error; }
    } finally {
      if (ticket === brain.requestId && kind === brain.kind) { brain.generating = false; brain.controller = null; persistBrainstorm(); if (state.view === 'brainstorm') renderBrainstorm(); }
    }
  }
  function stopBrainstorm() {
    if (!brain.generating) return;
    ++brain.requestId;
    if (brain.controller) brain.controller.abort();
    brain.controller = null; brain.generating = false; brainRecord().status = 'stopped';
    persistBrainstorm();
  }
  function brainIdeaText(entry) {
    return '# ' + entry.idea.title + '\n\n' + brainSource(entry.source) + '\n\n' + brainFields(brain.kind).map((pair) => pair[1] + '：\n' + entry.idea[pair[0]]).join('\n\n');
  }
  function downloadBrainText(text,filename) {
    const url = URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  async function copyBrainIdea(entry) {
    const text = brainIdeaText(entry);
    const ticket = state.navId;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (state.view === 'brainstorm' && ticket === state.navId) { brain.notice = '脑洞已复制。'; updateBrainNotice(); }
    } catch {
      if (state.view !== 'brainstorm' || ticket !== state.navId) return;
      brain.notice = '当前浏览器不支持直接复制，已展开文本。可长按复制或下载。'; brain.copyPreview = text; renderBrainstorm();
      const input = document.getElementById('brainCopyPreview'); if (input) { input.focus({preventScroll:true}); input.setSelectionRange(0,text.length); }
    }
  }
  function handleBrainstormAction(target) {
    const data = target.dataset;
    if (data.action === 'brainstorm') { void openBrainstorm(); return true; }
    if (data.brainKind) {
      if (!brain.generating && Object.prototype.hasOwnProperty.call(brainKinds,data.brainKind)) { brain.kind = data.brainKind; brain.tab = 'current'; brain.error = ''; brain.notice = ''; brain.copyPreview = ''; brain.storageWarning = ''; brainRecord(); try { localStorage.setItem('writer-mobile-brainstorm-kind',JSON.stringify(brain.kind)); } catch { brain.storageWarning = '篇幅选择无法保存。'; } renderBrainstorm(); }
      return true;
    }
    if (data.brainTab) { if (!brain.generating && ['current','history','favorites'].includes(data.brainTab)) { brain.tab = data.brainTab; brain.copyPreview = ''; renderBrainstorm(); } return true; }
    if (data.action === 'brain-stop') { stopBrainstorm(); renderBrainstorm(); return true; }
    if (data.action === 'brain-download-raw') { downloadBrainText(brainRecord().raw,brainKinds[brain.kind] + '-脑洞原文.txt'); return true; }
    const key = data.brainFavorite || data.brainCopy || data.brainDownload;
    if (!key) return false;
    const entry = brainIdeaEntry(key);
    if (!entry) return true;
    if (data.brainFavorite) {
      const record = brainRecord(); const index = record.favorites.findIndex((favorite) => brainIdeaKey(favorite.idea) === brainIdeaKey(entry.idea));
      if (index >= 0) { record.favorites.splice(index,1); brain.notice = '已取消收藏。'; }
      else if (record.favorites.length >= 30) { brain.notice = '最多收藏 30 个脑洞，请先取消不需要的收藏。'; }
      else { record.favorites.unshift({idea:entry.idea,source:entry.source}); brain.notice = '已收藏，可在「收藏」查看。'; }
      persistBrainstorm(); renderBrainstorm();
    } else if (data.brainCopy) void copyBrainIdea(entry);
    else downloadBrainText(brainIdeaText(entry),entry.idea.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'-').slice(0,60) + '-脑洞.txt');
    return true;
  }
  window.addEventListener('pagehide',stopBrainstorm);
  window.addEventListener('pageshow', () => { if (state.view === 'brainstorm' && !brain.generating) renderBrainstorm(); });
`
