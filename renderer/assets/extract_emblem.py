# -*- coding: utf-8 -*-
"""从党徽截图（黄标+红底）提取透明 PNG。
输出为白色剪影 + alpha，供 CSS mask-image 着色（红/黄随意切换）。"""
from PIL import Image
from pathlib import Path

SRC = r"D:\数据\图片\ScreenShot_2026-06-18_155438_122.png"
OUT = r"D:\数据\AI\Project\audio2text\renderer\assets\emblem-mask.png"

img = Image.open(SRC).convert("RGBA")
px = img.load()
w, h = img.size

# 党徽为黄色（高 R 高 G 低 B），红底为高 R 低 G 低 B —— 用 G 通道区分
out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
op = out.load()
minx, miny, maxx, maxy = w, h, 0, 0
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if g > 110 and r > 120:        # 黄色徽标像素
            op[x, y] = (255, 255, 255, 255)
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y

# 裁剪到徽标外接框 + 少量留白
pad = 12
minx = max(0, minx - pad); miny = max(0, miny - pad)
maxx = min(w, maxx + pad); maxy = min(h, maxy + pad)
cropped = out.crop((minx, miny, maxx, maxy))
cropped.save(OUT)
print(f"已输出 {OUT}  尺寸 {cropped.size}")
