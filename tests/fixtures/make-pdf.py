# Generates PDF fixtures: a vertical-writing CID-font PDF (+ a horizontal page) and an
# image-only "scanned" PDF.   python3 make-pdf.py <outdir>
import sys
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.lib.utils import ImageReader

out = sys.argv[1] if len(sys.argv) > 1 else '.'
pdfmetrics.registerFont(UnicodeCIDFont('HeiseiMin-W3', isVertical=True))
pdfmetrics.registerFont(UnicodeCIDFont('HeiseiKakuGo-W5'))
lines = ['吾輩は猫である。名前はまだ無い。', 'どこで生れたかとんと見当がつかぬ。', '昨日は本を読まなかった。']
c = canvas.Canvas(f'{out}/text-vertical.pdf', pagesize=(300, 420))
c.setFont('HeiseiMin-W3', 18)
for i, l in enumerate(lines):
    c.drawString(250 - i * 32, 395, l)  # vertical font: text runs down from (x, y)
c.showPage()
c.setFont('HeiseiKakuGo-W5', 16)
for i, l in enumerate(lines):
    c.drawString(20, 380 - i * 30, l)
c.showPage()
c.save()

img = ImageReader(f'{out}/horizontal.png')
w, h = img.getSize()
c = canvas.Canvas(f'{out}/scanned.pdf', pagesize=(w * 0.5, h * 0.5))
c.drawImage(img, 0, 0, w * 0.5, h * 0.5)
c.showPage()
c.save()
