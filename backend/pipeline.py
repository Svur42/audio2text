"""Audio2Text 后端转写脚本（随应用打包发布版）。

依赖（用户需自行安装到所用的 Python 环境）：
    pip install faster-whisper demucs
并安装 ffmpeg，加入系统 PATH。
GPU 加速需 CUDA 版 PyTorch；无 CUDA 时自动回退到 CPU（较慢）。

用法：
    python pipeline.py <音频文件> [--music]
         [--out-dir DIR] [--model-dir DIR] [--demucs-cache-dir DIR]
         [--model-name large-v3-turbo] [--demucs-model htdemucs]
         [--ffmpeg-dir DIR]
"""
import sys
import os
import argparse
import subprocess
import tempfile
from pathlib import Path

# 通用默认值；GUI 会显式传参覆盖
DEFAULT_MODEL_DIR = str(Path.home() / ".cache" / "audio2text" / "whisper-models")
DEFAULT_OUT_DIR = Path.home() / "Audio2Text"
PYTHON = sys.executable

# GUI 强杀后可据此前缀回收残留 temp 文件
SAFE_INPUT_PREFIX = "pipeline_safe_input"


def p(msg):
    print(msg, flush=True)


def maybe_add_ffmpeg(ffmpeg_dir):
    """若提供了存在的 ffmpeg 目录则加入 PATH；否则依赖系统 PATH。"""
    if ffmpeg_dir and Path(ffmpeg_dir).is_dir():
        os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")


def pick_device():
    """有可用 CUDA 用 GPU，否则回退 CPU。"""
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def get_duration(path):
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True
        )
        return float(result.stdout.strip())
    except Exception:
        return None


def estimate(duration_sec, with_music):
    mins = duration_sec / 60
    whisper_min = max(1, int(mins * 0.15))
    demucs_min = max(1, int(mins * 0.2)) if with_music else 0
    total = whisper_min + demucs_min
    return total, demucs_min, whisper_min


def cleanup_md(path):
    lines = path.read_text(encoding="utf-8").splitlines()
    cleaned = []
    removed = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            cleaned.append(lines[i])
            i += 1
            continue
        repeat = 1
        while i + repeat < len(lines) and lines[i + repeat].strip() == line:
            repeat += 1
        if repeat >= 3:
            preview = line[:50] + ("..." if len(line) > 50 else "")
            removed.append(f"  [{repeat}次重复] {preview}")
            i += repeat
            continue
        cleaned.append(lines[i])
        i += 1
    if removed:
        p("自动删除以下连续重复行：")
        for r in removed:
            p(r)
    else:
        p("未发现连续重复行。")
    path.write_text("\n".join(cleaned), encoding="utf-8")


def unique_path(out_dir, stem, ext):
    """同名冲突时追加 _2、_3...（写文件前一刻调用，避免覆盖）。"""
    p0 = out_dir / f"{stem}{ext}"
    if not p0.exists():
        return p0
    n = 2
    while True:
        cand = out_dir / f"{stem}_{n}{ext}"
        if not cand.exists():
            return cand
        n += 1


def fmt_time_srt(seconds):
    """秒 → SRT 时间戳 HH:MM:SS,mmm"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int(round((seconds - int(seconds)) * 1000))
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def fmt_time_vtt(seconds):
    """秒 → VTT 时间戳 HH:MM:SS.mmm"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int(round((seconds - int(seconds)) * 1000))
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def has_whisper_model(model_dir, model_name):
    token = model_name.replace("/", "--")
    try:
        for d in Path(model_dir).iterdir():
            if d.is_dir() and d.name.startswith("models--") and token in d.name:
                return True
    except Exception:
        pass
    return False


