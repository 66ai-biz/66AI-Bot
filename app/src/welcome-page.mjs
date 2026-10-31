// The pages the window shows before the Host when the account needs attention:
// - the product introduction, the app's home page before any sign-in (the one
//   place that sells the product), whose sign-up button leads to the unified
//   account site (cm.66ai.biz/pay) where accounts are registered and plans bought;
// - the paywall, for a signed-in account without a subscribed 66AI Bot monthly plan
//   plan (the cloud's 66AI Bot 套餐). Both talk through the `aibotAuth` bridge.

const PLAN_URL = 'https://cm.66ai.biz/pay'

const STYLE = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif;
    background: #f4f6fa; color: #14171f;
    display: flex; align-items: center; justify-content: center;
    -webkit-user-select: none; user-select: none;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #131418; color: #eef1f6; }
    .card { background: #1c1e25 !important; border-color: #2a2d37 !important; }
    .feat { background: #232630 !important; border-color: #2f3340 !important; }
    .sub, .feat p, .foot, .planNote { color: #9aa1ad !important; }
  }
  .card {
    width: 560px; max-width: 94vw; max-height: 94vh; overflow: auto;
    padding: 38px 40px 28px;
    background: #ffffff; border: 1px solid #e3e7ee; border-radius: 20px;
    box-shadow: 0 18px 50px rgba(20, 40, 90, .10);
  }
  .brand { display: flex; align-items: center; gap: 14px; }
  .logo {
    width: 52px; height: 52px; border-radius: 14px; flex: none;
    background: linear-gradient(135deg, #2563eb, #4f82f7);
    color: #fff; font-weight: 700; font-size: 23px;
    display: flex; align-items: center; justify-content: center;
  }
  h1 { font-size: 24px; font-weight: 700; letter-spacing: .2px; }
  .sub { margin-top: 4px; font-size: 13px; color: #6b7280; }
  .feats { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 26px 0 6px; }
  .feat {
    background: #f7f8fb; border: 1px solid #e9edf4; border-radius: 14px; padding: 14px 16px;
  }
  .feat b { display: block; font-size: 14px; margin-bottom: 5px; }
  .feat b em { font-style: normal; margin-right: 7px; }
  .feat p { font-size: 12px; color: #6b7280; line-height: 1.55; }
  .plan {
    margin: 18px 0 4px; padding: 13px 16px; border-radius: 14px;
    background: linear-gradient(135deg, rgba(37, 99, 235, .10), rgba(79, 130, 247, .14));
    border: 1px solid rgba(37, 99, 235, .28);
    font-size: 13px; line-height: 1.6;
  }
  .plan b { color: #2563eb; }
  .planNote { margin-top: 3px; font-size: 11.5px; color: #6b7280; }
  .row { display: flex; gap: 12px; margin-top: 20px; }
  .go {
    flex: 1; height: 44px; border: 0; border-radius: 11px; cursor: pointer;
    background: #2563eb; color: #fff; font-size: 15px; font-weight: 600;
  }
  .go:hover { background: #1d54d4; }
  .go:disabled { opacity: .55; cursor: default; }
  .alt {
    flex: 1; height: 44px; border-radius: 11px; cursor: pointer;
    background: none; border: 1.5px solid #2563eb; color: #2563eb;
    font-size: 14.5px; font-weight: 600;
  }
  .alt:hover { background: rgba(37, 99, 235, .08); }
  .ghost {
    width: 100%; height: 36px; margin-top: 12px; cursor: pointer;
    background: none; border: 1px dashed #9aa8c4; border-radius: 10px;
    color: inherit; font-size: 13px; opacity: .8;
  }
  .msg { min-height: 18px; margin-top: 12px; font-size: 13px; text-align: center; }
  .msg.err { color: #dc2626; }
  .msg.net { color: #b45309; }
  .msg.good { color: #16a34a; }
  .foot { margin-top: 16px; font-size: 11.5px; color: #9aa1ad; text-align: center; line-height: 1.6; }
  [hidden] { display: none !important; }
`

const introPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>66AI Bot · 你的 AI Bot 团队</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card">
  <div class="brand">
    <div class="logo">66</div>
    <div>
      <h1>66AI Bot</h1>
      <p class="sub">一台电脑上的一整支 AI Bot 团队 · 与 cm.66ai.biz 统一账号互通</p>
    </div>
  </div>
  <section class="feats">
    <div class="feat"><b><em>🤖</em>多 Bot 协作</b><p>创建多个专属 Bot，组成群聊互相接力：调研、写作、审校一站式完成。</p></div>
    <div class="feat"><b><em>⚡</em>GLM 5.3 引擎</b><p>内置 GLM 5.3 大模型引擎，开箱即用，也可接入任意 OpenAI 兼容接口。</p></div>
    <div class="feat"><b><em>📂</em>文件与 Office</b><p>直接读写 Office 文档、解析 PDF 与图片，Bot 能自己动手整理文件。</p></div>
    <div class="feat"><b><em>🌐</em>联网与浏览器</b><p>每个 Bot 都能检索网页、操作浏览器，把线上信息带回工作台。</p></div>
  </section>
  <section class="plan">
    <b>⚡ 66AI Bot · 98 元/月起</b>：开通 66AI Bot 包月套餐即可使用（98 元 1 个 Agent · 138 元 3 个 Agent · 198 元 10 个 Agent，第三方接口的 Agent 按套餐计入总数），内置 GLM 5.3 等多模型开箱即用，全平台统一账号一号通行。
    <div class="planNote">已开通？直接登录即可。还没有账号？点「购买套餐 / 开通账号」到统一账号站办理。</div>
  </section>
  <div class="row">
    <button class="go" id="btnLogin" type="button">登 录</button>
    <button class="alt" id="btnRegister" type="button">购买套餐 / 开通账号</button>
  </div>
  <p id="msg" class="msg" hidden></p>
  <p class="foot">登录账号由 cm.66ai.biz 统一管理 · 套餐 98 元/月起，随时可续 · 支持 Windows 与 macOS</p>
</main>
<script>
(function () {
  'use strict'
  var bridge = window.aibotAuth
  var msg = document.getElementById('msg')
  function show(text, kind) {
    msg.hidden = !text
    msg.textContent = text || ''
    msg.className = 'msg' + (kind ? ' ' + kind : '')
  }
  document.getElementById('btnLogin').onclick = function () {
    if (bridge && bridge.showLogin) bridge.showLogin()
    else show('应用初始化异常，请重启 66AI Bot', 'err')
  }
  document.getElementById('btnRegister').onclick = function () {
    if (bridge && bridge.open) bridge.open('${PLAN_URL}')
    else show('应用初始化异常，请重启 66AI Bot', 'err')
  }
})()
</script>
</body>
</html>
`

const paywallPage = (username, untilText) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>66AI Bot · 需要套餐</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card">
  <div class="brand">
    <div class="logo">66</div>
    <div>
      <h1>开通套餐后使用</h1>
      <p class="sub">账号 ${username} 已登录，但还没有 66AI Bot 包月套餐</p>
    </div>
  </div>
  <section class="plan">
    <b>⚡ 66AI Bot 基础版 · 98 元/月（1 个 Agent）</b><br>
    <b>⚡ 66AI Bot 包月 · 138 元/月（AIBot 专用 · 配置 3 个 Agent，含第三方共 5 个）</b><br>
    <b>⚡ 66AI Bot 包月 Pro · 198 元/月（配置 10 个 Agent，第三方 Agent 不限量）</b><br>
    66AI Bot 桌面版：一台电脑上一整支 AI Bot 团队，内置 GLM 5.3 等多模型开箱即用，包月期内无限使用，模型 Key 由云端自动下发无需手动填写；审核通过自动开通，全平台统一账号一号通行。
    <div class="planNote">已开通的套餐：${untilText}。在统一账号站（cm.66ai.biz/pay）完成支付后，回到这里点「我已开通」。</div>
  </section>
  <div class="row">
    <button class="go" id="btnPay" type="button">去订阅 · cm.66ai.biz/pay</button>
    <button class="alt" id="btnCheck" type="button">我已开通，刷新</button>
  </div>
  <p id="msg" class="msg" hidden></p>
  <button id="btnLogout" class="ghost" type="button">退出登录，换一个账号</button>
  <p class="foot">套餐与积分由 cm.66ai.biz 统一管理 · 支付后通常立即生效，若未生效请稍等片刻再刷新</p>
</main>
<script>
(function () {
  'use strict'
  var bridge = window.aibotAuth
  var msg = document.getElementById('msg')
  var busy = false
  function show(text, kind) {
    msg.hidden = !text
    msg.textContent = text || ''
    msg.className = 'msg' + (kind ? ' ' + kind : '')
  }
  document.getElementById('btnPay').onclick = function () {
    if (bridge && bridge.open) bridge.open('${PLAN_URL}')
    else show('应用初始化异常，请重启 66AI Bot', 'err')
  }
  document.getElementById('btnCheck').onclick = function () {
    if (!bridge || !bridge.checkPlan || busy) return
    busy = true
    show('正在向账号服务确认套餐…')
    bridge.checkPlan().then(function (result) {
      busy = false
      if (result && result.ok) return show('套餐已生效，正在进入 66AI Bot…', 'good')
      if (result && result.network) return show('暂时连不上账号服务，请检查网络后再试', 'net')
      show((result && result.error) || '还没有查到有效套餐，完成支付后再试', 'err')
    }).catch(function () { busy = false; show('确认失败，请稍后再试', 'err') })
  }
  document.getElementById('btnLogout').onclick = function () {
    if (!bridge || !bridge.logout || busy) return
    busy = true
    bridge.logout()
  }
  if (!bridge) show('应用初始化异常，请重启 66AI Bot', 'err')
})()
</script>
</body>
</html>
`

const pageUrl = page => `data:text/html;charset=utf-8,${encodeURIComponent(page)}`

/** The product introduction, the app's home page before any sign-in. */
export const INTRO_PAGE_URL = pageUrl(introPage)

/** The paywall for an account without the required plan; names the account and its subscriptions. */
export function paywallPageUrl(account = {}) {
  const username = String(account.username ?? '').replace(/[&<>"]/gu, '')
  const untilText = String(account.untilText ?? '暂无').replace(/[&<>"]/gu, '')
  return pageUrl(paywallPage(username, untilText))
}
