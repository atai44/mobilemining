# Generates synthetic test pages (horizontal and vertical Japanese) for the e2e test.
import sys
from PIL import Image, ImageDraw, ImageFont
font = sys.argv[1] if len(sys.argv) > 1 else '/usr/share/fonts/truetype/ipafont-gothic/ipag.ttf'
out = sys.argv[2] if len(sys.argv) > 2 else '.'
f = ImageFont.truetype(font, 36)
lines = ['吾輩は猫である。名前はまだ無い。', 'どこで生れたかとんと見当がつかぬ。', '昨日は本を読まなかった。']
im = Image.new('RGB', (760, 210), 'white'); d = ImageDraw.Draw(im)
for i, l in enumerate(lines): d.text((20, 20 + i * 60), l, font=f, fill='black')
im.save(f'{out}/horizontal.png')
im = Image.new('RGB', (260, 760), 'white'); d = ImageDraw.Draw(im)
for i, l in enumerate(lines):
    x = 260 - 64 - i * 74
    for j, ch in enumerate(l):
        d.text((x, 15 + j * 40), ch, font=f, fill='black')
im.save(f'{out}/vertical.png')
# A slightly rotated photo-like version
im = Image.open(f'{out}/horizontal.png').rotate(4, expand=True, fillcolor='white', resample=Image.BICUBIC)
im.save(f'{out}/rotated.png')
