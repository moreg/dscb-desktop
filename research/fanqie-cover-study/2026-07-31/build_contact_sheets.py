from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent
IMAGES = ROOT / "images"
OUTPUT = ROOT / "contact-sheets"
FONT_PATH = Path("C:/Windows/Fonts/msyh.ttc")

CATEGORIES = {
    "female": [
        ("female-ancient-society", "古风世情"),
        ("female-modern-brain", "现言脑洞"),
        ("female-period", "年代"),
        ("female-suspense-brain", "悬疑脑洞"),
        ("female-youth-romance", "青春甜宠"),
        ("female-ceo-romance", "豪门总裁"),
        ("female-scifi", "科幻末世"),
        ("female-fantasy-romance", "玄幻言情"),
        ("female-palace", "宫斗宅斗"),
        ("female-farming", "种田"),
        ("female-workplace", "职场婚恋"),
    ],
    "male": [
        ("male-western-fantasy", "西方奇幻"),
        ("male-xianxia", "东方仙侠"),
        ("male-scifi", "科幻末世"),
        ("male-urban-life", "都市日常"),
        ("male-urban-martial", "都市高武"),
        ("male-history", "历史古代"),
        ("male-traditional-fantasy", "传统玄幻"),
        ("male-fantasy-brain", "玄幻脑洞"),
        ("male-supernatural", "悬疑灵异"),
        ("male-war-spy", "抗战谍战"),
        ("male-game-sports", "游戏体育"),
        ("male-anime-derivative", "动漫衍生"),
    ],
}


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    if FONT_PATH.exists():
        return ImageFont.truetype(str(FONT_PATH), size)
    return ImageFont.load_default()


def build_sheet(channel: str, categories: list[tuple[str, str]]) -> None:
    cover_w, cover_h = 180, 240
    gap, label_w, row_gap = 18, 190, 34
    margin, header_h = 32, 84
    width = margin * 2 + label_w + 6 * cover_w + 5 * gap
    row_h = cover_h + row_gap
    height = header_h + margin + len(categories) * row_h
    canvas = Image.new("RGB", (width, height), "#f2eee6")
    draw = ImageDraw.Draw(canvas)
    title = "番茄小说女频封面样本" if channel == "female" else "番茄小说男频封面样本"
    draw.text((margin, 24), title, fill="#211d19", font=font(34))

    for row, (slug, label) in enumerate(categories):
        y = header_h + row * row_h
        draw.text((margin, y + 84), label, fill="#8d2f20", font=font(25))
        files = sorted(
            p for p in (IMAGES / slug).iterdir() if p.suffix.lower() in {".jpg", ".png", ".webp"}
        )
        for col, path in enumerate(files[:6]):
            with Image.open(path) as source:
                image = source.convert("RGB")
                image.thumbnail((cover_w, cover_h), Image.Resampling.LANCZOS)
                x = margin + label_w + col * (cover_w + gap)
                offset_x = x + (cover_w - image.width) // 2
                offset_y = y + (cover_h - image.height) // 2
                canvas.paste(image, (offset_x, offset_y))
                draw.rectangle((x, y, x + cover_w, y + cover_h), outline="#c9bda9", width=1)

    OUTPUT.mkdir(parents=True, exist_ok=True)
    canvas.save(OUTPUT / f"{channel}-overview.jpg", quality=92, optimize=True)


for group, items in CATEGORIES.items():
    build_sheet(group, items)
