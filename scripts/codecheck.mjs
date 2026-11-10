// Live-Code-Check für SportSupp
// Prüft jeden Code im echten Shopify-Checkout der Shops und schreibt codecheck.json.
// Ablauf je Shop: Produkt in den Warenkorb, Kasse ohne Code (Basispreis), Kasse mit
// erfundenem Code (Kontrolle), dann jeder echte Code einzeln. Es wird nie bestellt.

import { chromium } from 'playwright';
import fs from 'node:fs';

const SHOPS = {
  more:         { name: 'More Nutrition',  origin: 'https://morenutrition.de',          handle: 'chunky-flavour',                      qty: 5, codes: ['DROPTIME','SUPPLIGATOR','MORE10','MORE','IQ10','MOREBLACK'] },
  peak:         { name: 'Peak',            origin: 'https://www.peak.ag',               handle: 'creatin-monohydrat',                  qty: 3, codes: ['GOLDEN','DROPTIME','PEAK10','GOLDENDAYS'] },
  bodylab:      { name: 'Bodylab24',       origin: 'https://www.bodylab24.de',          handle: 'bodylab24-creatine-powder-500g',      qty: 6, codes: ['DROPTIME','SINGLEMAX','BLACK44','BLACK50','CYBER44','CYBER30ALL'] },
  ironbrothers: { name: 'Iron Brothers',   origin: 'https://www.ironbrothers-shop.com', handle: 'creatine-monohydrate-double-pack-1',  qty: 3, codes: ['DROPTIME','IRON10','IRON','IRON20','BLACK20','BLACK30'] },
  esn:          { name: 'ESN',             origin: 'https://www.esn.com',               handle: 'esn-ultrapure-creatine-monohydrate',  qty: 3, codes: ['DROPTIME','ESN','ESN10'] },
  naturecan:    { name: 'Naturecan',       origin: 'https://www.naturecan.de',          handle: 'kreatin',                             qty: 1, codes: ['WELCOME10','NATURECAN10','NC20'] },
  gannikus:     { name: 'Gannikus',        origin: 'https://www.gannikus-shop.com',     handle: 'verum-whey-isolate',                  qty: 2, codes: ['SHOP','DROPTIME','GANNIKUS10'] },
  rocka:        { name: 'Rocka Nutrition', origin: 'https://www.rockanutrition.de',     handle: 'flavor-powder',                       qty: 3, codes: ['DROPTIME','ROCKA10','ROCKA','ADVENT15'] },
};
// Codes, die in vielen Shops ausprobiert werden (Black Week, Portale, Willkommen)
const GENERIC = ['SUPPLIGATOR','DROPTIME','BLACKWEEK','BLACKFRIDAY','BLACK','CYBER','CYBERMONDAY','WELCOME10','WILLKOMMEN10'];
const CONTROL = 'XQFAKE' + Math.floor(Math.random() * 900000 + 100000);
const MAX_CODES = 18;

const only = (process.env.SHOPS || '').split(',').map(s => s.trim()).filter(Boolean);
const num = s => s == null ? null : parseFloat(String(s).replace(/\s/g, '').replace(/\./g, '').replace(',', '.'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Gesamtbetrag aus dem Checkout-Text lesen (deutsch/englisch, jede Währung)
function parseTotal(text) {
  const t = text.replace(/\u00a0/g, ' ');
  const re = /(?:Gesamt|Total)\s*\n\s*([A-Z]{3})\s*\n\s*[^\d\n]{0,3}\s*([\d.,]+)/g;
  let m, last = null;
  while ((m = re.exec(t))) last = { cur: m[1], val: num(m[2]) };
  return last;
}
const BLOCKED = /Verbindung muss verifiziert werden|verify your connection|Verifying your connection/i;

// Zeile mit dem Code-Rabatt (z. B. "DROPTIME 30% (-21,00 €)" oder "Bestellungsrabatt DROPTIME − 6,00 €")
function parseLine(text, code) {
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toUpperCase().includes(code) && /%|−|-\s?\d/.test(lines[i])) return lines[i].slice(0, 80);
    if (lines[i].toUpperCase() === code && lines[i + 1] && /^[−-]\s?[\d.,]+/.test(lines[i + 1])) return `${code} ${lines[i + 1]}`;
  }
  return '';
}

