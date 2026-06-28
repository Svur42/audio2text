'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 拖拽文件取真实路径（Electron 32+ 已移除 File.path，须用 webUtils）
  getFilePath: (file) => {
    try { return webUtils.getPathForFile(file); }
    catch (e) { return file && file.path ? file.path : null; }
  },

  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  detectModels: (hintW, hintD) => ipcRenderer.invoke('config:detectModels', hintW, hintD),

  // 对话框
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  pickExe: () => ipcRenderer.invoke('dialog:pickExe'),

  // 模型状态
  whisperModelStatus: (whisperDir, modelName) =>
    ipcRenderer.invoke('model:whisperStatus', { whisperDir, modelName }),
  demucsModelStatus: (demucsDir, modelName) =>
    ipcRenderer.invoke('model:demucsStatus', { demucsDir, modelName }),

  // 模型下载（fire-and-forget，进度通过事件推送）
  downloadModel: (payload) => ipcRenderer.send('model:download', payload),
  // 先 removeAllListeners 再注册，防止 init() 重复调用时 listener 叠加（#1）
  onDownloadProgress: (cb) => {
    ipcRenderer.removeAllListeners('model:download:progress');
    ipcRenderer.on('model:download:progress', (_e, d) => cb(d));
  },
  onDownloadDone: (cb) => {
    ipcRenderer.removeAllListeners('model:download:done');
    ipcRenderer.on('model:download:done', (_e, d) => cb(d));
  },

  // 任务
  addTasks: (payload) => ipcRenderer.invoke('tasks:add', payload),
  refreshTasks: () => ipcRenderer.invoke('tasks:list'),
  cancelTask: (id) => ipcRenderer.invoke('task:cancel', id),
  removeTask: (id) => ipcRenderer.invoke('task:remove', id),
  deleteTask: (id, deleteFile) => ipcRenderer.invoke('task:delete', { id, deleteFile }),
  clearFinished: () => ipcRenderer.invoke('tasks:clearFinished'),
  openFolder: (filePath) => ipcRenderer.invoke('task:openFolder', filePath),

  // 事件监听
  onTasksUpdate: (cb) => ipcRenderer.on('tasks:update', (_e, list) => cb(list)),
  onWarnings: (cb) => ipcRenderer.on('app:warnings', (_e, msgs) => cb(msgs)),
  onTaskError: (cb) => ipcRenderer.on('task:error-log', (_e, d) => cb(d)),

  // 调试
  getLogs: () => ipcRenderer.invoke('dev:get-logs'),
  openDevTools: () => ipcRenderer.send('dev:open-tools'),

  // 语言包
  listLangs: () => ipcRenderer.invoke('lang:list'),
  loadLang: (filePath) => ipcRenderer.invoke('lang:load', filePath),
  importLang: (srcPath) => ipcRenderer.invoke('lang:import', srcPath),
  exportLangTemplate: () => ipcRenderer.invoke('lang:export-template'),
  pickLangFile: () => ipcRenderer.invoke('lang:pick-file'),

  // 环境检测与依赖安装
  checkEnv: () => ipcRenderer.invoke('env:check'),
  installDep: (payload) => ipcRenderer.send('env:install', payload),
  onInstallProgress: (cb) => {
    ipcRenderer.removeAllListeners('env:install:progress');
    ipcRenderer.on('env:install:progress', (_e, d) => cb(d));
  },
  onInstallDone: (cb) => {
    ipcRenderer.removeAllListeners('env:install:done');
    ipcRenderer.on('env:install:done', (_e, d) => cb(d));
  },
});
