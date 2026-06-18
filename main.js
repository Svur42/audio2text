'use strict';

const S = require('./renderer/strings.js');

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// 可选模型清单（渲染端下拉同款；main 只透传 cfg.whisperModel/demucsModel）
// ---------------------------------------------------------------------------
const WHISPER_MODELS = [
  'large-v3-turbo', 'large-v3', 'large-v2', 'medium',
  'small', 'base', 'tiny', 'distil-large-v3',
];
const DEMUCS_MODELS = ['htdemucs', 'htdemucs_ft', 'mdx_extra'];

// 随应用打包的后端脚本路径（打包后经 extraResources 复制到 resources/backend/）
function bundledPipelinePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'backend', 'pipeline.py')
    : path.join(__dirname, 'backend', 'pipeline.py');
}

// 内嵌 Python 路径（extraResources/python-embed/python.exe）
function bundledPythonPath() {
  const embedDir = app.isPackaged
    ? path.join(process.resourcesPath, 'python-embed')
    : path.join(__dirname, 'build', 'python-embed');
  const exe = path.join(embedDir, 'python.exe');
  return fs.existsSync(exe) ? exe : null;
}

// 内嵌 Python 的 pip 包存放目录（userData，跨版本更新不丢失）
function embeddedSitePackages() {
  return path.join(app.getPath('userData'), 'site-packages');
}

// 运行内嵌 Python 时附加的环境变量
function embeddedPythonEnv() {
  const sp = embeddedSitePackages();
  const existing = process.env.PYTHONPATH || '';
  return {
    ...process.env,
    PYTHONPATH: existing ? `${sp};${existing}` : sp,
    PYTHONNOUSERSITE: '0',
  };
}

// 确保内嵌 Python 有 pip（首次自举）
async function ensureEmbeddedPip(pyPath) {
  const pipCheck = () => {
    try { execFileSync(pyPath, ['-m', 'pip', '--version'], { timeout: 8000 }); return true; }
    catch (e) { return false; }
  };
  if (pipCheck()) return;

  // 下载 get-pip.py 并运行
  const getPipPath = path.join(app.getPath('temp'), 'get-pip.py');
  await new Promise((resolve, reject) => {
    const https = require('https');
    const file = require('fs').createWriteStream(getPipPath);
    https.get('https://bootstrap.pypa.io/get-pip.py', (res) => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
  execFileSync(pyPath, [getPipPath, '--no-warn-script-location'], { timeout: 60000, stdio: 'inherit' });
  try { fs.unlinkSync(getPipPath); } catch (e) {}
}

// 自动检测可用 Python（优先用内嵌版本，再试系统 Python）
function detectPython() {
  // 1. 优先内嵌 Python
  const bundled = bundledPythonPath();
  if (bundled) return bundled;

  // 2. 回退到系统 Python
  const tries = [
    ['py', ['-3', '-c', 'import sys;print(sys.executable)']],
    ['python', ['-c', 'import sys;print(sys.executable)']],
    ['python3', ['-c', 'import sys;print(sys.executable)']],
  ];
  for (const [cmd, args] of tries) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf-8', timeout: 5000 });
      const pth = String(out).trim().split(/\r?\n/)[0].trim();
      if (pth && fs.existsSync(pth)) return pth;
    } catch (e) { /* 试下一个 */ }
  }
  return '';
}

function getDefaults() {
  return {
    pythonPath: '',            // 空 = 首启动自动检测
    pipelinePath: '',          // 空 = 用内置 bundledPipelinePath()
    ffmpegDir: '',             // 空 = 依赖系统 PATH
    outDir: path.join(app.getPath('documents') || app.getPath('home'), 'Audio2Text'),
    whisperDir: path.join(app.getPath('userData'), 'whisper-models'),
    demucsCacheDir: path.join(os.homedir(), '.cache', 'torch'),
    whisperModel: 'large-v3-turbo',
    demucsModel: 'htdemucs',
    defaultOutputFormat: 'md',  // md | txt | srt | vtt
    accent: '#5b5bfa',
    theme: 'dark',
  };
}

// pipeline.py 里用于临时文件的前缀（强杀后据此回收）
const TEMP_PREFIXES = ['pipeline_safe_input', 'pipeline_demucs_'];

// 启动下一个任务前要求的最小空闲显存（MB）
const VRAM_THRESHOLD_MB = 2000;
const VRAM_WAIT_TIMEOUT_MS = 30000;

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');

let mainWin = null;

// ---------------------------------------------------------------------------
// 配置读写
// ---------------------------------------------------------------------------
function loadConfig() {
  const defaults = getDefaults();
  let cfg;
  try {
    cfg = { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf-8')) };
  } catch (e) {
    // 首次启动：自动检测 python / 模型路径后写入
    cfg = { ...defaults };
    const det = detectModels();
    if (det.whisperDir) cfg.whisperDir = det.whisperDir;
    if (det.demucsCacheDir) cfg.demucsCacheDir = det.demucsCacheDir;
    cfg.pythonPath = detectPython();
    saveConfig(cfg);
  }
  if (!cfg.pythonPath) cfg.pythonPath = detectPython();   // 兜底再检测一次（不写盘）
  return cfg;
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
    fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2), 'utf-8');
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 模型自动检测
// ---------------------------------------------------------------------------
function dirHasWhisperModel(root) {
  // 找 root 下匹配 models--*faster-whisper-large-v3-turbo 且 snapshots/*/model.bin 存在
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!/models--.*faster-whisper-large-v3-turbo/.test(e.name)) continue;
      const snapRoot = path.join(root, e.name, 'snapshots');
      if (!fs.existsSync(snapRoot)) continue;
      for (const snap of fs.readdirSync(snapRoot)) {
        if (fs.existsSync(path.join(snapRoot, snap, 'model.bin'))) return true;
      }
    }
  } catch (e) { /* 忽略不可读目录 */ }
  return false;
}

