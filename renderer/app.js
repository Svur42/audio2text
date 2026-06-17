'use strict';

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
let config = null;
let tasks = [];                 // 来自主进程的最新任务列表
let currentFilter = 'running';  // running | queued | done
let pendingFiles = [];          // 待确认的拖入/选择文件
let pendingOutDirs = [];        // 与 pendingFiles 等长，每项=自定义输出目录或 null(默认)
let pendingFormats = [];        // 与 pendingFiles 等长，每项='txt'|'srt'|'vtt'
let elapsedTimer = null;
let detailTaskId = null;        // 当前打开详情的任务 id（null=未打开）
let pendingRemoveId = null;     // 待确认删除的已完成任务 id

const AUDIO_EXT = ['mp3','mp4','wav','m4a','flac','mkv','aac','ogg','wma','webm','mov'];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------------------------------------------------------------------------
// 主题 / 强调色
// ---------------------------------------------------------------------------
function hexToSoft(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 'rgba(91,91,250,0.14)';
  const n = parseInt(m[1], 16);
  return `rgba(${(n>>16)&255}, ${(n>>8)&255}, ${n&255}, 0.14)`;
}
function applyTheme(cfg) {
  document.documentElement.setAttribute('data-theme', cfg.theme || 'dark');
  document.documentElement.style.setProperty('--accent', cfg.accent || '#5b5bfa');
  document.documentElement.style.setProperty('--accent-soft', hexToSoft(cfg.accent));
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
async function init() {
  config = await window.api.getConfig();
  applyTheme(config);
  bindEvents();
  window.api.onTasksUpdate((list) => { tasks = list; render(); });
  window.api.onWarnings((msgs) => showWarnings(msgs));

  // 模型下载进度/完成（全局注册一次）
  window.api.onDownloadProgress(({ type, line }) => {
    const btn = type === 'whisper' ? $('#btn-dl-whisper') : $('#btn-dl-demucs');
    if (btn) btn.textContent = line.length > 20 ? line.slice(0, 20) + '…' : line;
  });
  window.api.onDownloadDone(({ type, code, error }) => {
    const btn = type === 'whisper' ? $('#btn-dl-whisper') : $('#btn-dl-demucs');
    if (code === 0) {
      if (btn) { btn.textContent = '✓ 已下载'; btn.disabled = false; }
      if (type === 'whisper') refreshWhisperModelStatus();
      else refreshDemucsModelStatus();
    } else {
      if (btn) { btn.textContent = '⬇ 下载'; btn.disabled = false; }
      showWarnings([`模型下载失败${error ? '：' + error : '（查看控制台日志）'}`]);
    }
  });

  window.api.refreshTasks();
  startElapsedTimer();
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
function bindEvents() {
  // 侧栏切换
  $$('.nav-item').forEach(el => {
    el.addEventListener('click', () => {
      $$('.nav-item').forEach(n => n.classList.remove('active'));
      el.classList.add('active');
      currentFilter = el.dataset.filter;
      $('#view-title').textContent = el.querySelector('.nav-label').textContent;
      // "清空记录"按钮仅在"已完成"页显示
      $('#btn-clear-finished').classList.toggle('hidden', currentFilter !== 'done');
      render();
    });
  });

  // 添加文件（左侧栏）
  $('#btn-add').addEventListener('click', pickFiles);

  // 刷新列表（右上角）
  $('#btn-refresh').addEventListener('click', () => {
    const btn = $('#btn-refresh');
    btn.classList.add('spinning');
    window.api.refreshTasks();
    setTimeout(() => btn.classList.remove('spinning'), 500);
  });

  // 清空已完成/失败记录（不删文档）
  $('#btn-clear-finished').addEventListener('click', async () => {
    const n = await window.api.clearFinished();
    void n;
  });

  // 删除确认弹窗（方案A三按钮）
  $('#remove-record-only').addEventListener('click', () => doRemove(false));
  $('#remove-with-file').addEventListener('click', () => doRemove(true));
  $('#remove-cancel').addEventListener('click', closeRemoveModal);
  $('#remove-modal').addEventListener('click', (e) => {
    if (e.target.id === 'remove-modal') closeRemoveModal();
  });

  // 设置
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', () => $('#settings-modal').classList.add('hidden'));
  $('#settings-save').addEventListener('click', saveSettings);
  $$('#settings-modal [data-pick]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const dir = await window.api.pickDir();
      if (dir) {
        const map = {
          outDir: '#set-outdir', whisperDir: '#set-whisper',
          demucsCacheDir: '#set-demucs', ffmpegDir: '#set-ffmpeg',
        };
        $(map[btn.dataset.pick]).value = dir;
        if (btn.dataset.pick === 'whisperDir') { refreshModelStatus(); refreshWhisperModelStatus(); }
        else if (btn.dataset.pick === 'demucsCacheDir') refreshModelStatus();
      }
    });
  });
  // 模型下载按钮
  $('#btn-dl-whisper').addEventListener('click', () => {
    const btn = $('#btn-dl-whisper');
    btn.textContent = '下载中…'; btn.disabled = true;
    window.api.downloadModel({
      type: 'whisper',
      modelName: $('#set-whisper-model').value,
      whisperDir: $('#set-whisper').value || config.whisperDir,
      demucsDir: $('#set-demucs').value || config.demucsCacheDir,
      ffmpegDir: $('#set-ffmpeg').value || config.ffmpegDir,
    });
  });
  $('#btn-dl-demucs').addEventListener('click', () => {
    const btn = $('#btn-dl-demucs');
    btn.textContent = '下载中…'; btn.disabled = true;
    window.api.downloadModel({
      type: 'demucs',
      demucsModel: $('#set-demucs-model').value,
      whisperDir: $('#set-whisper').value || config.whisperDir,
      demucsDir: $('#set-demucs').value || config.demucsCacheDir,
      ffmpegDir: $('#set-ffmpeg').value || config.ffmpegDir,
    });
  });

  // Python 解释器选择（选 .exe）
  $('#btn-pick-python').addEventListener('click', async () => {
    const p = await window.api.pickExe();
    if (p) { $('#set-python').value = p; updatePythonStatus(); }
  });
  // 切换模型 → 刷新该模型的下载状态
  $('#set-whisper-model').addEventListener('change', refreshWhisperModelStatus);
  $('#set-demucs-model').addEventListener('change', refreshDemucsModelStatus);
  $('#reset-accent').addEventListener('click', () => { $('#set-accent').value = '#5b5bfa'; });

  // 确认弹窗
  $('#confirm-cancel').addEventListener('click', closeConfirm);
  $('#confirm-ok').addEventListener('click', confirmStart);
  $$('input[name="music"]').forEach(r => r.addEventListener('change', updateMusicHint));
  $('#btn-pick-unified').addEventListener('click', pickUnifiedDir);
  $('#btn-clear-unified').addEventListener('click', clearUnifiedDir);
  const ufSel = $('#unified-format');
  if (ufSel) ufSel.addEventListener('change', () => applyUnifiedFormat(ufSel.value));

  // 任务详情
  $('#detail-close').addEventListener('click', closeDetail);
  $('#detail-modal').addEventListener('click', (e) => {
    if (e.target.id === 'detail-modal') closeDetail();   // 点遮罩关闭
  });

  // 拖拽
  setupDragDrop();
}

