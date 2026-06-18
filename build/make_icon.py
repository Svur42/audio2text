# -*- coding: utf-8 -*-
"""生成占位图标：紫蓝圆角底 + 白色 A2T 字样。"""
from PIL import Image, ImageDraw, ImageFont

SIZE = 256
ACCENT = (91, 91, 250, 255)  # #5b5bfa

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# 圆角方块底
r = 56
d.rounded_rectangle([8, 8, SIZE - 8, SIZE - 8], radius=r, fill=ACCENT)

# 文字
text = "A2T"
font = None
for fp in [r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\arialbd.ttf"]:
    try:
        font = ImageFont.truetype(fp, 96)
        break
    except Exception:
        pass
if font is None:
    font = ImageFont.load_default()

bbox = d.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
d.text(((SIZE - tw) / 2 - bbox[0], (SIZE - th) / 2 - bbox[1]),
       text, font=font, fill=(255, 255, 255, 255))

# 输出多尺寸 ico
out = r"D:\数据\AI\Project\audio2text\build\icon.ico"
img.save(out, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("已生成", out)