function detectModels() {
  const result = { whisperDir: null, demucsCacheDir: null };

  // Whisper：候选根目录（常见安装位置）
  const whisperCandidates = [
    path.join(os.homedir(), '.cache', 'huggingface', 'hub'),
    path.join(os.homedir(), 'whisper-models'),
  ];
  for (const c of whisperCandidates) {
    if (dirHasWhisperModel(c)) { result.whisperDir = c; break; }
  }

  // Demucs：torch hub checkpoints 下的 .th；找不到不报错，留用默认让首跑下载
  const torchCkpt = path.join(os.homedir(), '.cache', 'torch', 'hub', 'checkpoints');
  try {
    if (fs.existsSync(torchCkpt) && fs.readdirSync(torchCkpt).some(f => f.endsWith('.th'))) {
      result.demucsCacheDir = path.join(os.homedir(), '.cache', 'torch');
    }
  } catch (e) { /* 忽略 */ }

  return result;
}

// 某个 Whisper 模型是否已下载到 whisperDir（HF 缓存目录按模型名命名）
function isWhisperModelDownloaded(whisperDir, modelName) {
  const token = String(modelName).replace(/\//g, '--');
  try {
    return fs.readdirSync(whisperDir).some(n => n.startsWith('models--') && n.includes(token));
  } catch (e) { return false; }
}

// Demucs 模型 → 权重签名映射（来自 demucs 包的 remote/*.yaml）
const DEMUCS_SIGS = {
  htdemucs: ['955717e8'],
  htdemucs_ft: ['f7e0c4bc', 'd12395a8', '92cfc3b6', '04573f0d'],
  htdemucs_6s: ['5c90dfd2'],
  mdx_extra: ['e51eebcc', 'a1d90b5c', '5d2d6c55', 'cfa93e08'],
  mdx_extra_q: ['83fc094f', '464b36d7', '14fc6a69', '7fd6ef75'],
  mdx_q: ['6b9c2ca1', 'b72baf4e', '42e558d4', '305bc58f'],
};

// 某个 Demucs 模型是否已下载（其全部签名的 .th 文件都存在）
function isDemucsModelDownloaded(demucsDir, modelName) {
  const sigs = DEMUCS_SIGS[modelName];
  if (!sigs) return false;
  const ckpt = path.join(demucsDir, 'hub', 'checkpoints');
  let files;
  try { files = fs.readdirSync(ckpt); } catch (e) { return false; }
  return sigs.every(sig => files.some(f => f.startsWith(sig) && f.endsWith('.th')));
}

// ---------------------------------------------------------------------------
// 启动自检：python / pipeline.py / ffprobe
// ---------------------------------------------------------------------------
function resolvePipeline(cfg) {
  return cfg.pipelinePath && cfg.pipelinePath.trim()
    ? cfg.pipelinePath : bundledPipelinePath();
}

function selfCheck(cfg) {
  const problems = [];
  const py = cfg.pythonPath;
  if (!py || !fs.existsSync(py)) {
    problems.push(S.warn_no_python);
  }
  const pipe = resolvePipeline(cfg);
  if (!fs.existsSync(pipe)) {
    problems.push(S.warn_no_pipeline(pipe));
  }

  // 检查 ffprobe，再检查 Python 包（链式，避免并发启动多个进程）
  return new Promise((resolve) => {
    const checkPackages = () => {
      if (!py || !fs.existsSync(py)) { resolve(problems); return; }
      execFile(py, ['-c', 'import faster_whisper'], { timeout: 8000 }, (err) => {
        if (err) problems.push(S.warn_no_fw);
        execFile(py, ['-c', 'import demucs'], { timeout: 8000 }, (err2) => {
          if (err2) problems.push(S.warn_no_demucs);
          resolve(problems);
        });
      });
    };

    const candidates = cfg.ffmpegDir ? [path.join(cfg.ffmpegDir, 'ffprobe.exe')] : [];
    if (candidates.find(p => fs.existsSync(p))) { checkPackages(); return; }
    execFile('ffprobe', ['-version'], { timeout: 5000 }, (err) => {
      if (err) problems.push(S.warn_no_ffmpeg);
      checkPackages();
    });
  });
}

// ---------------------------------------------------------------------------
// 显存探测（nvidia-smi）
// ---------------------------------------------------------------------------
function getFreeVramMB() {
  return new Promise((resolve) => {
    execFile('nvidia-smi',
      ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
      (err, stdout) => {
        if (err) { resolve(null); return; } // nvidia-smi 不可用
        const first = String(stdout).trim().split('\n')[0].trim();
        const mb = parseInt(first, 10);
        resolve(Number.isFinite(mb) ? mb : null);
      });
  });
}

async function waitForVram() {
  const start = Date.now();
  while (Date.now() - start < VRAM_WAIT_TIMEOUT_MS) {
    const free = await getFreeVramMB();
    if (free === null) { await sleep(1500); return; } // 无 nvidia-smi → 退回固定短延时
    if (free >= VRAM_THRESHOLD_MB) return;
    await sleep(1000);
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 临时文件清理（强杀后回收）
// ---------------------------------------------------------------------------
function cleanupTemp() {
  const tmp = os.tmpdir();
  try {
    for (const name of fs.readdirSync(tmp)) {
      if (!TEMP_PREFIXES.some(p => name.startsWith(p))) continue;
      const full = path.join(tmp, name);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
        else fs.rmSync(full, { force: true });
      } catch (e) { /* 占用中等下次再清 */ }
    }
  } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------------------
// 任务队列
// ---------------------------------------------------------------------------
let taskSeq = 0;
const tasks = new Map();           // id -> task
let runningId = null;

function makeTask(file, music, outDir, outputFormat) {
  const id = ++taskSeq;
  const t = {
    id,
    file,
    name: path.basename(file),
    music: !!music,
    outDir,
    outputFormat: outputFormat || 'txt',   // 'txt' | 'srt' | 'vtt'
    status: 'queued',             // queued | running | done | error | canceled
    pct: 0,
    step: '',
    durationMin: null,
    etaMin: null,
    startTs: null,
    outFile: null,
    indeterminate: false,
    processedSec: null,
    totalSec: null,
    stepNum: null,
    stepTotal: null,
    proc: null,
  };
  tasks.set(id, t);
  return t;
}

// 安全推送（#2：webContents 可能已销毁）
function safeSend(channel, ...args) {
  if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isDestroyed()) {
    mainWin.webContents.send(channel, ...args);
  }
}

function pushTaskState() {
  if (!mainWin || mainWin.isDestroyed() || mainWin.webContents.isDestroyed()) return;
  const list = [...tasks.values()].map(t => ({
    id: t.id, name: t.name, music: t.music, outDir: t.outDir, outputFormat: t.outputFormat,
    status: t.status, pct: Math.min(100, t.pct || 0), step: t.step,  // #8: 百分比上限 100
    durationMin: t.durationMin, etaMin: t.etaMin, startTs: t.startTs,
    outFile: t.outFile, indeterminate: t.indeterminate,
    processedSec: t.processedSec, totalSec: t.totalSec,
    stepNum: t.stepNum, stepTotal: t.stepTotal,
  }));
  mainWin.webContents.send('tasks:update', list);
}

function nextQueued() {
  for (const t of tasks.values()) {
    if (t.status === 'queued') return t;
  }
  return null;
}

async function runNext() {
  if (runningId !== null) return;            // 已有任务在跑
  const t = nextQueued();
  if (!t) return;

  // 同步占位 runningId（在任何 await 之前），阻止并发 runNext 重入启动同一任务
  runningId = t.id;
  t.status = 'running';
  t.startTs = Date.now();
  t.pct = 0;
  t.step = S.step_preparing;
  pushTaskState();

  // 启动前等显存（取消/上个任务刚结束时尤为关键）
  await waitForVram();
  if (t.status === 'canceled') {             // 等显存期间被取消
    runningId = null;
    cleanupTemp();
    pushTaskState();
    setImmediate(runNext);
    return;
  }

  const cfg = loadConfig();
  startProcess(t, cfg);
}

function buildArgs(t, cfg) {
  const args = [resolvePipeline(cfg), t.file];
  if (t.music) args.push('--music');
  args.push('--out-dir', t.outDir);
  args.push('--model-dir', cfg.whisperDir);
  if (cfg.demucsCacheDir) args.push('--demucs-cache-dir', cfg.demucsCacheDir);
  if (cfg.whisperModel) args.push('--model-name', cfg.whisperModel);
  if (cfg.demucsModel) args.push('--demucs-model', cfg.demucsModel);
  if (cfg.ffmpegDir) args.push('--ffmpeg-dir', cfg.ffmpegDir);
  if (t.outputFormat && t.outputFormat !== 'txt') args.push('--output-format', t.outputFormat);
  return args;
}

// 全角冒号：U+FF1A — 直接用字面量
function startProcess(t, cfg, isRetry) {
  const args = buildArgs(t, cfg);
  const isBundledPy = cfg.pythonPath === bundledPythonPath();
  const runEnv = {
    ...(isBundledPy ? embeddedPythonEnv() : process.env),
    PYTHONIOENCODING: 'utf-8',
  };
  const child = spawn(cfg.pythonPath, ['-u', ...args], {
    env: runEnv,
    windowsHide: true,
  });
  t.proc = child;

  let buf = Buffer.alloc(0);
  let sawOOM = false;

  const handleLine = (line) => {
    line = line.replace(/\r$/, '');
    if (!line.trim()) return;

    // CPU 模式警告（无 CUDA 时速度极慢）
    if (/计算设备：CPU/i.test(line)) {
      safeSend('app:warnings',
        [S.warn_cpu_mode]);
    }

    // 友好处理 Python 包缺失错误（从 stderr 捕获后推到 step）
    if (/ModuleNotFoundError.*faster_whisper|No module named.*faster.whisper/i.test(line)) {
      t.step = S.step_no_fw; pushTaskState();
    }
    if (/ModuleNotFoundError.*demucs|No module named.*demucs/i.test(line)) {
      t.step = S.step_no_demucs; pushTaskState();
    }

    let m;
    if ((m = line.match(/(\d+)%\s+\[(\d+)s\s*\/\s*(\d+)s\]/))) {
      t.pct = parseInt(m[1], 10);
      t.processedSec = parseInt(m[2], 10);   // 已处理音频秒数
      t.totalSec = parseInt(m[3], 10);       // 总音频秒数
      t.indeterminate = false;
      pushTaskState();
      return;
    }
    if (/文件时长：([\d.]+)\s*分钟/.test(line)) {
      t.durationMin = parseFloat(RegExp.$1);
      pushTaskState();
      return;
    }
    if ((m = line.match(/预计耗时：约\s*(\d+)/))) {
      t.etaMin = parseInt(m[1], 10);
      pushTaskState();
      return;
    }
    // 步骤行：第 X 步 / 共 Y 步：活动  —— 单独记录第几步，避免被后续活动行覆盖
    if ((m = line.match(/第\s*(\d+)\s*步\s*\/\s*共\s*(\d+)\s*步[：:]\s*(.*)/))) {
      t.stepNum = parseInt(m[1], 10);
      t.stepTotal = parseInt(m[2], 10);
      const act = (m[3] || '').replace(/（.*?）/g, '').replace(/[。.\s]+$/g, '').trim();
      if (act) t.step = act;                 // 如"正在转写"/"正在分离人声"
      if (/分离人声/.test(line)) t.indeterminate = true;
      pushTaskState();
      return;
    }
    if (/正在分离人声/.test(line)) {
      t.step = S.step_separating;
      t.indeterminate = true;
      pushTaskState();
      return;
    }
    if (/正在加载|正在下载\s*Whisper/.test(line)) {
      t.step = S.step_loading_model;
      t.indeterminate = true;
      pushTaskState();
      return;
    }
    if (/转写中/.test(line)) {
      t.step = S.step_transcribing;
      t.indeterminate = false;
      pushTaskState();
      return;
    }
    if ((m = line.match(/转写完成：(.+)$/))) {
      t.outFile = m[1].trim();
      pushTaskState();
      return;
    }
    if (/CUDA out of memory|OutOfMemoryError|RuntimeError: CUDA/.test(line)) {
      sawOOM = true;
    }
  };

  const drain = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let idx;
    while ((idx = buf.indexOf(0x0a)) >= 0) {        // 找 \n
      const lineBuf = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      handleLine(lineBuf.toString('utf8'));         // 仅在完整行边界解码
    }
  };

  child.stdout.on('data', drain);
  child.stderr.on('data', (chunk) => {
    const s = chunk.toString('utf8');
    if (/CUDA out of memory|OutOfMemoryError/.test(s)) sawOOM = true;
  });

  child.on('close', async (code) => {
    t.proc = null;

    if (t.status === 'canceled') {
      runningId = null;
      cleanupTemp();
      pushTaskState();
      setImmediate(runNext);
      return;
    }

    if (code === 0) {
      t.status = 'done';
      t.pct = 100;
      t.indeterminate = false;
      t.step = S.step_complete;
      runningId = null;
    } else if (sawOOM && !isRetry) {
      // OOM 自动重试一次：保持 runningId 占位（避免等待期并发启动其它任务），
      // 用独立的 retrying 态以便此期间可被取消
      t.status = 'retrying';
      t.step = S.step_oom_retry;
      t.indeterminate = true;
      pushTaskState();
      cleanupTemp();
      await waitForVram();
      if (t.status === 'canceled') {          // 等待期间被取消
        runningId = null;
        cleanupTemp();
        pushTaskState();
        setImmediate(runNext);
        return;
      }
      t.status = 'running';
      t.startTs = Date.now();
      startProcess(t, cfg, true);
      return;
    } else {
      t.status = 'error';
      t.step = sawOOM ? S.step_oom_fail : S.step_fail(code);
      runningId = null;
    }
    cleanupTemp();
    pushTaskState();
    setImmediate(runNext);
  });

  child.on('error', (err) => {
    t.proc = null;
    runningId = null;
    t.status = 'error';
    t.step = S.step_start_fail(err.message);
    pushTaskState();
    setImmediate(runNext);
  });

  pushTaskState();
}

// taskkill 整树杀（Windows 下杀 demucs 孙进程必需）
function killTaskTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/pid', String(pid), '/t', '/f'], () => resolve());
  });
}

