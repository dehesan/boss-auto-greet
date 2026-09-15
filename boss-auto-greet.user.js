// ==UserScript==
// @name         BOSS直聘 · 定向自动沟通助手
// @namespace    doubao-boss-auto-greet
// @version      1.5.2
// @description  在 BOSS 直聘职位搜索结果页，按关键词/排除词/公司筛选岗位，逐个进入职位详情页点「立即沟通」，在聊天页自动填写并发送自定义招呼语（Enter 发送），然后返回初始筛选列表继续下一个。整页投完再翻页、投过自动去重、配置本地保存。
// @author       doubao
// @match        *://www.zhipin.com/*
// @match        *://*.zhipin.com/*
// @grant        none
// @noframes
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

/*
 * ⚠️ 使用前必读
 * 1. 本脚本仅用于你本人账号在 BOSS 直聘网页版的求职沟通自动化。
 * 2. BOSS 直聘用户协议禁止使用自动化程序；批量/高频自动沟通可能触发平台风控，
 *    导致账号被限制（无法再沟通、封禁等），请自行评估风险、控制数量与频率。
 * 3. 请先登录 BOSS 直聘，搜索就业方向进入「搜索结果列表页」，在右下角悬浮面板配置后点【开始】。
 * 4. 平台每日沟通有数量限制（一般 80~100 次），脚本默认每轮上限 30 次、随机间隔 8~15 秒，可自行下调。
 *
 * v1.5.2 新增地区过滤：自动读取页面所选城市（如珠海），只与该地区职位沟通，自动跳过其他城市；
 *    面板可手动指定允许地区（留空=跟随页面城市）。同时修正列表卡片地区(.company-location)与公司名(.boss-name)选择器。
 * v1.5.1 修复：记录原始筛选页时补全 query（职位方向），发送完带时间戳整页跳回并刷新出新职位
 *  - 聊天输入框：<div contenteditable="true" id="chat-input" class="chat-input">，位于主文档
 *    .chat-conversation .message-controls .chat-im.chat-editor .editor-container 内（不在 iframe）。
 *  - 发送按钮：<button class="btn-v2 btn-sure-v2 btn-send">发送</button>，空内容时额外带 disabled
 *    样式类（原生 disabled 属性始终为 false），输入内容后 Vue 异步移除该类；Enter 键可直接发送。
 *  - 彻底移除会导致「列表↔详情反复横跳/页面一直刷新」的全局 history 覆写与 800ms 路由轮询，
 *    改为「页面加载时一次性阶段分发 + 单飞锁 + 连续失败熔断」，详情页点沟通后在同一流程内等待跳聊天页。
 */