// ---------------------------------------------------------------------------
// 拖拽
// ---------------------------------------------------------------------------
function setupDragDrop() {
  const overlay = $('#drop-overlay');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    overlay.classList.add('show');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    depth--;
    if (depth <= 0) { depth = 0; overlay.classList.remove('show'); }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('show');
    const files = [...e.dataTransfer.files]
      .map(f => window.api.getFilePath(f))
      .filter(Boolean)
      .filter(p => AUDIO_EXT.includes(p.split('.').pop().toLowerCase()));
    if (files.length) openConfirm(files);
  });
}

async function pickFiles() {
  const files = await window.api.pickFiles();
  if (files && files.length) openConfirm(files);
}

// ---------------------------------------------------------------------------
// 确认弹窗（迷你任务列表 + 每文件/统一输出目录）
// ---------------------------------------------------------------------------
function openConfirm(files) {
  pendingFiles = files;
  pendingOutDirs = files.map(() => null);      // null = 用默认目录
  pendingFormats = files.map(() => 'txt');     // 每个文件的导出格式
  $('input[name="music"][value="no"]').checked = true;
  $('#unified-path').value = '';
  const uf = $('#unified-format');
  if (uf) uf.value = '';
  $('#confirm-count').textContent = files.length;
  updateMusicHint();
  renderConfirmRows();
  $('#confirm-modal').classList.remove('hidden');
}
function closeConfirm() {
  $('#confirm-modal').classList.add('hidden');
  pendingFiles = [];
  pendingOutDirs = [];
}
function updateMusicHint() {
  const yes = $('input[name="music"][value="yes"]').checked;
  $('#music-hint').textContent = yes
    ? '首次使用需联网下载人声分离模型（约数百 MB），过程中无进度显示，请耐心等待。'
    : '';
}

