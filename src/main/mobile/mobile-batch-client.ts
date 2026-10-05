export const MOBILE_BATCH_STYLES = String.raw`
    .mb-form{display:grid;gap:14px}.mb-range{display:grid;grid-template-columns:1fr 1fr;gap:12px}.mb-form label{display:grid;gap:7px;font-size:13px;font-weight:700}.mb-form .input{min-width:0;font-weight:400}.mb-checkbox{display:flex!important;align-items:center;gap:10px!important;min-height:44px;font-weight:400!important}.mb-checkbox input{width:20px;height:20px;accent-color:var(--red)}.mb-actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:14px}.mb-actions button{min-height:44px;border:1px solid var(--line);border-radius:10px;background:var(--paper);padding:9px 14px}.mb-actions .primary{background:var(--red);color:white;border-color:var(--red)}.mb-progress{margin-bottom:15px}.mb-progress h2{margin:0 0 12px;font-size:17px}.mb-count{display:flex;justify-content:space-between;gap:12px;font-size:14px;line-height:1.6}.mb-track{height:8px;border-radius:99px;background:var(--paper2);overflow:hidden;margin:12px 0}.mb-fill{height:100%;background:var(--red);border-radius:99px;transition:width .2s}.mb-current{color:var(--muted);font-size:13px;line-height:1.7}.mb-stream{max-height:210px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:13px;line-height:1.75;margin:10px 0 0}.mb-summary{font-size:13px;line-height:1.7}.mb-summary h3{font-size:15px;margin:0 0 8px}.mb-summary p{margin:4px 0;overflow-wrap:anywhere}.mb-summary .mb-pending{color:var(--red)}.mb-result-list{display:grid;gap:10px}.mb-safety{margin-top:10px;font-size:12px;color:var(--muted);line-height:1.7}.mb-status{margin-bottom:14px}.mb-status .notice{margin-bottom:10px}.mb-empty{margin-top:14px}.mb-form .primary{width:100%}
`