/* jshint esversion: 11 */
(function () {
  'use strict';

  // 只在顶层窗口运行（聊天输入框在主文档，避免 iframe 内重复注入面板/重复执行）
  if (typeof window === 'undefined') return;
  try { if (window.top !== window.self) return; } catch (e) { return; }
  if (window.__bgp_started) return;
  window.__bgp_started = true;

  /* ================= ① 默认配置（页面悬浮面板可临时覆盖，此处为兜底默认值） ================= */
  const CONFIG = {
    keywords: ['java'],              // 职位名称需包含以下任一关键词（不区分大小写）
    excludeKeywords: ['外包', '驻场', '外派', '资深', '高级', '实习', '应届'], // 职位名称含任一即跳过
    excludeCompanies: [],            // 公司名含任一即跳过（如 ['中软国际','德科']）
    areas: [],                       // 限定地区：只与这些地区的岗位沟通；空数组=自动读取页面所选城市
    message: '您好！我看到贵司在招 {jobName}，我对这个岗位非常感兴趣，有相关的项目经验，希望有机会和您进一步沟通。', // 支持 {jobName} {company} {salary} 占位符
    minDelaySec: 8,                  // 每两个岗位之间的最小间隔（秒，最低 1）
    maxDelaySec: 15,                 // 每两个岗位之间的最大间隔（秒）
    maxPerRun: 30,                   // 本轮最多沟通的岗位数
    maxPages: 3,                     // 最多自动翻几页搜索结果（1 = 只处理当前页）
    salaryRange: null,               // 可选薪资过滤，如 [10, 20] 表示只沟通 10K~20K；null 表示不限
    activeTexts: [],                 // 可选活跃度过滤；空 = 不限
    autoStart: false,                // 建议保持 false，手动点「开始」
    maxErrorStreak: 3                // 连续失败多少次后自动熔断停止（防止坏链接导致反复横跳）
  };

  /* ================= ② 选择器（2026-09 真机核对；页面改版时优先改这里） ================= */
  const SEL = {
    card: ['.job-card-wrapper', '.job-card-box', '.job-list-box li', 'li[class*="job-card"]'],
    title: ['.job-name', '[class*="job-name"]', '.job-title', '.job-card-title'],
    company: ['.boss-name', '[class*="boss-name"]', '.company-name', '[class*="company-name"]'],
    salary: ['.salary', '[class*="salary"]'],
    area: ['.company-location', '[class*="company-location"]', '.job-area', '[class*="job-area"]'],
    liveness: ['.boss-info .name', '[class*="boss-info"] .name', '.info-public', '[class*="liveness"]'],
    detailLink: ['a[href*="/job_detail/"]', 'a[href*="job_detail"]'],
    chatBtnSel: ['.op-btn-chat', '.op-btn.op-btn-chat', '[class*="start-chat"]', '[class*="btn-chat"]', '.btn-startchat'],
    chatBtnText: ['立即沟通', '开始沟通', '继续沟通'],
    // —— 聊天页输入框（真机：div#chat-input.chat-input[contenteditable]）——
    chatInputIds: ['chat-input'],
    chatInputs: [
      '#chat-input', '.chat-conversation #chat-input', '.message-controls #chat-input',
      '.chat-editor #chat-input', '.chat-input',
      '.chat-conversation [contenteditable="true"]', '.message-controls [contenteditable="true"]',
      '.chat-editor [contenteditable="true"]', '[contenteditable="true"]'
    ],
    // —— 聊天页发送按钮（真机：button.btn-send，空内容带 disabled 样式类）——
    sendBtn: ['.chat-conversation .btn-send', '.message-controls .btn-send', '.chat-editor .btn-send',
              'button.btn-send', '.btn-send', 'button[type="send"]'],
    btnAll: 'button, a, [class*="btn"], [role="button"]'
  };

  /* ================= ③ 工具函数 ================= */
  const LS_STATE = 'boss_auto_greet_state_v1';
  const LS_DONE = 'boss_auto_greet_done_v1';
  const LS_PANEL = 'boss_auto_greet_panel_v1';

  function $(sel, root) { try { return (root || document).querySelector(sel); } catch (e) { return null; } }
  function $$(sel, root) { try { return Array.from((root || document).querySelectorAll(sel)); } catch (e) { return []; } }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function rand(min, max) {
    min = Number(min) || 0; max = Number(max) || 0;
    if (max < min) max = min;
    return min + Math.random() * (max - min);
  }
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function lsGet(key, fb) { try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } }
  function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { } }

  function extractJobId(url) {
    var m = String(url || '').match(/job_detail\/([^./?#]+)/i);
    return m ? m[1] : null;
  }

  async function waitFor(fn, timeoutMs, interval) {
    timeoutMs = timeoutMs || 10000; interval = interval || 300;
    var t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { var v = fn(); if (v) return v; } catch (e) { }
      await sleep(interval);
    }
    return null;
  }

  // 真实可见性：尺寸>1、非 display:none；兼容 position:fixed（其 offsetParent 为 null 但可见）
  function isVisible(el) {
    if (!el) return false;
    var r;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (!r || r.width < 2 || r.height < 2) return false;
    var cs;
    try { cs = getComputedStyle(el); } catch (e) { return true; }
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || +cs.opacity === 0) return false;
    if (el.offsetParent === null && cs.position !== 'fixed') return false;
    return true;
  }

  // 在候选选择器里找第一个真实可见元素
  async function waitForAny(selectors, timeoutMs) {
    return waitFor(function () {
      for (var si = 0; si < selectors.length; si++) {
        var el = $(selectors[si]);
        if (isVisible(el)) return el;
      }
      return null;
    }, timeoutMs, 250);
  }

  // 判断元素是否属于本助手自己的悬浮面板（绝不能把面板输入框当成聊天框）
  function isOwnPanelEl(el) {
    var n = el;
    for (var i = 0; i < 6 && n; i++) {
      if (n.id === 'boss-auto-greet-panel' || (n.id && String(n.id).indexOf('bgp-') === 0)) return true;
      n = n.parentElement;
    }
    return false;
  }

  // 按可见文本查找元素：取文本最短的匹配元素（最可能是真正的按钮/链接，而非其容器）
  function findByText(texts, selector, root, contains) {
    texts = Array.isArray(texts) ? texts : [texts];
    var best = null, bestLen = Infinity;
    var els = $$(selector, root);
    for (var fi = 0; fi < els.length; fi++) {
      var el = els[fi];
      if (!isVisible(el)) continue;
      var t = norm(el.innerText);
      if (!t || t.length > 40) continue;
      for (var tj = 0; tj < texts.length; tj++) {
        var target = norm(texts[tj]);
        if (contains ? (t.indexOf(target) !== -1) : (t === target)) {
          if (t.length < bestLen) { best = el; bestLen = t.length; }
          break;
        }
      }
    }
    return best;
  }

  function pageHasText(texts, maxLen) {
    var t = (document.body && document.body.innerText || '').slice(0, maxLen || 40000);
    return texts.some(function (x) { return t.indexOf(x) !== -1; });
  }

  function pageKind() {
    var p = location.pathname;
    if (/login/.test(p)) return '登录页';
    if (p.indexOf('/web/geek/job') === 0) return '搜索结果页';
    if (p.indexOf('/job_detail') !== -1) return '职位详情页';
    if (p.indexOf('/chat') !== -1) return '聊天页';
    if (p === '/' || p === '/web/geek/') return '首页';
    return '其他页面';
  }
  function isListPage() { return location.pathname.indexOf('/web/geek/job') === 0; }
  function isChatPage() { return location.pathname.indexOf('/chat') !== -1; }
  function isDetailPage() { return location.pathname.indexOf('/job_detail') !== -1; }

  // 读取页面顶部职位搜索框里的真实关键词（用户可能通过分类/求职期望进入，URL 里没有 query）
  function readSearchKeyword() {
    try {
      var els = document.querySelectorAll('input.input, input[placeholder*="搜索职位"], input[placeholder*="搜索公司"]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (isOwnPanelEl(el)) continue;
        var v = norm(el.value);
        if (v && isVisible(el)) return v;
      }
    } catch (e) { }
    return '';
  }

  // 读取页面顶部当前所选城市（真机：.cur-city-label / .city-label.active，文本如「珠海」）
  function readSelectedCity() {
    var sels = ['.cur-city-label', '.city-label.active', '.city-label', '[class*="current-city"]', '[class*="cur-city"]'];
    for (var i = 0; i < sels.length; i++) {
      var el = $(sels[i]);
      if (!el) continue;
      var t = norm(el.innerText || el.textContent);
      // 去掉定位图标残留、下拉箭头、末尾「市」、空白
      t = t.replace(/[▾▼∨▲▴\s]/g, '').replace(/市$/, '');
      // 只保留城市名主体（形如「珠海」「中山」，避免取到整行筛选条）
      if (t && t.length <= 8 && !/工作区域|职位类型|求职类型|薪资|工作经验|公司/.test(t)) return t;
    }
    return '';
  }

  // 规范化「原始筛选页」URL：确保带 query（职位方向），删除一次性签名/分页参数，保证整页跳回能恢复同样的筛选而不是落到推荐页
  function buildOriginUrl(fallbackKw) {
    try {
      var u = new URL(location.href, location.origin);
      if (!u.searchParams.get('query')) {
        var kw = readSearchKeyword() || fallbackKw || '';
        if (kw) u.searchParams.set('query', kw);
      }
      ['page', '_security_check', 'seed', 'securityId', 'encryptUserId', 'lid', 'safeguard', 'traceid', 'requestId', '_r'].forEach(function (k) { u.searchParams.delete(k); });
      return u.href;
    } catch (e) { return location.href; }
  }

  // 给回退 URL 加时间戳参数，强制整页重新加载、刷新出新职位（BOSS 会忽略未知参数）
  function withRefreshStamp(url) {
    try {
      var u = new URL(url, location.origin);
      u.searchParams.set('_r', String(Date.now()));
      return u.href;
    } catch (e) { return url; }
  }

  /* ================= ④ 状态管理 ================= */
  function defaultState() {
    return {
      running: false, paused: false, queue: [], page: 1,
      returnUrl: '', originUrl: '', greetedThisRun: 0, stopReason: '',
      currentJobId: null, phase: '', errorStreak: 0, allowAreas: []
    };
  }
  function getState() { return Object.assign(defaultState(), lsGet(LS_STATE, {})); }
  function saveState(s) { lsSet(LS_STATE, s); }
  function isDone(id) { return !!id && lsGet(LS_DONE, []).indexOf(id) !== -1; }
  function markDone(id) {
    if (!id) return;
    var arr = lsGet(LS_DONE, []);
    if (arr.indexOf(id) === -1) { arr.push(id); lsSet(LS_DONE, arr); }
  }
  function findQueueEntry(s, id) {
    if (!s || !s.queue || !id) return null;
    for (var qi = 0; qi < s.queue.length; qi++) if (s.queue[qi].id === id) return s.queue[qi];
    return null;
  }
  function queueHasId(s, id) {
    if (!s || !s.queue) return false;
    for (var hi = 0; hi < s.queue.length; hi++) if (s.queue[hi].id === id) return true;
    return false;
  }

  function effectiveCfg() {
    var pc = lsGet(LS_PANEL, {});
    var c = Object.assign({}, CONFIG);
    if (pc.keywords && pc.keywords.length) c.keywords = pc.keywords;
    if (pc.excludeKeywords) c.excludeKeywords = pc.excludeKeywords;
    if (pc.excludeCompanies) c.excludeCompanies = pc.excludeCompanies;
    if (pc.areas) c.areas = pc.areas;
    if (pc.message) c.message = pc.message;
    if (pc.maxPerRun) c.maxPerRun = Number(pc.maxPerRun);
    if (pc.minDelaySec != null) c.minDelaySec = Number(pc.minDelaySec);
    if (pc.maxDelaySec != null) c.maxDelaySec = Number(pc.maxDelaySec);
    c.minDelaySec = Math.max(1, c.minDelaySec || 1);
    c.maxDelaySec = Math.max(c.minDelaySec, c.maxDelaySec || c.minDelaySec);
    return c;
  }

  /* ================= ⑤ 悬浮面板 ================= */
  var $panel = null, $log = null, $status = null;
  function setPanelStatus(text) { if ($status) $status.textContent = text; }

  var MAX_LOG_LINES = 20;
  function log(msg) {
    var line = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    try { console.log('[BOSS助手]', msg); } catch (e) { }
    if ($log) {
      var div = document.createElement('div');
      div.textContent = line;
      $log.appendChild(div);
      while ($log.children.length > MAX_LOG_LINES) $log.removeChild($log.firstChild);
      $log.scrollTop = $log.scrollHeight;
    }
  }

  function divVal(id) { var el = document.getElementById(id); return el ? el.value : ''; }

  function buildPanel() {
    if (document.getElementById('boss-auto-greet-panel')) return;
    var div = document.createElement('div');
    div.id = 'boss-auto-greet-panel';
    div.style.cssText = 'position:fixed;right:12px;bottom:12px;width:320px;max-height:82vh;display:flex;flex-direction:column;background:#ffffff;border:1px solid #e3e6ea;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.15);z-index:2147483647;font:12px/1.6 "Microsoft YaHei",system-ui,sans-serif;color:#1f2329;overflow:hidden;';
    div.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#00bebd;color:#fff;font-weight:600;font-size:13px;">' +
      '<span>BOSS 自动沟通助手</span><span id="bgp-close" style="cursor:pointer;font-size:16px;line-height:1;">×</span></div>' +
      '<div style="padding:8px 12px;display:flex;flex-direction:column;gap:6px;overflow-y:auto;">' +
      '<div id="bgp-status" style="background:#f5f7fa;border-radius:6px;padding:6px 8px;color:#555;">就绪</div>' +
      '<label style="display:flex;flex-direction:column;gap:2px;">关键词（逗号分隔，职位名含其一；中英文逗号均可）' +
      '<input id="bgp-kw" style="border:1px solid #dcdfe6;border-radius:6px;padding:4px 6px;" placeholder="java,后端"/></label>' +
      '<label style="display:flex;flex-direction:column;gap:2px;">屏蔽关键词（职位名含任一即跳过，逗号分隔）' +
      '<input id="bgp-exk" style="border:1px solid #dcdfe6;border-radius:6px;padding:4px 6px;" placeholder="外包,驻场,外派"/></label>' +
      '<label style="display:flex;flex-direction:column;gap:2px;">屏蔽公司（公司名含任一即跳过，逗号分隔）' +
      '<input id="bgp-exc" style="border:1px solid #dcdfe6;border-radius:6px;padding:4px 6px;" placeholder="中软国际,德科"/></label>' +
      '<label style="display:flex;flex-direction:column;gap:2px;">限定地区（只投这些城市，逗号分隔；留空=自动只投页面所选城市）' +
      '<input id="bgp-area" style="border:1px solid #dcdfe6;border-radius:6px;padding:4px 6px;" placeholder="留空自动读取，如 珠海 或 珠海,中山"/></label>' +
      '<label style="display:flex;flex-direction:column;gap:2px;">招呼语（支持 {jobName} {company} {salary}）' +
      '<textarea id="bgp-msg" rows="3" style="border:1px solid #dcdfe6;border-radius:6px;padding:4px 6px;resize:vertical;"></textarea></label>' +
      '<label style="display:flex;align-items:center;gap:6px;">本轮上限' +
      '<input id="bgp-max" type="number" min="1" style="width:64px;border:1px solid #dcdfe6;border-radius:6px;padding:3px 6px;"/>' +
      '<span>间隔</span><input id="bgp-min" type="number" min="1" style="width:48px;border:1px solid #dcdfe6;border-radius:6px;padding:3px 6px;"/>' +
      '~<input id="bgp-maxd" type="number" min="1" style="width:48px;border:1px solid #dcdfe6;border-radius:6px;padding:3px 6px;"/>秒</label>' +
      '<div style="display:flex;gap:6px;">' +
      '<button id="bgp-start" style="flex:1;background:#00bebd;color:#fff;border:none;border-radius:6px;padding:6px 0;cursor:pointer;font-weight:600;">开始</button>' +
      '<button id="bgp-pause" style="flex:1;background:#ff9d00;color:#fff;border:none;border-radius:6px;padding:6px 0;cursor:pointer;">暂停</button>' +
      '<button id="bgp-stop" style="flex:1;background:#f2564b;color:#fff;border:none;border-radius:6px;padding:6px 0;cursor:pointer;">停止</button></div>' +
      '<div style="font-size:11px;color:#999;">流程：列表筛选→进详情→点立即沟通→聊天页自动填写并回车发送→返回初始列表</div>' +
      '<div id="bgp-log" style="background:#0b0e14;color:#7ce7d8;border-radius:6px;padding:6px 8px;height:220px;overflow-y:auto;font-size:11px;line-height:1.7;"></div>' +
      '</div>';
    document.body.appendChild(div);
    $panel = div; $log = div.querySelector('#bgp-log'); $status = div.querySelector('#bgp-status');

    var pc = lsGet(LS_PANEL, {});
    div.querySelector('#bgp-kw').value = (pc.keywords && pc.keywords.length ? pc.keywords : CONFIG.keywords).join(',');
    div.querySelector('#bgp-exk').value = (pc.excludeKeywords && pc.excludeKeywords.length ? pc.excludeKeywords : CONFIG.excludeKeywords).join(',');
    div.querySelector('#bgp-exc').value = (pc.excludeCompanies && pc.excludeCompanies.length ? pc.excludeCompanies : CONFIG.excludeCompanies).join(',');
    div.querySelector('#bgp-area').value = (pc.areas && pc.areas.length ? pc.areas : CONFIG.areas).join(',');
    div.querySelector('#bgp-msg').value = pc.message || CONFIG.message;
    div.querySelector('#bgp-max').value = pc.maxPerRun || CONFIG.maxPerRun;
    div.querySelector('#bgp-min').value = (pc.minDelaySec != null ? pc.minDelaySec : CONFIG.minDelaySec);
    div.querySelector('#bgp-maxd').value = (pc.maxDelaySec != null ? pc.maxDelaySec : CONFIG.maxDelaySec);

    // 输入即保存：关闭面板/浏览器后下次仍保留上次配置
    function savePanelInputs() {
      if (!document.getElementById('bgp-kw') || !document.getElementById('bgp-msg') || !document.getElementById('bgp-max') || !document.getElementById('bgp-exk')) return;
      var data = {
        keywords: (divVal('bgp-kw') || '').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean),
        excludeKeywords: (divVal('bgp-exk') || '').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean),
        excludeCompanies: (divVal('bgp-exc') || '').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean),
        areas: (divVal('bgp-area') || '').split(/[,，]/).map(function (s) { return s.trim().replace(/市$/, ''); }).filter(Boolean),
        message: (divVal('bgp-msg') || '').trim(),
        maxPerRun: Number(divVal('bgp-max')) || null,
        minDelaySec: Number(divVal('bgp-min')) || null,
        maxDelaySec: Number(divVal('bgp-maxd')) || null
      };
      lsSet(LS_PANEL, data);
    }
    ['bgp-kw', 'bgp-exk', 'bgp-exc', 'bgp-area', 'bgp-msg', 'bgp-max', 'bgp-min', 'bgp-maxd'].forEach(function (id) {
      var el = div.querySelector('#' + id);
      if (el && el.addEventListener) {
        el.addEventListener('input', savePanelInputs);
        el.addEventListener('change', savePanelInputs);
      }
    });
    savePanelInputs();

    div.querySelector('#bgp-close').onclick = function () {
      div.style.display = 'none';
      if (document.getElementById('bgp-reopen')) return;
      var dot = document.createElement('div');
      dot.id = 'bgp-reopen';
      dot.textContent = '助';
      dot.style.cssText = 'position:fixed;right:12px;bottom:12px;width:30px;height:30px;border-radius:50%;background:#00bebd;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2147483647;font:13px sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);';
      dot.title = '重新打开 BOSS 自动沟通面板';
      dot.onclick = function () { div.style.display = 'flex'; dot.remove(); };
      document.body.appendChild(dot);
    };
    div.querySelector('#bgp-start').onclick = onStart;
    div.querySelector('#bgp-pause').onclick = onPause;
    div.querySelector('#bgp-stop').onclick = onStop;

    var s = getState();
    var kind = pageKind();
    if (s.running) setPanelStatus(s.paused ? '已暂停' : '运行中…');
    else if (kind === '搜索结果页') setPanelStatus('就绪 · 已识别搜索结果页，点【开始】运行');
    else if (kind === '职位详情页' || kind === '聊天页') setPanelStatus('就绪 · 当前在详情/聊天页，请回到搜索结果页点【开始】');
    else if (kind === '登录页') setPanelStatus('⚠ 未登录：请先登录 BOSS 直聘');
    else setPanelStatus('就绪 · 请登录后搜索岗位，进入搜索结果页');
    log('脚本已加载 v1.5.2 · 当前：' + kind + ' · ' + location.pathname);
  }

  function buildBanner() {
    if (document.getElementById('bgp-banner')) return;
    var s = getState();
    if (s.running) return;
    var kw = (lsGet(LS_PANEL, {}).keywords || CONFIG.keywords || []).join(',');
    var bar = document.createElement('div');
    bar.id = 'bgp-banner';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483646;background:#00bebd;color:#fff;padding:8px 44px 8px 16px;font:13px/1.6 "Microsoft YaHei",system-ui,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.15);';
    bar.innerHTML = 'BOSS 自动沟通助手已就绪 · 关键词：' + kw + ' · 点右下角面板【开始】自动沟通（已发送岗位自动去重）' +
      '<span id="bgp-banner-x" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);cursor:pointer;font-size:16px;line-height:1;">×</span>';
    document.body.appendChild(bar);
    bar.querySelector('#bgp-banner-x').onclick = function () { bar.remove(); };
    setTimeout(function () { if (bar.parentNode) bar.remove(); }, 10000);
  }

  /* ================= ⑥ 开始 / 暂停 / 停止 ================= */
  function onStart() {
    if (!isListPage()) { log('请先到「职位搜索」结果页（搜索关键词后的列表页）再点开始'); return; }
    var kw = (divVal('bgp-kw') || '').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    var msg = (divVal('bgp-msg') || '').trim();
    if (!kw.length) { log('请先填写至少一个关键词'); return; }
    if (!msg) { log('请先填写招呼语'); return; }
    var maxPerRun = Math.max(1, parseInt(divVal('bgp-max'), 10) || CONFIG.maxPerRun);
    var minDelaySec = Math.max(1, parseInt(divVal('bgp-min'), 10) || CONFIG.minDelaySec);
    var maxDelaySec = Math.max(minDelaySec, parseInt(divVal('bgp-maxd'), 10) || CONFIG.maxDelaySec);
    var exk = (divVal('bgp-exk') || '').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    var exc = (divVal('bgp-exc') || '').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    var areaInput = (divVal('bgp-area') || '').split(/[,，]/).map(function (s) { return s.trim().replace(/市$/, ''); }).filter(Boolean);
    // 生效地区：面板手动填了用面板；留空则自动读取页面顶部所选城市，只投该城市岗位
    var allowAreas = areaInput.slice();
    if (!allowAreas.length) { var city = readSelectedCity(); if (city) allowAreas = [city]; }
    lsSet(LS_PANEL, { keywords: kw, excludeKeywords: exk, excludeCompanies: exc, areas: areaInput, message: msg, maxPerRun: maxPerRun, minDelaySec: minDelaySec, maxDelaySec: maxDelaySec });
    var s = defaultState();
    s.running = true; s.phase = 'list'; s.page = 1;
    s.allowAreas = allowAreas;
    // 记录初始筛选页（含地点/类别/查询参数），发送完成后回到这里而不是默认推荐页
    s.originUrl = buildOriginUrl(kw[0]);
    s.returnUrl = s.originUrl;
    saveState(s);
    log('已记录原始筛选页：' + s.originUrl);
    log(allowAreas.length ? '限定地区：[' + allowAreas.join(',') + ']，其他城市岗位自动跳过' : '未读取到所选城市，本次不限定地区（可在面板手动填写）');
    log('▶ 开始：关键词 [' + kw.join(',') + '] 本轮上限 ' + maxPerRun + '，间隔 ' + minDelaySec + '-' + maxDelaySec + 's');
    setPanelStatus('运行中…');
    runListLoop();
  }

  function onPause() {
    var s = getState();
    if (!s.running) { log('当前未在运行'); return; }
    s.paused = !s.paused;
    saveState(s);
    setPanelStatus(s.paused ? '已暂停' : '运行中…');
    log(s.paused ? '⏸ 已暂停（当前岗位完成后生效）' : '▶ 已继续');
    if (!s.paused && isListPage()) runListLoop();
  }

  function onStop() {
    var s = getState();
    s.running = false; s.paused = false; s.phase = ''; s.stopReason = '手动停止';
    saveState(s);
    setPanelStatus('已停止');
    log('⏹ 已停止（已发送的岗位不会重复发送）');
  }

  function stopRun(reason) {
    var s = getState();
    s.running = false; s.paused = false; s.phase = ''; s.stopReason = reason;
    saveState(s);
    setPanelStatus(reason);
    log('⏹ ' + reason);
  }

  /* ================= ⑦ 列表页：扫描筛选 + 调度 ================= */
  function collectCards() {
    for (var ci = 0; ci < SEL.card.length; ci++) {
      var els = $$(SEL.card[ci]);
      if (els.length) return els;
    }
    return [];
  }
  function firstText(sels, root) {
    for (var ti = 0; ti < sels.length; ti++) {
      var el = $(sels[ti], root);
      if (el) { var t = norm(el.innerText); if (t) return t; }
    }
    return '';
  }
  function parseCard(card) {
    var p = { title: firstText(SEL.title, card), company: firstText(SEL.company, card), salary: firstText(SEL.salary, card), area: firstText(SEL.area, card), liveness: firstText(SEL.liveness, card), href: '', id: null };
    for (var li = 0; li < SEL.detailLink.length; li++) {
      var a = $(SEL.detailLink[li], card);
      if (a && a.href) { try { p.href = new URL(a.href, location.origin).href; } catch (e) { p.href = a.href; } break; }
    }
    p.id = extractJobId(p.href);
    return p;
  }
  function parseSalary(t) {
    var m = String(t || '').match(/(\d+(?:\.\d+)?)\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*[Kk千]/);
    if (m) return { min: +m[1], max: +m[2] };
    var m2 = String(t || '').match(/(\d+(?:\.\d+)?)\s*[Kk千]以上/);
    if (m2) return { min: +m2[1], max: 999 };
    return null;
  }
  // 地区匹配：卡片地区文本（如「珠海·香洲区·前山」）或职位标题（如「xx（广州）」）含任一允许城市即通过
  function areaMatch(p, areas) {
    if (!areas || !areas.length) return true; // 未限定地区时不拦截
    var area = String(p.area || '').toLowerCase();
    var title = String(p.title || '').toLowerCase();
    return areas.some(function (a) {
      a = String(a || '').trim().toLowerCase();
      if (!a) return true;
      return area.indexOf(a) !== -1 || title.indexOf(a) !== -1;
    });
  }
  function matchJob(card, cfg) {
    var p = parseCard(card);
    if (!p.id || !p.href) return null;
    if (p.href.indexOf('zhipin.com') === -1) return null;
    var t = p.title.toLowerCase();
    var cardText = norm(card.innerText);
    if (/已沟通|继续沟通|职位已下线|职位已经下线/.test(cardText)) return null;
    if (!cfg.keywords.some(function (k) { return t.indexOf(String(k).toLowerCase()) !== -1; })) return null;
    if (cfg.excludeKeywords.some(function (k) { return t.indexOf(String(k).toLowerCase()) !== -1; })) return null;
    if (cfg.excludeCompanies.some(function (c) { return p.company.toLowerCase().indexOf(String(c).toLowerCase()) !== -1; })) return null;
    if (!areaMatch(p, cfg.areas)) return null;
    if (cfg.salaryRange) {
      var r = parseSalary(p.salary);
      if (!r || !(r.max >= cfg.salaryRange[0] && r.min <= cfg.salaryRange[1])) return null;
    }
    if (cfg.activeTexts.length && !cfg.activeTexts.some(function (a) { return (p.liveness + p.area).indexOf(a) !== -1; })) return null;
    if (isDone(p.id)) return null;
    return p;
  }
  function setPageParam(url, page) {
    try { var u = new URL(url, location.href); u.searchParams.set('page', page); return u.href; } catch (e) { return url; }
  }

  // 单飞锁：同一页面内任一阶段流程在跑，其它触发直接忽略（根除重复/并发跳转）
  var _busy = false;

  async function runListLoop() {
    if (_busy) return;
    var cfg = effectiveCfg();
    var state = getState();
    cfg.areas = state.allowAreas || []; // 本次运行的限定地区（开始时按面板/页面城市确定）
    if (!state.running || state.paused) return;
    if (state.phase === 'detail' || state.phase === 'chat' || state.phase === 'awaiting-chat') return; // 正在处理某个岗位，列表不抢调度
    _busy = true;
    try {
      var ready = await waitFor(function () {
        return $('.job-list-box') || collectCards().length > 0;
      }, 15000);
      if (!ready) {
        var s0 = getState();
        s0.errorStreak = (s0.errorStreak || 0) + 1;
        saveState(s0);
        if (s0.errorStreak >= (cfg.maxErrorStreak || 3)) { stopRun('连续多次未找到职位列表，已自动停止（请确认在搜索结果页）'); return; }
        log('暂未找到职位列表（第 ' + s0.errorStreak + ' 次），2 秒后重试…');
        await sleep(2000);
        _busy = false; runListLoop(); return;
      }

      // 1) 队列快照优先：本页匹配岗位先逐个投完，投完一个返回列表再取第二个，不丢、不重复
      var pending = null, i;
      state = getState();
      for (i = 0; i < state.queue.length; i++) if (!state.queue[i].done) { pending = state.queue[i]; break; }

      // 2) 队列清空才扫描当前页并入队（整页匹配项一次性快照，避免投一个就刷新漏掉其余）
      if (!pending) {
        var cards = collectCards(), added = 0, skippedArea = 0;
        for (var mi = 0; mi < cards.length; mi++) {
          var pre = parseCard(cards[mi]);
          var p = matchJob(cards[mi], cfg);
          if (!p) {
            if (pre && pre.id && pre.area && cfg.areas.length && !areaMatch(pre, cfg.areas)) skippedArea++;
            continue;
          }
          if (queueHasId(state, p.id)) continue;
          p.done = false; state.queue.push(p); added++;
        }
        state.errorStreak = 0;
        saveState(state);
        log('本页扫描 ' + cards.length + ' 条，新匹配 ' + added + ' 条，队列待处理 ' + state.queue.filter(function (e) { return !e.done; }).length + ' 条');
        if (skippedArea) log('已跳过 ' + skippedArea + ' 个非[' + cfg.areas.join('/') + ']地区的岗位');
        for (i = 0; i < state.queue.length; i++) if (!state.queue[i].done) { pending = state.queue[i]; break; }
      }

      if (pending) {
        if (state.greetedThisRun >= cfg.maxPerRun) { stopRun('已达本轮上限 ' + cfg.maxPerRun + ' 个岗位'); return; }
        var remain = state.queue.filter(function (e) { return !e.done; }).length;
        state.returnUrl = state.originUrl || location.href;
        state.phase = 'detail'; state.currentJobId = pending.id;
        saveState(state);
        var secs = Math.max(1, Math.round(rand(cfg.minDelaySec, cfg.maxDelaySec)));
        for (var cd = secs; cd > 0; cd--) {
          setPanelStatus('⏳ ' + cd + 's 后进入：' + pending.title);
          await sleep(1000);
          var sc = getState();
          if (!sc.running || sc.paused) { log('已暂停/停止，调度结束'); return; }
        }
        log('→ 进入岗位' + (remain > 1 ? '（队列剩余 ' + remain + ' 个待投）' : '') + '：' + pending.title + ' | ' + pending.company + ' | ' + pending.salary);
        location.href = pending.href;   // 整页进入详情页
        return;
      }

      // 3) 本页无更多匹配 → 自动翻页
      state = getState();
      if (state.page < cfg.maxPages) {
        state.page += 1;
        saveState(state);
        log('本页匹配项已投完，翻到第 ' + state.page + ' 页…');
        setPanelStatus('翻页到第 ' + state.page + ' 页…');
        await sleep(1500);
        var sf = getState();
        if (sf.running && !sf.paused) location.href = setPageParam((sf.originUrl || location.href), sf.page);
        return;
      }
      stopRun('本轮完成：已沟通 ' + state.greetedThisRun + ' 个岗位，没有更多匹配项（可翻页或换关键词后再点开始）');
    } finally {
      _busy = false;
    }
  }

  /* ================= ⑧ 详情页 / 聊天页：沟通 + 发送 ================= */
  function buildMessage(entry) {
    var jobName = '', company = '', salary = '';
    if (entry) { jobName = entry.title; company = entry.company; salary = entry.salary; }
    if (!jobName) { var t = $('.job-detail-box .name, .job-detail-box h1, .job-title .name, [class*="job-detail"] h1'); if (t) jobName = norm(t.innerText); }
    if (!company) { var c = $('.job-detail-box .company-name, [class*="company-name"]'); if (c) company = norm(c.innerText); }
    if (!salary) { var s = $('.job-detail-box .salary, [class*="salary"]'); if (s) salary = norm(s.innerText); }
    return effectiveCfg().message
      .replace(/\{jobName\}/g, jobName)
      .replace(/\{company\}/g, company)
      .replace(/\{salary\}/g, salary);
  }

  function findChatBtn() {
    for (var bi = 0; bi < SEL.chatBtnSel.length; bi++) {
      var el = $(SEL.chatBtnSel[bi]);
      if (isVisible(el)) {
        var t = norm(el.innerText);
        if (t && /立即沟通|开始沟通|继续沟通/.test(t)) return el;
      }
    }
    return findByText(['立即沟通', '开始沟通'], SEL.btnAll, document, false) ||
           findByText(['立即沟通'], 'div,span,a,button', document, true);
  }

  function finishEntry(entry, id, status) {
    if (id) markDone(id);
    var s = getState();
    var eid = id || (entry && entry.id);
    if (eid) {
      var target = findQueueEntry(s, eid);
      if (target) target.done = true;
    }
    if (status === 'greeted') { s.greetedThisRun += 1; s.errorStreak = 0; }
    saveState(s);
    log((entry ? entry.title : '岗位') + ' → ' + (status === 'greeted' ? '✅ 已发送招呼语' : '跳过（' + status + '）') + '（本轮已沟通 ' + s.greetedThisRun + '）');
  }

  // 记录一次失败并判断是否熔断；返回是否应继续
  function bumpError(reason) {
    var s = getState();
    s.errorStreak = (s.errorStreak || 0) + 1;
    saveState(s);
    var cfg = effectiveCfg();
    if (s.errorStreak >= (cfg.maxErrorStreak || 3)) {
      stopRun('连续 ' + s.errorStreak + ' 次失败（' + reason + '），已自动熔断停止，避免反复跳转；请检查页面后重新开始');
      return false;
    }
    return true;
  }

  // 发送完成 / 失败后回到「原始筛选列表页」，并加时间戳强制整页刷新出新职位
  function goBack() {
    var s = getState();
    s.phase = 'list';
    saveState(s);
    var url = (s.returnUrl && s.returnUrl.indexOf('zhipin.com') !== -1) ? s.returnUrl : (s.originUrl || '');
    if (url && url !== location.href) {
      log('↩ 返回原始筛选页并刷新职位…');
      location.href = withRefreshStamp(url);
    } else if (!isListPage()) {
      history.back();
    }
  }

  /* ---------- 聊天页：定位输入框（真机 div#chat-input.chat-input[contenteditable]） ---------- */
  function findChatInput() {
    // 1) 精确选择器
    for (var i = 0; i < SEL.chatInputs.length; i++) {
      var el = $(SEL.chatInputs[i]);
      if (isVisible(el) && !isOwnPanelEl(el)) return el;
    }
    // 2) 通用兜底：枚举所有可编辑元素，排除自己面板 / 联系人搜索框 / 隐藏元素，按位置打分
    var cands = $$('textarea,input,[contenteditable="true"],[contenteditable],[role="textbox"]');
    var best = null, bestScore = -Infinity;
    cands.forEach(function (e) {
      if (isOwnPanelEl(e)) return;
      var cls = typeof e.className === 'string' ? e.className : '';
      if (/(boss-search-input)/.test(cls)) return;          // 左侧「搜索联系人」框
      if (e.tagName === 'INPUT' && e.type !== 'text' && e.type !== 'search') return;
      if (!isVisible(e)) return;
      var r = e.getBoundingClientRect();
      var score = 0;
      if (e.isContentEditable) score += 10;
      if (e.id === 'chat-input') score += 50;
      if (/chat-input|chat-editor|message-controls|chat-conversation/.test(cls + ' ' + (e.parentElement && e.parentElement.className || ''))) score += 20;
      score += Math.round(r.width / 100);                    // 越宽越像主输入框
      score += Math.round(r.top / 200);                      // 越靠下越像（聊天输入框在底部）
      if (score > bestScore) { bestScore = score; best = e; }
    });
    return best;
  }

  // 向 contenteditable / textarea 写入文本，确保 Vue 等框架感知（execCommand + InputEvent 双通道）
  async function setChatText(el, text) {
    if (!el) return false;
    try { el.focus(); } catch (e) { }
    await sleep(60);

    var editable = el.isContentEditable || el.tagName === 'DIV' || el.tagName === 'SPAN';
    if (editable) {
      // 选中现有内容后用 execCommand 插入（最接近真实输入，触发 beforeinput/input）
      try {
        var rg = document.createRange();
        rg.selectNodeContents(el);
        var sg = window.getSelection();
        sg.removeAllRanges();
        sg.addRange(rg);
      } catch (e) { }
      var ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
      if (!ok || norm(el.innerText).indexOf(norm(text).slice(0, 8)) === -1) {
        try { el.textContent = text; } catch (e) { }
      }
      // 显式补派发 input（Vue 监听 input 读取 innerText）
      try { el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text })); } catch (e) { }
      try { el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text, composed: true })); } catch (e) {
        try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e2) { }
      }
    } else {
      var proto = null;
      if (el.tagName === 'TEXTAREA') proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
      else proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
      var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, text); else el.value = text;
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { }
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { }
    }

    // 等待框架把内容渲染进去（异步），最多 2 秒
    var ok2 = await waitFor(function () {
      var v = editable ? el.innerText : el.value;
      return norm(v).length > 0;
    }, 2000, 120);
    return !!ok2;
  }

  // 在输入框上派发完整 Enter 键盘序列（真机验证：Enter 直接发送）
  function pressEnter(el) {
    var optsList = [
      { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13, bubbles: true, cancelable: true, composed: true }
    ];
    ['keydown', 'keypress', 'keyup'].forEach(function (type) {
      optsList.forEach(function (o) {
        try {
          var ev;
          try { ev = new KeyboardEvent(type, o); } catch (e) {
            ev = document.createEvent('KeyboardEvent');
            try { ev.initKeyboardEvent(type, true, true, window, 'Enter', 0, false, false, false, false, 13); } catch (e2) { ev = new Event(type, { bubbles: true, cancelable: true }); }
          }
          try { Object.defineProperty(ev, 'keyCode', { get: function () { return 13; } }); } catch (e) { }
          try { Object.defineProperty(ev, 'which', { get: function () { return 13; } }); } catch (e) { }
          el.dispatchEvent(ev);
        } catch (e) { }
      });
    });
  }

  // 发送按钮是否真正可用：原生属性 + class（BOSS 空内容会加 disabled 样式类）
  function sendButtonUsable(b) {
    if (!b || !isVisible(b)) return false;
    if (b.disabled === true) return false;
    if (b.getAttribute && b.getAttribute('disabled') != null) return false;
    if (b.getAttribute && b.getAttribute('aria-disabled') === 'true') return false;
    var cls = typeof b.className === 'string' ? b.className : '';
    // 输入框已有内容时，即便 disabled 类尚未移除也短暂重试；这里只把「明确的原生禁用」当不可用
    if (/(^|\s)is-disabled(\s|$)/.test(cls)) return false;
    return true;
  }
  function findSendBtn() {
    for (var i = 0; i < SEL.sendBtn.length; i++) { var el = $(SEL.sendBtn[i]); if (el) return el; }
    return findByText(['发送', '发 送'], SEL.btnAll, document, false);
  }

  // 聊天页完整发送流程：等输入框→写入→点发送/回车→以输入框被清空为成功判据
  async function sendChatMessage(entry, id) {
    log('聊天页：等待输入框加载…');
    var input = await waitFor(findChatInput, 10000, 250);
    if (!input) {
      log('✗ 聊天页：10 秒内未找到输入框 #chat-input（页面可能改版或对话未打开）');
      finishEntry(entry, id, '找不到输入框');
      if (bumpError('找不到输入框')) goBack();
      return false;
    }
    log('聊天页：找到输入框 [' + input.tagName + '#' + input.id + '.' + (typeof input.className === 'string' ? input.className : '') + ']，填写招呼语…');

    var msg = buildMessage(entry);
    var wrote = await setChatText(input, msg);
    if (!wrote) log('⚠ 招呼语写入后未检测到内容，仍尝试发送…');
    await sleep(300); // 等 Vue 移除发送按钮的 disabled 类

    // 路径一：点击发送按钮（轮询等待其可用，最多 2.5 秒）
    var clicked = false;
    var t0 = Date.now();
    while (Date.now() - t0 < 2500) {
      var btn = findSendBtn();
      if (btn && sendButtonUsable(btn)) {
        try { btn.click(); clicked = true; log('已点击「发送」按钮'); break; } catch (e) { }
      }
      await sleep(150);
    }
    // 路径二：Enter 发送（真机验证有效；无论按钮是否点到都补一次，重复发送会被 BOSS 自身拦截/内容已清空）
    var emptied = await waitFor(function () {
      var v = input.isContentEditable ? input.innerText : input.value;
      return norm(v).length === 0;
    }, 700, 120);
    if (!emptied) {
      try { input.focus(); } catch (e) { }
      pressEnter(input);
      log('已用 Enter 键发送');
    }

    // 成功判据：输入框被清空 = 消息已发出
    var sent = await waitFor(function () {
      var v = input.isContentEditable ? input.innerText : input.value;
      return norm(v).length === 0;
    }, 3000, 150);

    if (sent || clicked || emptied) {
      log('✅ 招呼语已发送（输入框已清空）');
      finishEntry(entry, id, 'greeted');
      await sleep(900);
      goBack();
      return true;
    }
    log('✗ 未能确认发送成功（输入框仍有内容）');
    finishEntry(entry, id, '发送未确认');
    if (bumpError('发送未确认')) goBack();
    return false;
  }

  /* ---------- 详情页：点「立即沟通」，并在同流程内承接跳转到聊天页 ---------- */
  async function runDetailPage() {
    if (_busy) return;
    _busy = true;
    try {
      var state = getState();
      if (!state.running || state.paused) { _busy = false; return; }
      var id = extractJobId(location.href);
      var entry = findQueueEntry(state, id) || (state.currentJobId ? findQueueEntry(state, state.currentJobId) : null);
      if (id && state.currentJobId && id !== state.currentJobId) { state.currentJobId = id; saveState(state); }

      var loaded = await waitFor(function () {
        return $('.op-btn-chat') || findByText(SEL.chatBtnText, SEL.btnAll, document, false) ||
               pageHasText(['职位描述', '岗位职责', '立即沟通'], 20000);
      }, 9000);
      if (!loaded) {
        finishEntry(entry, id, '详情页未加载');
        if (bumpError('详情页未加载')) goBack();
        return;
      }

      if (isDone(id)) { finishEntry(entry, id, '已发送过'); goBack(); return; }
      if (pageHasText(['今日沟通已达上限', '今日沟通次数已达上限', '沟通已达上限'])) { stopRun('今日沟通已达上限，已自动停止，明天再试'); return; }
      if (pageHasText(['安全验证', '请完成验证', '验证码', '操作频繁', '操作过快'])) { stopRun('检测到安全验证/操作频繁，请人工处理后再继续'); return; }
      if (findByText(['继续沟通', '已沟通'], SEL.btnAll, document, false) ||
          pageHasText(['职位已下线', '职位已经下线', '该职位已关闭'])) {
        finishEntry(entry, id, '已沟通或已下线'); goBack(); return;
      }

      var chatBtn = findChatBtn();
      if (!chatBtn) {
        finishEntry(entry, id, '找不到沟通按钮');
        if (bumpError('找不到沟通按钮')) goBack();
        return;
      }
      var st = getState();
      st.currentJobId = id; st.phase = 'awaiting-chat';
      saveState(st);
      try { chatBtn.click(); log('已点击「' + norm(chatBtn.innerText) + '」，等待进入聊天…'); }
      catch (e) { finishEntry(entry, id, '点击沟通按钮失败'); if (bumpError('点击失败')) goBack(); return; }

      // 点击后：可能 SPA 内跳到 /chat，也可能整页跳转（整页跳转则本上下文销毁，由新页面 init 承接）
      var jumped = await waitFor(function () { return isChatPage(); }, 5000, 200);
      if (jumped) {
        // SPA 跳转：本上下文仍在，直接在同一流程里发送
        st = getState(); st.phase = 'chat'; saveState(st);
        await sendChatMessage(entry, id);
        return;
      }
      // 未跳转：可能是「弹窗输入框」形态（当前版本 BOSS 已少见，做兼容）
      var dialogInput = await waitForAny(['.startchat-content [contenteditable="true"]', '.startchat-content textarea', '[class*="startchat"] textarea', '[class*="dialog"] textarea'], 2500);
      if (dialogInput) {
        log('检测到弹窗式输入框，直接填写发送…');
        var wrote = await setChatText(dialogInput, buildMessage(entry));
        await sleep(200);
        var okBtn = findByText(['发送', '确 定', '确定', '完成'], SEL.btnAll, document, false);
        var dSent = false;
        if (okBtn) { try { okBtn.click(); dSent = true; } catch (e) { } }
        if (!dSent) pressEnter(dialogInput);
        await sleep(800);
        finishEntry(entry, id, 'greeted');
        goBack();
        return;
      }
      // 既没跳聊天页也没弹窗：可能整页跳转稍慢，再等一会；否则按失败处理
      var jumped2 = await waitFor(function () { return isChatPage(); }, 3000, 200);
      if (jumped2) { var st2 = getState(); st2.phase = 'chat'; saveState(st2); await sendChatMessage(entry, id); return; }
      finishEntry(entry, id, '点击沟通后未进入聊天页');
      if (bumpError('未进入聊天页')) goBack();
    } finally {
      _busy = false;
    }
  }

  /* ================= ⑨ 入口：页面加载时一次性阶段分发（不做全局路由轮询） ================= */
  function boot() {
    if (location.hostname.indexOf('zhipin.com') === -1) return;
    buildPanel();
    var s = getState();
    var p = location.pathname;

    if (isChatPage()) {
      // 整页跳到聊天页：凭 currentJobId 关联队列并发送
      if (!s.running) { log('聊天页就绪（未在运行，不自动发送）'); return; }
      var id = extractJobId(location.href);
      var entry = findQueueEntry(s, id);
      if (!entry && s.currentJobId) entry = findQueueEntry(s, s.currentJobId);
      if (!entry) { log('聊天页：找不到对应岗位记录，返回列表'); s.phase = 'list'; saveState(s); var u = s.returnUrl; if (u) location.href = u; return; }
      if (isDone(s.currentJobId || id)) { log('该岗位已发送过，直接返回'); goBack(); return; }
      s.phase = 'chat'; saveState(s);
      sendChatMessage(entry, id || s.currentJobId);
    } else if (isDetailPage()) {
      if (!s.running) return;
      runDetailPage();
    } else if (isListPage()) {
      buildBanner();
      if (s.running && !s.paused) runListLoop();
    }
  }

  // 仅监听浏览器前进/后退（popstate）做一次温和恢复；不覆写 pushState/replaceState、不做 setInterval 轮询，从根上避免循环跳转
  window.addEventListener('pageshow', function () {
    var s = getState();
    if (!s.running || s.paused || _busy) return;
    if (isListPage() && s.phase !== 'detail' && s.phase !== 'chat' && s.phase !== 'awaiting-chat') runListLoop();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
