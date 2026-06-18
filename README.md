# Audio2Text

**本地 Whisper 语音转文字桌面工具 · Local Whisper Speech-to-Text Desktop App**

> 零 API 费用 · 隐私安全 · 支持多语言界面  
> Zero API cost · Privacy-first · Multi-language UI

<p align="center">
  <img src="docs/screenshot-zh.png" width="48%" alt="中文界面"/>
  &nbsp;
  <img src="docs/screenshot-en.png" width="48%" alt="English UI"/>
</p>

---

## 功能特点 / Features

| 功能 | Feature |
|------|---------|
| 🎙 本地运行 faster-whisper，完全离线 | Run faster-whisper locally, fully offline |
| 🎵 支持背景音乐人声分离（demucs） | Background music/vocal separation (demucs) |
| 📂 拖拽文件或批量添加 | Drag & drop or batch add audio files |
| ⚡ 支持 GPU 加速（NVIDIA CUDA） | GPU acceleration (NVIDIA CUDA) |
| 🌐 内置中文/英文，支持自定义翻译包 | Built-in Chinese/English, extensible i18n |
| 📊 实时进度与预计耗时 | Real-time progress + ETA |
| 🎨 深色/浅色主题，自定义强调色 | Dark/light theme, custom accent color |
| 📋 多格式输出：md / txt / srt / vtt | Multiple output formats |

---

## 截图 / Screenshots

<p align="center">
  <img src="docs/screenshot-settings-zh.png" width="48%" alt="设置界面（中文）"/>
  &nbsp;
  <img src="docs/screenshot-settings-en.png" width="48%" alt="Settings (English)"/>
</p>

---

## 快速开始 / Quick Start

### 1. 下载 / Download

前往 [Releases](../../releases/latest) 下载 `Audio2Text-x.x.x.exe`（便携版，无需安装）。

Go to [Releases](../../releases/latest) to download `Audio2Text-x.x.x.exe` (portable, no install needed).

### 2. 安装 Python / Install Python

需要先安装 Python 3.9+：https://python.org（安装时勾选"Add Python to PATH"）

Requires Python 3.9+: https://python.org (check "Add Python to PATH" during install)

### 3. 运行并安装依赖 / Run & Install Dependencies

双击 `Audio2Text.exe` 启动，打开 **设置 → 运行环境**，应用会自动检测缺少的依赖并提供一键安装按钮（含实时进度条）。

Double-click `Audio2Text.exe` to launch. Open **Settings → Environment** — the app will detect missing dependencies and offer one-click install with real-time progress.

---

## 技术栈 / Tech Stack

| 组件 | 说明 | License |
|------|------|---------|
| [Electron](https://electronjs.org) | 桌面应用框架 / Desktop app framework | MIT |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | 基于 CTranslate2 的高效 Whisper 实现 | MIT |
| [demucs](https://github.com/facebookresearch/demucs) | 音乐/人声分离 / Music/vocal separation | MIT |
| [OpenAI Whisper](https://github.com/openai/whisper) | 原始语音识别模型权重 / Original ASR model weights | MIT |
| Python | 后端推理运行时 / Backend inference runtime | PSF |

UI 视觉语言参考了 [Motrix](https://github.com/agalwood/Motrix) 的构成主义风格（深色、硬边、等宽字体）。  
UI visual language inspired by [Motrix](https://github.com/agalwood/Motrix)'s constructivist aesthetic.

---

## 国际化 / Internationalization

内置语言：**中文**（默认）、**English**，无需额外下载，打开即可切换。

Built-in languages: **Chinese** (default) and **English**, available immediately without any download.

### 贡献翻译 / Contribute a Translation

1. 打开设置 → 界面语言 → 点击 **"导出双语翻译模板"**  
   Open Settings → Interface language → Click **"Export bilingual template"**

2. 用任意文本编辑器打开 `translation-template.json`：  
   Open `translation-template.json` in any text editor:

```json
{
  "_instructions_en": "Replace each English value with your translation. Keys starting with _ are ignored.",
  "_instructions_zh": "将每行英文值替换为您的翻译，_ 开头的键会被忽略。",
  "LANG_NAME": "Your Language Name",
  "btn_add_title": "Add files",
  "empty_text":    "No tasks yet",
  ...
}
```

3. 将所有英文值替换为目标语言，修改 `LANG_NAME` 为语言名称  
   Replace all English values with your translation, set `LANG_NAME` to the language name

4. 保存文件，拖入设置的翻译文件框（或点击框选择文件），然后保存设置  
   Save, drag the file into the Settings translation drop zone (or click to browse), then save

**欢迎通过 PR 提交翻译文件到 `locales/` 目录！**  
**Translations via PR to the `locales/` directory are welcome!**

---

## 开发 / Development

```bash
git clone https://github.com/Svur42/audio2text.git
cd audio2text
npm install
npm start        # 开发模式 / Dev mode
npm run build    # 打包 Windows exe / Build Windows portable exe
```

---

## 许可证 / License

[GNU General Public License v3.0](LICENSE)

本项目基于 GPL-3.0 协议开源。衍生作品须以相同协议开源发布。  
This project is licensed under GPL-3.0. Derivative works must be released under the same license.