async function cancelTask(id) {
  const t = tasks.get(id);
  if (!t) return;
  if (t.status === 'running' || t.status === 'retrying') {
    const proc = t.proc;
    t.status = 'canceled';
    t.step = S.step_canceled;
    pushTaskState();
    if (proc && proc.pid) {
      await killTaskTree(proc.pid);
      // close 事件里会接着 cleanupTemp + runNext
    } else {
      // 无 proc（等显存 / OOM 重试窗口）：立刻释放 runningId，不等 30s 超时
      runningId = null;
      cleanupTemp();
      setImmediate(runNext);
    }
  } else if (t.status === 'queued') {
    tasks.delete(id);
    pushTaskState();
  }
}

function removeTask(id) {
  const t = tasks.get(id);
  if (!t) return;
  if (t.status === 'running') return;   // 运行中不允许移除，先取消
  tasks.delete(id);
  pushTaskState();
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createWindow() {
  mainWin = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#2b2b2b',
    title: 'Audio2Text',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('config:get', () => loadConfig());

ipcMain.handle('config:save', (_e, cfg) => {
  const merged = { ...loadConfig(), ...cfg };
  return saveConfig(merged);
});

ipcMain.handle('config:detectModels', () => detectModels());

// 某 Whisper 模型是否已下载
ipcMain.handle('model:whisperStatus', (_e, { whisperDir, modelName }) =>
  isWhisperModelDownloaded(whisperDir || loadConfig().whisperDir, modelName));

// Demucs 某模型是否已下载（按 yaml 签名精确判断）
ipcMain.handle('model:demucsStatus', (_e, { demucsDir, modelName }) =>
  isDemucsModelDownloaded(demucsDir || loadConfig().demucsCacheDir, modelName));

// 下载模型（streaming 输出通过 webContents.send 推送）
ipcMain.on('model:download', (event, { type, modelName, demucsModel, whisperDir, demucsDir, ffmpegDir }) => {
  const cfg = loadConfig();
  const py = cfg.pythonPath || detectPython();
  if (!py) {
    event.sender.send('model:download:done', { type, code: 1, error: '未找到 Python，请在设置里配置' });
    return;
  }
  const pipe = resolvePipeline(cfg);
  const args = ['-u', pipe,
    '--model-dir', whisperDir || cfg.whisperDir,
    '--demucs-cache-dir', demucsDir || cfg.demucsCacheDir,
    '--model-name', modelName || cfg.whisperModel,
    '--demucs-model', demucsModel || cfg.demucsModel,
  ];
  if (ffmpegDir || cfg.ffmpegDir) args.push('--ffmpeg-dir', ffmpegDir || cfg.ffmpegDir);
  args.push(type === 'whisper' ? '--download-whisper' : '--download-demucs');

  const child = spawn(py, args, {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    windowsHide: true,
  });
  let buf = Buffer.alloc(0);
  const senderSend = (ch, data) => {
    if (!event.sender.isDestroyed()) event.sender.send(ch, data);
  };
  const drain = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let idx;
    while ((idx = buf.indexOf(0x0a)) >= 0) {
      const line = buf.slice(0, idx).toString('utf8').replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.trim()) senderSend('model:download:progress', { type, line });
    }
  };
  child.stdout.on('data', drain);
  child.stderr.on('data', (c) => senderSend('model:download:progress', { type, line: c.toString('utf8').trim() }));
  child.on('close', (code) => senderSend('model:download:done', { type, code }));
  child.on('error', (err) => senderSend('model:download:done', { type, code: 1, error: err.message }));
});

