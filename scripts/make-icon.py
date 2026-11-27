#!/usr/bin/env python3
"""Draws the app icon (pixel art: a white monkey in a miner's helmet) and writes every size.

    python3 scripts/make-icon.py
"""
import os
from PIL import Image

BG = (51, 102, 153)      # the app's blue
FUR, SHADE = (247, 244, 236), (212, 206, 192)
MASK, EAR, EAR2 = (96, 58, 36), (70, 42, 28), (120, 78, 54)
BLACK, WHITE = (20, 16, 14), (255, 255, 255)
HAT, HAT_EDGE, BRIM = (242, 194, 48), (196, 146, 22), (150, 110, 15)
LAMP_RIM, LAMP = (110, 110, 110), (255, 250, 220)
HAND_EDGE = (150, 140, 124)
WOOD, WOOD2, IRON, IRON2 = (150, 98, 56), (112, 70, 38), (196, 202, 210), (120, 126, 134)


N, TOP = 28, 2
OUTLINE = (16, 24, 36)
SOFT_EDGE = (104, 108, 116)
METAL = ((255, 255, 255), (200, 206, 214), (92, 98, 108))   # highlight, mid, shadow


def base(style=1):
    """A 32×32 monkey in profile: white fur, brown face mask, a miner's helmet, pickaxe over the shoulder."""
    px = {}

    def row(y, a, b, c):
        for x in range(a, b + 1):
            px[(x, y)] = c

    def dot(x, y, c):
        px[(x, y)] = c

    # (drawn facing right, mirrored at the end)
    # tail: a solid curl, two pixels thick (no diagonal-only joins)
    tail = [(x, y) for x in (2, 3) for y in range(26, 32)] + [(x, y) for y in (25, 26) for x in range(3, 7)] + [(x, y) for x in (5, 6) for y in (27, 28)]
    for (x, y) in tail:
        dot(x, y, FUR)
    for (x, y) in [(2, y) for y in range(26, 32)] + [(6, 28), (5, 28)]:
        dot(x, y, SHADE)
    # body, sitting
    for y, (a, b) in {21: (11, 19), 22: (10, 20), 23: (9, 21), 24: (9, 21), 25: (8, 21), 26: (8, 21), 27: (8, 21), 28: (8, 22), 29: (8, 23), 30: (8, 24), 31: (8, 24)}.items():
        row(y, a, b, FUR); dot(a, y, SHADE)
    for (x, y) in [(22, 30), (23, 30), (24, 30), (22, 31), (23, 31), (24, 31)]:
        dot(x, y, SHADE)
    # head
    for y, (a, b) in {9: (11, 20), 10: (10, 21), 11: (9, 22), 12: (9, 22), 13: (9, 23), 14: (9, 23), 15: (9, 23), 16: (9, 24), 17: (9, 24), 18: (10, 23), 19: (10, 22), 20: (11, 20)}.items():
        row(y, a, b, FUR)
    for (x, y) in [(11, 20), (12, 20), (10, 19)]:
        dot(x, y, SHADE)
    # pickaxe head: a crescent across the end of the handle (in front of the head)
    # the top of the handle: under the metal, with its end poking out on the far side of the head
    for i in range(-2, 5):
        dot(5 + i, 15 + i, WOOD); dot(5 + i, 16 + i, WOOD2)
    # a quarter-round head, the same on both sides of the handle: one half is drawn (the arm
    # pointing down) and mirrored across the handle's line for the arm pointing along the top
    half = [(2, 23), (2, 22), (2, 21), (2, 20), (2, 19), (3, 18), (3, 17), (4, 16), (5, 15)]
    iron = set()
    for (x, y) in half:
        for (xx, yy, c) in [(x, y, METAL[0]), (x + 1, y, METAL[1]), (x + 1, y + 1, METAL[2])]:
            for (ax, ay) in ((xx, yy), (yy - 10, xx + 10)):
                dot(ax, ay, c); iron.add((ax, ay))
    # body, sitting
    for y, (a, b) in {21: (11, 19), 22: (10, 20), 23: (9, 21), 24: (9, 21), 25: (8, 21), 26: (8, 21), 27: (8, 21), 28: (8, 22), 29: (8, 23), 30: (8, 24), 31: (8, 24)}.items():
        row(y, a, b, FUR); dot(a, y, SHADE)
    for (x, y) in [(22, 30), (23, 30), (24, 30), (22, 31), (23, 31), (24, 31)]:
        dot(x, y, SHADE)
    # head
    for y, (a, b) in {9: (11, 20), 10: (10, 21), 11: (9, 22), 12: (9, 22), 13: (9, 23), 14: (9, 23), 15: (9, 23), 16: (9, 24), 17: (9, 24), 18: (10, 23), 19: (10, 22), 20: (11, 20)}.items():
        row(y, a, b, FUR)
    for (x, y) in [(11, 20), (12, 20), (10, 19)]:
        dot(x, y, SHADE)
    # pickaxe head: a crescent across the end of the handle (in front of the head)
    # the top of the handle: under the metal, with its end poking out on the far side of the head
    for i in range(-2, 5):
        dot(5 + i, 13 + i, WOOD); dot(5 + i, 14 + i, WOOD2)
    # a quarter-round head: one tip points along the top, the other straight down
    arc = [(2, 21), (2, 20), (2, 19), (2, 18), (2, 17), (3, 16), (3, 15), (4, 14), (5, 13), (6, 12), (7, 12), (8, 12), (9, 12), (10, 12), (11, 12)]
    if style >= 2:   # a longer, heavier head
        arc = [(0, 22), (0, 21), (0, 20)] + arc + [(10, 9), (11, 9)]
    iron = set()
    for (x, y) in arc:
        # three tones across the blade: highlight on the outer edge, mid, shadow on the inner edge
        for (xx, yy, c) in [(x, y, METAL[0]), (x + 1, y, METAL[1]), (x + 1, y + 1, METAL[2])] + ([(x + 2, y + 1, METAL[2]), (x, y - 1, METAL[0])] if style >= 2 else []):
            dot(xx, yy, c); iron.add((xx, yy))
    if style == 0:
        dot(1, 20, METAL[2]); dot(10, 10, METAL[2])
    # the handle, over the shoulder, through the hand and a little beyond
    for i in range(0, 13):
        dot(10 + i, 20 + i, WOOD); dot(10 + i, 21 + i, WOOD2)
    # ear
    for y in (14, 15, 16, 17):
        row(y, 11, 13, EAR)
    dot(12, 15, EAR2); dot(12, 16, EAR2); dot(11, 14, FUR); dot(11, 17, FUR)
    # face mask, snout forward; a white eye around a black pupil; nose
    for y, (a, b) in {12: (18, 22), 13: (17, 23), 14: (17, 23), 15: (17, 24), 16: (18, 25), 17: (19, 25), 18: (20, 24)}.items():
        row(y, a, b, MASK)
    for y in (13, 14, 15):
        row(y, 19, 21, WHITE)
    dot(21, 14, BLACK)
    dot(25, 16, BLACK)
    # helmet, fitting the head, level, with the lamp at the front
    dome = {3: (12, 19), 4: (10, 21), 5: (9, 22), 6: (8, 23), 7: (8, 23), 8: (8, 23), 9: (8, 23)}
    for y, (a, b) in dome.items():
        row(y, a, b, HAT); dot(a, y, HAT_EDGE); dot(b, y, HAT_EDGE)
    row(3, 12, 19, HAT_EDGE)
    row(10, 7, 27, BRIM)
    for y in (5, 6, 7, 8):
        row(y, 21, 25, LAMP_RIM)
    for y in (6, 7):
        row(y, 23, 25, LAMP)

    if style >= 1:   # a dark edge around the pick head
        for (x, y) in list(iron):
            for (xx, yy) in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                # all the way round, also where it crosses the fur (but not over the helmet or handle)
                # dark against the background; only a soft grey line where it crosses the fur
                if (xx, yy) in iron or px.get((xx, yy)) in (HAT, HAT_EDGE, BRIM, WOOD, WOOD2, LAMP, LAMP_RIM, OUTLINE):
                    continue
                px[(xx, yy)] = OUTLINE if (xx, yy) not in px else SOFT_EDGE
    # Framed tightly from the chest up, facing left: N×N pixels of the 32-wide drawing.
    im = Image.new('RGB', (N, N), BG)
    for (x, y), c in px.items():
        xx, yy = N - 1 - x, y - TOP
        if 0 <= xx < N and 0 <= yy < N:
            im.putpixel((xx, yy), c)
    return im


