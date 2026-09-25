// ==UserScript==
// @name         LastRO 账号监控直连助手
// @namespace    https://ltsd.ro/
// @version      1.0.0
// @description  让露天商店.Ro「账号监控台」的查询请求由浏览器直接发送给 LastRO 官方服务器，账号密码不再经过本站中转。
// @author       LastROLTSD
// @match        https://ltsd.ro/accounts*
// @match        http://localhost:5173/accounts*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      game.lastro.cn
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ---- 1. 接管账号状态查询：直连 LastRO 官方服务器 ----
  //
  // 原理：油猴的 GM_xmlhttpRequest 由浏览器扩展直接发出请求，不受网页跨域（CORS）限制。
  // 页面原本的请求路径是 POST /api/v1/lastro/account-status（JSON: { userid, user_pass }），
  // 这里在 window.fetch 层拦截该请求，改为直接调用官方接口，并把返回值包装成
  // 与本站服务器完全一致的响应格式（{ state: 'online' | 'offline' | 'auth_failed', data? }），
  // 因此页面其他代码无需任何改动。

  var pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  var originalFetch = pageWindow.fetch.bind(pageWindow);
  var UPSTREAM_URL = 'https://game.lastro.cn/?r=mn/search&nid=5';
  var API_MARKER = '/api/v1/lastro/account-status';

  function queryOfficial(userid, userPass) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'POST',
        url: UPSTREAM_URL,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        data: 'Login_debug%5Buserid%5D=' + encodeURIComponent(userid)
          + '&Login_debug%5Buser_pass%5D=' + encodeURIComponent(userPass),
        timeout: 15000,
        onload: function (res) {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error('LastRO 官方接口暂时不可用，请稍后再试'));
            return;
          }
          var payload;
          try {
            payload = JSON.parse(res.responseText);
          } catch (e) {
            reject(new Error('LastRO 官方接口返回异常，请稍后再试'));
            return;
          }
          // 官方约定：返回数字 1 = 账号或密码错误；数字 2 = 角色不在线；对象 = 在线状态数据
          if (payload === 1) resolve({ state: 'auth_failed' });
          else if (payload === 2) resolve({ state: 'offline' });
          else if (payload && typeof payload === 'object' && !Array.isArray(payload)) resolve({ state: 'online', data: payload });
          else reject(new Error('LastRO 官方接口返回异常，请稍后再试'));
        },
        onerror: function () { reject(new Error('无法连接 LastRO 官方服务器，请稍后再试')); },
        ontimeout: function () { reject(new Error('连接 LastRO 官方服务器超时，请稍后再试')); },
      });
    });
  }

  pageWindow.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (url.indexOf(API_MARKER) !== -1 && init && typeof init.body === 'string') {
      var body = null;
      try { body = JSON.parse(init.body); } catch (e) { /* 交给原始 fetch 处理 */ }
      if (body && typeof body.userid === 'string' && typeof body.user_pass === 'string') {
        return queryOfficial(body.userid, body.user_pass).then(function (json) {
          return new pageWindow.Response(JSON.stringify(json), {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          });
        });
      }
    }
    return originalFetch(input, init);
  };

  // ---- 2. 改写页面上的隐私说明为「直连模式已生效」 ----

  function patchPrivacyNotice() {
    var body = document.querySelector('.accounts-privacy-body');
    if (!body) return false;
    body.innerHTML =
      '<h2 id="accounts-privacy-title">直连脚本已生效：账号密码不经过本站</h2>'
      + '<ul>'
      + '<li><strong>当前是直连模式。</strong>你已安装直连脚本：每次查询时，账号密码由你的浏览器直接发送给 LastRO 官方服务器，不会经过露天商店.Ro 转发。</li>'
      + '<li><strong>账号信息仍只保存在你自己的浏览器里。</strong>所有账号数据存放在这台设备的浏览器存储中；换设备或清除浏览器数据后需要重新添加。</li>'
      + '<li><strong>网站与脚本代码完全公开。</strong>本站和本脚本的全部源代码都在 GitHub 上开放，欢迎随时查看或监督。</li>'
      + '</ul>'
      + '<a class="accounts-github" href="https://github.com/parkerjj/LastROLTSD" target="_blank" rel="noreferrer">在 GitHub 查看源代码</a>';
    return true;
  }

  // 页面是脚本渲染的，隐私说明区块在 DOMContentLoaded 之后才出现，这里轮询等待。
  function waitAndPatch() {
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (patchPrivacyNotice() || tries > 100) clearInterval(timer);
    }, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitAndPatch);
  } else {
    waitAndPatch();
  }
})();