// ─── 环境检测 ──────────────────────────────────────────────────────────────
ipcMain.handle('env:check', async () => {
  const cfg = loadConfig();
  const py = cfg.pythonPath || detectPython();
  const result = { python: !!py, pythonPath: py, fasterWhisper: false, demucs: false, gpu: false, gpuName: null };
  if (!py) return result;

  const isBundled = py === bundledPythonPath();
  const pyEnv = isBundled ? embeddedPythonEnv() : process.env;
  const pyCheck = (code) => new Promise((resolve) => {
    const c = spawn(py, ['-c', code], { timeout: 8000, env: pyEnv });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.on('close', r => resolve(r === 0 ? out.trim() : null));
    c.on('error', () => resolve(null));
  });

  const [fw, dm, tc] = await Promise.all([
    pyCheck('import faster_whisper; print("ok")'),
    pyCheck('import demucs; print("ok")'),
    pyCheck('import torch; print("cuda" if torch.cuda.is_available() else "cpu")'),
  ]);
  result.fasterWhisper = fw === 'ok';
  result.demucs = dm === 'ok';
  result.torchInstalled = tc === 'cuda' || tc === 'cpu';
  result.torchCuda = tc === 'cuda';   // true = GPU(CUDA)版；false = CPU版或未安装

  await new Promise((resolve) => {
    const ns = spawn('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 5000 });
    let out = '';
    ns.stdout.on('data', d => { out += d; });
    ns.on('close', code => {
      if (code === 0 && out.trim()) { result.gpu = true; result.gpuName = out.trim().split('\n')[0].trim(); }
      resolve();
    });
    ns.on('error', resolve);
  });

  return result;
});

// ─── 依赖安装（带进度流） ────────────────────────────────────────────────────
ipcMain.on('env:install', (event, { pkg, variant }) => {
  const cfg = loadConfig();
  const py = cfg.pythonPath || detectPython();
  const send = (ev, d) => { try { event.sender.send(ev, d); } catch (_) {} };

  if (!py) { send('env:install:done', { pkg, code: 1, error: S.env_install_no_python }); return; }

  // 内嵌 Python 时把包装到 userData/site-packages
  const isBundled = py === bundledPythonPath();
  const targetArgs = isBundled ? ['--target', embeddedSitePackages()] : [];
  const installEnv = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8',
    ...(isBundled ? embeddedPythonEnv() : {}) };

  // 构建安装步骤序列
  const steps = [];
  if (pkg === 'faster-whisper') {
    steps.push({ label: 'faster-whisper', args: ['-m', 'pip', 'install', 'faster-whisper', ...targetArgs] });
  } else if (pkg === 'torch') {
    if (variant === 'gpu') {
      steps.push({ label: 'PyTorch（GPU/CUDA）', args: ['-m', 'pip', 'install', 'torch', '--index-url', 'https://download.pytorch.org/whl/cu121', ...targetArgs] });
    } else {
      steps.push({ label: 'PyTorch（CPU）', args: ['-m', 'pip', 'install', 'torch', ...targetArgs] });
    }
  } else if (pkg === 'demucs') {
    steps.push({ label: 'demucs', args: ['-m', 'pip', 'install', 'demucs', ...targetArgs] });
  }

  let stepIdx = 0;
  const runStep = () => {
    if (stepIdx >= steps.length) { send('env:install:done', { pkg, code: 0 }); return; }
    const { label, args } = steps[stepIdx];
    const stepBase = stepIdx / steps.length;       // 0.0 ~ 1.0（本步起始）
    const stepRange = 1 / steps.length;            // 每步占总进度的比例
    let dlPct = 0;                                 // 当前包下载百分比 0-100

    const toTotal = (p) => Math.round((stepBase + stepRange * p / 100) * 90); // → 0-90%
    send('env:install:progress', { pkg, label, progress: toTotal(0), line: `准备安装 ${label}…` });

    const child = spawn(py, args, { env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } });
    let buf = '';

    const parseLine = (raw) => {
      // 去除 ANSI 颜色码、Unicode 进度条字符
      const line = raw.replace(/\x1b\[[0-9;]*[mGKHF]/g, '').replace(/[━─▓█▒░]+/g, '').trim();
      if (!line) return;

      let progress, display;

      // ① 实时下载进度：pip 输出 "X.X/Y.Y MB" 或 "X.X MB / Y.Y MB"
      const dlMatch = line.match(/([\d.]+)\s*\/\s*([\d.]+)\s*(k?[Mm][Bb]|[Gg][Bb])/);
      if (dlMatch) {
        const cur = parseFloat(dlMatch[1]), tot = parseFloat(dlMatch[2]);
        if (tot > 0) dlPct = Math.min(99, Math.round(cur / tot * 100));
        // 速度/eta 提取（可选展示）
        const etaM = line.match(/eta\s+([\d:]+)/i);
        display = `下载中 ${dlPct}%` + (etaM ? `  剩余 ${etaM[1]}` : '');
        progress = toTotal(dlPct * 0.8);  // 下载阶段占本步 0-80%
        send('env:install:progress', { pkg, label, progress, line: display }); return;
      }

      // ② 阶段关键词
      if (/Collecting/i.test(line))          { progress = toTotal(2);  display = `检查依赖: ${line.replace(/Collecting\s+/i, '')}`; }
      else if (/Downloading/i.test(line))    { progress = toTotal(5);  display = `开始下载: ${line}`; }
      else if (/Installing collected/i.test(line)) { progress = toTotal(82); display = '正在写入文件…'; }
      else if (/Successfully installed/i.test(line)){ progress = toTotal(95); display = `✓ ${line}`; }
      else if (/already satisfied/i.test(line))    { progress = toTotal(95); display = `✓ 已是最新版`; }
      else if (/error|failed/i.test(line))         { progress = toTotal(dlPct); display = `⚠ ${line}`; }
      else return; // 其余无意义行不推送

      send('env:install:progress', { pkg, label, progress, line: display });
    };

    const onData = (d) => {
      // pip 进度行用 \r 覆盖，需同时按 \n 和 \r 分割
      buf += d.toString('utf8');
      const parts = buf.split(/[\n\r]/); buf = parts.pop() || '';
      parts.forEach(parseLine);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      if (buf.trim()) parseLine(buf);
      if (code !== 0) { send('env:install:done', { pkg, code, error: S.env_install_fail(label, code) }); return; }
      stepIdx++;
      runStep();
    });
    child.on('error', (err) => send('env:install:done', { pkg, code: 1, error: err.message }));
  };
  runStep();
});

