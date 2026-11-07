"""
小程序封面图生成 —— 144×144
生成 5 款方案，让用户挑选而不是由我单方面决定。

设计约束（144×144 是极小尺寸）：
1. 文字最多 3 个字，再多就糊成一团
2. 图形要简单、轮廓粗，在 144px 下才清晰
3. 与 App 实际主色保持一致：#7C6F64（暖褐灰）
4. 不画细节纹理——小尺寸下只会变成噪点

微信小程序封面的两个用途：
- 分享卡片缩略图（约 100×100 显示）
- 「小程序码」中心的 logo
"""

from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets')
os.makedirs(OUT, exist_ok=True)

S = 144  # 画布尺寸；实际渲染 3 倍再缩小，保证边缘平滑
SS = 3
W = H = S * SS

# 与小程序 app.wxss / 首页一致的暖褐灰
BROWN = (124, 111, 100)
BROWN_DARK = (98, 87, 78)
CREAM = (250, 248, 245)
WHITE = (255, 255, 255)
GREEN = (61, 153, 112)   # 入账成功的绿色
RED = (217, 79, 79)      # 强调红

FONT_REG = 'C:/Windows/Fonts/msyh.ttc'
FONT_BD = 'C:/Windows/Fonts/msyhbd.ttc'


def font(size, bold=False):
    return ImageFont.truetype(FONT_BD if bold else FONT_REG, size * SS)


def text_center(draw, y, text, fnt, fill, canvas=W):
    bbox = draw.textbbox((0, 0), text, font=fnt)
    w = bbox[2] - bbox[0]
    draw.text(((canvas - w) / 2, y), text, font=fnt, fill=fill)


# ─────────────────────────────────────────────
# 方案 1：极简文字标
# 144px 下最稳的方案，任何情况下都不会糊
# ─────────────────────────────────────────────
def plan_1():
    img = Image.new('RGB', (W, H), CREAM)
    d = ImageDraw.Draw(img)

    # 圆角方块底
    d.rounded_rectangle([0, 0, W, H], radius=int(W * 0.22), fill=BROWN)

    # 品牌色下压一层更深的底，给文字留对比
    d.rounded_rectangle(
        [int(W * 0.12), int(H * 0.20), int(W * 0.88), int(H * 0.80)],
        radius=int(W * 0.14), fill=BROWN_DARK
    )

    # 「随口记」三个字竖排在小方块里，字号顶到接近边界以最大化可读性
    text_center(d, int(H * 0.255), '随口记', font(30, True), CREAM)

    # 下方细横线，暗示"记完一笔"
    d.rounded_rectangle(
        [int(W * 0.42), int(H * 0.685), int(W * 0.58), int(H * 0.71)],
        radius=int(2 * SS), fill=GREEN
    )
    return img.resize((S, S), Image.LANCZOS)


# ─────────────────────────────────────────────
# 方案 2：麦克风 + 声波（最贴合"语音记账"）
# ─────────────────────────────────────────────
def plan_2():
    img = Image.new('RGB', (W, H), CREAM)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, W, H], radius=int(W * 0.22), fill=BROWN)

    cx = W // 2
    # 声波圆心放在画面中线偏上，但要给弧线半径留足边距，
    # 否则最外层弧会超出圆角被裁掉（第一版就是这么翻车的）
    cy = int(H * 0.36)
    max_r = int(W * 0.30)   # 0.36H + 0.30W ≈ 0.36*432 + 0.30*432 = 285 < 432，安全

    for i, r in enumerate([int(W * 0.20), int(W * 0.25), max_r]):
        w = max(3, 5 * SS - i)  # 外侧略细，且保证最细不低于 3px
        box = [cx - r, cy - r, cx + r, cy + r]
        d.arc(box, start=-58, end=58, fill=WHITE, width=w)
        d.arc(box, start=122, end=238, fill=WHITE, width=w)

    # 麦克风主体：圆头方身
    mic_w = int(W * 0.17)
    mic_h = int(W * 0.24)
    d.rounded_rectangle(
        [cx - mic_w // 2, int(H * 0.22), cx + mic_w // 2, int(H * 0.22) + mic_h],
        radius=mic_w // 2, fill=WHITE
    )

    # 支架 U 形：紧贴麦克风底部
    u_w, u_h = int(W * 0.32), int(W * 0.18)
    u_cy = int(H * 0.44)
    d.arc([cx - u_w // 2, u_cy - u_h // 2, cx + u_w // 2, u_cy + u_h // 2],
          start=0, end=180, fill=WHITE, width=5 * SS)

    # 底座
    d.line([cx, u_cy + u_h // 2 - 2, cx, int(H * 0.60)],
           fill=WHITE, width=5 * SS)
    d.line([cx - int(W * 0.10), int(H * 0.60), cx + int(W * 0.10), int(H * 0.60)],
           fill=WHITE, width=5 * SS)

    # 底部文字
    text_center(d, int(H * 0.685), '随口记', font(21, True), CREAM)
    return img.resize((S, S), Image.LANCZOS)


# ─────────────────────────────────────────────
# 方案 3：对话气泡里的「¥」（语音→入账的语义最完整）
# ─────────────────────────────────────────────
def plan_3():
    img = Image.new('RGB', (W, H), CREAM)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, W, H], radius=int(W * 0.22), fill=BROWN)

    # 对话气泡
    bx0, by0 = int(W * 0.16), int(H * 0.20)
    bx1, by1 = int(W * 0.84), int(H * 0.62)
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=int(W * 0.13), fill=WHITE)

    # 气泡小尾巴（左下）
    tail = [(bx0 + int(W * 0.06), by1 - 2),
            (bx0 + int(W * 0.05), by1 + int(H * 0.10)),
            (bx0 + int(W * 0.24), by1 - 2)]
    d.polygon(tail, fill=WHITE)

    # 气泡内的 ¥ 号
    #
    # 第一版用手绘线条（竖 + 两横 + 两斜），结果三条横线间距不均，
    # 在 144px 下整个符号退化成了「半」字。
    # 小尺寸下**必须用字体渲染**——字体的比例是设计好的，
    # 手绘线条在小画布上会因取整误差而失真。
    f_yen = font(46, True)
    bbox = d.textbbox((0, 0), '¥', font=f_yen)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((W - tw) / 2 - bbox[0], (by0 + by1) / 2 - th / 2 - bbox[1]),
           '¥', font=f_yen, fill=BROWN)

    text_center(d, int(H * 0.685), '随口记', font(21, True), CREAM)
    return img.resize((S, S), Image.LANCZOS)


