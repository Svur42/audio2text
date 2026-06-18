# Audio2Text

**本地 Whisper 语音转文字桌面工具**

[English](README_EN.md) | 中文

> 零 API 费用 · 完全本地运行 · 隐私安全 · 支持多语言界面

<p align="center">
  <img src="docs/screenshot-zh.png" width="48%" alt="主界面"/>
  &nbsp;
  <img src="docs/screenshot-settings-zh.png" width="48%" alt="设置界面"/>
</p>

---

## 功能特点

- 🎙 **本地转写**：基于 faster-whisper，完全离线，不消耗任何 API token
- 🎵 **人声分离**：可选 demucs，自动分离背景音乐后再转写
- 📂 **批量处理**：拖拽文件或批量添加，支持任务队列
- ⚡ **GPU 加速**：自动检测 NVIDIA GPU，支持 CUDA 加速
- 🔍 **环境自检**：启动时自动检测所有依赖，缺什么提示装什么（含一键安装+实时进度）
- 🌐 **多语言界面**：内置中文/英文，支持拖入自定义 JSON 翻译包
- 📋 **多格式输出**：Markdown / 纯文本 / SRT 字幕 / VTT 字幕
- 🎨 **主题定制**：深色/浅色，可自定义强调色

---

## 支持的模型

### Whisper 语音识别模型

| 模型 | 说明 | 显存需求 |
|------|------|---------|
| `large-v3-turbo` | ⭐ 推荐，速度与质量均衡 | ~3 GB |
| `large-v3` | 最高质量，较慢 | ~6 GB |
| `large-v2` | 经典稳定版 | ~6 GB |
| `distil-large-v3` | 蒸馏版，接近 large 质量，更快 | ~3 GB |
| `medium` | 中等质量，可 CPU 使用 | ~2 GB |
| `small` | 轻量，CPU 友好 | ~1 GB |
| `base` | 极轻，CPU 友好 | ~0.5 GB |
| `tiny` | 最轻最快，精度较低 | ~0.3 GB |

模型首次使用时自动从 HuggingFace 下载，无需手动管理。

### Demucs 人声分离模型

| 模型 | 说明 |
|------|------|
| `htdemucs` | ⭐ 默认推荐，质量与速度平衡 |
| `htdemucs_ft` | 更高质量，慢约 4 倍 |
| `htdemucs_6s` | 分离 6 个声部（人声/鼓/贝斯/其他/钢琴/吉他） |
| `mdx_extra` | MDX 架构备选 |
| `mdx_extra_q` | 量化版，CPU 友好 |
| `mdx_q` | 量化版，CPU 友好 |

---

## 快速开始

### 1. 下载

前往 [Releases](../../releases/latest) 下载 `Audio2Text-x.x.x.exe`（便携版，无需安装）。

### 2. 安装 Python

需要 Python 3.9+：https://python.org

> **为什么需要手动安装 Python？**  
> 本应用的 AI 推理依赖 faster-whisper、PyTorch 等库，总体积达数 GB。若将 Python 捆绑进 exe，安装包会从 71MB 膨胀到 2GB+，反而增加下载负担。当前方案：用户安装好 Python 后，应用会自动检测并提供一键安装所有 pip 依赖（含实时进度条），与同类工具（Buzz、faster-whisper-GUI 等）的主流做法一致。

安装时勾选 **"Add Python to PATH"**。

### 3. 运行

双击 `Audio2Text.exe`，打开 **设置 → 运行环境**，应用自动检测依赖并提供一键安装。

---

## 项目结构

```
audio2text/
├── main.js              # Electron 主进程（窗口、IPC、任务队列、模型检测）
├── preload.js           # 预加载脚本（安全桥接主进程与渲染进程）
├── renderer/
│   ├── index.html       # 主界面 HTML
│   ├── app.js           # 界面逻辑（任务管理、设置、动画）
│   ├── style.css        # 样式（深色主题、构成主义风格）
│   └── strings.js       # i18n 字符串（所有用户可见文字集中于此）
├── backend/
│   └── pipeline.py      # Python 推理管道（Whisper 转写 + Demucs 分离）
├── locales/
│   └── English.json     # 英文翻译包（内置，可作为其他语言的翻译模板）
├── build/
│   └── icon.ico         # 应用图标
└── docs/
    └── *.png            # 截图
```

**架构说明：**
- Electron 主进程负责任务调度、文件 I/O、进程管理
- 渲染进程（Chromium）负责 UI，通过 contextBridge 安全调用主进程 API
- Python 作为外部子进程运行，与主进程通过 stdout/stdin 通信（行协议）
- i18n 系统：所有文字存于 `strings.js`，外部语言包为 JSON 文件，运行时动态合并

---

## 技术栈

| 组件 | 版本 | 用途 | License |
|------|------|------|---------|
| [Electron](https://electronjs.org) | 33.x | 桌面应用框架 | MIT |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | latest | 基于 CTranslate2 的高效 Whisper 推理 | MIT |
| [CTranslate2](https://github.com/OpenNMT/CTranslate2) | — | 高性能 Transformer 推理引擎（faster-whisper 底层） | MIT |
| [demucs](https://github.com/facebookresearch/demucs) | latest | 音乐/人声分离 | MIT |
| [OpenAI Whisper](https://github.com/openai/whisper) | — | 原始 ASR 模型权重来源 | MIT |
| [PyTorch](https://pytorch.org) | latest | demucs 深度学习框架（可选 CUDA） | BSD-3 |
| Python | 3.9+ | 后端推理运行时 | PSF |

**UI 设计说明：**  
界面采用深色、硬边、等宽字体的风格，灵感来自构成主义平面设计（Constructivism）——强调几何形态、高对比度、功能优先。[Motrix](https://github.com/agalwood/Motrix) 在布局结构上提供了参考（侧边栏+内容区的双栏布局），但 Motrix 本身属于现代极简风格，与构成主义不同。

---

## 国际化

内置中文（默认）与英文，打开即可在设置中切换。

**贡献翻译：**

1. 打开设置 → 界面语言 → 点击 **"导出双语翻译模板"**
2. 用任意文本编辑器编辑生成的 JSON 文件（`_` 开头的行是说明，导入时忽略）：
```json
{
  "LANG_NAME": "Your Language Name",
  "btn_add_title": "Your translation",
  ...
}
```
3. 将翻译好的文件拖入设置中的翻译区域导入，或通过 PR 提交到 `locales/` 目录

---

## 开发

```bash
git clone https://github.com/Svur42/audio2text.git
cd audio2text
npm install
npm start        # 开发模式
npm run build    # 打包 Windows portable exe
```

---

## License

[GNU General Public License v3.0](LICENSE)

本项目基于 GPL-3.0 开源。衍生作品须以相同协议开源。
