'use strict';

// ---------------------------------------------------------------------------
// 渲染端日志缓冲（捕获 console 错误 + 下载进度，供"查看日志"面板使用）
// ---------------------------------------------------------------------------
const _rlogs = [];
function _rlog(level, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  _rlogs.push(`[${ts}][${level}] ${msg}`);
  if (_rlogs.length > 300) _rlogs.shift();
}
{ // 只覆盖 error/warn，不干扰 log（避免死循环）
  const _oe = console.error, _ow = console.warn;
  console.error = (...a) => { _oe(...a); _rlog('ERROR', a.map(String).join(' ')); };
  console.warn  = (...a) => { _ow(...a); _rlog('WARN',  a.map(String).join(' ')); };
}

// ---------------------------------------------------------------------------
// i18n：data-i18n / data-i18n-title / data-i18n-ph 属性驱动 DOM 文字替换
// 外部语言包（JSON）通过 loadExternalLang() 合并到 S，再重新 applyI18n()
// ---------------------------------------------------------------------------
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const v = S[el.dataset.i18n];
    if (typeof v !== 'string') return;
    if (el.childElementCount === 0) {
      // 纯文本节点：直接替换
      el.textContent = v;
    } else {
      // 含子元素（如 label 内有 button/span）：只替换第一个文本节点，不删子元素
      let replaced = false;
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
          node.textContent = v + ' ';
          replaced = true;
          break;
        }
      }
      // 没有现成文本节点则在最前面插一个
      if (!replaced) el.insertBefore(document.createTextNode(v + ' '), el.firstChild);
    }
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const v = S[el.dataset.i18nTitle];
    if (typeof v === 'string') el.title = v;
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const v = S[el.dataset.i18nPh];
    if (typeof v === 'string') el.placeholder = v;
  });
}
document.addEventListener('DOMContentLoaded', applyI18n);

async function loadExternalLang(filePath) {
  // 先把上次覆盖的 key 全部还原为原始中文值（而非 delete，delete 会留空白）
  const originals = window.__langOriginals || {};
  Object.keys(originals).forEach(k => { S[k] = originals[k]; });
  window.__langOriginals = {};
  window.__langOverrides = {};

  const refresh = () => {
    applyI18n();
    refreshAllModelDropdowns();
    const activeNav = document.querySelector('.nav-item.active .nav-label');
    if (activeNav) $('#view-title').textContent = activeNav.textContent;
  };

  if (!filePath) { refresh(); return; }  // 切回中文：还原后直接刷新

  const data = await window.api.loadLang(filePath);
  if (!data) return;

  Object.entries(data).forEach(([k, v]) => {
    if (k === 'LANG_NAME') return;
    if (typeof S[k] === 'function') return;
    // 覆盖前先存原始值，以便将来还原
    if (window.__langOriginals[k] === undefined) window.__langOriginals[k] = S[k];
    window.__langOverrides[k] = v;
    S[k] = v;
  });
  refresh();
}