def transcribe(audio_path, stem, out_dir, model_dir, model_name, device, output_format="txt"):
    from faster_whisper import WhisperModel
    local_present = has_whisper_model(model_dir, model_name)
    if local_present:
        p("Whisper 模型已就绪，正在加载...")
        # 本地已有模型：强制离线，避免联网校验在弱网/被墙环境长时间卡顿
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
    else:
        p(f"⚠ 本地未找到模型 {model_name}（目录：{model_dir}）。")
        p("  将尝试联网下载；若无网络会在约 10 秒后失败——建议先在设置里下载模型，或指定正确的模型目录。")
        # 缩短 HuggingFace 连接/下载超时，避免无网络时干等几十分钟
        os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "10")
        os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "10")
    compute_type = "float16" if device == "cuda" else "int8"
    model = WhisperModel(model_name, device=device, compute_type=compute_type,
                         download_root=str(model_dir), local_files_only=local_present)
    p("转写中...")
    segments, info = model.transcribe(str(audio_path), beam_size=5)

    segs = []
    total = info.duration
    for seg in segments:
        segs.append((seg.start, seg.end, seg.text.strip()))
        pct = int(seg.end / total * 100) if total else 0
        p(f"  {pct}%  [{seg.end:.0f}s / {total:.0f}s]")

    out_dir.mkdir(parents=True, exist_ok=True)

    if output_format == "srt":
        out_path = unique_path(out_dir, stem, ".srt")
        blocks = []
        for i, (start, end, text) in enumerate(segs, 1):
            blocks.append(f"{i}\n{fmt_time_srt(start)} --> {fmt_time_srt(end)}\n{text}")
        out_path.write_text("\n\n".join(blocks) + "\n", encoding="utf-8")
    elif output_format == "vtt":
        out_path = unique_path(out_dir, stem, ".vtt")
        blocks = ["WEBVTT\n"]
        for start, end, text in segs:
            blocks.append(f"{fmt_time_vtt(start)} --> {fmt_time_vtt(end)}\n{text}")
        out_path.write_text("\n\n".join(blocks) + "\n", encoding="utf-8")
    elif output_format == "txt":
        out_path = unique_path(out_dir, stem, ".txt")
        out_path.write_text("\n".join(t for _, _, t in segs), encoding="utf-8")
    else:  # 'md' 或默认
        out_path = unique_path(out_dir, stem, ".md")
        out_path.write_text("\n".join(t for _, _, t in segs), encoding="utf-8")
        cleanup_md(out_path)

    p(f"转写完成：{out_path}")


def needs_safe_copy(path):
    """检测文件名是否含 pyav 无法处理的特殊字符（如弯引号、问号等）。"""
    try:
        import av
        with av.open(str(path), mode="r", metadata_errors="ignore") as _:
            pass
        return False
    except Exception:
        return True