// ─── 语言包 ─────────────────────────────────────────────────────────────────
// 自定义语言文件存储在 userData/locales/，打包后持久存在，无需 exe 旁边额外文件夹
function localesDir() {
  return path.join(app.getPath('userData'), 'locales');
}

ipcMain.handle('lang:list', () => {
  const dir = localesDir();
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const filePath = path.join(dir, f);
        let name = f.replace(/\.json$/i, '');
        try {
          const obj = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (obj.LANG_NAME) name = obj.LANG_NAME;
        } catch (e) {}
        return { name, path: filePath };
      });
  } catch (e) { return []; }
});

ipcMain.handle('lang:load', (_e, filePath) => {
  try {
    const obj = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // 过滤掉 _ 前缀的说明键，只返回实际翻译键值
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('_')));
  } catch (e) { return null; }
});

// 导入翻译文件：复制到 userData/locales/，同名时询问是否覆盖，返回 {name, path} 或 null
ipcMain.handle('lang:import', async (_e, srcPath) => {
  try {
    const dir = localesDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const raw = fs.readFileSync(srcPath, 'utf-8');
    const obj = JSON.parse(raw);
    const langName = obj.LANG_NAME || path.basename(srcPath, '.json');
    const dest = path.join(dir, path.basename(srcPath));
    if (fs.existsSync(dest)) {
      const { response } = await dialog.showMessageBox(mainWin, {
        type: 'question',
        title: '语言包已存在 / Language pack exists',
        message: `"${langName}" 已导入过，是否覆盖？\nOverwrite existing "${langName}"?`,
        buttons: ['覆盖 / Overwrite', '取消 / Cancel'],
        defaultId: 0, cancelId: 1,
      });
      if (response === 1) return null;  // 用户取消
    }
    fs.copyFileSync(srcPath, dest);
    return { name: langName, path: dest };
  } catch (e) { return null; }
});