// Codes aus Bannern der Startseite ziehen ("Code: GOLDEN", "mit CODE SHOP")
function bannerCodes(text) {
  const out = new Set();
  const re = /(?:code|gutschein(?:code)?|rabattcode)\s*[:„"']?\s*([A-Z][A-Z0-9]{2,19})\b/gi;
  let m;
  while ((m = re.exec(text))) {
    const c = m[1].toUpperCase();
    if (/[A-Z]/.test(c) && !/^(KOPIEREN|COPY|ANWENDEN|EINGEBEN|EINLÖSEN|SICHERN|NUR|FÜR|AUF|IM|BEI|DES|DER|DIE|DAS)$/.test(c) && c === m[1]) out.add(c);
  }
  return [...out];
}

async function checkShop(browser, key, cfg) {
  const res = { key, name: cfg.name, origin: cfg.origin, product: null, baseline: null, control: null, codes: [], bannerCodes: [], error: null };
  const ctx = await browser.newContext({
    locale: 'de-DE', timezoneId: 'Europe/Berlin', viewport: { width: 1500, height: 1000 },
    extraHTTPHeaders: { 'Accept-Language': 'de-DE,de;q=0.9' },
  });
  const page = await ctx.newPage();
  try {
    await page.goto(cfg.origin + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(2500);
    // Land auf Deutschland stellen, damit Preise in EUR und mit deutscher Steuer kommen
    await page.evaluate(async () => {
      const fd = new FormData(); fd.append('form_type', 'localization'); fd.append('_method', 'put'); fd.append('country_code', 'DE'); fd.append('return_to', '/');
      try { await fetch('/localization', { method: 'POST', body: fd }); } catch (e) {}
    });
    const home = await page.evaluate(() => document.body.innerText);
    res.bannerCodes = bannerCodes(home);

    const variant = await page.evaluate(async (handle) => {
      const p = await fetch('/products/' + handle + '.js').then(r => r.json());
      const v = p.variants.find(v => v.available && !/probe|sample/i.test(v.title)) || p.variants.find(v => v.available);
      return v ? { id: v.id, title: p.title + (v.title && v.title !== 'Default Title' ? ' – ' + v.title : ''), price: v.price / 100 } : null;
    }, cfg.handle);
    if (!variant) throw new Error('Testprodukt nicht verfügbar');
    res.product = { ...variant, qty: cfg.qty };

    const codes = [...new Set([...cfg.codes, ...res.bannerCodes, ...GENERIC])].slice(0, MAX_CODES);

    const run = async (code) => {
      await page.evaluate(async ({ id, qty }) => {
        await fetch('/cart/clear.js', { method: 'POST' });
        await fetch('/cart/add.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ id, quantity: qty }] }) });
        await fetch('/cart/update.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ discount: '' }) });
      }, { id: variant.id, qty: cfg.qty });
      const co = await ctx.newPage();
      try {
        await co.goto(cfg.origin + '/checkout' + (code ? '?discount=' + encodeURIComponent(code) : ''), { waitUntil: 'domcontentloaded', timeout: 45000 });
        const read = () => co.evaluate(() => document.body ? document.body.innerText : '');
        let text = '', tot = null;
        for (let i = 0; i < 40; i++) {
          await sleep(750);
          text = await read();
          // Schutzseiten der Shops werden nicht umgangen: Shop wird übersprungen
          if (BLOCKED.test(text)) throw new Error('BLOCKED');
          if (/captcha|Bestätige, dass du ein Mensch bist|verify you are human/i.test(text)) throw new Error('BLOCKED');
          tot = parseTotal(text);
          if (tot) break;
        }
        // Rabatte werden oft erst nach dem Laden eingerechnet: bis zu 15 s auf die Code-Zeile warten
        if (code && tot) {
          for (let i = 0; i < 20; i++) {
            await sleep(750);
            text = await read();
            if (parseLine(text, code)) { await sleep(1500); text = await read(); break; }
          }
        } else { await sleep(2000); text = await read(); }
        tot = parseTotal(text) || tot;
        return { total: tot ? tot.val : null, currency: tot ? tot.cur : null, line: code ? parseLine(text, code) : '', url: co.url(), snippet: text.replace(/\s+/g, ' ').slice(0, 1500) };
      } finally { await co.close(); }
    };

    const base = await run('');
    if (process.env.DEBUG) res.debug = { url: base.url, snippet: base.snippet };
    if (base.total == null) throw new Error('Kasse lieferte keinen Gesamtpreis');
    res.baseline = base.total; res.currency = base.currency;
    const ctrl = await run(CONTROL);
    res.control = { total: ctrl.total, clean: ctrl.total != null && Math.abs(ctrl.total - base.total) < 0.01 };

    for (const code of codes) {
      let r;
      try { r = await run(code); } catch (e) { if (e.message === 'BLOCKED') throw e; res.codes.push({ code, error: e.message }); continue; }
      const pct = r.total != null && res.baseline ? Math.round((1 - r.total / res.baseline) * 1000) / 10 : null;
      res.codes.push({ code, total: r.total, pct, works: pct != null && pct > 0.4, line: r.line, fromBanner: res.bannerCodes.includes(code) });
    }
  } catch (e) {
    res.blocked = e.message === 'BLOCKED';
    res.error = res.blocked ? 'Der Shop zeigt automatischen Prüfungen eine Sicherheitsabfrage. Die wird nicht umgangen.' : e.message;
  } finally {
    await ctx.close();
  }
  return res;
}

const started = Date.now();
const browser = await chromium.launch();
const keys = Object.keys(SHOPS).filter(k => !only.length || only.includes(k));
const results = await Promise.all(keys.map(k => checkShop(browser, k, SHOPS[k])));
await browser.close();

const out = {
  checkedAt: new Date().toISOString(),
  durationSec: Math.round((Date.now() - started) / 1000),
  trigger: process.env.TRIGGER || 'manual',
  control: CONTROL,
  shops: Object.fromEntries(results.map(r => [r.key, r])),
};
fs.writeFileSync('codecheck.json', JSON.stringify(out, null, 2));
for (const r of results) {
  const ok = r.codes.filter(c => c.works).map(c => `${c.code} ${c.pct}%`).join(', ');
  console.log(`${r.name}: ${r.error ? 'FEHLER ' + r.error : `Basis ${r.baseline} €, Kontrolle ${r.control?.clean ? 'sauber' : 'AUFFÄLLIG'}, funktionieren: ${ok || 'keine'}`}`);
}