def run(input_file, with_music, out_dir, model_dir, model_name, demucs_model, device, output_format="txt"):
    inp = Path(input_file)
    stem = inp.stem
    if stem.endswith('_音频'):
        stem = stem[:-3]
    elif stem.endswith('音频'):
        stem = stem[:-2]

    tmp_copy = None
    if needs_safe_copy(inp):
        tmp_copy = Path(tempfile.gettempdir()) / f"{SAFE_INPUT_PREFIX}{inp.suffix or '.mp4'}"
        import shutil
        p(f"文件名含特殊字符，临时复制到：{tmp_copy}")
        shutil.copy2(str(inp), str(tmp_copy))
        work_inp = tmp_copy
    else:
        work_inp = inp

    try:
        dur = get_duration(work_inp)
        if dur:
            total_est, d_est, w_est = estimate(dur, with_music)
            p(f"文件时长：{dur/60:.1f} 分钟")
            if with_music:
                p(f"预计耗时：约 {total_est} 分钟（人声分离约 {d_est} 分钟 + 转写约 {w_est} 分钟）")
            else:
                p(f"预计耗时：约 {w_est} 分钟（仅转写）")
        else:
            p("无法读取文件时长，继续执行...")

        if with_music:
            with tempfile.TemporaryDirectory(prefix="pipeline_demucs_") as tmpdir:
                p("第 1 步 / 共 2 步：正在分离人声...（此步无进度，请耐心等待）")
                result = subprocess.run(
                    [PYTHON, "-m", "demucs", "-n", demucs_model, "--two-stems", "vocals",
                     "--device", device, "-o", tmpdir, str(work_inp)]
                )
                if result.returncode != 0:
                    p("人声分离失败，请检查 ffmpeg / GPU 或输入文件格式。")
                    sys.exit(1)
                vocals = Path(tmpdir) / demucs_model / work_inp.stem / "vocals.wav"
                if not vocals.exists():
                    p(f"未找到人声文件：{vocals}")
                    sys.exit(1)
                p("第 2 步 / 共 2 步：正在转写人声...")
                transcribe(vocals, stem, out_dir, model_dir, model_name, device, output_format)
        else:
            p("第 1 步 / 共 1 步：正在转写...")
            transcribe(work_inp, stem, out_dir, model_dir, model_name, device, output_format)
    finally:
        if tmp_copy and tmp_copy.exists():
            tmp_copy.unlink()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Audio2Text 音频转文字 pipeline")
    ap.add_argument("file", nargs="?", help="音频/视频文件路径（下载模式时可省略）")
    ap.add_argument("--music", action="store_true", help="有背景音乐时加，先做人声分离")
    ap.add_argument("--out-dir", default=None, help="输出目录")
    ap.add_argument("--model-dir", default=None, help="Whisper 模型目录")
    ap.add_argument("--demucs-cache-dir", default=None, help="Demucs 模型缓存目录(设到 TORCH_HOME)")
    ap.add_argument("--model-name", default="large-v3-turbo", help="Whisper 模型名")
    ap.add_argument("--demucs-model", default="htdemucs", help="Demucs 模型名")
    ap.add_argument("--ffmpeg-dir", default=None, help="ffmpeg bin 目录(可选,缺省用 PATH)")
    ap.add_argument("--output-format", default="md", choices=["md", "txt", "srt", "vtt"],
                    help="输出格式：txt 纯文本 / srt 字幕 / vtt 字幕（默认 txt）")
    ap.add_argument("--download-whisper", action="store_true", help="仅下载 Whisper 模型，不转写")
    ap.add_argument("--download-demucs", action="store_true", help="仅下载 Demucs 模型，不转写")
    a = ap.parse_args()

    maybe_add_ffmpeg(a.ffmpeg_dir or os.environ.get("A2T_FFMPEG_DIR"))
    model_dir = a.model_dir if a.model_dir else DEFAULT_MODEL_DIR
    if a.demucs_cache_dir:
        os.environ["TORCH_HOME"] = a.demucs_cache_dir

    if a.download_whisper:
        p(f"正在下载 Whisper 模型：{a.model_name}")
        p("下载中...（此步无进度条，请耐心等待）")
        from faster_whisper import WhisperModel
        WhisperModel(a.model_name, device="cpu", compute_type="int8",
                     download_root=str(model_dir))
        p(f"下载完成：{a.model_name}")
        sys.exit(0)

    if a.download_demucs:
        p(f"正在下载 Demucs 模型：{a.demucs_model}")
        p("下载中...（此步无进度条，请耐心等待）")
        # 用 demucs CLI 触发权重 .th 下载（demucs 4.x 用哈希文件名，import 不一定下 .th）
        # 用 /dev/null 或 NUL 作为假输入，demucs 会在下载权重后报文件错误，但权重已缓存
        dummy = "nul" if sys.platform == "win32" else "/dev/null"
        result = subprocess.run(
            [PYTHON, "-m", "demucs", "-n", a.demucs_model, "--two-stems", "vocals",
             "--device", "cpu", "-o", tempfile.gettempdir(), dummy],
            capture_output=True
        )
        # 预期会报文件不存在错误，但只要权重已缓存就算成功
        import glob, os as _os
        torch_home = _os.environ.get("TORCH_HOME", str(Path.home() / ".cache" / "torch"))
        ckpt = Path(torch_home) / "hub" / "checkpoints"
        th_files = list(ckpt.glob("*.th")) if ckpt.exists() else []
        if th_files:
            p(f"下载完成：{a.demucs_model}（权重已缓存到 {ckpt}）")
        else:
            p(f"下载可能失败，请检查网络后重试")
        sys.exit(0)

    if not a.file:
        ap.print_help()
        sys.exit(1)

    out_dir = Path(a.out_dir) if a.out_dir else DEFAULT_OUT_DIR
    device = pick_device()
    p(f"计算设备：{device.upper()}")
    run(a.file, a.music, out_dir, model_dir, a.model_name, a.demucs_model, device, a.output_format)
