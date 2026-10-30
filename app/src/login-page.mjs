// The sign-in page the window shows after the product introduction: sign in with the
// 66AI account (the cloud keeps one user list with the web and the admin console).
// New accounts are created on the unified account site (cm.66ai.biz/pay) — the page
// links there instead of offering its own form. There is no offline escape:
// the account service cannot be reached. The page talks to the main process
// through the `aibotAuth` bridge of the preload.

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>66AI Bot</title>
<style>
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
    input { background: #232630 !important; border-color: #333743 !important; color: #eef1f6 !important; }
    .hint, .sub, .foot { color: #9aa1ad !important; }
  }
  .card {
    width: 380px; max-width: 92vw; padding: 36px 34px 26px;
    background: #ffffff; border: 1px solid #e3e7ee; border-radius: 18px;
    box-shadow: 0 18px 50px rgba(20, 40, 90, .10);
  }
  .brand { display: flex; align-items: center; gap: 12px; }
  .logo {
    width: 44px; height: 44px; border-radius: 12px; flex: none;
    background: linear-gradient(135deg, #2563eb, #4f82f7);
    color: #fff; font-weight: 700; font-size: 20px;
    display: flex; align-items: center; justify-content: center;
  }
  h1 { font-size: 21px; font-weight: 700; letter-spacing: .2px; }
  .sub { margin-top: 3px; font-size: 12.5px; color: #6b7280; }
  .tabs { display: flex; gap: 22px; margin: 24px 0 16px; border-bottom: 1px solid #e7eaf1; }
  @media (prefers-color-scheme: dark) { .tabs { border-bottom-color: #2a2d37; } }
  .tabs button {
    appearance: none; border: 0; background: none; cursor: pointer;
    font-size: 14.5px; padding: 8px 2px 10px; color: inherit; opacity: .55;
    border-bottom: 2px solid transparent; margin-bottom: -1px;
  }
  .tabs button.on { opacity: 1; font-weight: 600; color: #2563eb; border-bottom-color: #2563eb; }
  label { display: block; font-size: 12.5px; color: #6b7280; margin: 13px 0 6px; }
  input {
    width: 100%; height: 40px; padding: 0 12px; font-size: 14px;
    background: #f7f8fb; border: 1px solid #dfe3ec; border-radius: 10px;
    color: inherit; outline: none;
  }
  input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, .15); }
  .go {
    width: 100%; height: 42px; margin-top: 20px; border: 0; border-radius: 10px;
    background: #2563eb; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
  }
  .go:hover { background: #1d54d4; }
  .go:disabled { opacity: .55; cursor: default; }
  .ghost {
    width: 100%; height: 36px; margin-top: 12px; cursor: pointer;
    background: none; border: 1px dashed #9aa8c4; border-radius: 10px;
    color: inherit; font-size: 13px; opacity: .8;
  }
  .msg { min-height: 18px; margin-top: 14px; font-size: 13px; text-align: center; }
  .msg.err { color: #dc2626; }
  .msg.net { color: #b45309; }
  .msg.good { color: #16a34a; }
  .hint { margin-top: 12px; font-size: 12px; color: #6b7280; line-height: 1.6; }
  .foot { margin-top: 18px; font-size: 11.5px; color: #9aa1ad; text-align: center; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main class="card">
  <div class="brand">
    <div class="logo">66</div>
    <div>
      <h1>66AI Bot</h1>
      <p class="sub">登录你的 66AI 账号，与官网通用</p>
    </div>
  </div>
  <form id="formLogin" autocomplete="on">
    <label for="liUser">用户名</label>
    <input id="liUser" maxlength="32" autocomplete="username" spellcheck="false">
    <label for="liPass">密码</label>
    <input id="liPass" type="password" maxlength="64" autocomplete="current-password">
    <button class="go" id="liGo" type="submit">登 录</button>
  </form>
  <p id="msg" class="msg" hidden></p>
  <button id="btnRegister" class="ghost" type="button">没有账号？注册 / 开通套餐（cm.66ai.biz）</button>
  <p class="foot">账号由 cm.66ai.biz 统一管理 · 使用需 98 元/月全能捆绑套餐 · 退出登录在侧栏账号卡片</p>
</main>
<script>
(function () {
  'use strict'
  var bridge = window.aibotAuth
  var $ = function (id) { return document.getElementById(id) }
  var msg = $('msg')
  var busy = false
  function show(text, kind) {
    msg.hidden = !text
    msg.textContent = text || ''
    msg.className = 'msg' + (kind ? ' ' + kind : '')
  }
  function setBusy(on) {
    busy = on
    $('liGo').disabled = on
    if (on) show('正在连接账号服务…')
  }
  $('formLogin').onsubmit = function (event) {
    event.preventDefault()
    if (busy || !bridge) return
    setBusy(true)
    bridge.login($('liUser').value, $('liPass').value).then(function (result) {
      setBusy(false)
      if (result && result.ok) return show('登录成功，正在进入 66AI Bot…', 'good')
      show((result && result.error) || '登录失败，请稍后再试', result && result.network ? 'net' : 'err')
    }).catch(function () { setBusy(false); show('登录失败，请稍后再试', 'err') })
  }
  $('btnRegister').onclick = function () {
    if (busy || !bridge || !bridge.open) return
    bridge.open('https://cm.66ai.biz/pay')
  }
  if (!bridge) show('应用初始化异常，请重启 66AI Bot', 'err')
})()
</script>
</body>
</html>
`

export const LOGIN_PAGE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`
