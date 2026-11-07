"""
可用性验证 —— 把 144×144 缩到真实显示尺寸看是否还认得出

为什么要这一步：144×144 的图在微信里通常以 100~120px 显示，
而且用户扫「小程序码」时可能更小。如果在真实尺寸下糊成一团，
设计得再精致也没意义。这一步把大图缩小后并排放，一眼看出哪些方案
真的扛得住。
"""

from PIL import Image
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets')

# 微信里的实际显示场景
SIZES = [(120, '小程序码中心'), (100, '分享卡片'), (64, '搜索结果列表')]

FILES = [
    'cover-1-极简文字标.png',
    'cover-2-语音麦克风.png',
    'cover-3-气泡记账.png',
    'cover-4-记账打勾.png',
    'cover-5-大字竖排.png',
]


def main():
    # 按真实尺寸缩小（用 LANCZOS，等价于微信的缩放方式）
    small = {}
    for size, _ in SIZES:
        for f in FILES:
            img = Image.open(os.path.join(OUT, f))
            small[(f, size)] = img.resize((size, size), Image.LANCZOS)

    max_size = max(s for s, _ in SIZES)
    gap = 10
    label_w = 0

    rows = len(FILES)
    cols = len(SIZES)
    W = cols * (max_size + gap) + gap
    H = rows * (max_size + gap) + gap

    sheet = Image.new('RGB', (W, H), (235, 233, 230))
    for r, f in enumerate(FILES):
        for c, (size, _) in enumerate(SIZES):
            x = gap + c * (max_size + gap)
            y = gap + r * (max_size + gap)
            sheet.paste(small[(f, size)], (x, y))

    path = os.path.join(OUT, '实际尺寸验证.png')
    sheet.save(path)
    print(f'✓ 实际尺寸验证.png  {sheet.size[0]}×{sheet.size[1]}')
    print('  列从左到右：' + ' | '.join(f'{s}px（{name}）' for s, name in SIZES))
    print('  行从上到下：方案 1 → 5')


if __name__ == '__main__':
    main()