# ─────────────────────────────────────────────
# 方案 4：一笔账目 + 打勾（结果导向：记好了）
# ─────────────────────────────────────────────
def plan_4():
    img = Image.new('RGB', (W, H), CREAM)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, W, H], radius=int(W * 0.22), fill=BROWN)

    # 卡片（账目条）
    cx0, cy0 = int(W * 0.18), int(H * 0.18)
    cx1, cy1 = int(W * 0.82), int(H * 0.64)
    d.rounded_rectangle([cx0, cy0, cx1, cy1], radius=int(W * 0.10), fill=WHITE)

    # 左侧圆点：类目色点（对应 App 里莫兰迪配色）
    d.ellipse([cx0 + int(W * 0.07), cy0 + int(H * 0.09),
               cx0 + int(W * 0.16), cy0 + int(H * 0.18)], fill=(231, 131, 111))

    # 两条文字占位线
    d.rounded_rectangle([cx0 + int(W * 0.21), cy0 + int(H * 0.10),
                         cx0 + int(W * 0.52), cy0 + int(H * 0.135)],
                        radius=int(2 * SS), fill=(200, 194, 188))
    d.rounded_rectangle([cx0 + int(W * 0.07), cy0 + int(H * 0.24),
                         cx1 - int(W * 0.22), cy0 + int(H * 0.27)],
                        radius=int(2 * SS), fill=(220, 215, 210))

    # 右下角绿色对勾徽标 —— 144px 下这是最强的识别信号
    bx, by = int(W * 0.74), int(H * 0.60)
    br = int(W * 0.17)
    d.ellipse([bx - br, by - br, bx + br, by + br], fill=GREEN)
    lw = 6 * SS
    d.line([bx - br * 0.45, by, bx - br * 0.08, by + br * 0.40],
           fill=WHITE, width=lw)
    d.line([bx - br * 0.08, by + br * 0.40, bx + br * 0.48, by - br * 0.38],
           fill=WHITE, width=lw)

    text_center(d, int(H * 0.70), '随口记', font(21, True), CREAM)
    return img.resize((S, S), Image.LANCZOS)


# ─────────────────────────────────────────────
# 方案 5：大字标（分享卡片里最先被看到的就是字）
# ─────────────────────────────────────────────
def plan_5():
    img = Image.new('RGB', (W, H), CREAM)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, W, H], radius=int(W * 0.22), fill=BROWN)

    # 顶部一条绿色短横，作为品牌记忆点
    d.rounded_rectangle([int(W * 0.40), int(H * 0.24), int(W * 0.60), int(H * 0.268)],
                        radius=int(2 * SS), fill=GREEN)

    # 「随口」两字放大，「记」单独一行 —— 144px 下竖排比横排更易读
    f_big = font(38, True)
    f_mid = font(30, True)
    text_center(d, int(H * 0.30), '随口', f_big, CREAM)
    text_center(d, int(H * 0.58), '记', f_mid, CREAM)

    return img.resize((S, S), Image.LANCZOS)


def main():
    plans = [
        ('cover-1-极简文字标.png', plan_1),
        ('cover-2-语音麦克风.png', plan_2),
        ('cover-3-气泡记账.png', plan_3),
        ('cover-4-记账打勾.png', plan_4),
        ('cover-5-大字竖排.png', plan_5),
    ]

    print(f'输出目录：{OUT}\n')
    for name, fn in plans:
        img = fn()
        path = os.path.join(OUT, name)
        img.save(path, 'PNG')
        print(f'  ✓ {name}  {img.size[0]}×{img.size[1]}')

    # 顺带出 512×512 高清版。
    # 144 只够小程序码/分享卡片用，但 mp 后台的头像与 logo 位要求 200×200，
    # 官方规范常建议备一份 ≥512 的源图，向上缩放永远比向下缩放清晰。
    for name, fn in plans:
        base = name.split('-')[0]      # cover-N
        label = name.split('-', 2)[2]  # 中文名
        big = fn().resize((512, 512), Image.LANCZOS)
        big.save(os.path.join(OUT, f'{base}-高清512-{label}'), 'PNG')
    print('\n  ✓ 另存 512×512 高清版 5 张')

    # 拼一张对比图，方便一眼挑选
    gap = 12
    cols, rows = 3, 2
    sheet = Image.new('RGB', (cols * (S + gap) + gap, rows * (S + gap) + gap),
                      (240, 238, 235))
    for i, (name, fn) in enumerate(plans):
        row, col = divmod(i, cols)
        sheet.paste(fn(), (gap + col * (S + gap), gap + row * (S + gap)))
    sheet.save(os.path.join(OUT, '封面方案对比.png'))
    print(f'  ✓ 封面方案对比.png  {sheet.size[0]}×{sheet.size[1]}')


if __name__ == '__main__':
    main()