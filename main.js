'use strict';

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

// 自动检测可用 Python（依次试 py -3 / python / python3）
function detectPython() {
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

  // Whisper：候选根目录
  const whisperCandidates = [
    'D:\\数据\\AI\\whisper-models',
    path.join(os.homedir(), '.cache', 'huggingface', 'hub'),
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
    problems.push('未找到 Python（请在设置里指定 python.exe，并确保已 pip install faster-whisper demucs）');
  }
  const pipe = resolvePipeline(cfg);
  if (!fs.existsSync(pipe)) {
    problems.push(`找不到后端脚本 pipeline.py：${pipe}`);
  }

  // 检查 ffprobe，再检查 Python 包（链式，避免并发启动多个进程）
  return new Promise((resolve) => {
    const checkPackages = () => {
      if (!py || !fs.existsSync(py)) { resolve(problems); return; }
      execFile(py, ['-c', 'import faster_whisper'], { timeout: 8000 }, (err) => {
        if (err) problems.push('Python 环境未安装 faster-whisper，请运行：pip install faster-whisper');
        execFile(py, ['-c', 'import demucs'], { timeout: 8000 }, (err2) => {
          if (err2) problems.push('Python 环境未安装 demucs（"有背景音乐"功能不可用），可运行：pip install demucs');
          resolve(problems);
        });
      });
    };

    const candidates = cfg.ffmpegDir ? [path.join(cfg.ffmpegDir, 'ffprobe.exe')] : [];
    if (candidates.find(p => fs.existsSync(p))) { checkPackages(); return; }
    execFile('ffprobe', ['-version'], { timeout: 5000 }, (err) => {
      if (err) problems.push('未找到 ffmpeg/ffprobe（请安装 ffmpeg 并加入 PATH，或在设置里指定目录）');
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

function makeTask(file, music, outDir) {
  const id = ++taskSeq;
  const t = {
    id,
    file,
    name: path.basename(file),
    music: !!music,
    outDir,
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
    id: t.id, name: t.name, music: t.music, outDir: t.outDir,
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
  t.step = '准备中...';
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
  return args;
}

// 全角冒号：U+FF1A — 直接用字面量
function startProcess(t, cfg, isRetry) {
  const args = buildArgs(t, cfg);
  const child = spawn(cfg.pythonPath, ['-u', ...args], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
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
        ['当前以 CPU 模式转写（未检测到 CUDA），速度较慢。建议在设置里切换为 small 或 medium 模型以提升速度。']);
    }

    // 友好处理 Python 包缺失错误（从 stderr 捕获后推到 step）
    if (/ModuleNotFoundError.*faster_whisper|No module named.*faster.whisper/i.test(line)) {
      t.step = '缺少依赖：请运行 pip install faster-whisper'; pushTaskState();
    }
    if (/ModuleNotFoundError.*demucs|No module named.*demucs/i.test(line)) {
      t.step = '缺少依赖：请运行 pip install demucs'; pushTaskState();
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
      t.step = '正在分离人声';
      t.indeterminate = true;
      pushTaskState();
      return;
    }
    if (/正在加载|正在下载\s*Whisper/.test(line)) {
      t.step = '加载模型中';
      t.indeterminate = true;
      pushTaskState();
      return;
    }
    if (/转写中/.test(line)) {
      t.step = '正在转写';
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
      t.step = '完成';
      runningId = null;
    } else if (sawOOM && !isRetry) {
      // OOM 自动重试一次：保持 runningId 占位（避免等待期并发启动其它任务），
      // 用独立的 retrying 态以便此期间可被取消
      t.status = 'retrying';
      t.step = '显存不足，等待后重试...';
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
      t.step = sawOOM ? '失败：显存不足' : `失败（退出码 ${code}）`;
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
    t.step = `启动失败：${err.message}`;
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
    t.step = '已取消';
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

// Demucs 模型是否已下载（demucs 4.x 用哈希文件名，无法按模型名匹配）
// 策略：checkpoints 目录存在且有 .th 文件 = 已下载过至少一个 demucs 模型
ipcMain.handle('model:demucsStatus', (_e, { demucsDir }) => {
  const ckpt = path.join(demucsDir || loadConfig().demucsCacheDir, 'hub', 'checkpoints');
  try {
    return fs.readdirSync(ckpt).some(f => f.endsWith('.th'));
  } catch (e) { return false; }
});

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

ipcMain.handle('tasks:add', (_e, { files, music, outDirs }) => {
  // outDirs: null（用各 task 默认）或字符串数组（与 files 等长）
  if (!Array.isArray(files) || !files.length) return false;
  files.forEach((f, i) => {
    const out = Array.isArray(outDirs) ? outDirs[i] : outDirs;
    makeTask(f, music, out || loadConfig().outDir);
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
  const cfg = loadConfig();
  const problems = await selfCheck(cfg);
  if (problems.length) {
    mainWin.webContents.once('did-finish-load', () => safeSend('app:warnings', problems));
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
