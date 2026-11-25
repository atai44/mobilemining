// Renders realistic vertical (縦書き) fixtures with Chromium: node render-vertical.cjs <outdir>
const { join } = require('path');
let pw; try { pw = require('playwright'); } catch { pw = require(join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); }
const pages = {
  'vertical.png': ['吾輩は猫である。名前はまだ無い。', 'どこで生れたかとんと見当がつかぬ。', '昨日は本を読まなかった。'],
  'vertical2.png': ['「ちょっと待って」と、彼女は言った。', 'コーヒーを飲みながら、鬱蒼とした森を眺める。', '薔薇の棘に気を付けてください。'],
};
// Pages with furigana (ruby), like children's books and light novels
const R = (b, r) => `<ruby>${b}<rt>${r}</rt></ruby>`;
const rubyLines = [
  `${R('昨日', 'きのう')}は${R('図書館', 'としょかん')}で${R('本', 'ほん')}を${R('読', 'よ')}んだ。`,
  `${R('薔薇', 'ばら')}の${R('花', 'はな')}が${R('咲', 'さ')}いている。`,
  `${R('明日', 'あした')}も${R('学校', 'がっこう')}に${R('行', 'い')}きます。`,
];
const rubyPages = {
  'ruby-vertical.png': { mode: 'vertical-rl', w: 330, h: 760 },
  'ruby-horizontal.png': { mode: 'horizontal-tb', w: 760, h: 300 },
};
(async () => {
  const b = await pw.chromium.launch();
  for (const [name, lines] of Object.entries(pages)) {
    const p = await b.newPage({ viewport: { width: 80 + lines.length * 66, height: 840 } });
    await p.setContent(`<html><body style="margin:0;background:#fff"><div style="writing-mode:vertical-rl;font:34px 'IPAGothic';line-height:1.9;padding:20px;height:800px;color:#111">${lines.join('<br>')}</div></body></html>`);
    await p.screenshot({ path: join(process.argv[2], name) });
  }
  for (const [name, o] of Object.entries(rubyPages)) {
    const p = await b.newPage({ viewport: { width: o.w, height: o.h } });
    await p.setContent(`<html><body style="margin:0;background:#fff"><div style="writing-mode:${o.mode};font:34px 'IPAGothic';line-height:2.3;padding:24px;color:#111">${rubyLines.join('<br>')}</div><style>rt{font-size:15px}</style></body></html>`);
    await p.screenshot({ path: join(process.argv[2], name) });
  }
  await b.close();
})();