root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
import sys
icon = base(int(sys.argv[1]) if len(sys.argv) > 1 else 1)
def up(size):
    """The icon at `size` px: whole-number pixel scaling, centred on the background colour."""
    k = max(1, size // icon.width)
    out = Image.new('RGB', (size, size), BG)
    out.paste(icon.resize((icon.width * k, icon.width * k), Image.NEAREST), ((size - icon.width * k) // 2,) * 2)
    return out

bg = BG

# Web
for size in (192, 512):
    up(size).save(os.path.join(root, 'public/icons', f'icon-{size}.png'))
n = icon.width
rects = ''.join(f'<rect x="{x}" y="{y}" width="1" height="1" fill="#%02x%02x%02x"/>' % icon.getpixel((x, y)) for y in range(n) for x in range(n) if icon.getpixel((x, y)) != bg)
open(os.path.join(root, 'public/icons/icon.svg'), 'w').write(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n} {n}" shape-rendering="crispEdges"><rect width="{n}" height="{n}" fill="#%02x%02x%02x"/>{rects}</svg>\n' % bg)

# Android: legacy icons, round icons, and the adaptive foreground (art in the middle 2/3)
res = os.path.join(root, 'android/app/src/main/res')
for d, s in {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}.items():
    up(s).save(f'{res}/mipmap-{d}/ic_launcher.png')
    up(s).save(f'{res}/mipmap-{d}/ic_launcher_round.png')
    f = s * 108 // 48
    inner = (f * 2 // 3) // n * n or n
    fg = Image.new('RGB', (f, f), bg)
    fg.paste(icon.resize((inner, inner), Image.NEAREST), ((f - inner) // 2, (f - inner) // 2))
    fg.save(f'{res}/mipmap-{d}/ic_launcher_foreground.png')
open(f'{res}/values/ic_launcher_background.xml', 'w').write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#%02X%02X%02X</color>\n</resources>\n' % bg)
import glob
for p in glob.glob(f'{res}/drawable*/splash.png'):
    w, h = Image.open(p).size
    im = Image.new('RGB', (w, h), bg)
    s = (min(w, h) // 3) // n * n
    im.paste(icon.resize((s, s), Image.NEAREST), ((w - s) // 2, (h - s) // 2))
    im.save(p)
print('icon written')