const FMT_LABELS = { txt: '纯文本', srt: 'SRT 字幕', vtt: 'VTT 字幕' };

function renderConfirmRows() {
  const wrap = $('#confirm-file-rows');
  wrap.innerHTML = pendingFiles.map((f, i) => {
    const name = f.replace(/^.*[\\/]/, '');
    const dir = pendingOutDirs[i];
    const dirTxt = dir ? escapeHtml(dir) : '默认目录';
    const dirCls = dir ? 'file-row-dir custom' : 'file-row-dir';
    const fmt = pendingFormats[i] || 'txt';
    const fmtOpts = ['txt','srt','vtt'].map(v =>
      `<option value="${v}"${v===fmt?' selected':''}>${FMT_LABELS[v]}</option>`).join('');
    return `<div class="file-row" data-idx="${i}">
      <span class="file-row-name" title="${escapeAttr(name)}">${escapeHtml(name)}</span>
      <select class="file-fmt-sel select-tiny" data-fmt-idx="${i}">${fmtOpts}</select>
      <span class="${dirCls}" title="${escapeAttr(dir || '默认目录')}">${dirTxt}</span>
      <button class="icon-btn" data-pick-file="${i}" title="设置此文件的输出位置">📂</button>
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-pick-file]').forEach(b =>
    b.onclick = async () => {
      const idx = Number(b.dataset.pickFile);
      const d = await window.api.pickDir();
      if (d) { pendingOutDirs[idx] = d; renderConfirmRows(); }
    });
  wrap.querySelectorAll('[data-fmt-idx]').forEach(sel =>
    sel.onchange = () => { pendingFormats[Number(sel.dataset.fmtIdx)] = sel.value; });
}

function applyUnifiedFormat(fmt) {
  if (!fmt) return;
  pendingFormats = pendingFormats.map(() => fmt);
  renderConfirmRows();
}

async function pickUnifiedDir() {
  const d = await window.api.pickDir();
  if (!d) return;
  $('#unified-path').value = d;
  pendingOutDirs = pendingOutDirs.map(() => d);   // 统一应用到所有文件
  renderConfirmRows();
}
function clearUnifiedDir() {
  $('#unified-path').value = '';
  pendingOutDirs = pendingOutDirs.map(() => null); // 全部回到默认
  renderConfirmRows();
}

async function confirmStart() {
  const music = $('input[name="music"][value="yes"]').checked;
  const outDirs = pendingOutDirs.map(d => d || config.outDir);
  const outputFormats = pendingFormats.slice();
  await window.api.addTasks({ files: pendingFiles, music, outDirs, outputFormats });
  closeConfirm();
  $('.nav-item[data-filter="running"]').click();   // 切到处理中视图
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
const WHISPER_MODELS = [
  ['large-v3-turbo', 'large-v3-turbo（推荐 · 快且质量高）'],
  ['large-v3',       'large-v3（最高质量 · 慢 · 显存高）'],
  ['large-v2',       'large-v2（老牌稳定）'],
  ['distil-large-v3','distil-large-v3（蒸馏 · 接近 large 质量 · 更快）'],
  ['medium',         'medium（中等质量 · CPU 可用）'],
  ['small',          'small（轻量 · CPU 友好）'],
  ['base',           'base（极轻 · CPU 友好）'],
  ['tiny',           'tiny（最轻最快 · 精度低 · CPU 首选）'],
];
const DEMUCS_MODELS = [
  ['htdemucs',      'htdemucs（默认 · 推荐）'],
  ['htdemucs_ft',   'htdemucs_ft（更好 · 慢约 4 倍）'],
  ['htdemucs_6s',   'htdemucs_6s（分离 6 个声部 · 慢）'],
  ['mdx_extra',     'mdx_extra（MDX 架构 · 备选）'],
  ['mdx_extra_q',   'mdx_extra_q（量化版 · CPU 友好）'],
  ['mdx_q',         'mdx_q（量化版 · CPU 友好）'],
];

function fillSelect(sel, options, current) {
  sel.innerHTML = options.map(([v, label]) =>
    `<option value="${v}"${v === current ? ' selected' : ''}>${label}</option>`).join('');
}

function openSettings() {
  fillSelect($('#set-whisper-model'), WHISPER_MODELS, config.whisperModel || 'large-v3-turbo');
  fillSelect($('#set-demucs-model'), DEMUCS_MODELS, config.demucsModel || 'htdemucs');
  $('#set-outdir').value = config.outDir || '';
  $('#set-whisper').value = config.whisperDir || '';
  $('#set-demucs').value = config.demucsCacheDir || '';
  $('#set-python').value = config.pythonPath || '';
  $('#set-ffmpeg').value = config.ffmpegDir || '';
  $('#set-theme').value = config.theme || 'dark';
  $('#set-accent').value = config.accent || '#5b5bfa';
  updatePythonStatus();
  refreshWhisperModelStatus();
  refreshDemucsModelStatus();
  refreshModelStatus();
  $('#settings-modal').classList.remove('hidden');
}

function updatePythonStatus() {
  const tag = $('#python-status');
  const p = $('#set-python').value;
  if (p) { tag.textContent = '已设置'; tag.className = 'status-tag ok'; }
  else { tag.textContent = '将自动检测'; tag.className = 'status-tag miss'; }
}

// 刷新 Whisper 模型下载状态 + 显隐下载按钮 + 动态目录标签
async function refreshWhisperModelStatus() {
  const name = $('#set-whisper-model').value;
  const dir = $('#set-whisper').value || config.whisperDir;
  const ok = await window.api.whisperModelStatus(dir, name);
  const tag = $('#whisper-model-status');
  const btn = $('#btn-dl-whisper');
  if (ok) {
    tag.textContent = '已下载'; tag.className = 'status-tag ok';
    btn.classList.add('hidden');
    $('#whisper-dir-label').textContent = 'Whisper 模型目录';
  } else {
    tag.textContent = '未下载'; tag.className = 'status-tag miss';
    btn.classList.remove('hidden');
    $('#whisper-dir-label').textContent = 'Whisper 模型存储目录（下载位置）';
  }
  updateModelDlHint();
}

// 刷新 Demucs 模型下载状态
async function refreshDemucsModelStatus() {
  const name = $('#set-demucs-model').value;
  const dir = $('#set-demucs').value || config.demucsCacheDir;
  const ok = await window.api.demucsModelStatus(dir);
  const tag = $('#demucs-model-status');
  const btn = $('#btn-dl-demucs');
  if (ok) {
    tag.textContent = '已下载'; tag.className = 'status-tag ok';
    btn.classList.add('hidden');
    $('#demucs-dir-label').textContent = 'Demucs 模型目录';
  } else {
    tag.textContent = '未下载'; tag.className = 'status-tag miss';
    btn.classList.remove('hidden');
    $('#demucs-dir-label').textContent = 'Demucs 模型存储目录（下载位置）';
  }
  updateModelDlHint();
}

function updateModelDlHint() {
  const hint = $('#model-dl-hint');
  const anyMissing = !$('#btn-dl-whisper').classList.contains('hidden')
    || !$('#btn-dl-demucs').classList.contains('hidden');
  hint.style.display = anyMissing ? '' : 'none';
}

async function refreshModelStatus() {
  const det = await window.api.detectModels();
  const wTag = $('#whisper-status');
  const dTag = $('#demucs-status');
  if (det.whisperDir) { wTag.textContent = '已检测到'; wTag.className = 'status-tag ok'; }
  else { wTag.textContent = '未检测到'; wTag.className = 'status-tag miss'; }
  if (det.demucsCacheDir) { dTag.textContent = '已检测到'; dTag.className = 'status-tag ok'; }
  else { dTag.textContent = '未检测，首次将下载'; dTag.className = 'status-tag miss'; }
}

async function saveSettings() {
  const next = {
    whisperModel: $('#set-whisper-model').value,
    demucsModel: $('#set-demucs-model').value,
    outDir: $('#set-outdir').value,
    whisperDir: $('#set-whisper').value,
    demucsCacheDir: $('#set-demucs').value,
    pythonPath: $('#set-python').value,
    ffmpegDir: $('#set-ffmpeg').value,
    theme: $('#set-theme').value,
    accent: $('#set-accent').value,
  };
  await window.api.saveConfig(next);
  config = await window.api.getConfig();
  applyTheme(config);
  $('#settings-modal').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// 警告
// ---------------------------------------------------------------------------
function showWarnings(msgs) {
  if (!msgs || !msgs.length) return;
  const bar = $('#warn-bar');
  bar.textContent = '⚠ ' + msgs.join('；');
  bar.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function categoryOf(t) {
  if (t.status === 'running' || t.status === 'retrying') return 'running';
  if (t.status === 'queued') return 'queued';
  return 'done'; // done | error | canceled
}

// 状态 → 中文
function statusText(s) {
  return ({ running: '处理中', retrying: '等待重试', queued: '排队中',
    done: '已完成', error: '失败', canceled: '已取消' })[s] || s;
}

// 渲染主入口：原地更新 DOM（不重建 innerHTML），避免入场动画反复重放导致的闪烁
function render() {
  // 徽标
  const counts = { running: 0, queued: 0, done: 0 };
  tasks.forEach(t => counts[categoryOf(t)]++);
  $('#badge-running').textContent = counts.running;
  $('#badge-queued').textContent = counts.queued;
  $('#badge-done').textContent = counts.done;

  const list = tasks.filter(t => categoryOf(t) === currentFilter);
  const listEl = $('#task-list');
  const emptyEl = $('#empty-state');
  emptyEl.classList.toggle('hidden', list.length > 0);

  // 调和：移除不在当前过滤集里的卡片
  const wantIds = new Set(list.map(t => String(t.id)));
  [...listEl.children].forEach(el => {
    if (!wantIds.has(el.dataset.id)) el.remove();
  });
  // 新增 / 原地更新
  list.forEach(t => {
    let el = listEl.querySelector(`.card[data-id="${t.id}"]`);
    if (!el) { el = createCardEl(t); listEl.appendChild(el); }
    updateCardEl(el, t);
  });

  // 详情页若打开则同步刷新
  if (detailTaskId != null) renderDetail();
}

function createCardEl(t) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = t.id;
  el.innerHTML =
    '<div class="card-top">' +
      '<span class="card-name"></span>' +
      '<span class="card-tag-slot"></span>' +
      '<span class="card-actions"></span>' +
      '<span class="card-arrow" title="查看详情">›</span>' +
    '</div>' +
    '<div class="progress"><div class="progress-fill"></div></div>' +
    '<div class="card-meta"></div>';
  // 点卡片进详情（点操作按钮区域不触发）
  el.addEventListener('click', (e) => {
    if (e.target.closest('.card-actions')) return;
    openDetail(t.id);
  });
  return el;
}

function updateCardEl(el, t) {
  const isRunning = t.status === 'running' || t.status === 'retrying';
  const isDone = t.status === 'done';
  const isError = t.status === 'error' || t.status === 'canceled';

  el.classList.toggle('is-done', isDone);
  el.classList.toggle('is-error', isError);

  const nameEl = el.querySelector('.card-name');
  nameEl.textContent = t.name;
  nameEl.title = t.name;

  el.querySelector('.card-tag-slot').innerHTML =
    t.music ? '<span class="card-tag music">含音乐</span>' : '';

  // 进度条：indeterminate 用 CSS 动画扫光；determinate 设 width 走平滑过渡
  const fill = el.querySelector('.progress-fill');
  const indet = !isDone && !isError && t.indeterminate;
  fill.classList.toggle('done', isDone);
  fill.classList.toggle('error', isError);
  fill.classList.toggle('indeterminate', indet);
  if (!indet) fill.style.width = (isDone ? 100 : (t.pct || 0)) + '%';

  // 元信息（含当前步骤文字 + 用时 + 百分比）
  el.querySelector('.card-meta').innerHTML = metaHtml(t);

  // 操作按钮（无动画，原地替换不闪）
  const actEl = el.querySelector('.card-actions');
  actEl.innerHTML = actionsHtml(t);
  actEl.querySelectorAll('[data-cancel]').forEach(b =>
    b.onclick = (e) => { e.stopPropagation(); window.api.cancelTask(Number(b.dataset.cancel)); });
  actEl.querySelectorAll('[data-remove]').forEach(b =>
    b.onclick = (e) => { e.stopPropagation(); requestRemove(Number(b.dataset.remove)); });
  actEl.querySelectorAll('[data-open]').forEach(b =>
    b.onclick = (e) => { e.stopPropagation(); window.api.openFolder(b.dataset.open); });
}

function metaHtml(t) {
  const isRunning = t.status === 'running' || t.status === 'retrying';
  const isDone = t.status === 'done';
  if (isRunning) {
    let stepTxt = escapeHtml(t.step || '处理中');
    if (t.stepTotal > 1 && t.stepNum) stepTxt = `第${t.stepNum}/${t.stepTotal}步 · ` + stepTxt;
    const eta = t.etaMin ? ` · 预计 ${t.etaMin} 分` : '';
    const elapsed = `<span class="elapsed" data-start="${t.startTs || 0}">用时 ${fmtElapsed(t.startTs)}</span>`;
    const pct = t.indeterminate ? '<span class="pct dim">处理中…</span>' : `<span class="pct">${t.pct}%</span>`;
    return `<span class="step">${stepTxt}${eta}</span>${elapsed}${pct}`;
  }
  if (isDone) return `<span class="step">完成</span><span class="pct">100%</span>`;
  if (t.status === 'queued') return `<span class="step">排队等待中…</span>`;
  return `<span class="step">${escapeHtml(t.step || statusText(t.status))}</span>`;
}

function actionsHtml(t) {
  const isRunning = t.status === 'running' || t.status === 'retrying';
  const isDone = t.status === 'done';
  if (isRunning || t.status === 'queued') {
    return `<button class="icon-btn danger" data-cancel="${t.id}">✕ 取消</button>`;
  } else if (isDone) {
    return `<button class="icon-btn ok" data-open="${escapeAttr(t.outFile || '')}">📂 打开</button>` +
           `<button class="icon-btn" data-remove="${t.id}">移除</button>`;
  }
  return `<button class="icon-btn" data-remove="${t.id}">移除</button>`;
}

// ---------------------------------------------------------------------------
// 任务详情
// ---------------------------------------------------------------------------
function openDetail(id) {
  detailTaskId = id;
  renderDetail();
  $('#detail-modal').classList.remove('hidden');
}
function closeDetail() {
  detailTaskId = null;
  $('#detail-modal').classList.add('hidden');
}
function renderDetail() {
  const t = tasks.find(x => x.id === detailTaskId);
  if (!t) { closeDetail(); return; }
  const isDone = t.status === 'done';
  const isError = t.status === 'error' || t.status === 'canceled';
  const indet = !isDone && !isError && t.indeterminate;

  $('#detail-name').textContent = t.name;

  const fill = $('#detail-fill');
  fill.className = 'progress-fill'
    + (isDone ? ' done' : (isError ? ' error' : (indet ? ' indeterminate' : '')));
  if (!indet) fill.style.width = (isDone ? 100 : (t.pct || 0)) + '%';

  $('#detail-pct').textContent =
    isDone ? '100%' : (indet ? '处理中…' : (t.pct || 0) + '%');

  const stepLabel = (t.stepNum && t.stepTotal)
    ? `第 ${t.stepNum} 步 / 共 ${t.stepTotal} 步 · ${t.step || ''}`
    : (t.step || statusText(t.status));
  $('#detail-step').textContent = stepLabel;

  // 进度条下方的醒目状态横幅：当前在干嘛 + 进度
  const procTxt = (t.processedSec != null && t.totalSec)
    ? ` · ${fmtSec(t.processedSec)} / ${fmtSec(t.totalSec)}`
    : '';
  let banner;
  if (isDone) banner = '✓ 已完成';
  else if (isError) banner = t.step || statusText(t.status);
  else if (t.status === 'queued') banner = '排队等待中…';
  else banner = stepLabel + procTxt;     // running/retrying
  $('#detail-status').textContent = banner;

  $('#detail-processed').textContent =
    (t.processedSec != null && t.totalSec)
      ? `${fmtSec(t.processedSec)} / ${fmtSec(t.totalSec)}`
      : '—';
  $('#detail-duration').textContent = t.durationMin ? `${t.durationMin} 分钟` : '—';
  $('#detail-eta').textContent = t.etaMin ? `约 ${t.etaMin} 分钟` : '—';
  $('#detail-elapsed').textContent =
    (t.status === 'running' || t.status === 'retrying') ? fmtElapsed(t.startTs)
      : (isDone ? '已完成' : '—');
  $('#detail-fmt').textContent = FMT_LABELS[t.outputFormat] || '纯文本';
  $('#detail-music').textContent = t.music ? '是（含人声分离）' : '否';
  $('#detail-outdir').textContent = t.outDir || '—';

  const openBtn = $('#detail-open-folder');
  if (isDone && t.outFile) {
    openBtn.style.display = '';
    openBtn.onclick = () => window.api.openFolder(t.outFile);
  } else {
    openBtn.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// 删除任务（成功任务弹三按钮确认，其余直接删记录）
// ---------------------------------------------------------------------------
function requestRemove(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  if (t.status === 'done' && t.outFile) {
    pendingRemoveId = id;
    $('#remove-name').textContent = t.name;
    $('#remove-modal').classList.remove('hidden');
  } else {
    window.api.removeTask(id);        // 失败/取消/无文档：直接删记录
  }
}
function doRemove(deleteFile) {
  const id = pendingRemoveId;
  if (id == null) return;
  window.api.deleteTask(id, deleteFile);
  if (detailTaskId === id) closeDetail();
  closeRemoveModal();
}
function closeRemoveModal() {
  pendingRemoveId = null;
  $('#remove-modal').classList.add('hidden');
}

function fmtElapsed(startTs) {
  if (!startTs) return '0:00';
  const s = Math.floor((Date.now() - startTs) / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function fmtSec(s) {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// 实时刷新"用时"（每秒，仅更新文字，不重渲染）
function startElapsedTimer() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    document.querySelectorAll('.elapsed').forEach(el => {
      const start = Number(el.dataset.start);
      if (start) el.textContent = `用时 ${fmtElapsed(start)}`;
    });
    if (detailTaskId != null) {
      const t = tasks.find(x => x.id === detailTaskId);
      if (t && (t.status === 'running' || t.status === 'retrying')) {
        $('#detail-elapsed').textContent = fmtElapsed(t.startTs);
      }
    }
  }, 1000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
}
function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

init();