// 弹出文件选择器，只显示 JSON 文件
ipcMain.handle('lang:pick-file', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: '选择翻译文件',
    filters: [{ name: 'JSON 翻译文件', extensions: ['json'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

// 导出双语模板（英文 | 中文）到用户选择的目录
ipcMain.handle('lang:export-template', async () => {
  const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory'] });
  if (r.canceled) return false;
  const zh = require('./renderer/strings.js');
  // 读英文参考（项目内）
  let en = {};
  try {
    const enPath = app.isPackaged
      ? path.join(process.resourcesPath, 'locales', 'English.json')
      : path.join(__dirname, 'locales', 'English.json');
    if (fs.existsSync(enPath)) en = JSON.parse(fs.readFileSync(enPath, 'utf-8'));
  } catch (e) {}
  // 模板格式：值 = 英文（待翻译），_ 前缀键 = 说明（app 加载时忽略）
  const template = {
    '_instructions_en': 'HOW TO TRANSLATE: 1) Set LANG_NAME to your language name. 2) Replace each English value below with your translation. 3) Keys starting with _ are instructions — keep or delete them, the app ignores them. 4) Save the file. 5) Drag it into Audio2Text Settings → Language to import.',
    '_instructions_zh': '翻译说明：1）将 LANG_NAME 改为您的语言名称。2）将每一行的英文值替换为您的翻译。3）以 _ 开头的键是说明行，可保留也可删除，导入时会被忽略。4）保存文件。5）拖入 Audio2Text 设置 → 界面语言 处导入即可生效。',
    'LANG_NAME': 'Your Language Name',
  };
  Object.keys(en).forEach(k => {
    if (k === 'LANG_NAME' || k.startsWith('_')) return;
    if (typeof zh[k] === 'function') return;   // 跳过函数型键
    template[k] = en[k] || '';                 // 值 = 英文（翻译者替换）
  });
  const dest = path.join(r.filePaths[0], 'translation-template.json');
  fs.writeFileSync(dest, JSON.stringify(template, null, 2), 'utf-8');
  shell.showItemInFolder(dest);
  return true;
});

ipcMain.handle('dialog:pickDir', async () => {
  const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:pickExe', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    properties: ['openFile'],
    filters: [{ name: '可执行文件', extensions: ['exe'] }, { name: '所有文件', extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:pickFiles', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '音频/视频', extensions: ['mp3', 'mp4', 'wav', 'm4a', 'flac', 'mkv', 'aac', 'ogg', 'wma', 'webm', 'mov'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('tasks:add', (_e, { files, music, outDirs, outputFormats }) => {
  // outDirs / outputFormats: null(用默认) 或与 files 等长的数组
  if (!Array.isArray(files) || !files.length) return false;
  files.forEach((f, i) => {
    const out = Array.isArray(outDirs) ? outDirs[i] : outDirs;
    const fmt = Array.isArray(outputFormats) ? outputFormats[i] : (outputFormats || loadConfig().defaultOutputFormat || 'md');
    makeTask(f, music, out || loadConfig().outDir, fmt);
  });
  pushTaskState();
  runNext();
  return true;
});

ipcMain.handle('tasks:list', () => {
  pushTaskState();
  return true;
});

ipcMain.handle('task:cancel', (_e, id) => cancelTask(id));
ipcMain.handle('task:remove', (_e, id) => removeTask(id));

// 删除任务记录，可选同时删除生成的文档
ipcMain.handle('task:delete', (_e, { id, deleteFile }) => {
  const t = tasks.get(id);
  if (!t) return { ok: false };
  if (t.status === 'running') return { ok: false, reason: 'running' };
  let fileDeleted = false;
  if (deleteFile && t.outFile) {
    try {
      if (fs.existsSync(t.outFile)) { fs.rmSync(t.outFile, { force: true }); fileDeleted = true; }
    } catch (e) { /* 文件占用或已不存在，忽略 */ }
  }
  tasks.delete(id);
  pushTaskState();
  return { ok: true, fileDeleted };
});

// 清空所有已结束（完成/失败/取消）的任务记录（不删文档）
ipcMain.handle('tasks:clearFinished', () => {
  let n = 0;
  for (const [id, t] of [...tasks.entries()]) {
    if (t.status === 'done' || t.status === 'error' || t.status === 'canceled') {
      tasks.delete(id); n++;
    }
  }
  pushTaskState();
  return n;
});
ipcMain.handle('task:openFolder', (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
  }
  return true;
});

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  createWindow();
  // 若使用内嵌 Python，自举 pip（首次异步完成，不阻塞窗口显示）
  const bundledPy = bundledPythonPath();
  if (bundledPy) {
    ensureEmbeddedPip(bundledPy).catch(e => console.warn('[pip-bootstrap]', e.message));
  }
  // 首次启动：把内置 locales（English 等）复制到 userData/locales，用户无需手动导入
  try {
    const builtinLocales = app.isPackaged
      ? path.join(process.resourcesPath, 'locales')
      : path.join(__dirname, 'locales');
    const userLocales = path.join(app.getPath('userData'), 'locales');
    if (fs.existsSync(builtinLocales)) {
      if (!fs.existsSync(userLocales)) fs.mkdirSync(userLocales, { recursive: true });
      fs.readdirSync(builtinLocales).forEach(f => {
        const dest = path.join(userLocales, f);
        if (!fs.existsSync(dest)) fs.copyFileSync(path.join(builtinLocales, f), dest);
      });
    }
  } catch (e) {}
  const cfg = loadConfig();
  // 若之前已检测到环境完整，跳过启动自检（不打扰用户）
  // 用户可在设置里点"重新检测"手动触发
  if (!cfg.envComplete) {
    const problems = await selfCheck(cfg);
    if (problems.length) {
      mainWin.webContents.once('did-finish-load', () => safeSend('app:warnings', problems));
    }
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;
app.on('before-quit', async (e) => {
  if (quitting) return;
  const pids = [...tasks.values()].filter(t => t.proc && t.proc.pid).map(t => t.proc.pid);
  if (!pids.length) { cleanupTemp(); return; }
  // 有残留子进程：拦截退出，杀完进程树再真正退出（避免 python/demucs 孙进程残留）
  e.preventDefault();
  quitting = true;
  await Promise.all(pids.map(killTaskTree));
  cleanupTemp();
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