// Shares the mobile page's authenticated request and navigation helpers.
export const MOBILE_BATCH_CLIENT = String.raw`
  const mobileBatch = {projectId:'',epoch:0,timer:0,poll:null,paused:true,loading:false,loaded:false,busy:false,job:null,chapters:[],error:'',readError:false,notice:'',form:{from:'1',to:'10',autoStrength:false},formEdited:false,startKey:'',startId:''};
  const mobileBatchPath = (projectId,suffix) => '/api/projects/' + encodeURIComponent(projectId) + '/batch' + (suffix || '');
  const mobileBatchCurrent = (projectId,epoch) => state.view === 'mobile-batch' && !!state.project && state.project.id === projectId && mobileBatch.projectId === projectId && mobileBatch.epoch === epoch && !mobileBatch.paused;
  function mobileBatchRange(chapters) {
    const sorted = chapters.filter((chapter) => Number.isSafeInteger(chapter.chapterNumber) && chapter.chapterNumber > 0).slice().sort((a,b) => a.chapterNumber - b.chapterNumber);
    const first = sorted.find((chapter) => !(chapter.wordCount > 0));
    const from = first ? first.chapterNumber : sorted.length ? sorted[sorted.length - 1].chapterNumber + 1 : 1;
    let to = Math.min(Number.MAX_SAFE_INTEGER,from + 9);
    if (first) to = Math.min(to,sorted[sorted.length - 1].chapterNumber);
    const nextWritten = sorted.find((chapter) => chapter.chapterNumber > from && chapter.chapterNumber <= to && chapter.wordCount > 0);
    if (nextWritten) to = nextWritten.chapterNumber - 1;
    return {from:String(from),to:String(to),autoStrength:false};
  }
  function mobileBatchRangeError(from,to) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < 1) return '章号必须为正整数。';
    if (to < from) return '结束章号不能小于起始章号。';
    if (to - from + 1 > 100) return '每批最多生成 100 章。';
    return '';
  }
  function mobileBatchSaved(job) {
    const progress = job && job.progress || {};
    return Array.from(new Set((Array.isArray(progress.completed) ? progress.completed : []).filter((chapter) => Number.isSafeInteger(chapter) && chapter >= progress.fromChapter && chapter <= progress.toChapter))).sort((a,b) => a - b);
  }
  function mobileBatchStatus(job) {
    const progress = job.progress || {};
    if (job.running && job.stopping) return '正在停止';
    if (job.running && job.retryWait) return '等待自动重试';
    if (job.running) return ({generating:'正在生成正文',deslop:'自动去 AI 味中',checking:'写后检查中'})[job.stage] || '电脑正在执行本批';
    return ({pending:'等待开始',generating:'已中断，可继续',flow:'检查待继续',paused:'已暂停',failed:'本批失败',completed:'本批完成'})[progress.status] || '等待继续';
  }
  function mobileBatchNotice() {
    return (mobileBatch.error ? '<div class="notice error" role="alert">' + esc(mobileBatch.error) + '</div>' : '') + (mobileBatch.notice ? '<div class="notice" role="status">' + esc(mobileBatch.notice) + '</div>' : '');
  }
  function mobileBatchJobHtml(job) {
    const progress = job.progress || {};
    const saved = mobileBatchSaved(job);
    const total = Number.isSafeInteger(progress.total) && progress.total > 0 ? progress.total : Math.max(1,progress.toChapter - progress.fromChapter + 1 || 1);
    const percent = Math.max(0,Math.min(100,Math.round(saved.length / total * 100)));
    const disabled = mobileBatch.busy || state.offline ? ' disabled' : '';
    const pending = progress.pendingPostProcessChapter;
    const retry = job.retryWait;
    const remaining = retry && Number.isFinite(retry.retryAt) ? Math.max(0,Math.ceil((retry.retryAt - Date.now()) / 1000)) : 0;
    const canResume = !job.running && (progress.status !== 'completed' || pending != null);
    const summaries = Array.isArray(job.summaries) ? job.summaries : [];
    return '<article class="card mb-progress"><h2>' + esc(mobileBatchStatus(job)) + '</h2><div class="mb-count" role="status"><strong>' + saved.length + ' / ' + total + ' 章已保存</strong><span>第 ' + esc(progress.fromChapter) + '—' + esc(progress.toChapter) + ' 章</span></div><div class="mb-track" role="progressbar" aria-label="已保存正文章节进度" aria-valuemin="0" aria-valuemax="' + total + '" aria-valuenow="' + saved.length + '"><div class="mb-fill" style="width:' + percent + '%"></div></div><div class="mb-current">当前：第 ' + esc(progress.currentChapter || progress.fromChapter) + ' 章' + (job.autoStrength ? ' · 按节奏调整生成强度' : '') + '</div>' + (saved.length ? '<p class="mb-safety">已保存章节：' + esc(saved.join('、')) + '</p>' : '') + (pending != null ? '<div class="notice">第 ' + esc(pending) + ' 章正文已保存，' + (job.running ? '电脑正在补跑检查，完成后继续下一章。' : '继续时复用正文补跑检查。') + '</div>' : '') + (retry ? '<div class="notice" role="status">第 ' + esc(retry.chapter) + ' 章遇到限流，' + (remaining ? remaining + ' 秒后自动重试' : '正在等待电脑重试') + '（第 ' + esc(retry.attempt) + ' / ' + esc(retry.maxAttempts) + ' 次）。</div>' : '') + (progress.pauseReason ? '<div class="notice">暂停原因：' + esc(progress.pauseReason) + '</div>' : '') + (progress.error ? '<div class="notice error" role="alert">' + esc(progress.error) + '</div>' : '') + '<div class="mb-actions">' + (job.running ? '<button data-action="mobile-batch-stop"' + (job.stopping ? ' disabled' : disabled) + '>' + (job.stopping ? '停止请求已送达' : '停止本批') + '</button>' : (canResume ? '<button class="primary" data-action="mobile-batch-resume"' + disabled + '>' + (pending != null ? '补跑检查并继续' : progress.status === 'failed' ? '重试并继续' : '继续本批') + '</button>' : '') + '<button data-action="mobile-batch-clear"' + disabled + '>结束本批 / 新批</button>') + '<button data-action="mobile-batch-refresh"' + (mobileBatch.busy ? ' disabled' : '') + '>刷新进度</button><button data-action="mobile-batch-chapters">返回章节列表</button></div></article>' + (job.streamText ? '<article class="card mb-progress"><h2>当前正文预览</h2><p class="mb-safety">预览显示最近收到的文字；保存情况以上方章节进度为准。</p><pre id="mbStream" class="mb-stream">' + esc(String(job.streamText).slice(-4000)) + '</pre></article>' : '') + '<div class="section-head"><h2>逐章结果</h2><span class="badge">' + summaries.length + ' 章</span></div><div class="mb-result-list">' + (summaries.length ? summaries.map((summary) => '<article class="card mb-summary"><h3>第 ' + esc(summary.chapter) + ' 章 · ' + esc(summary.wordCount || 0) + ' 字</h3><p>正文：' + (summary.saved === true ? '已保存' : '尚未确认保存') + '</p><p>去 AI 味：' + esc(summary.deslop || '尚未完成') + '</p><p>记忆：' + esc(summary.memory || '尚未完成') + '</p><p' + (summary.checks === 'completed' ? '' : ' class="mb-pending"') + '>检查：' + (summary.checks === 'completed' ? '流程已完成，请查看检查结果' : '待补跑') + '</p><div class="mb-actions"><button data-chapter="' + esc(summary.chapter) + '">查看正文</button></div></article>').join('') : '<div class="empty">每章正文保存及检查完成后，小结会显示在这里。</div>') + '</div>';
  }
  function renderMobileBatch() {
    if (state.view !== 'mobile-batch' || !state.project || state.project.id !== mobileBatch.projectId) return;
    const active = document.activeElement;
    const activeId = active && active.id;
    const pageScroll = window.scrollY;
    const beforeStream = document.getElementById('mbStream');
    const streamScroll = beforeStream ? beforeStream.scrollTop : 0;
    const disabled = mobileBatch.busy || mobileBatch.loading || !mobileBatch.loaded || state.offline ? ' disabled' : '';
    const form = mobileBatch.form;
    const noPending = mobileBatch.loaded && mobileBatch.chapters.length && !mobileBatch.chapters.some((chapter) => !(chapter.wordCount > 0));
    root.innerHTML = topbar('一键 10 章',state.project.name || '作品',true,'') + '<section class="content"><p class="hint">任务在电脑后台连续执行。返回章节列表、锁屏或手机断网后，电脑仍会继续；电脑需要保持应用运行。</p><div id="mbNotice" class="mb-status">' + mobileBatchNotice() + '</div>' + (mobileBatch.loading ? '<div class="notice" role="status">正在读取电脑上的章节与本批进度…</div>' : '') + (mobileBatch.job ? mobileBatchJobHtml(mobileBatch.job) : '<form id="mbForm" class="card mb-form">' + (noPending ? '<div class="notice">当前已知章节全部已有正文。可在电脑补充细纲，或手动调整到新的未写范围。</div>' : '') + '<div class="mb-range"><label for="mbFrom">起始章号<input id="mbFrom" class="input" type="number" inputmode="numeric" min="1" step="1" value="' + esc(form.from) + '"' + disabled + '></label><label for="mbTo">结束章号<input id="mbTo" class="input" type="number" inputmode="numeric" min="1" step="1" value="' + esc(form.to) + '"' + disabled + '></label></div><p class="mb-safety">默认从第一个未写章节起连续写 10 章；遇到已有正文或章节末尾会缩短范围。每批可写 1—100 章。</p><label class="mb-checkbox" for="mbAutoStrength"><input id="mbAutoStrength" type="checkbox"' + (form.autoStrength ? ' checked' : '') + disabled + '>按节奏自动调整生成强度</label><p class="mb-safety">生成后自动去 AI 味、同步记忆并执行写后检查。存在需要核对的问题时，本批会暂停并保留已保存正文。</p><button id="mbStart" class="primary" type="submit" data-action="mobile-batch-start"' + disabled + '>' + (mobileBatch.busy ? '正在提交…' : '开始生成本批') + '</button></form><div class="mb-actions"><button data-action="mobile-batch-refresh"' + (mobileBatch.busy || mobileBatch.loading ? ' disabled' : '') + '>重新读取章节与进度</button><button data-action="mobile-batch-chapters">返回章节列表</button></div>') + '</section>' + nav();
    const bind = (id,key) => { const input = document.getElementById(id); if (input) input.addEventListener('input', () => { mobileBatch.form[key] = input.value; mobileBatch.formEdited = true; }); };
    bind('mbFrom','from'); bind('mbTo','to');
    const strength = document.getElementById('mbAutoStrength');
    if (strength) strength.addEventListener('change', () => { mobileBatch.form.autoStrength = strength.checked; mobileBatch.formEdited = true; });
    const node = document.getElementById('mbForm');
    if (node) node.addEventListener('submit', (event) => { event.preventDefault(); void startMobileBatch(); });
    const restored = activeId && document.getElementById(activeId); if (restored) restored.focus({preventScroll:true});
    const afterStream = document.getElementById('mbStream'); if (afterStream) afterStream.scrollTop = streamScroll;
    window.scrollTo(0,pageScroll);
  }
  function scheduleMobileBatchPoll() {
    window.clearTimeout(mobileBatch.timer);
    if (state.view !== 'mobile-batch' || mobileBatch.paused || state.offline || document.visibilityState === 'hidden' || mobileBatch.busy || mobileBatch.poll) return;
    mobileBatch.timer = window.setTimeout(() => void refreshMobileBatch(false),2000);
  }
  function leaveMobileBatch() {
    window.clearTimeout(mobileBatch.timer);
    mobileBatch.paused = true;
    ++mobileBatch.epoch;
    if (mobileBatch.poll) mobileBatch.poll.controller.abort();
    mobileBatch.poll = null;
    mobileBatch.loading = false;
    mobileBatch.busy = false;
  }
  async function refreshMobileBatch(withChapters) {
    const projectId = mobileBatch.projectId;
    const epoch = mobileBatch.epoch;
    if (!mobileBatchCurrent(projectId,epoch) || document.visibilityState === 'hidden' || mobileBatch.busy) return;
    if (state.offline) { mobileBatch.loading = false; mobileBatch.readError = true; mobileBatch.error = '手机当前离线，无法读取最新进度。电脑任务仍可能在继续，恢复网络后会重新连接。'; renderMobileBatch(); return; }
    if (mobileBatch.poll) return mobileBatch.poll.promise;
    window.clearTimeout(mobileBatch.timer);
    const before = {job:JSON.stringify(mobileBatch.job),error:mobileBatch.error,notice:mobileBatch.notice,loaded:mobileBatch.loaded};
    const handle = {controller:new AbortController(),promise:null};
    mobileBatch.poll = handle;
    handle.promise = (async () => {
      try {
        const results = await Promise.all([request(mobileBatchPath(projectId),{signal:handle.controller.signal}),withChapters ? request('/api/projects/' + encodeURIComponent(projectId) + '/chapters',{signal:handle.controller.signal}) : Promise.resolve(null)]);
        if (!mobileBatchCurrent(projectId,epoch)) return;
        const previousJob = mobileBatch.job;
        mobileBatch.job = results[0].job || null;
        if (results[1]) { mobileBatch.chapters = (results[1].chapters || []).slice().sort((a,b) => a.chapterNumber - b.chapterNumber); state.chapters = mobileBatch.chapters; }
        else if (previousJob && !mobileBatch.job) {
          const chapters = await request('/api/projects/' + encodeURIComponent(projectId) + '/chapters',{signal:handle.controller.signal});
          if (!mobileBatchCurrent(projectId,epoch)) return;
          mobileBatch.chapters = chapters.chapters || []; state.chapters = mobileBatch.chapters;
        }
        mobileBatch.loaded = true;
        if (withChapters || mobileBatch.readError || before.job !== JSON.stringify(mobileBatch.job)) { mobileBatch.error = ''; mobileBatch.readError = false; }
        if (withChapters || before.job !== JSON.stringify(mobileBatch.job)) mobileBatch.notice = '';
        if (!mobileBatch.job && (!mobileBatch.formEdited || previousJob)) { mobileBatch.form = mobileBatchRange(mobileBatch.chapters); mobileBatch.formEdited = false; }
        if (mobileBatch.job) mobileBatch.form = {from:String(mobileBatch.job.progress.fromChapter),to:String(mobileBatch.job.progress.toChapter),autoStrength:mobileBatch.job.autoStrength === true};
      } catch (error) {
        if (mobileBatchCurrent(projectId,epoch) && !handle.controller.signal.aborted) { mobileBatch.readError = true; mobileBatch.error = '暂时无法读取最新进度：' + error.message + ' 电脑任务可能仍在运行，手机断线不会停止任务。请重试读取。'; }
      } finally {
        if (mobileBatch.poll === handle) mobileBatch.poll = null;
        if (mobileBatchCurrent(projectId,epoch)) {
          const shouldRender = withChapters || mobileBatch.loading || before.loaded !== mobileBatch.loaded || before.job !== JSON.stringify(mobileBatch.job) || before.error !== mobileBatch.error || before.notice !== mobileBatch.notice || mobileBatch.job && mobileBatch.job.running && mobileBatch.job.retryWait;
          mobileBatch.loading = false;
          if (shouldRender) renderMobileBatch();
          scheduleMobileBatchPoll();
        }
      }
    })();
    return handle.promise;
  }
  async function openMobileBatch() {
    if (!state.project || state.transitioning) return;
    state.transitioning = true;
    const canLeave = await prepareToLeave(); state.transitioning = false;
    if (!canLeave || !state.project) return;
    leaveMobileBatch();
    const projectId = state.project.id;
    if (mobileBatch.projectId !== projectId) { mobileBatch.job = null; mobileBatch.chapters = []; mobileBatch.formEdited = false; mobileBatch.startKey = ''; mobileBatch.startId = ''; }
    mobileBatch.projectId = projectId; mobileBatch.paused = false; mobileBatch.loading = true; mobileBatch.loaded = false; mobileBatch.error = ''; mobileBatch.readError = false; mobileBatch.notice = '';
    beginView('mobile-batch'); renderMobileBatch();
    await refreshMobileBatch(true);
  }
  async function startMobileBatch() {
    if (mobileBatch.busy || mobileBatch.loading || !mobileBatch.loaded || !state.project || state.view !== 'mobile-batch' || state.offline || mobileBatch.job) return;
    const from = Number(mobileBatch.form.from); const to = Number(mobileBatch.form.to);
    const error = mobileBatchRangeError(from,to);
    if (error) { mobileBatch.error = error; mobileBatch.readError = false; renderMobileBatch(); return; }
    const projectId = mobileBatch.projectId; const epoch = mobileBatch.epoch;
    mobileBatch.busy = true; mobileBatch.error = ''; mobileBatch.readError = false; mobileBatch.notice = ''; window.clearTimeout(mobileBatch.timer); renderMobileBatch();
    try {
      if (mobileBatch.poll) await mobileBatch.poll.promise;
      if (!mobileBatchCurrent(projectId,epoch)) return;
      const results = await Promise.all([request(mobileBatchPath(projectId)),request('/api/projects/' + encodeURIComponent(projectId) + '/chapters')]);
      if (!mobileBatchCurrent(projectId,epoch)) return;
      mobileBatch.chapters = results[1].chapters || []; state.chapters = mobileBatch.chapters;
      if (results[0].job) { mobileBatch.job = results[0].job; mobileBatch.notice = '电脑已有本批记录，已读取进度。请继续本批，或结束后再开始新批。'; return; }
      const risks = mobileBatch.chapters.filter((chapter) => chapter.chapterNumber >= from && chapter.chapterNumber <= to && chapter.wordCount > 0).map((chapter) => chapter.chapterNumber);
      if (risks.length) { mobileBatch.error = '第 ' + risks.slice(0,20).join('、') + ' 章已有正文，请缩短范围或从下一段未写章节开始。'; return; }
      const key = JSON.stringify([projectId,from,to,mobileBatch.form.autoStrength]);
      if (mobileBatch.startKey !== key || !mobileBatch.startId) { mobileBatch.startKey = key; mobileBatch.startId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
      const result = await request(mobileBatchPath(projectId),{method:'POST',body:JSON.stringify({requestId:mobileBatch.startId,fromChapter:from,toChapter:to,autoStrength:mobileBatch.form.autoStrength})});
      if (!mobileBatchCurrent(projectId,epoch)) return;
      mobileBatch.job = result.job || null;
      if (!mobileBatch.job) throw new Error('未收到本批进度，请刷新确认电脑上的任务状态。');
    } catch (failure) {
      if (mobileBatchCurrent(projectId,epoch)) mobileBatch.error = failure.message + ' 请刷新确认，电脑可能已经接收任务。';
    } finally {
      if (mobileBatchCurrent(projectId,epoch)) { mobileBatch.busy = false; renderMobileBatch(); scheduleMobileBatchPoll(); }
      else if (mobileBatchCurrent(projectId,mobileBatch.epoch) && !mobileBatch.busy) void refreshMobileBatch(true);
    }
  }
  async function mutateMobileBatch(action) {
    if (mobileBatch.busy || !mobileBatch.job || state.view !== 'mobile-batch' || state.offline) return;
    const job = mobileBatch.job;
    if (action === 'stop' && (!job.running || job.stopping) || action !== 'stop' && job.running) return;
    if (action === 'clear' && !window.confirm('结束本批会清除本批进度记录，已经保存的正文会保留。继续后可选择新的章节范围，确定结束吗？')) return;
    const projectId = mobileBatch.projectId; const epoch = mobileBatch.epoch;
    mobileBatch.busy = true; mobileBatch.error = ''; mobileBatch.readError = false; window.clearTimeout(mobileBatch.timer); renderMobileBatch();
    try {
      if (mobileBatch.poll) await mobileBatch.poll.promise;
      if (!mobileBatchCurrent(projectId,epoch)) return;
      const result = await request(mobileBatchPath(projectId,'/' + action),{method:'POST',body:JSON.stringify({jobId:job.id})});
      if (!mobileBatchCurrent(projectId,epoch)) return;
      mobileBatch.job = result.job || null;
      if (action === 'clear') { mobileBatch.formEdited = false; mobileBatch.startKey = ''; mobileBatch.startId = ''; mobileBatch.notice = '本批已结束，已保存正文保留。请选择下一批范围。'; }
      else mobileBatch.notice = action === 'stop' ? '停止请求已送达电脑。已保存正文会保留，请等待电脑确认当前阶段结束。' : '已请求电脑继续本批，将从尚未完成的位置接着执行。';
    } catch (error) { if (mobileBatchCurrent(projectId,epoch)) mobileBatch.error = error.message + ' 请刷新确认电脑上的最新状态。'; }
    finally {
      if (mobileBatchCurrent(projectId,epoch)) { mobileBatch.busy = false; renderMobileBatch(); if (action === 'clear' && !mobileBatch.job && !mobileBatch.error) await refreshMobileBatch(true); else scheduleMobileBatchPoll(); }
      else if (mobileBatchCurrent(projectId,mobileBatch.epoch) && !mobileBatch.busy) void refreshMobileBatch(true);
    }
  }
  function handleMobileBatchAction(target) {
    const action = target.dataset.action;
    if (action === 'mobile-batch') { void openMobileBatch(); return true; }
    if (!action || !action.startsWith('mobile-batch-')) return false;
    if (action === 'mobile-batch-start') { void startMobileBatch(); return true; }
    if (action === 'mobile-batch-refresh') { void refreshMobileBatch(true); return true; }
    if (action === 'mobile-batch-chapters') { void navigate('chapters'); return true; }
    if (['mobile-batch-stop','mobile-batch-resume','mobile-batch-clear'].includes(action)) { void mutateMobileBatch(action.slice('mobile-batch-'.length)); return true; }
    return false;
  }
  function restoreMobileBatchView() {
    if (state.view !== 'mobile-batch' || !state.project || state.project.id !== mobileBatch.projectId || mobileBatch.busy) return;
    mobileBatch.paused = false; mobileBatch.loading = true; renderMobileBatch(); void refreshMobileBatch(true);
  }
  window.addEventListener('pagehide', () => { if (state.view === 'mobile-batch') leaveMobileBatch(); });
  window.addEventListener('pageshow',restoreMobileBatchView);
  document.addEventListener('visibilitychange', () => { if (state.view !== 'mobile-batch') return; if (document.visibilityState === 'hidden') leaveMobileBatch(); else restoreMobileBatchView(); });
  window.addEventListener('offline', () => {
    window.clearTimeout(mobileBatch.timer);
    const projectId = mobileBatch.projectId; const epoch = mobileBatch.epoch;
    window.setTimeout(() => { if (mobileBatchCurrent(projectId,epoch)) { mobileBatch.readError = true; mobileBatch.error = '手机当前离线，无法读取最新进度。电脑后台任务会继续，恢复网络后会重新连接。'; renderMobileBatch(); } },0);
  });
  window.addEventListener('online', () => { if (state.view === 'mobile-batch') window.setTimeout(restoreMobileBatchView,0); });
`
