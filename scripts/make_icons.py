"""Generate ProBeing PWA icons.

Run with the project venv:  ./.venv/bin/python scripts/make_icons.py
Outputs into icons/. Re-run any time the mark changes.
"""

from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
BG = (16, 24, 40)        # deep navy
ACCENT = (56, 189, 172)  # teal
FG = (255, 255, 255)
SS = 4                   # supersample factor for smooth edges


def draw_mark(size, *, maskable):
    """Draw the ProBeing mark at `size` px.

    maskable=True keeps the artwork inside the 80% safe zone and lets the
    background bleed to the edges, so Android can crop it to any shape.
    """
    px = size * SS
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if maskable:
        d.rectangle([0, 0, px, px], fill=BG)
        scale = 0.62
    else:
        d.rounded_rectangle([0, 0, px, px], radius=int(px * 0.22), fill=BG)
        scale = 0.78

    # "P" monogram
    font = ImageFont.truetype(FONT, int(px * scale * 0.72))
    l, t, r, b = d.textbbox((0, 0), "P", font=font)
    d.text(((px - (r - l)) / 2 - l, (px - (b - t)) / 2 - t), "P", font=font, fill=FG)

    # teal "being" dot, lower-right of the monogram
    rad = px * scale * 0.10
    cx, cy = px * 0.66, px * 0.66
    d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=ACCENT)

    return img.resize((size, size), Image.LANCZOS)


for size in (192, 512):
    draw_mark(size, maskable=False).save(f"icons/icon-{size}.png")
draw_mark(512, maskable=True).save("icons/icon-maskable-512.png")
draw_mark(180, maskable=False).save("icons/apple-touch-icon.png")
draw_mark(32, maskable=False).save("icons/favicon-32.png")
print("wrote icons/: 192, 512, maskable-512, apple-touch-180, favicon-32")
