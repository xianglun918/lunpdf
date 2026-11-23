#!/usr/bin/env python3
"""生成 LunPDF 应用图标源图（1024x1024），再交给 `tauri icon` 生成各平台图标。"""
from PIL import Image, ImageDraw

S = 1024
SS = 4  # 超采样倍数
W = S * SS

BG_TOP = (214, 148, 58)
BG_BOT = (176, 108, 26)
PAPER = (252, 250, 246)
LINE = (208, 198, 182)
ACCENT = (194, 121, 15)

img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 背景：圆角方块 + 纵向渐变
grad = Image.new("RGB", (1, W))
for y in range(W):
    t = y / (W - 1)
    grad.putpixel(
        (0, y),
        (
            int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t),
            int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t),
            int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t),
        ),
    )
grad = grad.resize((W, W))
mask = Image.new("L", (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.22), fill=255)
img.paste(grad, (0, 0), mask)

# 纸张：带右上折角
left, top, right, bottom = int(W * 0.24), int(W * 0.17), int(W * 0.76), int(W * 0.83)
fold = int(W * 0.14)
d.rounded_rectangle(
    [left, top, right, bottom], radius=int(W * 0.03), fill=PAPER
)
# 折角三角（切掉右上角，画背景色三角）
d.polygon(
    [(right - fold, top), (right, top), (right, top + fold)],
    fill=(0, 0, 0, 0),
)
d.polygon(
    [(right - fold, top), (right, top + fold), (right - fold, top + fold)],
    fill=(226, 215, 198, 255),
)

# 文本行
line_x0, line_x1 = left + int(W * 0.07), right - int(W * 0.07)
y = top + int(W * 0.30)
for i, ratio in enumerate([1.0, 0.92, 0.97, 0.86, 0.55]):
    h = int(W * 0.026)
    d.rounded_rectangle(
        [line_x0, y, line_x0 + int((line_x1 - line_x0) * ratio), y + h],
        radius=h // 2,
        fill=LINE if i < 4 else ACCENT,
    )
    y += int(W * 0.085)

img = img.resize((S, S), Image.LANCZOS)
out = "/opt/data/workspace/pdf-reader/src-tauri/icon-src.png"
img.save(out)
print("saved", out, img.size)
