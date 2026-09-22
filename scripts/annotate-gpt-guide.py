# -*- coding: utf-8 -*-
"""为 GPT 频道教程截图添加标注：箭头 + 覆盖文字。
原图较小（900x294），先放大 2 倍再标注，保证输出清晰。"""
import os
import math
from PIL import Image, ImageDraw, ImageFont

SRC = r"C:\Users\Parker\Downloads\28f23609-b272-444c-9c2d-f773feca5514.png"
DST = r"d:\Development\LastROWeb\apps\web\public\tutorial\gpt-guide.png"

RED = (231, 76, 60)
RED_DEEP = (192, 57, 43)
WHITE = (255, 255, 255)

img = Image.open(SRC).convert("RGBA")
img = img.resize((img.width * 2, img.height * 2), Image.LANCZOS)
W, H = img.size
print("size:", W, H)

overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
draw = ImageDraw.Draw(overlay)

F_LABEL = ImageFont.truetype(r"C:\Windows\Fonts\msyhbd.ttc", 42)
F_BADGE = ImageFont.truetype(r"C:\Windows\Fonts\msyhbd.ttc", 44)


def rounded_pill(cx, cy, text, fill, txt_color, pad_x=34, pad_y=20, radius=20,
                 border=None, border_w=0):
    bbox = draw.textbbox((0, 0), text, font=F_LABEL)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x0 = int(cx - tw / 2 - pad_x)
    y0 = int(cy - th / 2 - pad_y)
    x1 = int(cx + tw / 2 + pad_x)
    y1 = int(cy + th / 2 + pad_y)
    draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=fill,
                           outline=border, width=border_w)
    draw.text((cx - tw / 2 - bbox[0], cy - th / 2 - bbox[1]), text,
              font=F_LABEL, fill=txt_color)
    return x0, y0, x1, y1


def arrow(start, end, width=12, head=40):
    draw.line([start, end], fill=RED, width=width)
    ang = math.atan2(end[1] - start[1], end[0] - start[0])
    for a in (ang + 2.55, ang - 2.55):
        p = (end[0] + head * math.cos(a), end[1] + head * math.sin(a))
        draw.line([end, p], fill=RED, width=width)


def badge(cx, cy, text, r=40):
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=RED, outline=WHITE, width=6)
    bbox = draw.textbbox((0, 0), text, font=F_BADGE)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((cx - tw / 2 - bbox[0], cy - th / 2 - bbox[1] - 3), text,
              font=F_BADGE, fill=WHITE)


# ---- 目标位置（按比例） ----
dots = (int(0.952 * W), int(0.932 * H))          # 两个蓝色小点的中心
gpt = (int(0.895 * W), int(0.833 * H))           # GPT 菜单项中心

# ---- ② 高亮 GPT 行 ----
draw.rounded_rectangle([int(0.843 * W), int(0.778 * H),
                        int(0.985 * W), int(0.890 * H)],
                       radius=10, outline=RED, width=9)

# ---- ② 标签（放在聊天区中上部，避免与①重叠） ----
t2 = rounded_pill(int(0.46 * W), int(0.52 * H),
                  "② 选择「GPT」频道",
                  fill=(38, 50, 44, 242), txt_color=WHITE,
                  border=RED, border_w=4)
arrow((t2[2] - 30, t2[3] - 14), (int(0.843 * W) - 4, gpt[1] - 4))

# ---- ① 高亮蓝色小点 ----
draw.ellipse([int(0.918 * W), int(0.886 * H),
              int(0.983 * W), int(0.968 * H)],
             outline=RED, width=11)

# ---- ① 标签 ----
t1 = rounded_pill(int(0.50 * W), int(0.865 * H),
                  "① 点击右下角的蓝色小点按钮",
                  fill=(255, 255, 255, 246), txt_color=RED_DEEP,
                  border=RED, border_w=4)
arrow((t1[2] - 10, (t1[1] + t1[3]) // 2), (dots[0] - 110, dots[1] + 4))

out = Image.alpha_composite(img, overlay).convert("RGB")
os.makedirs(os.path.dirname(DST), exist_ok=True)
out.save(DST, quality=90, optimize=True)
print("saved:", DST)
