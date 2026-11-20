const fs = require('fs');
let h = fs.readFileSync('index.html', 'utf8');
const OLD = 'https://dl.66ai.biz/66ai-bot-0.2.5-win-x64.exe';
const n = h.split(OLD).length - 1;
h = h.split(OLD).join('https://dl.66ai.biz/download');
fs.writeFileSync('index.html', h);
console.log('links replaced:', n);

const html = fs.readFileSync('index.html', 'utf8');
const DL_PROXY = 'https://gh-proxy.com/https://github.com/66ai-biz/66AI-Bot/releases/download/v0.2.17/66ai-bot-0.2.17-win-x64.exe';
const DL_RAW = 'https://github.com/66ai-biz/66AI-Bot/releases/download/v0.2.17/66ai-bot-0.2.17-win-x64.exe';

// Homepage screenshots: base64-embedded JPEGs served at /shots/N.jpg.
const SHOTS = [1, 2, 3].map(i => fs.readFileSync(`shots/shot-${i}.jpg`).toString('base64'));

const w = `// 66AI Bot homepage + download worker - generated
const HTML = ${JSON.stringify(html)};
const DL_PROXY = ${JSON.stringify(DL_PROXY)};
const DL_RAW = ${JSON.stringify(DL_RAW)};
const SHOTS = ${JSON.stringify(SHOTS)};

function redirect(loc) {
  return new Response(null, { status: 302, headers: { Location: loc, 'cache-control': 'no-store' } });
}

export default {
  async fetch(request) {
    const u = new URL(request.url);
    if (u.pathname === '/download') return redirect(DL_PROXY);
    if (u.pathname === '/download-raw') return redirect(DL_RAW);
    const shot = u.pathname.match(/^\\/shots\\/([1-3])\\.jpg$/);
    if (shot) {
      const bytes = Uint8Array.from(atob(SHOTS[Number(shot[1]) - 1]), c => c.charCodeAt(0));
      return new Response(bytes, {
        headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' }
      });
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      return new Response(HTML, {
        headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-cache', 'x-66ai-site': 'aibot-home' }
      });
    }
    return new Response('Not Found', { status: 404 });
  }
};
`;
fs.writeFileSync('worker.js', w);
console.log('worker.js bytes:', w.length);
