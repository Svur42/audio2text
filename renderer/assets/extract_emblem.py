# -*- coding: utf-8 -*-
"""从党徽截图提取透明剪影：只保留与中心连通的主体，去掉边缘杂散黄边。"""
from PIL import Image, ImageDraw
import numpy as np
from pathlib import Path

SRC = r"D:\数据\图片\ScreenShot_2026-06-18_155438_122.png"
OUT = r"D:\数据\AI\Project\audio2text\renderer\assets\emblem-mask.png"

img = Image.open(SRC).convert("RGB")
arr = np.asarray(img).astype(int)
r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
# 黄色徽标：高 R 高 G 低 B
emblem = (g > 110) & (r > 120) & (b < 150)

if emblem.sum() == 0:
    raise SystemExit("没找到黄色像素，检查源图")

# 质心（落在主体内）
ys, xs = np.where(emblem)
cy, cx = int(ys.mean()), int(xs.mean())

# 构造白底二值图，从质心 floodfill，只保留连通主体
binimg = Image.new("RGB", img.size, (0, 0, 0))
bpx = binimg.load()
h, w = emblem.shape
white = np.where(emblem)
for y, x in zip(*white):
    bpx[x, y] = (255, 255, 255)
# 若质心不在白区，找最近白点
if not emblem[cy, cx]:
    cy, cx = int(ys[0]), int(xs[0])
ImageDraw.floodfill(binimg, (cx, cy), (255, 0, 0), thresh=10)

barr = np.asarray(binimg)
keep = (barr[:, :, 0] == 255) & (barr[:, :, 1] == 0) & (barr[:, :, 2] == 0)

out = np.zeros((h, w, 4), dtype=np.uint8)
out[keep] = (255, 255, 255, 255)
out_img = Image.fromarray(out, "RGBA")

# 裁剪到主体外接框 + 留白
ys2, xs2 = np.where(keep)
pad = 16
x0, x1 = max(0, xs2.min() - pad), min(w, xs2.max() + pad)
y0, y1 = max(0, ys2.min() - pad), min(h, ys2.max() + pad)
out_img.crop((x0, y0, x1, y1)).save(OUT)
print(f"已输出 {OUT}  主体像素 {keep.sum()}  尺寸 {(x1-x0, y1-y0)}")