async function refreshLangDropdown() {
  const sel = $('#set-lang');
  if (!sel) return;
  const langs = await window.api.listLangs().catch(() => []);
  sel.innerHTML = `<option value="" data-i18n="lang_default">${S.lang_default || '中文（默认）'}</option>`;
  langs.forEach(({ name, path }) => {
    const opt = document.createElement('option');
    opt.value = path;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  // 恢复上次选择
  const saved = config.lang || '';
  if (saved && langs.some(l => l.path === saved)) sel.value = saved;
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
let config = null;
let tasks = [];                 // 来自主进程的最新任务列表
let currentFilter = 'running';  // running | queued | done
let pendingFiles = [];          // 待确认的拖入/选择文件
let pendingOutDirs = [];        // 与 pendingFiles 等长，每项=自定义输出目录或 null(默认)
let pendingFormats = [];        // 与 pendingFiles 等长，每项='md'|'txt'|'srt'|'vtt'
let pendingMusics = [];         // 与 pendingFiles 等长，每项=true/false（是否有背景音乐）
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
  if (config.lang) loadExternalLang(config.lang);  // 自动恢复上次选择的语言
  bindEvents();
  window.api.onTasksUpdate((list) => { tasks = list; render(); });
  window.api.onWarnings((msgs) => showWarnings(msgs));
  window.api.onTaskError(({ name, code, stderr }) => {
    const msg = stderr ? stderr.slice(0, 200) : `退出码 ${code}`;
    _rlog('ERROR', `任务失败 [${name}] code=${code}: ${stderr || '(无详细信息)'}`);
    showWarnings([`转写失败（退出码 ${code}）：${msg}。点"🛠 查看日志"查看详情。`]);
  });

  // 模型下载进度/完成（全局注册一次）
  const _dlLines = [];   // 本次下载的所有输出行，用于日志面板
  window.api.onDownloadProgress(({ type, line }) => {
    if (line) { _dlLines.push(line); _rlog('DL', `[${type}] ${line}`); }
    const btn = type === 'whisper' ? $('#btn-dl-whisper') : $('#btn-dl-demucs');
    if (btn) btn.textContent = line.length > 20 ? line.slice(0, 20) + '…' : line;
  });
  window.api.onDownloadDone(({ type, code, error }) => {
    const btn = type === 'whisper' ? $('#btn-dl-whisper') : $('#btn-dl-demucs');
    if (code === 0) {
      if (btn) { btn.textContent = S.downloaded; btn.disabled = false; }
      _rlog('INFO', `[${type}] 下载完成`);
      if (type === 'whisper') refreshWhisperModelStatus();
      else refreshDemucsModelStatus();
    } else {
      if (btn) { btn.textContent = S.btn_dl; btn.disabled = false; }
      const errMsg = error || (_dlLines.slice(-5).join(' | ')) || '未知错误';
      _rlog('ERROR', `[${type}] 下载失败 code=${code} ${errMsg}`);
      showWarnings([S.download_fail(error)]);
    }
    _dlLines.length = 0;
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
  let _refreshClicks = 0, _refreshTimer = null;
  $('#btn-refresh').addEventListener('click', () => {
    const btn = $('#btn-refresh');
    if (btn.classList.contains('refresh-flyoff') || btn.classList.contains('refresh-flyback')) return;

    _refreshClicks++;
    clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(() => { _refreshClicks = 0; }, 1500);

    if (_refreshClicks >= 5) {
      _refreshClicks = 0;
      // 彩蛋：飞走再飞回
      btn.classList.add('refresh-flyoff');
      btn.addEventListener('animationend', function flyback(e) {
        if (e.animationName !== 'refreshFlyOff') return;
        btn.removeEventListener('animationend', flyback);
        btn.classList.remove('refresh-flyoff');
        btn.classList.add('refresh-flyback');
        btn.addEventListener('animationend', function done(e) {
          if (e.animationName !== 'refreshFlyBack') return;
          btn.removeEventListener('animationend', done);
          btn.classList.remove('refresh-flyback');
        });
      });
      window.api.refreshTasks();
      return;
    }
    btn.classList.add('spinning');
    window.api.refreshTasks();
    setTimeout(() => btn.classList.remove('spinning'), 500);
  });

  // 彩蛋：logo 连点 5 次 → 全屏彩虹 overlay + accent 同步旋转，8 秒后恢复
  let _logoClicks = 0, _logoTimer = null, _logoRainbow = false;
  $('.rail-logo').addEventListener('click', () => {
    _logoClicks++;
    clearTimeout(_logoTimer);
    _logoTimer = setTimeout(() => { _logoClicks = 0; }, 2000);
    if (_logoClicks >= 5 && !_logoRainbow) {
      _logoClicks = 0;
      _logoRainbow = true;
      // 三区块各差 1s 相位 → 同时呈现三种颜色（CSS hue-rotate 实现）
      $('.app').classList.add('rainbow-mode');
      // --accent 也同步旋转，用于进度条等 inline accent 元素
      const baseAccent = config.accent || '#5b5bfa';
      const { h, s, l } = hexToHsl(baseAccent);
      const start = Date.now(), duration = 9000;
      (function frame() {
        const elapsed = Date.now() - start;
        if (elapsed >= duration) {
          document.documentElement.style.setProperty('--accent', baseAccent);
          document.documentElement.style.setProperty('--accent-soft', hexToSoft(baseAccent));
          $('.app').classList.remove('rainbow-mode');
          _logoRainbow = false;
          return;
        }
        const newH = (h + (elapsed / duration) * 360) % 360;
        const c = hslToHex(newH, s, l);
        document.documentElement.style.setProperty('--accent', c);
        document.documentElement.style.setProperty('--accent-soft', hexToSoft(c));
        requestAnimationFrame(frame);
      })();
    }
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
  document.addEventListener('click', (e) => {
    if (e.target.id === 'btn-env-refresh') { refreshEnvStatus(); }
    if (e.target.id === 'btn-export-template') window.api.exportLangTemplate();
    if (e.target.id === 'btn-devtools') showLogsPanel();
    // Whisper/Demucs 模型行的"↺ 检测"按钮：带反馈的自动检测
    if (e.target.id === 'btn-detect-whisper' || e.target.id === 'btn-detect-demucs') {
      const btn = e.target;
      const orig = btn.textContent;
      btn.textContent = '检测中…'; btn.disabled = true;
      autoDetectModelDirs()
        .then(() => { btn.textContent = '✓ 完成'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500); })
        .catch(() => { btn.textContent = '✗ 失败'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000); });
    }
  });

  // 语言文件区：拖入 + 点击选文件（只在 lang-drop-zone 范围内响应，不触发全局遮罩）
  const dropZone = document.getElementById('lang-drop-zone');
  if (dropZone) {
    const importLangFile = async (srcPath) => {
      if (!srcPath || !srcPath.endsWith('.json')) return;
      const result = await window.api.importLang(srcPath);
      if (result) {
        dropZone.textContent = (S.lang_imported || '✓ 已导入：{name}').replace('{name}', result.name);
        dropZone.classList.add('ok');
        await refreshLangDropdown();
        const sel = document.getElementById('set-lang');
        if (sel) sel.value = result.path;
      } else {
        dropZone.textContent = S.lang_import_fail || '导入失败';
        setTimeout(() => { dropZone.textContent = S.lang_drop_hint || '拖入 .json'; dropZone.classList.remove('ok'); }, 3000);
      }
    };

    dropZone.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('over'); });
    dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); e.stopPropagation(); });
    dropZone.addEventListener('dragleave', (e) => { e.stopPropagation(); dropZone.classList.remove('over'); });
    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault(); e.stopPropagation();
      dropZone.classList.remove('over');
      const file = e.dataTransfer.files[0];
      if (file) importLangFile(window.api.getFilePath(file));
    });

    // 点击弹出文件选择器（只显示 JSON）
    dropZone.style.cursor = 'pointer';
    dropZone.addEventListener('click', async () => {
      const filePath = await window.api.pickLangFile();
      if (filePath) importLangFile(filePath);
    });
  }
  $('#settings-save').addEventListener('click', saveSettings);
  // 设置里的 readonly input 点击也弹文件夹选择器
  $$('#settings-modal input.text-input[readonly]').forEach(input => {
    input.style.cursor = 'pointer';
    input.addEventListener('click', () => {
      const pickBtn = input.nextElementSibling;
      if (pickBtn) pickBtn.click();
    });
  });
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
    btn.textContent = S.downloading; btn.disabled = true;
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
    btn.textContent = S.downloading; btn.disabled = true;
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
  // 切换模型 → 重新检测当前选中模型的下载状态（并更新下拉前缀）
  $('#set-whisper-model').addEventListener('change', refreshAllModelDropdowns);
  $('#set-demucs-model').addEventListener('change', refreshAllModelDropdowns);
  $('#reset-accent').addEventListener('click', () => { $('#set-accent').value = '#5b5bfa'; });

  // 确认弹窗
  $('#confirm-cancel').addEventListener('click', closeConfirm);
  $('#confirm-ok').addEventListener('click', confirmStart);
  $$('input[name="music"]').forEach(r => r.addEventListener('change', updateMusicHint));
  $('#unified-path').addEventListener('click', pickUnifiedDir);   // 点 input 弹文件夹选择
  const ufSel = $('#unified-format');
  if (ufSel) ufSel.addEventListener('change', () => applyUnifiedFormat(ufSel.value));
  $('#btn-all-music')?.addEventListener('click', () => {
    const allHave = pendingMusics.every(v => v);
    applyUnifiedMusic(!allHave);  // 全有→全无；否则→全有
    const dot = $('#btn-all-music');
    const hint = $('#all-music-hint');
    if (dot) dot.classList.toggle('active', !allHave);
    if (hint) hint.textContent = !allHave ? S.confirm_music_all_on : S.confirm_music_all_off;
  });

  // ── 光束引擎：真实投影几何，每帧重算梯形 ──
  // 顶边 = 飞船发光口（绑定飞船，随浮动/飞行移动）；光束中心方向 = 飞船倾角(--ufo-tilt)，二者锁死。
  // 两种模式：
  //   normal —— 常驻：倾角=BASE_TILT，固定扩散半角，照到"当前没有任务"上方的虚拟地面。
  //   aim    —— 彩蛋：拿党徽实际像素包围盒(四角)，反解 → 飞船倾角自动指向党徽中心(仍锁死)，
  //             左右边缘光线从发光口端点恰好擦过党徽横向最外角，地面线=党徽底边
  //             ⇒ 梯形精确外接党徽全部像素，刚好覆盖、不漏不多（确定性算法，无需手调参数）。
  (function initBeam() {
    const empty  = $('#empty-state');
    const ufo    = $('#ufo-art');
    const svg    = $('#ufo-beam-svg');
    const poly   = $('#beam-poly');
    const gradN  = document.getElementById('beam-grad-normal');
    const groundRef = document.querySelector('.empty-text');
    const emblem = $('#emblem-proj');
    if (!empty || !ufo || !svg || !poly || !gradN || !groundRef || !emblem) return;

    const root = document.documentElement;
    const BASE_TILT = parseFloat(getComputedStyle(root).getPropertyValue('--ufo-tilt')) || 10;
    const PORT_HALF = 0.16;   // 发光口半宽 = uw*0.16（固定）
    const SPREAD = 13;         // 常驻扩散半角(度)：飞船固有属性，恒定不变

    let mode = 'normal';
    let tiltCur = BASE_TILT, tiltTgt = BASE_TILT;
    let blendAim = 0, blendAimTgt = 0;   // 0=normal  1=aim，缓动插值，beam 顶点平滑过渡
    window.__beam = {
      aim()             { mode = 'aim';    blendAimTgt = 1; },
      normal()          { mode = 'normal'; blendAimTgt = 0; tiltTgt = BASE_TILT; },
      _setTiltTarget(d) { tiltTgt = Math.max(-55, Math.min(55, d)); },
    };

    const rot = (v, a) => {
      const c = Math.cos(a), s = Math.sin(a);
      return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
    };
    const hitGround = (S, dir, G) => {
      if (dir.y <= 1e-3) return null;
      const t = (G - S.y) / dir.y;
      if (t < 0) return null;
      return { x: S.x + t * dir.x, y: G };
    };
    const setGrad = (g, x1, y1, x2, y2) => {
      g.setAttribute('x1', x1.toFixed(1)); g.setAttribute('y1', y1.toFixed(1));
      g.setAttribute('x2', x2.toFixed(1)); g.setAttribute('y2', y2.toFixed(1));
    };

    function frame() {
      const eR = empty.getBoundingClientRect();
      const uR = ufo.getBoundingClientRect();
      const ow = ufo.offsetWidth || 100;    // 飞船布局尺寸（不受 transform 旋转影响）
      const oh = ufo.offsetHeight || 54;
      const cx = (uR.left + uR.right) / 2 - eR.left;   // 飞船几何中心（=旋转中心）
      const cy = (uR.top + uR.bottom) / 2 - eR.top;

      // 党徽包围盒（blendAim > 0 时用）
      let corners = null, emBottom = 0;
      if (blendAimTgt > 0 || blendAim > 0.01) {
        const cR = emblem.getBoundingClientRect();
        const ex0 = cR.left - eR.left, ex1 = cR.right - eR.left;
        const ey0 = cR.top - eR.top,  ey1 = cR.bottom - eR.top;
        corners = [{x:ex0,y:ey0},{x:ex1,y:ey0},{x:ex0,y:ey1},{x:ex1,y:ey1}];
        emBottom = ey1;
        // 倾角目标：aim 时指向党徽中心（clamp 防光束向上消失）
        if (mode === 'aim') {
          const tcx = (ex0 + ex1) / 2, tcy = (ey0 + ey1) / 2;
          const ux = tcx - cx, uy = tcy - cy, L = Math.hypot(ux, uy) || 1;
          tiltTgt = Math.max(-55, Math.min(55,
            Math.atan2(-ux / L, uy / L) * 180 / Math.PI));
        }
      }

      // blendAim 缓动（k=0.055 ≈ 650ms 到位）→ beam 顶点从 normal 插值到 aim，不跳变
      blendAim += (blendAimTgt - blendAim) * 0.055;

      // 倾斜缓动
      tiltCur += (tiltTgt - tiltCur) * 0.12;
      root.style.setProperty('--ufo-tilt', tiltCur.toFixed(2) + 'deg');

      const tRad = tiltCur * Math.PI / 180;
      const d = rot({ x: 0, y: 1 }, tRad);   // 光束中心方向 = 飞船 local-down
      const portDir = { x: d.y, y: -d.x };   // 发光口线段方向（垂直 d，指右）

      const portDist = oh * 0.42;
      const px = cx + d.x * portDist;        // 发光口中心：沿飞船中轴下移
      const py = cy + d.y * portDist;
      const hw = ow * PORT_HALF;
      const Ltop = { x: px - hw * portDir.x, y: py - hw * portDir.y };
      const Rtop = { x: px + hw * portDir.x, y: py + hw * portDir.y };

      // 始终计算 normal 顶点
      const gR = groundRef.getBoundingClientRect();
      const G_n = gR.top - eR.top - 6;
      const sRad = SPREAD * Math.PI / 180;
      const Lbot_n = hitGround(Ltop, rot(d,  sRad), G_n);
      const Rbot_n = hitGround(Rtop, rot(d, -sRad), G_n);

      let Lbot, Rbot, G, midBotX;
      const b = blendAim;
      if (b < 0.01 || !corners) {
        // 纯 normal
        Lbot = Lbot_n; Rbot = Rbot_n; G = G_n;
      } else {
        // 计算 aim 顶点
        const G_a = Math.max(emBottom, py + 8);
        const edge = (origin, rightmost) => {
          let best = null, key = null;
          for (const c of corners) {
            const vx = c.x - origin.x, vy = c.y - origin.y;
            const fwd = vx * d.x + vy * d.y;
            if (fwd <= 1e-3) continue;
            const ang = (vx * portDir.x + vy * portDir.y) / fwd;
            if (key === null || (rightmost ? ang > key : ang < key)) { key = ang; best = {x:vx, y:vy}; }
          }
          if (!best) best = { x: d.x, y: d.y };
          const m = Math.hypot(best.x, best.y) || 1;
          return { x: best.x / m, y: best.y / m };
        };
        const Lbot_a = hitGround(Ltop, edge(Ltop, false), G_a);
        const Rbot_a = hitGround(Rtop, edge(Rtop, true),  G_a);
        if (!Lbot_a || !Rbot_a) {
          Lbot = Lbot_n; Rbot = Rbot_n; G = G_n;
        } else {
          // 插值：beam 顶点从 normal 平滑过渡到 aim（视觉上光束"扫过去"）
          const lp = (a, z, t) => a + (z - a) * t;
          Lbot = { x: lp(Lbot_n.x, Lbot_a.x, b), y: lp(Lbot_n.y, Lbot_a.y, b) };
          Rbot = { x: lp(Rbot_n.x, Rbot_a.x, b), y: lp(Rbot_n.y, Rbot_a.y, b) };
          G = lp(G_n, G_a, b);
        }
      }
      if (!Lbot_n || !Rbot_n) { Lbot = Lbot || Lbot_n; Rbot = Rbot || Rbot_n; }

      if (G <= py + 4 || !Lbot || !Rbot) { poly.setAttribute('points', ''); requestAnimationFrame(frame); return; }

      poly.setAttribute('points',
        `${Ltop.x.toFixed(1)},${Ltop.y.toFixed(1)} ${Rtop.x.toFixed(1)},${Rtop.y.toFixed(1)} ` +
        `${Rbot.x.toFixed(1)},${Rbot.y.toFixed(1)} ${Lbot.x.toFixed(1)},${Lbot.y.toFixed(1)}`);

      midBotX = (Lbot.x + Rbot.x) / 2;
      setGrad(gradN, px, py, midBotX, G);   // 渐变沿光束方向：发光口中心 → 地面交点中线

      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  })();

  // 彩蛋：UFO 右键 3 次（1 秒内）+ 红色主题 → 共产主义光束
  let _ufoRightClicks = 0, _ufoRightTimer = null, _ufoEasterActive = false;
  document.addEventListener('contextmenu', (e) => {
    const ufoArt = $('#ufo-art');
    if (!ufoArt || !ufoArt.contains(e.target)) return;
    e.preventDefault();
    if (_ufoEasterActive) return;
    _ufoRightClicks++;
    clearTimeout(_ufoRightTimer);
    _ufoRightTimer = setTimeout(() => { _ufoRightClicks = 0; }, 1000);
    if (_ufoRightClicks >= 3) {
      _ufoRightClicks = 0;
      if (!isRedAccent()) return;
      _ufoEasterActive = true;
      triggerUFOEaster();
      setTimeout(() => { _ufoEasterActive = false; }, 7200);
    }
  });

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

  // 判断拖入的是否全是 JSON（翻译文件），是则不触发全局音频遮罩
  const isJsonOnly = (dt) => {
    const files = [...(dt.files || [])];
    if (!files.length) {
      const types = [...(dt.items || [])];
      return types.length > 0 && types.every(i => i.type === 'application/json' || (i.kind === 'file' && i.type === ''));
    }
    return files.every(f => f.name.endsWith('.json'));
  };

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (isJsonOnly(e.dataTransfer)) return;  // JSON → 不弹音频遮罩
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
  const def = config.defaultOutputFormat || 'md';
  pendingOutDirs = files.map(() => null);
  pendingFormats = files.map(() => def);
  pendingMusics = files.map(() => false);      // 默认无背景音乐

  const isSingle = files.length === 1;
  // 单文件和批量分别显示不同布局
  $('#confirm-modal').dataset.mode = isSingle ? 'single' : 'batch';
  $('#confirm-count').textContent = files.length;
  const cc2 = $('#confirm-count2');
  if (cc2) cc2.textContent = files.length;

  // 重置统一选项
  // 旧版全局 music radio 已移除，批量 pendingMusics 默认全 false
  $('#unified-path').value = '';
  const uf = $('#unified-format');
  if (uf) uf.value = '';

  // 批量专属区块的显隐
  ['#confirm-batch-only'].forEach(sel => {
    const el = $(sel);
    if (el) el.classList.toggle('hidden', isSingle);
  });
  // 单文件专属区块
  ['#confirm-single-only'].forEach(sel => {
    const el = $(sel);
    if (el) el.classList.toggle('hidden', !isSingle);
  });

  if (isSingle) {
    renderSingleConfirm();
  } else {
    renderConfirmRows();
    // 初始同步统一格式：全部相同就设值，否则插入只读"格式不统一"提示项
    syncUnifiedFormat();
  }
  $('#confirm-modal').classList.remove('hidden');
}

