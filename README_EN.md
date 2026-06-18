# Audio2Text

**Local Whisper Speech-to-Text Desktop App**

中文 | [English](README_EN.md)

> Zero API cost · Fully local · Privacy-first · Multi-language UI

<p align="center">
  <img src="docs/screenshot-en.png" width="48%" alt="Main interface"/>
  &nbsp;
  <img src="docs/screenshot-settings-en.png" width="48%" alt="Settings"/>
</p>

---

## Features

- 🎙 **Local transcription**: Powered by faster-whisper, fully offline, zero API tokens
- 🎵 **Vocal separation**: Optional demucs to separate background music before transcribing
- 📂 **Batch processing**: Drag & drop or batch add files, task queue included
- ⚡ **GPU acceleration**: Auto-detects NVIDIA GPU, supports CUDA acceleration
- 🔍 **Environment check**: Detects missing dependencies on startup, offers one-click install with progress bars
- 🌐 **Multi-language UI**: Built-in Chinese/English, import custom JSON translation packs
- 📋 **Multiple output formats**: Markdown / Plain text / SRT subtitles / VTT subtitles
- 🎨 **Theme customization**: Dark/light mode, custom accent color

---

## Supported Models

### Whisper Speech Recognition Models

| Model | Description | VRAM |
|-------|-------------|------|
| `large-v3-turbo` | ⭐ Recommended — speed & quality balanced | ~3 GB |
| `large-v3` | Highest quality, slower | ~6 GB |
| `large-v2` | Classic stable version | ~6 GB |
| `distil-large-v3` | Distilled, near-large quality, faster | ~3 GB |
| `medium` | Moderate quality, works on CPU | ~2 GB |
| `small` | Lightweight, CPU-friendly | ~1 GB |
| `base` | Very light, CPU-friendly | ~0.5 GB |
| `tiny` | Lightest & fastest, lower accuracy | ~0.3 GB |

Models are automatically downloaded from HuggingFace on first use.

### Demucs Vocal Separation Models

| Model | Description |
|-------|-------------|
| `htdemucs` | ⭐ Default — recommended, balanced quality/speed |
| `htdemucs_ft` | Better quality, ~4× slower |
| `htdemucs_6s` | 6-stem separation (vocals/drums/bass/other/piano/guitar) |
| `mdx_extra` | MDX architecture alternative |
| `mdx_extra_q` | Quantized, CPU-friendly |
| `mdx_q` | Quantized, CPU-friendly |

---

## Quick Start

### 1. Download

Go to [Releases](../../releases/latest) and download `Audio2Text-x.x.x.exe` (portable, no installation needed).

### 2. Install Python

Requires Python 3.9+: https://python.org

> **Why is Python installed separately?**  
> The AI libraries (faster-whisper, PyTorch, demucs) total several GB. Bundling Python into the exe would inflate it from 71 MB to 2+ GB with no meaningful benefit, since the large ML packages still need to be downloaded anyway. Instead, the app auto-detects your Python installation and provides one-click pip dependency installation with real-time progress — the same approach used by Buzz, faster-whisper-GUI, and similar tools.

Check **"Add Python to PATH"** during installation.

### 3. Run

Double-click `Audio2Text.exe`. Open **Settings → Environment** — the app will detect missing dependencies and offer one-click installation.

---

## Project Structure

```
audio2text/
├── main.js              # Electron main process (window, IPC, task queue, model detection)
├── preload.js           # Preload script (secure bridge between main and renderer)
├── renderer/
│   ├── index.html       # Main UI HTML
│   ├── app.js           # UI logic (task management, settings, animations)
│   ├── style.css        # Styles (dark theme, constructivist aesthetic)
│   └── strings.js       # i18n strings (all user-visible text centralized here)
├── backend/
│   └── pipeline.py      # Python inference pipeline (Whisper + Demucs)
├── locales/
│   └── English.json     # English translation pack (built-in; use as template)
├── build/
│   └── icon.ico         # App icon
└── docs/
    └── *.png            # Screenshots
```

**Architecture:**
- Electron main process handles task scheduling, file I/O, subprocess management
- Renderer process (Chromium) handles UI; communicates with main process via `contextBridge`
- Python runs as an external subprocess; communicates via stdout/stdin (line protocol)
- i18n system: all strings live in `strings.js`; external language packs are JSON files merged at runtime

---

## Tech Stack

| Component | Version | Role | License |
|-----------|---------|------|---------|
| [Electron](https://electronjs.org) | 33.x | Desktop app framework | MIT |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | latest | Efficient Whisper inference via CTranslate2 | MIT |
| [CTranslate2](https://github.com/OpenNMT/CTranslate2) | — | High-performance Transformer inference engine | MIT |
| [demucs](https://github.com/facebookresearch/demucs) | latest | Music/vocal source separation | MIT |
| [OpenAI Whisper](https://github.com/openai/whisper) | — | Original ASR model weights | MIT |
| [PyTorch](https://pytorch.org) | latest | Deep learning framework for demucs (optional CUDA) | BSD-3 |
| Python | 3.9+ | Backend inference runtime | PSF |

**UI design:** The interface uses dark tones, hard edges, and monospace typography inspired by Constructivist graphic design principles — emphasizing geometric form, high contrast, and function-first aesthetics. Layout structure (sidebar + content area) references [Motrix](https://github.com/agalwood/Motrix), though Motrix itself follows modern minimal design rather than constructivism.

---

## Internationalization

Chinese (default) and English are built-in — switch in Settings with no download required.

**Contributing a translation:**

1. Open Settings → Interface language → **"Export bilingual template"**
2. Edit the exported JSON in any text editor (lines starting with `_` are notes, ignored on import):
```json
{
  "LANG_NAME": "Your Language Name",
  "btn_add_title": "Your translation",
  ...
}
```
3. Drag the translated file into the Settings translation drop zone, or submit a PR to `locales/`

---

## Development

```bash
git clone https://github.com/Svur42/audio2text.git
cd audio2text
npm install
npm start        # Development mode
npm run build    # Build Windows portable exe
```

---

## License

[GNU General Public License v3.0](LICENSE)

This project is open-sourced under GPL-3.0. Derivative works must be released under the same license.
