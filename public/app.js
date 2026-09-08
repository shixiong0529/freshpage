/* FreshPage V0 前端：首页 / 进度 / 结果 三态，无构建步骤。 */
(function () {
  'use strict';

  var MAX_MAIN_FINDINGS = 20;
  var app = document.getElementById('app');
  var pollTimer = null;
  var state = { view: 'home', token: null, payload: null, submitting: false, lastVote: {} };

  var STAGES = [
    { key: 'checking_access', label: '正在确认网站是否可以访问' },
    { key: 'discovering_pages', label: '正在发现网站页面' },
    { key: 'checking_content', label: '正在检查内容和链接' },
    { key: 'finalizing', label: '正在整理结果' }
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function el(html) {
    var div = document.createElement('div');
    div.innerHTML = html.trim();
    return div.firstElementChild;
  }

  function toast(msg) {
    var t = document.querySelector('.toast');
    if (!t) {
      t = el('<div class="toast"></div>');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove('show'); }, 2000);
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { toast('链接已复制'); }, fallback);
    } else {
      fallback();
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('链接已复制'); } catch (e) { toast('复制失败，请手动复制'); }
      document.body.removeChild(ta);
    }
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ------------------------------- 首页 ------------------------------- */
  function renderHome() {
    state.view = 'home';
    app.innerHTML =
      '<form id="scan-form" autocomplete="off" novalidate>' +
      '<section class="hero">' +
      '<h1>你的网站内容还准确吗？</h1>' +
      '<p>输入网址，检查失效链接、过期日期、价格冲突和可能已经过时的内容。</p>' +
      '<div class="searchbox">' +
      '<input id="url-input" type="text" name="url" placeholder="https://example.com" aria-label="网站地址" autofocus />' +
      '</div>' +
      '<div style="margin-top:26px;text-align:center">' +
      '<button class="btn lg" id="submit-btn" type="submit">开始检查</button>' +
      '</div>' +
      '<div class="form-error" id="form-error" role="alert"></div>' +
      '<div class="hero-links">' +
      '<a href="/example">查看示例报告</a>' +
      '<a href="/privacy">隐私与抓取说明</a>' +
      '</div>' +
      '</section>' +
      '</form>' +
      '<div class="how">' +
      '<div class="how-item"><h3>1 · 输入网址</h3><p>不需要注册，也不需要安装任何代码。</p></div>' +
      '<div class="how-item"><h3>2 · 自动检查</h3><p>系统读取并检查最多50个公开页面。</p></div>' +
      '<div class="how-item"><h3>3 · 查看结果</h3><p>每条问题都会给出页面和原文证据。</p></div>' +
      '</div>';

    var form = document.getElementById('scan-form');
    var input = document.getElementById('url-input');
    var btn = document.getElementById('submit-btn');
    var err = document.getElementById('form-error');
    input.focus();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (state.submitting) return;
      var value = input.value.trim();
      if (!value) {
        err.textContent = '请输入网站地址。';
        input.classList.add('invalid');
        return;
      }
      input.classList.remove('invalid');
      err.textContent = '';
      submitScan(value, btn);
    });
  }

  function submitScan(value, btn) {
    state.submitting = true;
    if (btn) { btn.disabled = true; btn.textContent = '正在创建…'; }
    var slowTimer = setTimeout(function () {
      var err = document.getElementById('form-error');
      if (err && state.submitting) err.textContent = '仍在处理中，请稍候…';
    }, 4000);

    fetch('/api/scans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: value })
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (res) {
        clearTimeout(slowTimer);
        state.submitting = false;
        if (res.status >= 400 || !res.body.token) {
          var err = document.getElementById('form-error');
          if (err) err.textContent = res.body.message || '提交失败，请稍后重试。';
          if (btn) { btn.disabled = false; btn.textContent = '开始检查'; }
          return;
        }
        history.pushState({}, '', res.body.resultUrl);
        state.token = res.body.token;
        renderProgress(res.body.token);
      })
      .catch(function () {
        clearTimeout(slowTimer);
        state.submitting = false;
        var err = document.getElementById('form-error');
        if (err) err.textContent = '网络异常，请检查连接后重试。';
        if (btn) { btn.disabled = false; btn.textContent = '开始检查'; }
      });
  }

  /* ------------------------------ 进度页 ------------------------------ */
  function renderProgress(token) {
    state.view = 'progress';
    state.token = token;
    app.innerHTML = '<div class="card" id="progress-card"><div class="loading">正在准备检查…</div></div>';
    poll();
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, 1500);
  }

  function poll() {
    if (!state.token) return;
    fetch('/api/scans/' + encodeURIComponent(state.token))
      .then(function (r) {
        if (r.status === 404) {
          clearInterval(pollTimer);
          renderMissing();
          return null;
        }
        return r.json();
      })
      .then(function (payload) {
        if (!payload) return;
        state.payload = payload;
        if (state.view !== 'progress') return;
        if (payload.scan.status === 'complete' || payload.scan.status === 'partial' ||
            payload.scan.status === 'failed' || payload.scan.status === 'cancelled') {
          clearInterval(pollTimer);
          renderResult(payload);
        } else {
          drawProgress(payload);
        }
      })
      .catch(function () { /* 网络抖动，下一轮继续 */ });
  }

  /** 重新拉取并渲染结果（重试失败页面后使用）。 */
  function reloadResult() {
    if (!state.token) return;
    return fetch('/api/scans/' + encodeURIComponent(state.token))
      .then(function (r) { return r.json(); })
      .then(function (payload) {
        state.payload = payload;
        if (payload.scan.status === 'failed') renderFailure(payload);
        else renderResult(payload);
      });
  }

  function drawProgress(payload) {
    var scan = payload.scan;
    var stageIdx = STAGES.findIndex(function (s) { return s.key === scan.stage; });
    if (scan.status === 'queued') stageIdx = -1;

    var stagesHtml = STAGES.map(function (s, i) {
      var cls = '';
      if (stageIdx > i) cls = 'done';
      else if (stageIdx === i) cls = 'active';
      var mark = stageIdx > i ? '✓' : String(i + 1);
      return '<li class="' + cls + '"><span class="dot">' + mark + '</span>' +
        '<div><div class="nm">' + esc(s.label) + '</div></div></li>';
    }).join('');

    var card = document.getElementById('progress-card');
    card.innerHTML =
      '<div class="progress-head">' +
      '<div><h2>正在检查你的网站</h2><div class="progress-domain">' + esc(scan.normalizedUrl || scan.submittedUrl) + '</div></div>' +
      '<div class="progress-domain">' + (scan.stageMessage ? esc(scan.stageMessage) : '') + '</div>' +
      '</div>' +
      '<ul class="stages">' + (scan.status === 'queued'
        ? '<li class="active"><span class="dot">1</span><div><div class="nm">正在排队，马上开始</div></div></li>' : stagesHtml) + '</ul>' +
      '<div class="counters">' +
      '<div class="counter"><div class="num">' + (scan.discoveredCount || 0) + '</div><div class="lbl">已发现页面</div></div>' +
      '<div class="counter"><div class="num">' + (scan.scannedCount || 0) + '</div><div class="lbl">已检查页面</div></div>' +
      '<div class="counter"><div class="num">' + (scan.maxPages || 25) + '</div><div class="lbl">最多检查</div></div>' +
      '</div>' +
      '<div class="progress-actions">' +
      '<button class="btn btn ghost sm" id="cancel-btn">取消检查</button>' +
      '<button class="btn btn ghost sm" id="copy-btn">复制结果链接</button>' +
      '</div>' +
      '<div class="wait-note">通常需要几十秒到几分钟。你可以先复制链接离开，稍后再打开查看结果。</div>';

    document.getElementById('copy-btn').addEventListener('click', function () {
      copyText(location.origin + '/result/' + state.token);
    });
    document.getElementById('cancel-btn').addEventListener('click', function () {
      fetch('/api/scans/' + encodeURIComponent(state.token) + '/cancel', { method: 'POST' })
        .then(function () { clearInterval(pollTimer); renderCancelled(); });
    });
  }

  function renderCancelled() {
    state.view = 'cancelled';
    app.innerHTML =
      '<div class="card failure">' +
      '<h2>已取消本次检查</h2>' +
      '<p>没有产生新的结果。你可以重新输入网址开始一次新的检查。</p>' +
      '<button class="btn" id="again">返回首页</button>' +
      '</div>';
    document.getElementById('again').addEventListener('click', function () {
      history.pushState({}, '', '/');
      renderHome();
    });
  }

  function renderMissing() {
    state.view = 'missing';
    app.innerHTML =
      '<div class="card failure">' +
      '<h2>结果不存在或已过期</h2>' +
      '<p>结果链接仅保存 7 天，被删除后也会立即失效。你可以重新检查一次。</p>' +
      '<button class="btn" id="again">返回首页</button>' +
      '</div>';
    document.getElementById('again').addEventListener('click', function () {
      history.pushState({}, '', '/');
      renderHome();
    });
  }

  /* ------------------------------ 结果页 ------------------------------ */
  function renderResult(payload) {
    state.view = 'result';
    state.payload = payload;
    var scan = payload.scan;

    if (scan.status === 'failed') return renderFailure(payload);

    var summary = payload.summary || { critical: 0, warning: 0, info: 0 };
    var findings = payload.findings || [];
    var critical = findings.filter(function (f) { return f.severity === 'critical'; });
    var warnings = findings.filter(function (f) { return f.severity === 'warning'; });
    var infos = findings.filter(function (f) { return f.severity === 'info'; });

    var html =
      '<div class="card">' +
      '<div class="result-head">' +
      '<div><h1 class="result-title">' + esc(scan.domain || scan.normalizedUrl) + '</h1>' +
      '<div class="result-meta">' +
      '检查时间 ' + esc(fmtTime(scan.finishedAt || scan.createdAt)) +
      ' · 已检查 ' + (scan.scannedCount || 0) + ' 个页面' +
      ' · ' + (scan.complete ? '已覆盖站内全部已发现页面' : '本次为部分覆盖') +
      (scan.status === 'partial' ? '（部分页面未成功读取）' : '') +
      '</div></div>' +
      '<div class="result-actions">' +
      (scan.failedCount > 0 ? '<button class="btn btn ghost sm" id="retry-failed">重试 ' + scan.failedCount + ' 个失败页面</button>' : '') +
      '<button class="btn btn ghost sm" id="rescan">重新检查</button>' +
      '<button class="btn btn ghost sm" id="copy">复制结果链接</button>' +
      '<button class="btn btn danger sm" id="delete">删除结果</button>' +
      '</div></div>' +
      '<div class="summary-grid">' +
      '<div class="summary-box critical"><div class="num">' + summary.critical + '</div><div class="lbl">需要优先处理</div></div>' +
      '<div class="summary-box warning"><div class="num">' + summary.warning + '</div><div class="lbl">建议检查</div></div>' +
      '<div class="summary-box info"><div class="num">' + summary.info + '</div><div class="lbl">信息</div></div>' +
      '<div class="summary-box ok"><div class="num">' + (scan.scannedCount || 0) + '</div><div class="lbl">成功读取页面</div></div>' +
      '</div>' +
      '<div class="note info" style="margin-top:18px">任何拥有此链接的人都可以查看这份结果。结果将在 ' + esc(fmtTime(scan.expiresAt)) + ' 后自动删除，你也可以现在就删除。</div>' +
      '</div>';

    html += renderGroup('优先处理', '这些是确定性较高、可能直接影响客户的问题。', critical, 'critical');
    html += renderGroup('建议检查', '这些内容疑似过期或不一致，需要你人工确认。', warnings, 'warning');
    if (infos.length > 0) html += renderGroup('信息', '不构成问题，但值得知道。', infos, 'info');
    html += renderPages(payload.pages || []);
    html += renderLimits(payload);

    app.innerHTML = html;
    bindResultActions(scan);
    bindFeedback();
  }

  function renderGroup(title, desc, list, severity) {
    var head = '<section class="section"><h2>' + esc(title) + '<span class="count">' + list.length + ' 条</span></h2>';
    if (list.length === 0) {
      return head + '<div class="empty">' + (severity === 'critical' ? '没有发现需要优先处理的问题。' : '这一类没有问题。') + '</div></section>';
    }
    if (desc) head += '<p class="result-meta" style="margin:-6px 0 14px">' + esc(desc) + '</p>';
    var main = list.slice(0, MAX_MAIN_FINDINGS);
    var rest = list.slice(MAX_MAIN_FINDINGS);
    var body = main.map(function (f) { return findingCard(f); }).join('');
    if (rest.length > 0) {
      body += '<details class="more"><summary>展开其余 ' + rest.length + ' 条</summary>' +
        rest.map(function (f) { return findingCard(f); }).join('') + '</details>';
    }
    return head + body + '</section>';
  }

  function findingCard(f) {
    var ev = f.evidence || {};
    var hasTwo = ev.side_a && ev.side_b;
    var evidenceHtml = '<div class="evidence' + (hasTwo ? ' two' : '') + '">' +
      (ev.side_a ? evidencePiece(ev.side_a, 'A') : '') +
      (ev.side_b ? evidencePiece(ev.side_b, 'B') : '') +
      '</div>';
    if (!hasTwo && ev.sources && ev.sources.length) {
      evidenceHtml += '<details class="more"><summary>查看出现该链接的 ' + ev.sources.length + ' 个页面</summary><div class="evidence">' +
        ev.sources.map(function (s) { return evidencePiece(s, ''); }).join('') + '</div></details>';
    }

    var pagesHtml = (f.pages || []).map(function (p) {
      return '<a href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer">' + esc(p.title || p.url) + '</a>';
    }).join(' · ');

    var extra = ev.extra && ev.extra.possible_explanation
      ? '<dt>可能的解释</dt><dd>' + esc(ev.extra.possible_explanation) + '</dd>' : '';

    return '<article class="finding ' + esc(f.severity) + '" data-id="' + f.id + '">' +
      '<div class="finding-head"><span class="badge ' + esc(f.severity) + '">' +
      (f.severity === 'critical' ? '优先处理' : f.severity === 'warning' ? '建议检查' : '信息') + '</span>' +
      '<h3>' + esc(f.title) + '</h3></div>' +
      '<p class="finding-summary">' + esc(f.summary) + '</p>' +
      (pagesHtml ? '<div class="finding-pages">所在页面：' + pagesHtml + '</div>' : '') +
      evidenceHtml +
      '<dl class="finding-detail">' +
      '<dt>为什么被报告</dt><dd>' + esc(whyReported(f)) + '</dd>' +
      extra +
      '<dt>推荐操作</dt><dd>' + esc(f.recommendation) + '</dd>' +
      '</dl>' +
      '<div class="feedback">' +
      '<button class="btn btn ghost sm" data-vote="helpful">有帮助</button>' +
      '<button class="btn btn ghost sm" data-vote="not_helpful">不是问题</button>' +
      '<span class="thanks" hidden>感谢反馈</span>' +
      '</div>' +
      '</article>';
  }

  function whyReported(f) {
    if (f.method === 'deterministic') return '由自动规则直接判定，无需人工推断。';
    if (f.method === 'ai_reviewed') return '规则发现候选后，经自动复核认为两处内容疑似描述同一事项（置信度 ' + Math.round((f.confidence || 0) * 100) + '%）。';
    return '规则发现的候选，尚未经自动复核，请人工确认。';
  }

  function evidencePiece(piece, tag) {
    return '<div class="evidence-piece">' +
      '<div class="src">' + (tag ? esc(tag) + ' · ' : '') + esc(piece.url || '') + '</div>' +
      '<div class="quote">' + esc(piece.quote || '') + '</div>' +
      (piece.note ? '<div class="note">' + esc(piece.note) + '</div>' : '') +
      '</div>';
  }

  function renderPages(pages) {
    if (!pages.length) return '';
    var rows = pages.map(function (p) {
      var ok = p.crawlStatus === 'ok';
      return '<tr><td class="url"><a href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer">' + esc(p.url) + '</a></td>' +
        '<td>' + esc(p.pageType || '') + '</td>' +
        '<td class="' + (ok ? 'status-ok' : 'status-failed') + '">' + (ok ? '成功' : (esc(p.errorCode || '失败'))) + '</td>' +
        '<td>' + (p.status ? esc(String(p.status)) : '-') + '</td></tr>';
    }).join('');
    return '<section class="section"><h2>页面概览<span class="count">' + pages.length + ' 个</span></h2>' +
      '<div class="card" style="padding:12px"><table><thead><tr><th>页面</th><th>类型</th><th>状态</th><th>HTTP</th></tr></thead><tbody>' +
      rows + '</tbody></table></div></section>';
  }

  function renderLimits(payload) {
    var scan = payload.scan;
    var items = [];
    if (scan.truncationNote) items.push(esc(scan.truncationNote));
    items.push('本次最多检查 ' + (scan.maxPages || 25) + ' 个公开页面，未覆盖的页面不在报告范围内。');
    items.push('只检查无需登录即可访问的页面；需要登录、依赖交互或由脚本动态生成且未渲染的内容无法判断。');
    items.push('不检查外部网站链接，避免扫描范围失控。');
    if (scan.aiStatus && scan.aiStatus !== 'ok' && scan.aiStatus !== 'not_needed') {
      items.push('本次的自动复核服务不可用，报告以自动规则结果为主，疑似类问题请人工确认。');
    }
    if (scan.status === 'partial') items.push('有 ' + (scan.failedCount || 0) + ' 个页面未能成功读取，报告只包含成功读取的页面。');
    return '<section class="section"><h2>本次检查限制</h2><div class="card"><ul style="margin:0;padding-left:20px;color:var(--muted);font-size:14px">' +
      items.map(function (i) { return '<li>' + i + '</li>'; }).join('') + '</ul></div></section>';
  }

  function renderFailure(payload) {
    var scan = payload.scan;
    var reason = scan.failureReason || '无法完成这次检查。';
    var hint = scan.failureHint ? '<p>' + esc(scan.failureHint) + '</p>' : '';
    app.innerHTML =
      '<div class="card failure">' +
      '<h2>无法完成检查</h2>' +
      '<p>' + esc(reason) + '</p>' + hint +
      '<button class="btn" id="again">重新输入网址</button>' +
      '</div>';
    document.getElementById('again').addEventListener('click', function () {
      history.pushState({}, '', '/');
      renderHome();
    });
  }

  function bindResultActions(scan) {
    var copy = document.getElementById('copy');
    var rescan = document.getElementById('rescan');
    var del = document.getElementById('delete');
    if (copy) copy.addEventListener('click', function () { copyText(location.origin + '/result/' + state.token); });
    var retry = document.getElementById('retry-failed');
    if (retry) retry.addEventListener('click', function () {
      retry.disabled = true;
      retry.textContent = '正在重试…';
      fetch('/api/scans/' + encodeURIComponent(state.token) + '/retry-failed', { method: 'POST' })
        .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
        .then(function (res) {
          if (res.status >= 400) {
            toast(res.body.message || '重试失败');
            retry.disabled = false;
            retry.textContent = '重试失败页面';
            return;
          }
          toast('已恢复 ' + (res.body.recovered || 0) + ' 个页面');
          return reloadResult();
        })
        .catch(function () { toast('网络异常'); retry.disabled = false; });
    });
    if (rescan) rescan.addEventListener('click', function () {
      history.pushState({}, '', '/');
      renderHome();
      var input = document.getElementById('url-input');
      if (input) input.value = scan.submittedUrl || '';
    });
    if (del) del.addEventListener('click', function () {
      if (!window.confirm('删除后这个结果链接将立即失效，且无法恢复。确定删除吗？')) return;
      fetch('/api/scans/' + encodeURIComponent(state.token), { method: 'DELETE' })
        .then(function () {
          app.innerHTML = '<div class="card failure"><h2>结果已删除</h2><p>这个链接已经永久失效。</p>' +
            '<button class="btn" id="again">返回首页</button></div>';
          document.getElementById('again').addEventListener('click', function () {
            history.pushState({}, '', '/');
            renderHome();
          });
        });
    });
  }

  function bindFeedback() {
    var buttons = app.querySelectorAll('.finding .feedback button');
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener('click', function () {
        var card = btn.closest('.finding');
        var id = card.getAttribute('data-id');
        var vote = btn.getAttribute('data-vote');
        if (state.lastVote[id]) { toast('已经记录过你的反馈'); return; }
        fetch('/api/findings/' + id + '/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vote: vote, token: state.token })
        }).then(function (r) { return r.json(); }).then(function () {
          state.lastVote[id] = vote;
          var thanks = card.querySelector('.thanks');
          if (thanks) { thanks.hidden = false; thanks.textContent = vote === 'helpful' ? '感谢反馈' : '已记录，我们会减少这类结果'; }
        }).catch(function () { toast('反馈提交失败'); });
      });
    });
  }

  /* ------------------------------ 示例报告 ----------------------------- */
  function renderExample() {
    state.view = 'example';
    app.innerHTML = '<div class="loading">正在加载示例报告…</div>';
    fetch('/api/example')
      .then(function (r) { return r.json(); })
      .then(function (payload) {
        if (!payload || !payload.scan) throw new Error('bad sample');
        app.innerHTML = '<div class="note" style="margin-bottom:18px">这是一份示例报告，数据来自受控演示网站，仅用于说明报告长什么样。</div>' +
          '<div id="example-root"></div>';
        var root = document.getElementById('example-root');
        var prev = app;
        app = root;
        renderResult(payload);
        app = prev;
        var actions = root.querySelector('.result-actions');
        if (actions) actions.innerHTML = '<a class="btn btn ghost sm" href="/">检查我自己的网站</a>';
      })
      .catch(function () {
        app.innerHTML = '<div class="card failure"><h2>示例报告尚未生成</h2><p>可以运行 npm run gen:sample 生成。</p></div>';
      });
  }

  /* -------------------------------- 路由 -------------------------------- */
  function route() {
    var path = location.pathname;
    var m = path.match(/^\/result\/([A-Za-z0-9_-]+)\/?$/);
    if (m) {
      state.token = decodeURIComponent(m[1]);
      renderProgress(state.token);
      return;
    }
    if (path === '/example' || path === '/example/') {
      renderExample();
      return;
    }
    renderHome();
  }

  window.addEventListener('popstate', function () { clearInterval(pollTimer); route(); });
  route();
})();