function renderSingleConfirm() {
  const f = pendingFiles[0];
  const name = f.replace(/^.*[\\/]/, '');
  const def = config.defaultOutputFormat || 'md';
  const fmtOpts = Object.entries(FMT_LABELS()).map(([v, l]) =>
    `<option value="${v}"${v===def?' selected':''}>${l}</option>`).join('');
  const el = $('#confirm-single-only');
  if (!el) return;
  el.innerHTML = `
    <div class="field">
      <label class="field-label">文件</label>
      <div class="single-name">${escapeHtml(name)}</div>
    </div>
    <div class="field">
      <label class="field-label">有背景音乐？</label>
      <div class="radio-row">
        <label class="radio"><input type="radio" name="single-music" value="no" checked /> 没有</label>
        <label class="radio"><input type="radio" name="single-music" value="yes" /> 有（先分离人声）</label>
      </div>
      <p class="hint" id="single-music-hint"></p>
    </div>
    <div class="field">
      <label class="field-label">输出格式</label>
      <select id="single-fmt" class="select">${fmtOpts}</select>
    </div>
    <div class="field">
      <label class="field-label">输出目录</label>
      <div class="out-picker">
        <input type="text" id="single-outdir" class="text-input" readonly value="${escapeAttr(config.outDir||'')}" placeholder="默认目录" />
        <button class="btn ghost" id="btn-single-pick">浏览</button>
      </div>
    </div>`;
  // 绑定
  const musicHint = () => {
    const yes = el.querySelector('input[name="single-music"][value="yes"]').checked;
    $('#single-music-hint').textContent = yes ? S.music_hint_yes : '';
  };
  el.querySelectorAll('input[name="single-music"]').forEach(r => r.addEventListener('change', musicHint));
  const pickDir = async () => {
    const d = await window.api.pickDir();
    if (d) el.querySelector('#single-outdir').value = d;
  };
  el.querySelector('#btn-single-pick').addEventListener('click', pickDir);
  el.querySelector('#single-outdir').addEventListener('click', pickDir);
}
function closeConfirm() {
  $('#confirm-modal').classList.add('hidden');
  pendingFiles = [];
  pendingOutDirs = [];
  pendingFormats = [];
  pendingMusics = [];
}
function updateMusicHint() {
  const yes = $('input[name="music"][value="yes"]')?.checked;
  const hint = $('#music-hint');
  if (hint) hint.textContent = yes
    ? S.music_note_yes
    : '';
}

