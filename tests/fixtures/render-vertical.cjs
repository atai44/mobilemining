// Renders realistic vertical (縦書き) fixtures with Chromium: node render-vertical.cjs <outdir>
const { join } = require('path');
let pw; try { pw = require('playwright'); } catch { pw = require(join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); }
const pages = {
  'vertical.png': ['吾輩は猫である。名前はまだ無い。', 'どこで生れたかとんと見当がつかぬ。', '昨日は本を読まなかった。'],
  'vertical2.png': ['「ちょっと待って」と、彼女は言った。', 'コーヒーを飲みながら、鬱蒼とした森を眺める。', '薔薇の棘に気を付けてください。'],
};
(async () => {
  const b = await pw.chromium.launch();
  for (const [name, lines] of Object.entries(pages)) {
    const p = await b.newPage({ viewport: { width: 80 + lines.length * 66, height: 840 } });
    await p.setContent(`<html><body style="margin:0;background:#fff"><div style="writing-mode:vertical-rl;font:34px 'IPAGothic';line-height:1.9;padding:20px;height:800px;color:#111">${lines.join('<br>')}</div></body></html>`);
    await p.screenshot({ path: join(process.argv[2], name) });
  }
  await b.close();
})();
