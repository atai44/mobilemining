const { join } = require('path');
const pw = (() => { try { return require('playwright'); } catch { return require(join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); } })();
const R = (b, r) => `<ruby>${b}<rt>${r}</rt></ruby>`;
(async () => {
  const b = await pw.chromium.launch(); const p = await b.newPage();
  await p.setContent(`<html><body style="font:20px 'IPAGothic';line-height:2.4;padding:20px">${R('昨日', 'きのう')}は${R('図書館', 'としょかん')}で${R('本', 'ほん')}を${R('読', 'よ')}んだ。<br>${R('薔薇', 'ばら')}の${R('花', 'はな')}が${R('咲', 'さ')}いている。</body></html>`);
  await p.pdf({ path: join(process.argv[2], 'text-ruby.pdf'), width: '420px', height: '200px' });
  await b.close();
})();