const FMT_LABELS = () => ({ md: S.fmt_md, txt: S.fmt_txt, srt: S.fmt_srt, vtt: S.fmt_vtt });
// 批量行每格空间小：只显示后缀名
const FMT_SHORT = () => ({ md: '.md', txt: '.txt', srt: '.srt', vtt: '.vtt' });

function renderConfirmRows() {
  const wrap = $('#confirm-file-rows');
  wrap.innerHTML = pendingFiles.map((f, i) => {
    const name = f.replace(/^.*[\\/]/, '');
    const dir = pendingOutDirs[i];
    const dirTxt = dir ? escapeHtml(dir) : '默认目录';
    const dirCls = dir ? 'file-row-dir custom' : 'file-row-dir';
    const fmt = pendingFormats[i] || config.defaultOutputFormat || 'md';
    const hasMusic = pendingMusics[i];
    const fmtOpts = Object.entries(FMT_SHORT()).map(([v,l]) =>
      `<option value="${v}"${v===fmt?' selected':''}>${l}</option>`).join('');
    return `<div class="file-row" data-idx="${i}">
      <button class="music-dot${hasMusic?' active':''}" data-music-idx="${i}" title="${hasMusic?'有背景音乐，需分离（点击取消）':'无背景音乐（点击标记需分离）'}"></button>
      <span class="file-row-name" title="${escapeAttr(name)}">${escapeHtml(name)}</span>
      <select class="file-fmt-sel select-tiny" data-fmt-idx="${i}">${fmtOpts}</select>
      <span class="${dirCls}" title="${escapeAttr(dir || '默认目录')}">${dirTxt}</span>
      <button class="icon-btn" data-pick-file="${i}" title="设置此文件的输出位置">📂</button>
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-music-idx]').forEach(b =>
    b.onclick = () => {
      const idx = Number(b.dataset.musicIdx);
      pendingMusics[idx] = !pendingMusics[idx];
      renderConfirmRows();
    });
  wrap.querySelectorAll('[data-pick-file]').forEach(b =>
    b.onclick = async () => {
      const idx = Number(b.dataset.pickFile);
      const d = await window.api.pickDir();
      if (d) { pendingOutDirs[idx] = d; renderConfirmRows(); }
    });
  wrap.querySelectorAll('[data-fmt-idx]').forEach(sel =>
    sel.onchange = () => {
      pendingFormats[Number(sel.dataset.fmtIdx)] = sel.value;
      syncUnifiedFormat();
    });
}

function syncUnifiedFormat() {
  const uf = $('#unified-format');
  if (!uf) return;
  const unique = [...new Set(pendingFormats)];
  // 移除之前插入的只读项（如果有）
  const existing = uf.querySelector('option[data-mixed]');
  if (existing) existing.remove();
  if (unique.length === 1) {
    uf.value = unique[0];
  } else {
    // 格式不统一：插入只读提示项并选中，用户无法主动选择
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = S.fmt_no_unify_auto || '格式不统一';
    opt.dataset.mixed = '1';
    opt.disabled = false;  // 允许显示但实际上只读（通过 change 事件过滤）
    uf.insertBefore(opt, uf.firstChild);
    uf.value = '';
  }
}

function applyUnifiedMusic(hasMusic) {
  pendingMusics = pendingMusics.map(() => hasMusic);
  renderConfirmRows();
}

function applyUnifiedFormat(fmt) {
  if (!fmt) return;
  pendingFormats = pendingFormats.map(() => fmt);
  renderConfirmRows();
  syncUnifiedFormat();   // 清掉"格式不统一"只读项（如有），确保选的值生效
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
  const isSingle = pendingFiles.length === 1;
  let outDirs, outputFormats, musics;
  if (isSingle) {
    const el = $('#confirm-single-only');
    const musicYes = el && el.querySelector('input[name="single-music"][value="yes"]').checked;
    const fmt = el ? (el.querySelector('#single-fmt').value || config.defaultOutputFormat || 'md') : 'md';
    const dir = el ? (el.querySelector('#single-outdir').value || config.outDir) : config.outDir;
    outDirs = [dir];
    outputFormats = [fmt];
    musics = [musicYes];
  } else {
    outDirs = pendingOutDirs.map(d => d || config.outDir);
    outputFormats = pendingFormats.slice();
    musics = pendingMusics.slice();
  }
  // 批量逐文件发送（每个文件可有不同 music 设置）
  for (let i = 0; i < pendingFiles.length; i++) {
    await window.api.addTasks({
      files: [pendingFiles[i]],
      music: musics[i],
      outDirs: [outDirs[i]],
      outputFormats: [outputFormats[i]],
    });
  }
  closeConfirm();
  $('.nav-item[data-filter="running"]').click();
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
// 函数形式：每次调用时读当前 S 值，语言切换后立即生效
const WHISPER_MODELS = () => [
  ['large-v3-turbo', S.whisper_model_turbo],
  ['large-v3',       S.whisper_model_v3],
  ['large-v2',       S.whisper_model_v2],
  ['distil-large-v3',S.whisper_model_distil],
  ['medium',         S.whisper_model_medium],
  ['small',          S.whisper_model_small],
  ['base',           S.whisper_model_base],
  ['tiny',           S.whisper_model_tiny],
];
const DEMUCS_MODELS = () => [
  ['htdemucs',      S.demucs_model_ht],
  ['htdemucs_ft',   S.demucs_model_ht_ft],
  ['htdemucs_6s',   S.demucs_model_ht_6s],
  ['mdx_extra',     S.demucs_model_mdx],
  ['mdx_extra_q',   S.demucs_model_mdx_q],
  ['mdx_q',         S.demucs_model_mdx_q2],
];

function fillSelect(sel, options, current, downloadedSet) {
  // downloadedSet: 已下载模型集合（null = 不加前缀）
  // ● 前缀只加在「已下载且非当前选中」的项上：
  //   - 选中项不加 ●（关闭时显示干净的名字，状态由左侧图标表示）
  //   - 展开下拉时，其它已下载的项前面有 ●
  sel.innerHTML = options.map(([v, label]) => {
    let prefix = '';
    if (downloadedSet && v !== current) prefix = downloadedSet.has(v) ? '● ' : '　';
    return `<option value="${v}"${v === current ? ' selected' : ''}>${prefix}${label}</option>`;
  }).join('');
}

function openSettings() {
  // 先快速填充无状态版（秒开），再异步更新 ▶ ✓ ○ 前缀
  fillSelect($('#set-whisper-model'), WHISPER_MODELS(), config.whisperModel || 'large-v3-turbo');
  fillSelect($('#set-demucs-model'), DEMUCS_MODELS(), config.demucsModel || 'htdemucs');
  $('#set-outdir').value = config.outDir || '';
  $('#set-whisper').value = config.whisperDir || '';
  $('#set-demucs').value = config.demucsCacheDir || '';
  $('#set-python').value = config.pythonPath || '';
  $('#set-ffmpeg').value = config.ffmpegDir || '';
  const defFmt = $('#set-default-fmt');
  if (defFmt) defFmt.value = config.defaultOutputFormat || 'md';
  $('#set-theme').value = config.theme || 'dark';
  $('#set-accent').value = config.accent || '#5b5bfa';
  updatePythonStatus();
  $('#settings-modal').classList.remove('hidden');
  // 自动检测模型目录并回填 → 再刷新下拉（顺序执行，路径先到位）
  autoDetectModelDirs().catch(() => refreshModelStatus());
  // 环境检测：只在未完成时自动跑；已完成则仅显示缓存状态，不重复检测
  if (!config.envComplete) refreshEnvStatus();
  else renderEnvComplete();
  refreshLangDropdown();       // 语言包扫描，异步
}

// ── 环境检测与依赖安装 ────────────────────────────────────────────────────────
let _envInstalling = false;

function renderEnvComplete() {
  const rows = $('#env-rows');
  if (!rows) return;
  rows.innerHTML = `<div class="env-row"><span class="env-status-ok">✓ ${S.env_complete_label || '环境已就绪'}</span><span class="env-note" style="margin-left:8px">${S.env_complete_hint || '点"↺ 重新检测"可手动刷新'}</span></div>`;
}

async function refreshEnvStatus() {
  const rows = $('#env-rows');
  if (!rows) return;
  rows.innerHTML = `<div class="env-row"><span class="env-status-checking">${S.env_detecting}</span></div>`;

  let env;
  try { env = await window.api.checkEnv(); }
  catch (e) { rows.innerHTML = `<div class="env-row"><span class="env-status-miss">${S.env_detect_fail}</span></div>`; return; }

  // ── 五行：Python / faster-whisper / PyTorch / demucs / NVIDIA 显卡 ──
  // PyTorch 行负责 CPU/GPU 变体选择；其余行无变体概念
  rows.innerHTML = '';

  const makeRow = (icon, name, note, statusHtml, actionsHtml = '') => {
    const div = document.createElement('div');
    div.className = 'env-row';
    div.innerHTML = `<span class="env-icon">${icon}</span>
      <span class="env-name">${name}</span>
      <span class="env-note">${note}</span>
      ${statusHtml}
      <div class="env-actions">${actionsHtml}</div>`;
    rows.appendChild(div);
  };

  makeRow('🐍', S.env_python_name,
    env.python ? env.pythonPath || '' : S.env_python_note_miss,
    env.python ? `<span class="env-status-ok">${S.env_ok}</span>` : `<span class="env-status-miss">${S.env_not_found}</span>`);

  makeRow('🎙', S.env_fw_name, S.env_fw_note,
    env.fasterWhisper ? `<span class="env-status-ok">${S.env_ok}</span>` : `<span class="env-status-miss">${S.env_miss}</span>`,
    env.fasterWhisper ? '' : `<button class="btn ghost tiny" data-install="faster-whisper" data-variant="cpu">${S.btn_install}</button>`);

  {
    let statusHtml, actionsHtml = '';
    if (env.torchInstalled) {
      statusHtml = env.torchCuda
        ? `<span class="env-status-ok">${S.env_torch_cuda}</span>`
        : `<span class="env-status-ok" style="color:var(--warning)">${S.env_torch_cpu}</span>`;
      if (!env.torchCuda && env.gpu) {
        actionsHtml = `<span class="env-note" style="color:var(--warning)">${S.env_torch_upgrade}</span>
          <button class="btn ghost tiny" data-install="torch" data-variant="gpu">${S.btn_torch_upgrade}</button>`;
      }
    } else {
      statusHtml = `<span class="env-status-miss">${S.env_miss}</span>`;
      if (env.gpu) {
        actionsHtml = `
          <select class="env-variant-select" id="torch-variant" title="${S.env_torch_variant_title}">
            <option value="gpu" selected>${S.env_torch_gpu_opt}</option>
            <option value="cpu">${S.env_torch_cpu_opt}</option>
          </select>
          <button class="btn ghost tiny" id="btn-install-torch">${S.btn_install}</button>
          <span class="env-note" style="color:var(--warning)">${S.env_gpu_hint(env.gpuName)}</span>`;
      } else {
        actionsHtml = `<button class="btn ghost tiny" data-install="torch" data-variant="cpu">${S.btn_install} (CPU)</button>
          <span class="env-note">${S.env_no_gpu_note}</span>`;
      }
    }
    makeRow('🔢', S.env_torch_name, S.env_torch_note, statusHtml, actionsHtml);

    // 有 GPU 时，安装按钮读取下拉值
    if (env.gpu && !env.torchInstalled) {
      setTimeout(() => {
        const btn = document.getElementById('btn-install-torch');
        if (btn) btn.addEventListener('click', () => {
          if (_envInstalling) return;
          const v = document.getElementById('torch-variant')?.value || 'gpu';
          startEnvInstall('torch', v);
        });
      }, 0);
    }
  }

  makeRow('🎵', S.env_demucs_name, S.env_demucs_note,
    env.demucs ? `<span class="env-status-ok">${S.env_ok}</span>` : `<span class="env-status-miss">${S.env_miss}</span>`,
    env.demucs ? '' : `<button class="btn ghost tiny" data-install="demucs" data-variant="cpu">${S.btn_install}</button>`);

  makeRow('🖥', S.env_gpu_name, S.env_gpu_note,
    env.gpu
      ? `<span class="env-status-ok">${S.env_gpu_ok(env.gpuName)}</span>`
      : `<span class="env-status-miss">${S.env_gpu_miss}</span>`);

  // 必要依赖（python + faster-whisper）全部就绪 → 存标志，之后启动不再自动弹警告
  const allReady = env.python && env.fasterWhisper;
  if (config) {
    const newEnvComplete = allReady ? true : false;
    if (newEnvComplete !== config.envComplete) {
      window.api.saveConfig({ ...config, envComplete: newEnvComplete });
      config.envComplete = newEnvComplete;
    }
  }

  // 绑定安装按钮（variant 已烘焙在 data-variant 属性里）
  rows.querySelectorAll('[data-install]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (_envInstalling) return;
      startEnvInstall(btn.dataset.install, btn.dataset.variant || 'cpu');
    });
  });
}

function startEnvInstall(pkg, variant) {
  if (_envInstalling) return;
  _envInstalling = true;

  const box = $('#env-install-box');
  const labelEl = $('#env-install-label');
  const fillEl = $('#env-progress-fill');
  const lineEl = $('#env-install-line');
  box.classList.remove('hidden');
  const variantLabel = pkg === 'torch' ? `（${variant === 'gpu' ? 'GPU 版' : 'CPU 版'}）` : '';
  labelEl.textContent = `正在安装 ${pkg}${variantLabel}…`;
  fillEl.style.width = '0%';
  lineEl.textContent = '';

  window.api.onInstallProgress(({ label, progress, line }) => {
    labelEl.textContent = S.install_ing(label);
    fillEl.style.width = Math.min(progress, 95) + '%';
    lineEl.textContent = line || '';
  });

  window.api.onInstallDone(({ code, error }) => {
    _envInstalling = false;
    if (code === 0) {
      fillEl.style.width = '100%';
      labelEl.textContent = S.install_done;
      lineEl.textContent = '';
      setTimeout(() => { box.classList.add('hidden'); refreshEnvStatus(); }, 1500);
    } else {
      labelEl.textContent = S.install_fail;
      lineEl.textContent = error || S.install_fail_hint;
      fillEl.style.background = 'var(--danger)';
      setTimeout(() => {
        box.classList.add('hidden');
        fillEl.style.background = '';
      }, 4000);
    }
  });

  window.api.installDep({ pkg, variant });
}

async function refreshAllModelDropdowns() {
  const whisperDir = $('#set-whisper').value || config.whisperDir;
  const demucsDir = $('#set-demucs').value || config.demucsCacheDir;
  const currentWhisper = $('#set-whisper-model').value;
  const currentDemucs = $('#set-demucs-model').value;

  // 并发检测所有 Whisper 模型
  const whisperResults = await Promise.all(
    WHISPER_MODELS().map(([v]) => window.api.whisperModelStatus(whisperDir, v).then(ok => [v, ok]))
  );
  const whisperDownloaded = new Set(whisperResults.filter(([, ok]) => ok).map(([v]) => v));
  fillSelect($('#set-whisper-model'), WHISPER_MODELS(), currentWhisper, whisperDownloaded);

  // 并发检测所有 Demucs 模型（按签名精确判断每个）
  const demucsResults = await Promise.all(
    DEMUCS_MODELS().map(([v]) => window.api.demucsModelStatus(demucsDir, v).then(ok => [v, ok]))
  );
  const demucsDownloaded = new Set(demucsResults.filter(([, ok]) => ok).map(([v]) => v));
  fillSelect($('#set-demucs-model'), DEMUCS_MODELS(), currentDemucs, demucsDownloaded);

  // 当前选中模型是否已下载
  const wOk = whisperDownloaded.has(currentWhisper);
  const dOk = demucsDownloaded.has(currentDemucs);

  // status tag（缩短文字，避免挤占下拉宽度）
  const wTag = $('#whisper-model-status');
  if (wTag) { wTag.textContent = wOk ? S.model_downloaded : S.model_not_downloaded; wTag.className = `status-tag ${wOk?'ok':'miss'}`; }
  const dTag = $('#demucs-model-status');
  if (dTag) { dTag.textContent = dOk ? S.model_downloaded : S.model_not_downloaded; dTag.className = `status-tag ${dOk?'ok':'miss'}`; }
  $('#btn-dl-whisper')?.classList.toggle('hidden', wOk);
  $('#btn-dl-demucs')?.classList.toggle('hidden', dOk);

  // 左侧外部图标：已下载(=使用中) → ‖ 双竖杠；未下载 → 空心圆
  const wi = $('#whisper-active-icon');
  if (wi) { wi.dataset.ok = wOk ? '1' : '0'; wi.title = wOk ? S.model_downloaded : S.model_not_downloaded; }
  const di = $('#demucs-active-icon');
  if (di) { di.dataset.ok = dOk ? '1' : '0'; di.title = dOk ? S.model_downloaded : S.model_not_downloaded; }
}

function updatePythonStatus() {
  const tag = $('#python-status');
  if (!tag) return;
  const p = $('#set-python')?.value || '';
  if (p) { tag.textContent = S.python_set; tag.className = 'status-tag ok'; }
  else { tag.textContent = S.python_auto; tag.className = 'status-tag miss'; }
}

// 刷新 Whisper 模型下载状态 + 显隐下载按钮 + 动态目录标签
async function refreshWhisperModelStatus() {
  const name = $('#set-whisper-model').value;
  const dir = $('#set-whisper').value || config.whisperDir;
  const ok = await window.api.whisperModelStatus(dir, name);
  const tag = $('#whisper-model-status');
  const btn = $('#btn-dl-whisper');
  if (ok) {
    tag.textContent = S.model_downloaded; tag.className = 'status-tag ok';
    btn.classList.add('hidden');
    $('#whisper-dir-label').textContent = S.whisper_dir_label;
  } else {
    tag.textContent = S.model_not_downloaded; tag.className = 'status-tag miss';
    btn.classList.remove('hidden');
    $('#whisper-dir-label').textContent = S.whisper_dir_label_dl;
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
    tag.textContent = S.model_downloaded; tag.className = 'status-tag ok';
    btn.classList.add('hidden');
    $('#demucs-dir-label').textContent = S.demucs_dir_label;
  } else {
    tag.textContent = S.model_not_downloaded; tag.className = 'status-tag miss';
    btn.classList.remove('hidden');
    $('#demucs-dir-label').textContent = S.demucs_dir_label_dl;
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
  if (det.whisperDir) { wTag.textContent = S.model_detected; wTag.className = 'status-tag ok'; }
  else { wTag.textContent = S.model_not_detected; wTag.className = 'status-tag miss'; }
  if (det.demucsCacheDir) { dTag.textContent = S.model_detected; dTag.className = 'status-tag ok'; }
  else { dTag.textContent = S.model_not_detected_dl; dTag.className = 'status-tag miss'; }
}

// 自动检测模型目录：扫描常见路径，找到就回填输入框，然后刷新下拉和状态
async function autoDetectModelDirs() {
  const wInput = $('#set-whisper');
  const dInput = $('#set-demucs');
  const hintW = wInput?.value || '';
  const hintD = dInput?.value || '';

  // 主检测：扫常见路径 + HF 环境变量 + 当前输入框路径
  const det = await window.api.detectModels(hintW, hintD);

  // 找到就回填；没找到保留原值（原值可能就是正确的，只是不在标准路径）
  if (det.whisperDir && wInput) wInput.value = det.whisperDir;
  if (det.demucsCacheDir && dInput) dInput.value = det.demucsCacheDir;

  // 更新状态标签 + 刷新下拉（用最终路径检查模型是否已下载）
  await refreshModelStatus();
  await refreshAllModelDropdowns();
  await refreshDemucsModelStatus();
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
    defaultOutputFormat: $('#set-default-fmt')?.value || 'md',
    theme: $('#set-theme').value,
    accent: $('#set-accent').value,
    lang: $('#set-lang')?.value || '',
  };
  await window.api.saveConfig(next);
  config = await window.api.getConfig();
  applyTheme(config);
  await loadExternalLang(next.lang || '');
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
  return ({ running: S.status_running, retrying: S.status_retrying, queued: S.status_queued,
    done: S.status_done, error: S.status_error, canceled: S.status_canceled })[s] || s;
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
      `<span class="card-arrow" title="${S.card_detail_title}">›</span>` +
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
    t.music ? `<span class="card-tag music">${S.tag_music}</span>` : '';

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
    let stepTxt = escapeHtml(t.step || S.status_running);
    if (t.stepTotal > 1 && t.stepNum) stepTxt = `第${t.stepNum}/${t.stepTotal}步 · ` + stepTxt;
    const eta = t.etaMin ? S.step_eta(t.etaMin) : '';
    const elapsed = `<span class="elapsed" data-start="${t.startTs || 0}">${S.step_elapsed(fmtElapsed(t.startTs))}</span>`;
    const pct = t.indeterminate ? `<span class="pct dim">${S.step_indeterminate}</span>` : `<span class="pct">${t.pct}%</span>`;
    return `<span class="step">${stepTxt}${eta}</span>${elapsed}${pct}`;
  }
  if (isDone) return `<span class="step">${S.step_done}</span><span class="pct">${S.pct_done}</span>`;
  if (t.status === 'queued') return `<span class="step">${S.step_queued}</span>`;
  return `<span class="step">${escapeHtml(t.step || statusText(t.status))}</span>`;
}

function actionsHtml(t) {
  const isRunning = t.status === 'running' || t.status === 'retrying';
  const isDone = t.status === 'done';
  if (isRunning || t.status === 'queued') {
    return `<button class="icon-btn danger" data-cancel="${t.id}">${S.btn_cancel_task}</button>`;
  } else if (isDone) {
    return `<button class="icon-btn ok" data-open="${escapeAttr(t.outFile || '')}">${S.btn_open_folder}</button>` +
           `<button class="icon-btn" data-remove="${t.id}">${S.btn_remove}</button>`;
  }
  return `<button class="icon-btn" data-remove="${t.id}">${S.btn_remove}</button>`;
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
    isDone ? S.pct_done : (indet ? S.step_indeterminate : (t.pct || 0) + '%');

  const stepLabel = (t.stepNum && t.stepTotal)
    ? S.detail_step_of(t.stepNum, t.stepTotal, t.step || '')
    : (t.step || statusText(t.status));
  $('#detail-step').textContent = stepLabel;

  // 进度条下方的醒目状态横幅：当前在干嘛 + 进度
  const procTxt = (t.processedSec != null && t.totalSec)
    ? ` · ${fmtSec(t.processedSec)} / ${fmtSec(t.totalSec)}`
    : '';
  let banner;
  if (isDone) banner = `✓ ${S.status_done}`;
  else if (isError) banner = t.step || statusText(t.status);
  else if (t.status === 'queued') banner = S.step_queued;
  else banner = stepLabel + procTxt;     // running/retrying
  $('#detail-status').textContent = banner;

  $('#detail-processed').textContent =
    (t.processedSec != null && t.totalSec)
      ? `${fmtSec(t.processedSec)} / ${fmtSec(t.totalSec)}`
      : '—';
  $('#detail-duration').textContent = t.durationMin ? S.detail_duration_val(t.durationMin) : '—';
  $('#detail-eta').textContent = t.etaMin ? S.detail_eta_val(t.etaMin) : '—';
  $('#detail-elapsed').textContent =
    (t.status === 'running' || t.status === 'retrying') ? fmtElapsed(t.startTs)
      : (isDone ? S.detail_done : '—');
  $('#detail-fmt').textContent = FMT_LABELS()[t.outputFormat] || S.fmt_txt;
  $('#detail-music').textContent = t.music ? S.detail_music_yes : S.detail_music_no;
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
      if (start) el.textContent = S.step_elapsed(fmtElapsed(start));
    });
    if (detailTaskId != null) {
      const t = tasks.find(x => x.id === detailTaskId);
      if (t && (t.status === 'running' || t.status === 'retrying')) {
        $('#detail-elapsed').textContent = fmtElapsed(t.startTs);
      }
    }
  }, 1000);
}

// ---------------------------------------------------------------------------
// 颜色工具（彩蛋用）
// ---------------------------------------------------------------------------
// 判断当前 accent 是否在"红色"范围内（排除粉/橙/棕）
function isRedAccent() {
  const accent = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim() || (config.accent || '#5b5bfa');
  if (!accent.startsWith('#') || accent.length < 7) return false;
  const { h, s, l } = hexToHsl(accent);
  const inRedHue = h >= 345 || h <= 18;   // 345°–360° and 0°–18°（真红，排除橙）
  return inRedHue && s > 0.55 && l > 0.22 && l < 0.68;
}

// UFO 彩蛋动画序列（飞到右上角 → 斜向光束打向中央 → 恢复）
function triggerUFOEaster() {
  const empty = $('#empty-state');
  const flyer = $('#ufo-flyer');
  const body = $('#ufo-art');
  const emblem = $('#emblem-proj');
  const pool = $('#ground-pool');
  if (!empty || !flyer || !body || !emblem || !pool || !window.__beam) return;

  const root = document.documentElement;
  const BASE_TILT = parseFloat(getComputedStyle(root).getPropertyValue('--ufo-tilt')) || 10;
  const uw = parseFloat(getComputedStyle(root).getPropertyValue('--uw')) || 110;

  // 绝对坐标三次贝塞尔飞行：从 (ax,ay) 飞到 (bx,by)，两个绝对控制点
  // banking 侧倾：飞碟没有前后之分，只随横向加速侧倾（不朝向目标）
  function flyTo(ax, ay, bx, by, c1x, c1y, c2x, c2y, dur, cb) {
    const start = performance.now();
    let lx = ax;
    function step(now) {
      const t = Math.min(1, (now - start) / dur);
      const u = 1 - t;
      const x = u*u*u*ax + 3*u*u*t*c1x + 3*u*t*t*c2x + t*t*t*bx;
      const y = u*u*u*ay + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*by;
      flyer.style.transform = `translate(${x.toFixed(2)}px,${y.toFixed(2)}px)`;
      // banking：仅用横向速度分量，BASE_TILT 叠加，clamp 防光束丢失
      const vx = x - lx; lx = x;
      if (window.__beam) {
        const bank = Math.max(-20, Math.min(20, vx * 2.8));
        window.__beam._setTiltTarget(BASE_TILT + bank);
      }
      if (t < 1) requestAnimationFrame(step);
      else cb && cb();
    }
    requestAnimationFrame(step);
  }

  // 初始化
  empty.classList.add('egg-active');
  emblem.style.animation = 'none'; emblem.style.opacity = '0';
  pool.style.animation   = 'none'; pool.style.opacity   = '0';
  body.classList.add('frozen');
  flyer.style.animation = 'none';
  flyer.style.transform = 'translate(0,0)';

  // 停泊位：右上方
  const PX = uw * 1.6, PY = -uw * 1.05;

  // ── 飞出：cp2=终点 → 到站速度为零（平滑停止）；提前 350ms 激活 aim，倾角在到站前就开始转 ──
  flyTo(0, 0,  PX, PY,
    -uw*0.08, PY*0.45,  // cp1：轻微左上拱（决定弧线形状）
     PX, PY,            // cp2=终点：切线速度→0，平滑减速停止
    1350, null);

  // 提前 350ms 激活 aim，beam 和倾角开始缓动过渡（到站时已部分到位，无突变感）
  setTimeout(() => {
    window.__beam.aim();
    pool.style.animation = 'poolFade 0.7s ease forwards';
  }, 1000);

  // 停稳后党徽渐现
  setTimeout(() => {
    emblem.style.animation = 'symbolAppear 0.85s cubic-bezier(0.2,0,0.4,1) forwards';
  }, 1750);

  // 党徽消失
  setTimeout(() => {
    emblem.style.animation = 'symbolFade 0.5s ease-in forwards';
  }, 4900);

  // 光束复位（banking 也随之缓动回 BASE_TILT）
  setTimeout(() => {
    window.__beam.normal();
    pool.style.animation = 'poolFade 0.6s ease reverse forwards';
  }, 5400);

  // 飞回：cp1=起点 → 起步速度为零（平滑启动）；cp2 偏左下让轨迹有弧度
  setTimeout(() => {
    flyTo(PX, PY,  0, 0,
      PX, PY,            // cp1=起点：初速为零，平滑启动
      uw*0.2, PY*0.15,   // cp2：弧线收向原点
      1200, null);
  }, 5900);

  // 全部归零
  setTimeout(() => {
    empty.classList.remove('egg-active');
    flyer.style.transform = '';
    flyer.style.animation = '';
    body.classList.remove('frozen');
    emblem.style.animation = 'none'; emblem.style.opacity = '0';
    pool.style.animation   = 'none'; pool.style.opacity   = '0';
    if (window.__beam) window.__beam.normal();
  }, 7200);
}

// ── 应用日志面板（简洁文本，重点标红 ERROR/WARN）────────────────────────────
async function showLogsPanel() {
  const mainLogs = await window.api.getLogs().catch(() => '');
  const sep = '─'.repeat(60);
  // 合并渲染端（下载错误 + console.error）和主进程日志，按时间排序
  const all = [
    ..._rlogs,
    ...(mainLogs ? mainLogs.split('\n').filter(Boolean) : []),
  ].sort();
  const logs = all.length ? all.join('\n') : '（暂无日志）';
  // 复用现有 modal 样式，动态创建一次性面板
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9999;display:flex;align-items:center;justify-content:center';
  mask.innerHTML = `
    <div class="modal wide" style="max-height:80vh;display:flex;flex-direction:column;width:700px">
      <div class="modal-title" style="display:flex;align-items:center;justify-content:space-between">
        应用日志
        <div style="display:flex;gap:8px">
          <button class="btn ghost tiny" id="_log-copy">📋 复制</button>
          <button class="btn ghost tiny" id="_log-close">✕ 关闭</button>
        </div>
      </div>
      <pre id="_log-body" style="flex:1;overflow-y:auto;background:var(--bg-card);padding:12px;border-radius:6px;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-all;margin:0"></pre>
    </div>`;
  document.body.appendChild(mask);

  const pre = mask.querySelector('#_log-body');
  // 标红 ERROR/WARN，普通行正常色
  // 会话分隔线（app 启动时间）
  const sessionTs = new Date().toLocaleString('zh-CN');
  const header = `${'─'.repeat(20)} 本次会话 ${sessionTs} ${'─'.repeat(20)}`;
  const fullText = header + '\n' + logs;
  pre.innerHTML = fullText.split('\n').map(line => {
    if (line.startsWith('─'))              return `<span style="color:var(--text-dim)">${escapeHtml(line)}</span>`;
    if (/\[ERROR\]/.test(line))            return `<span style="color:var(--danger)">${escapeHtml(line)}</span>`;
    if (/\[WARN\]/.test(line))             return `<span style="color:var(--warning)">${escapeHtml(line)}</span>`;
    if (/\[DL\]/.test(line))               return `<span style="color:#88c8ff">${escapeHtml(line)}</span>`;
    return escapeHtml(line);
  }).join('\n');
  pre.scrollTop = pre.scrollHeight;

  mask.querySelector('#_log-close').onclick = () => mask.remove();
  mask.querySelector('#_log-copy').onclick = async (e) => {
    await navigator.clipboard.writeText(logs);
    const btn = e.target;
    const orig = btn.textContent;
    btn.textContent = '✓ 已复制';
    btn.style.color = 'var(--success)';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 2000);
  };
  mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
}

function hexToHsl(hex) {
  let r = parseInt(hex.slice(1,3),16)/255;
  let g = parseInt(hex.slice(3,5),16)/255;
  let b = parseInt(hex.slice(5,7),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h = 0, s = 0, l = (max+min)/2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    switch (max) {
      case r: h = ((g-b)/d + (g<b?6:0))/6; break;
      case g: h = ((b-r)/d + 2)/6; break;
      case b: h = ((r-g)/d + 4)/6; break;
    }
  }
  return { h: h*360, s, l };
}
function hslToHex(h, s, l) {
  h /= 360;
  const hue2rgb = (p,q,t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p+(q-p)*6*t;
    if (t < 0.5) return q;
    if (t < 2/3) return p+(q-p)*(2/3-t)*6;
    return p;
  };
  const q = l < 0.5 ? l*(1+s) : l+s-l*s, p = 2*l-q;
  return '#' + [hue2rgb(p,q,h+1/3), hue2rgb(p,q,h), hue2rgb(p,q,h-1/3)]
    .map(v => Math.round(v*255).toString(16).padStart(2,'0')).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
}
function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

init();
