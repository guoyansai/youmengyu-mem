/* 记忆面板前端脚本：独立文件，便于语法校验与打包（改动后请跑 npm run asaitest）
 *
 * 性能设计（支持百万级条目）：
 *  - 列表用虚拟渲染：滚动容器 #listbox，画布 #list 按总条数撑高，只渲染可见窗口 ±缓冲
 *  - 数据分页：首屏 200 行，滚动近尾部时向宿主发 loadMore 续拉下一页
 *  - 批量管理：勾选走 id 集合；「全选」只记标记，取消的几条放 except，删除时由宿主按当前筛选重算
 */
(function () {
  var vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: function () {} };
  var q = document.getElementById('q');
  var sort = document.getElementById('sort');
  var space = document.getElementById('space');
  var archived = document.getElementById('archived');
  var list = document.getElementById('list');
  var listbox = document.getElementById('listbox');
  var loadmore = document.getElementById('loadmore');
  var chips = document.getElementById('chips');
  var stats = document.getElementById('stats');
  var profile = document.getElementById('profile');
  var overlay = document.getElementById('overlay');
  var drawer = document.getElementById('drawer');
  var toastEl = document.getElementById('toast');
  var totalEl = document.getElementById('total');
  var selcountEl = document.getElementById('selcount');
  var selmaster = document.getElementById('selmaster');
  var selAllBtn = document.getElementById('selallbtn');
  var selNoneBtn = document.getElementById('selnone');
  var batchDelBtn = document.getElementById('batchdel');
  var tabs = document.getElementById('tabs');
  var memapp = document.getElementById('memapp');
  var aiapp = document.getElementById('aiapp');
  var timer = null;
  var toastTimer = null;

  /* ---------- 标签页：全部页面都在这个视图里切换，不另开窗口 ---------- */
  var curTab = 'memory';
  var PAGE = {
    memory: memapp,
    compose: document.getElementById('composeapp'),
    git: document.getElementById('gitapp'),
    profile: document.getElementById('profileapp'),
    io: document.getElementById('ioapp'),
    ai: aiapp,
  };
  function setTab(tab) {
    curTab = Object.prototype.hasOwnProperty.call(PAGE, tab) ? tab : 'memory';
    var btns = tabs.querySelectorAll('[data-tab]');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].dataset.tab === curTab);
    Object.keys(PAGE).forEach(function (k) {
      if (PAGE[k]) PAGE[k].classList.toggle('off', k !== curTab);
    });
    window.scrollTo(0, 0);
  }
  tabs.addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-tab]');
    if (!btn || btn.dataset.tab === curTab) return;
    setTab(btn.dataset.tab);
    vscode.postMessage({ type: 'tab', tab: btn.dataset.tab });
  });
  var onTab = tabs.querySelector('.tab.on');
  if (onTab) setTab(onTab.dataset.tab);

  /* ---------- 滚动状态（整页滚动：侧边栏窄视图下固定区块也能全部看到） ---------- */
  function scrollTop() {
    return window.scrollY || document.documentElement.scrollTop || 0;
  }
  function viewportH() {
    return window.innerHeight || document.documentElement.clientHeight || 400;
  }
  /** 列表顶端在文档中的 Y。上面还有标题和筛选，不能把 window.scrollY 当成列表内偏移。 */
  function listDocTop() {
    var rect = list.getBoundingClientRect();
    return (rect.top || 0) + scrollTop();
  }

  /* ---------- 虚拟列表状态 ---------- */
  // 首屏引导：条数和第一页行在 HTML 里就写好。没引导之前不要用 total=0 去重画，否则滚动会把直出列表清成空状态。
  var boot = (window.__AIMEM_BOOT && typeof window.__AIMEM_BOOT === 'object') ? window.__AIMEM_BOOT : {};
  var rows = Array.isArray(boot.rows) ? boot.rows.slice() : [];
  var total = typeof boot.total === 'number' ? boot.total : 0;
  var live = Array.isArray(boot.rows);
  var loading = false;    // loadMore 在途标记
  var rafPending = false; // 滚动渲染合并标记
  var sel = {};           // 勾选集合（id -> true），全选时不用它
  var selAll = false;     // 全选标记：删除按宿主当前筛选重算，不逐条传 id
  var selCount = 0;
  var except = {};        // 全选之后取消的 id
  var exceptCount = 0;
  var epoch = 0;          // 与宿主 viewEpoch 对齐，过期分页回包丢弃
  var filterKey = '';     // 筛选指纹：只有筛选变了才回顶、清空勾选
  var emptyKind = typeof boot.emptyKind === 'string' ? boot.emptyKind : 'filter';

  function currentRowH() {
    var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h'));
    return isFinite(v) && v > 40 ? v : 76;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function pips(p) {
    var out = '';
    for (var i = 1; i <= 5; i++) out += '<i class="pip' + (i <= p ? ' on' : '') + '"></i>';
    return out;
  }

  function rowOn(id) {
    return selAll ? !except[id] : !!sel[id];
  }

  function rowHtml(r, index) {
    var on = rowOn(r.id);
    var checked = on ? ' checked' : '';
    var pills = '';
    for (var i = 0; i < r.g.length; i++) pills += '<span class="tag">' + esc(r.g[i]) + '</span>';
    var flags = (r.ar ? '<span class="pill">已归档</span>' : '') + (r.ex ? '<span class="pill warn">已过期</span>' : '');
    return '<div class="row' + (r.pin ? ' pinned' : '') + (r.ar ? ' archived' : '') + (on ? ' picked' : '') + '" data-row="' + esc(r.id) + '" style="top:' + index * currentRowH() + 'px">' +
      '<input type="checkbox" class="row-sel" data-sel="' + esc(r.id) + '" title="选择"' + checked + '>' +
      '<div class="row-main" data-act="detail" data-id="' + esc(r.id) + '" title="查看详情">' +
        '<div class="row-top"><span class="row-title">' + (r.pin ? '⭐ ' : '') + esc(r.t) + '</span>' +
        '<span class="pips" title="重要性 P' + r.p + '">' + pips(r.p) + '</span></div>' +
        '<div class="row-snippet">' + esc(r.c) + '</div>' +
        '<div class="row-meta">' + pills + flags +
          '<span class="meta-item">' + esc(r.s) + '</span>' +
          '<span class="meta-item">' + r.u + ' 次命中</span>' +
          '<span class="meta-item">' + esc(r.d) + '</span></div>' +
      '</div>' +
      '<div class="row-tools">' +
        '<button class="icon' + (r.pin ? ' active' : '') + '" data-act="pin" data-id="' + esc(r.id) + '" title="' + (r.pin ? '取消置顶' : '置顶') + '"><svg class="ic" viewBox="0 0 16 16"><path d="M4.8 2.6h6.4v10.8L8 10.7l-3.2 2.7z"/></svg></button>' +
        '<button class="icon" data-act="edit" data-id="' + esc(r.id) + '" title="编辑"><svg class="ic" viewBox="0 0 16 16"><path d="M11.4 2.3l2.3 2.3L5.5 12.8 2.3 13.7l.9-3.2z"/></svg></button>' +
        '<button class="icon" data-act="archive" data-id="' + esc(r.id) + '" title="' + (r.ar ? '恢复' : '归档') + '"><svg class="ic" viewBox="0 0 16 16"><path d="M2.4 5.6h11.2v7.8H2.4zM2 2.8h12v2.6H2zM6.4 8.6h3.2"/></svg></button>' +
        '<button class="icon danger" data-act="delete" data-id="' + esc(r.id) + '" title="删除"><svg class="ic" viewBox="0 0 16 16"><path d="M2.8 4.4h10.4M6.2 4.4V2.7h3.6v1.7M4.5 4.4l.7 9h5.6l.7-9"/></svg></button>' +
      '</div></div>';
  }

  function emptyHtml() {
    if (emptyKind === 'none') {
      return '<div class="empty"><div class="empty-icon">🐟</div><div class="empty-title">还没有记忆</div>' +
        '<p>新建一条，或把教训、决策、偏好存进来。</p></div>';
    }
    if (emptyKind === 'view') {
      return '<div class="empty"><div class="empty-icon">🗂️</div><div class="empty-title">该视图下暂无记忆</div>' +
        '<p>试试打开「显示已归档」，或新建一条记忆。</p></div>';
    }
    return '<div class="empty"><div class="empty-icon">🔍</div><div class="empty-title">没有匹配的记忆</div>' +
      '<p>换个关键词，或清空标签 / 空间筛选再试。</p></div>';
  }

  function windowRange() {
    var rowH = currentRowH();
    list.style.height = total ? total * rowH + 'px' : 'auto';
    return AiMemoryList.listWindow({
      scrollTop: scrollTop(),
      viewportH: viewportH(),
      listDocTop: listDocTop(),
      rowH: rowH,
      total: total,
    });
  }

  function render() {
    if (!live || !list) return;
    if (!total) {
      list.style.height = 'auto';
      if (listbox) listbox.classList.add('is-empty');
      list.innerHTML = emptyHtml();
      return;
    }
    if (listbox) listbox.classList.remove('is-empty');
    var win = windowRange();
    var html = '';
    for (var i = win.start; i < win.end; i++) {
      var r = rows[i];
      if (r) html += rowHtml(r, i);
    }
    list.innerHTML = html;
  }

  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      render();
      maybeLoadMore();
    });
  }

  function maybeLoadMore() {
    if (loading || rows.length >= total) return;
    var win = windowRange();
    if (!AiMemoryList.shouldLoadMore({ visibleEnd: win.end, loaded: rows.length, total: total })) return;
    loading = true;
    loadmore.classList.remove('off');
    vscode.postMessage({ type: 'loadMore', offset: rows.length, epoch: epoch });
  }

  function filterKeyOf(s) {
    s = s || {};
    return [s.query || '', s.tag || '', s.space || '', s.sort || '', s.archived ? '1' : '0'].join('\u0001');
  }
  if (boot.state) filterKey = filterKeyOf(boot.state);

  function selectedCount() {
    return selAll ? Math.max(0, total - exceptCount) : selCount;
  }

  function updateSelInfo() {
    var n = selectedCount();
    var allOn = total > 0 && n === total;
    var partial = n > 0 && !allOn;
    if (totalEl) totalEl.textContent = String(total);
    if (selcountEl) selcountEl.textContent = String(n);
    if (selmaster) {
      selmaster.checked = allOn;
      selmaster.indeterminate = partial;
      selmaster.disabled = total === 0;
    }
    if (selAllBtn) {
      selAllBtn.disabled = total === 0;
      if (selAllBtn.classList) selAllBtn.classList.toggle('on', allOn);
    }
    if (selNoneBtn) selNoneBtn.disabled = n === 0;
    if (batchDelBtn) batchDelBtn.disabled = n === 0;
  }

  function setSel(id, on) {
    if (!id) return;
    if (selAll) {
      if (on) {
        if (except[id]) { delete except[id]; exceptCount--; }
      } else if (!except[id]) {
        except[id] = true;
        exceptCount++;
      }
      if (total > 0 && exceptCount >= total) { clearSel(); return; }
      updateSelInfo();
      return;
    }
    if (on && !sel[id]) { sel[id] = true; selCount++; }
    if (!on && sel[id]) { delete sel[id]; selCount--; }
    updateSelInfo();
  }

  function clearSel() {
    sel = {};
    selCount = 0;
    selAll = false;
    except = {};
    exceptCount = 0;
    updateSelInfo();
  }

  function selectAll() {
    if (!total) {
      showToast('当前没有可选条目', 'warn');
      updateSelInfo();
      return;
    }
    selAll = true;
    except = {};
    exceptCount = 0;
    sel = {};
    selCount = 0;
    updateSelInfo();
    render();
  }

  /* ---------- 筛选状态 ---------- */
  function snapshot() {
    return {
      query: q.value,
      tag: chips.dataset.tag || '',
      space: space.value || '',
      sort: sort.value,
      archived: archived.checked
    };
  }
  function ask() {
    vscode.postMessage({ type: 'query', state: snapshot() });
  }
  function askSoon() {
    clearTimeout(timer);
    timer = setTimeout(ask, 180);
  }

  if (q) q.addEventListener('input', askSoon);
  if (sort) sort.addEventListener('change', ask);
  if (space) space.addEventListener('change', ask);
  if (archived) archived.addEventListener('change', ask);

  if (chips) chips.addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-tag]');
    if (!btn) return;
    chips.dataset.tag = btn.dataset.tag;
    ask();
  });

  window.addEventListener('scroll', scheduleRender, { passive: true });
  window.addEventListener('resize', scheduleRender);

  function showToast(text, kind) {
    toastEl.textContent = text;
    toastEl.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, 2200);
  }
  function openDrawer() { overlay.classList.add('show'); }
  function closeDrawer() {
    overlay.classList.remove('show');
    drawer.innerHTML = '';
    vscode.postMessage({ type: 'closed' });
  }

  drawer.addEventListener('input', function (ev) {
    if (ev.target && ev.target.name === 'importance') {
      var out = drawer.querySelector('.range-val');
      if (out) out.textContent = 'P' + ev.target.value;
    }
  });

  function saveForm() {
    var form = drawer.querySelector('form');
    if (!form) return;
    var pick = function (name) { return form.querySelector('[name=' + name + ']'); };
    var metadata = {};
    pick('meta').value.split('\n').forEach(function (line) {
      var i = line.indexOf('=');
      if (i <= 0) return;
      var k = line.slice(0, i).trim();
      var v = line.slice(i + 1).trim();
      if (k) metadata[k] = v;
    });
    var patch = {
      title: pick('title').value.trim(),
      content: pick('content').value,
      importance: Number(pick('importance').value) || 3,
      space: pick('space').value.trim() || 'default',
      pinned: pick('pinned').checked,
      expiresAt: pick('expiresAt').value || undefined,
      metadata: metadata,
      tags: Array.prototype.map.call(form.querySelectorAll('[name=tag]:checked'), function (c) { return c.value; })
    };
    if (!patch.title || !patch.content.trim()) {
      showToast('标题与正文不能为空', 'warn');
      return;
    }
    vscode.postMessage({ type: 'update', id: form.dataset.id, patch: patch });
  }

  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (!t || !t.matches) return;
    if (t.id === 'selmaster') {
      if (t.checked) selectAll();
      else { clearSel(); render(); }
      return;
    }
    if (t.matches('[data-sel]')) setSel(t.dataset.sel, t.checked);
  });

  function actNode(ev) {
    var node = ev && ev.target;
    if (!node) return null;
    if (node.nodeType === 3) node = node.parentElement || node.parentNode || node.parent;
    if (!node || !node.closest) return null;
    return node.closest('[data-act]');
  }

  document.addEventListener('click', function (ev) {
    var el = actNode(ev);
    if (!el) {
      if (ev.target === overlay) closeDrawer();
      return;
    }
    var act = el.dataset.act;
    var id = el.dataset.id || '';
    if (act === 'confirmYes' || act === 'confirmNo') { answerConfirm(act === 'confirmYes'); return; }
    if (act === 'create') { submitCompose(); return; }
    if (act === 'gitReload') { vscode.postMessage({ type: 'gitLoad' }); return; }
    if (act === 'gitImport') { submitGit(); return; }
    if (act === 'exportCopy' || act === 'exportWrite') { vscode.postMessage({ type: act }); return; }
    if (act === 'importJson') { submitImport(); return; }
    if (act === 'importText') { submitText(); return; }
    if (act === 'youmengyuGo') { submitYoumengyu(); return; }
    if (act === 'save') { saveForm(); return; }
    if (act === 'close') { closeDrawer(); return; }
    if (act === 'rollback') {
      vscode.postMessage({ type: 'rollback', id: id, index: Number(el.dataset.vindex) || 0 });
      return;
    }
    if (act === 'selAll') { selectAll(); return; }
    if (act === 'selNone') { clearSel(); render(); return; }
    if (act === 'batchDelete') {
      if (!selectedCount()) { showToast('先勾选要删除的条目', 'warn'); return; }
      vscode.postMessage({
        type: 'batchDelete',
        all: selAll,
        ids: selAll ? [] : Object.keys(sel),
        except: selAll ? Object.keys(except) : [],
      });
      return;
    }
    if (act === 'scan') {
      showToast('正在扫描问题数据…');
      vscode.postMessage({ type: 'scan' });
      return;
    }
    if (act === 'cleanup') {
      var kind = el.dataset.kind || 'all';
      var kinds = kind === 'all' ? ['duplicate', 'invalid', 'meaningless', 'expired'] : [kind];
      vscode.postMessage({ type: 'cleanup', kinds: kinds });
      return;
    }
    if (act === 'pin' || act === 'edit' || act === 'archive' || act === 'delete' || act === 'detail' || act === 'copy') {
      vscode.postMessage({ type: act, id: id });
      return;
    }
    vscode.postMessage({ type: 'action', action: act });
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeDrawer();
    if (curTab === 'memory' && ev.key === '/' && document.activeElement !== q) {
      ev.preventDefault();
      q.focus();
    }
  });

  /* ---------- AI 服务设置标签页（原独立设置页并入，消息由宿主转发给设置控制器） ---------- */
  var aiState = { prefs: null, providers: [], presets: [], protocols: [], lanes: [], log: [], editing: null, test: {}, presetUrls: {} };

  function aiChosenId(lane) {
    if (!aiState.prefs) return '';
    return lane === 'online' ? aiState.prefs.onlineId : lane === 'free' ? aiState.prefs.freeId : aiState.prefs.offlineId;
  }
  function aiLaneChosen(lane) { return Boolean(aiState.prefs && aiState.prefs.lane === lane); }
  function aiProtocolLabel(id) {
    for (var i = 0; i < aiState.protocols.length; i++) {
      if (aiState.protocols[i].id === (id || 'openai')) return aiState.protocols[i].label;
    }
    return id || 'openai';
  }
  function aiKindLabel(k) { return k === 'record' ? '记录' : k === 'consolidate' ? '整理' : '捕获'; }
  function aiCheckbox(id, val, label, desc) {
    return '<label class="chk"><input type="checkbox" id="' + id + '"' + (val ? ' checked' : '') + '> <b>' + esc(label) + '</b><span class="muted"> ' + esc(desc) + '</span></label>';
  }
  function aiRowNumber(id, label, val, min, max) {
    return '<label class="lbl">' + esc(label) + '<input type="number" id="' + id + '" value="' + Number(val || 0) + '" min="' + min + '" max="' + max + '"></label>';
  }

  function aiRenderEditor() {
    var e = aiState.editing;
    var isNew = !e;
    var data = e || { lane: (aiState.prefs && aiState.prefs.lane) || 'free', protocol: 'openai' };
    var html = '<h2>' + (isNew ? '添加服务源' : '编辑：' + esc(data.name || '')) + '</h2><div class="card">';
    html += '<label class="lbl">从预设填充<select id="f_preset"><option value="">（自定义）</option>';
    aiState.presets.forEach(function (p) {
      html += '<option value="' + esc(p.id) + '" data-preset=\'' + esc(JSON.stringify(p)) + '\'' + (data.presetId === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
    });
    html += '</select></label>';
    html += '<label class="lbl">通路<select id="f_lane">';
    aiState.lanes.forEach(function (l) {
      html += '<option value="' + l.id + '"' + (data.lane === l.id ? ' selected' : '') + '>' + l.label + '</option>';
    });
    html += '</select></label>';
    html += '<label class="lbl">名称<input id="f_name" value="' + esc(data.name || '') + '" placeholder="例如：我的 Ollama"></label>';
    html += '<label class="lbl">接口地址<input id="f_baseUrl" value="' + esc(data.baseUrl || '') + '" placeholder="https://api.example.com/v1"></label>';
    html += '<label class="lbl">模型<input id="f_model" value="' + esc(data.model || '') + '" placeholder="model 名称"></label>';
    html += '<label class="lbl">协议<select id="f_protocol">';
    aiState.protocols.forEach(function (p) {
      html += '<option value="' + p.id + '"' + ((data.protocol || 'openai') === p.id ? ' selected' : '') + '>' + esc(p.label) + '</option>';
    });
    html += '</select></label>';
    html += '<label class="lbl">API Key（留空保持不变；只存本机 SecretStorage）<input id="f_key" type="password" placeholder="sk-…" autocomplete="off"></label>';
    html += '<label class="chk"><input type="checkbox" id="f_keyless"' + (data.keyless ? ' checked' : '') + '> 免密钥（公共免费接口）</label>';
    html += '<div class="btns">';
    html += '<button class="btn primary" id="saveProvBtn">' + (isNew ? '添加并设为当前' : '保存修改') + '</button>';
    if (!isNew) html += '<button class="btn" id="cancelEditBtn">取消</button>';
    html += '</div></div>';
    return html;
  }

  function aiQ(sel) { return Array.prototype.slice.call(aiapp.querySelectorAll(sel)); }

  function aiSavePrefs() {
    var patterns = (document.getElementById('chatWatchPatterns').value || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    vscode.postMessage({
      type: 'savePrefs',
      prefs: {
        autoRecord: document.getElementById('autoRecord').checked,
        autoConsolidate: document.getElementById('autoConsolidate').checked,
        consolidateHours: Number(document.getElementById('consolidateHours').value) || 24,
        maxAutoEntries: Number(document.getElementById('maxAutoEntries').value) || 5,
        freeTimeoutSec: Number(document.getElementById('freeTimeoutSec').value) || 20,
        freeFailover: document.getElementById('freeFailover').checked,
        chatWatchPatterns: patterns,
      },
    });
  }

  function aiSaveProvider() {
    var editing = aiState.editing;
    vscode.postMessage({
      type: 'saveProvider',
      provider: {
        id: editing ? editing.id : undefined,
        builtin: editing ? editing.builtin : false,
        name: document.getElementById('f_name').value.trim(),
        baseUrl: document.getElementById('f_baseUrl').value.trim(),
        model: document.getElementById('f_model').value.trim(),
        protocol: document.getElementById('f_protocol').value,
        lane: document.getElementById('f_lane').value,
        keyless: document.getElementById('f_keyless').checked,
      },
      key: document.getElementById('f_key').value,
    });
    aiState.editing = null;
  }

  function bindAi() {
    aiQ('input[name=lane]').forEach(function (el) {
      el.addEventListener('change', function () {
        vscode.postMessage({ type: 'savePrefs', prefs: { lane: el.value } });
      });
    });
    aiQ('[data-choose]').forEach(function (el) {
      el.addEventListener('change', function () {
        if (el.value) vscode.postMessage({ type: 'selectProvider', id: el.value });
      });
    });
    var sp = document.getElementById('savePrefsBtn');
    if (sp) sp.addEventListener('click', aiSavePrefs);
    var rr = document.getElementById('runRecordBtn');
    if (rr) rr.addEventListener('click', function () { vscode.postMessage({ type: 'runRecord' }); });
    var rc = document.getElementById('runConsolidateBtn');
    if (rc) rc.addEventListener('click', function () { vscode.postMessage({ type: 'runConsolidate' }); });
    var cap = document.getElementById('captureBtn');
    if (cap) cap.addEventListener('click', function () { vscode.postMessage({ type: 'captureEditor' }); });
    aiQ('[data-edit]').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-edit');
        for (var i = 0; i < aiState.providers.length; i++) {
          if (aiState.providers[i].id === id) { aiState.editing = aiState.providers[i]; renderAi(); return; }
        }
      });
    });
    aiQ('[data-del]').forEach(function (el) {
      el.addEventListener('click', function () {
        vscode.postMessage({ type: 'deleteProvider', id: el.getAttribute('data-del') });
      });
    });
    aiQ('[data-test]').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-test');
        aiState.test[id] = null;
        vscode.postMessage({ type: 'testProvider', id: id });
      });
    });
    var preset = document.getElementById('f_preset');
    if (preset) {
      preset.addEventListener('change', function () {
        var opt = preset.selectedOptions[0];
        if (!opt || !opt.getAttribute('data-preset')) return;
        var p = JSON.parse(opt.getAttribute('data-preset'));
        document.getElementById('f_name').value = p.name;
        var known = aiState.presetUrls[p.id];
        if (known) {
          document.getElementById('f_baseUrl').value = known.baseUrl;
          document.getElementById('f_model').value = known.model;
        }
        document.getElementById('f_protocol').value = p.protocol || 'openai';
        document.getElementById('f_lane').value = p.lane || document.getElementById('f_lane').value;
        document.getElementById('f_keyless').checked = !p.needsKey && Boolean(known);
      });
    }
    var saveP = document.getElementById('saveProvBtn');
    if (saveP) saveP.addEventListener('click', aiSaveProvider);
    var cancel = document.getElementById('cancelEditBtn');
    if (cancel) cancel.addEventListener('click', function () { aiState.editing = null; renderAi(); });
  }

  function renderAi() {
    if (!aiState.prefs) { aiapp.innerHTML = '<p class="muted">正在加载 AI 服务设置…</p>'; return; }
    var pf = aiState.prefs;
    var html = '';
    // 通路卡片
    html += '<h2>AI 通路</h2><p class="muted">记忆提炼与整理走这里选的通路，不占用开发 Agent 的 token。离线=本机推理，在线=自带密钥的付费服务，免费=公共免费接口/免费额度。</p>';
    html += '<div class="lanes">';
    aiState.lanes.forEach(function (lane) {
      var pool = aiState.providers.filter(function (p) { return p.lane === lane.id; });
      var chosen = aiChosenId(lane.id);
      html += '<div class="lane card' + (aiLaneChosen(lane.id) ? ' on' : '') + '">';
      html += '<div class="lane-head"><label><input type="radio" name="lane" value="' + lane.id + '"' + (aiLaneChosen(lane.id) ? ' checked' : '') + '> ' + lane.label + '通路</label>';
      html += '<span class="count">' + pool.length + ' 个源</span></div>';
      html += '<select data-choose="' + lane.id + '"' + (pool.length ? '' : ' disabled') + '>';
      html += '<option value="">（未选择）</option>';
      pool.forEach(function (p) {
        html += '<option value="' + esc(p.id) + '"' + (p.id === chosen ? ' selected' : '') + '>' + esc(p.name) + (p.keyHint ? ' ' + esc(p.keyHint) : '') + '</option>';
      });
      html += '</select></div>';
    });
    html += '</div>';
    // 自动化设置
    html += '<h2>自动记录与整理</h2><div class="card">';
    html += aiCheckbox('autoRecord', pf.autoRecord, '主动记录（推荐开启）', '捕获 git 提交与匹配的 AI 聊天/内容文件，AI 自动提炼成记忆条目');
    html += aiCheckbox('autoConsolidate', pf.autoConsolidate, '自动整理', '按周期合并重复、归档过时条目、提炼原子事实，压缩注入体积');
    html += aiRowNumber('consolidateHours', '整理周期（小时）', pf.consolidateHours, 1, 168);
    html += aiRowNumber('maxAutoEntries', '每轮最多新增条数', pf.maxAutoEntries, 1, 20);
    html += aiRowNumber('freeTimeoutSec', '免费档超时（秒）', pf.freeTimeoutSec, 10, 45);
    html += aiCheckbox('freeFailover', pf.freeFailover, '免费档失败自动换源', '单个免费源超时/失败时自动换下一个免费源');
    html += '<label class="lbl">AI 聊天捕获匹配（glob，每行一个）<textarea id="chatWatchPatterns" rows="3">' + esc((pf.chatWatchPatterns || []).join('\n')) + '</textarea></label>';
    html += '<p class="muted">匹配到的文件变更会被当作开发 AI 的聊天/产出内容捕获。也可把对话导出为 *.chat.md 放进仓库。</p>';
    html += '<div class="btns"><button class="btn primary" id="savePrefsBtn">保存设置</button>';
    html += '<button class="btn" id="runRecordBtn">立即记录</button>';
    html += '<button class="btn ai-organize" id="runConsolidateBtn" type="button" title="用已配置的 AI 通路立即记录并整理记忆，不占用开发 Agent 的 token"><svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2l1 3.8L13 6.2 9 7.4 8 11.2 7 7.4 3 6.2l4-1.2zM12.2 9.4l.4 1.5 1.5.4-1.5.4-.4 1.5-.4-1.5-1.5-.4 1.5-.4z"/></svg>AI 立即整理记忆</button>';
    html += '<button class="btn" id="captureBtn">捕获当前编辑器</button></div></div>';
    // 服务源列表
    html += '<h2>AI 服务源</h2>';
    aiState.lanes.forEach(function (lane) {
      var pool = aiState.providers.filter(function (p) { return p.lane === lane.id; });
      html += '<h3 class="sub">' + lane.label + '</h3>';
      if (!pool.length) html += '<p class="muted">暂无服务源</p>';
      pool.forEach(function (p) {
        var t = aiState.test[p.id];
        html += '<div class="card prov' + (p.id === aiChosenId(lane.id) ? ' on' : '') + '">';
        html += '<div class="prov-head"><b>' + esc(p.name) + '</b>' + (p.builtin ? '<span class="tag">内置</span>' : '') + (p.id === aiChosenId(lane.id) ? '<span class="tag ok">当前</span>' : '') + '</div>';
        html += '<div class="mono muted">' + esc(p.baseUrl) + ' · ' + esc(p.model) + ' · ' + esc(aiProtocolLabel(p.protocol)) + (p.keyHint ? ' · ' + esc(p.keyHint) : '') + '</div>';
        html += '<div class="btns">';
        html += '<button class="btn sm" data-edit="' + esc(p.id) + '">编辑</button>';
        html += '<button class="btn sm" data-test="' + esc(p.id) + '">测试' + (t ? (t.ok ? ' ✓' : ' ✗') : '') + '</button>';
        if (!p.builtin) html += '<button class="btn sm danger" data-del="' + esc(p.id) + '">删除</button>';
        html += '</div>';
        if (t) html += '<div class="muted sm-note">' + (t.ok ? ('正常，' + t.ms + 'ms' + (t.reply ? '：' + esc(t.reply) : '')) : ('失败：' + esc(t.error))) + '</div>';
        html += '</div>';
      });
    });
    // 编辑表单
    html += aiRenderEditor();
    // 运行日志
    html += '<h2>运行日志</h2>';
    if (!aiState.log.length) html += '<p class="muted">还没有运行记录</p>';
    else {
      html += '<div class="card log">';
      aiState.log.forEach(function (e) {
        html += '<div class="log-row"><span class="mono">' + esc((e.at || '').replace('T', ' ').slice(0, 19)) + '</span><span class="tag">' + esc(aiKindLabel(e.kind)) + '</span><span>' + esc(e.detail) + (e.error ? ' <b class="err">⚠ ' + esc(e.error) + '</b>' : '') + '</span></div>';
      });
      html += '</div>';
    }
    aiapp.innerHTML = html;
    bindAi();
  }

  var confirmToken = '';
  function showConfirm(msg) {
    confirmToken = msg.token || '';
    var box = document.getElementById('confirm');
    if (!box) {
      vscode.postMessage({ type: 'confirmAnswer', token: confirmToken, ok: false });
      return;
    }
    var text = document.getElementById('confirmtext');
    if (text) text.textContent = msg.text || '';
    var okBtn = document.getElementById('confirmok');
    if (okBtn) okBtn.textContent = msg.okLabel || '确认';
    box.classList.remove('off');
  }
  function answerConfirm(ok) {
    var box = document.getElementById('confirm');
    if (box) box.classList.add('off');
    vscode.postMessage({ type: 'confirmAnswer', token: confirmToken, ok: ok });
    confirmToken = '';
  }
  function formVal(form, name) {
    var el = form.querySelector('[name=' + name + ']');
    return el ? el.value : '';
  }
  function submitCompose() {
    var form = document.getElementById('composeform');
    if (!form) return;
    vscode.postMessage({
      type: 'create',
      patch: {
        title: formVal(form, 'title').trim(),
        content: formVal(form, 'content'),
        importance: Number(formVal(form, 'importance')) || 3,
        space: formVal(form, 'space').trim(),
        source: formVal(form, 'source'),
        tags: Array.prototype.map.call(form.querySelectorAll('[name=ctag]:checked'), function (c) { return c.value; }),
      },
    });
  }
  function submitGit() {
    var host = document.getElementById('gitlist');
    if (!host) return;
    var boxes = host.querySelectorAll('[data-hash]');
    var hashes = [];
    for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) hashes.push(boxes[i].dataset.hash);
    var spaceEl = document.getElementById('gitspace');
    vscode.postMessage({ type: 'gitImport', hashes: hashes, space: spaceEl ? spaceEl.value : '' });
  }
  function renderGit(msg) {
    var host = document.getElementById('gitlist');
    if (!host) return;
    var commits = msg.commits || [];
    if (msg.error) { host.innerHTML = '<p class="muted">' + esc(msg.error) + '</p>'; return; }
    if (!commits.length) { host.innerHTML = '<p class="muted">没有可用的提交记录</p>'; return; }
    var html = '';
    for (var i = 0; i < commits.length; i++) {
      var c = commits[i];
      html += '<label class="git-row"><input type="checkbox" data-hash="' + esc(c.hash) + '"><span><b>' + esc(c.subject) + '</b> <span class="muted">' + esc(c.hash) + ' ' + esc(c.date) + '</span></span></label>';
    }
    host.innerHTML = html;
  }
  function submitImport() {
    var box = document.getElementById('iojson');
    vscode.postMessage({ type: 'importJson', text: box ? box.value : '' });
  }
  function submitText() {
    var title = document.getElementById('iotitle');
    var body = document.getElementById('iomd');
    var spaceEl = document.getElementById('iospace');
    vscode.postMessage({
      type: 'importText',
      title: title ? title.value : '',
      content: body ? body.value : '',
      space: spaceEl ? spaceEl.value : '',
    });
  }
  function submitYoumengyu() {
    var root = document.getElementById('ioroot');
    vscode.postMessage({ type: 'youmengyuGo', root: root ? root.value : '' });
  }

  window.addEventListener('message', function (ev) {
    var msg = ev.data || {};
    if (msg.type === 'results') {
      stats.innerHTML = msg.statsHtml;
      chips.innerHTML = msg.chipsHtml;
      var st = msg.state || {};
      chips.dataset.tag = st.tag || '';
      if (profile) profile.innerHTML = msg.profileHtml;
      space.innerHTML = msg.spacesHtml;
      space.value = st.space || '';
      rows = msg.rows || [];
      total = msg.total || 0;
      if (msg.emptyKind) emptyKind = msg.emptyKind;
      if (typeof msg.epoch === 'number') epoch = msg.epoch;
      else epoch += 1;
      loading = false;
      var nextKey = filterKeyOf(st);
      var filterChanged = nextKey !== filterKey;
      filterKey = nextKey;
      if (filterChanged) {
        window.scrollTo(0, 0);
        sel = {};
        selCount = 0;
        selAll = false;
        except = {};
        exceptCount = 0;
      }
      live = true;
      if (loadmore) loadmore.classList.toggle('off', rows.length >= total);
      updateSelInfo();
      render();
      maybeLoadMore();
      return;
    }
    if (msg.type === 'rows') {
      var applied = AiMemoryList.applyPage(rows, msg, epoch);
      if (!applied.applied) {
        if (applied.reason !== 'epoch') loading = false;
        return;
      }
      rows = applied.rows;
      if (typeof msg.total === 'number') total = msg.total;
      loading = false;
      live = true;
      if (loadmore) loadmore.classList.toggle('off', rows.length >= total);
      updateSelInfo();
      render();
      maybeLoadMore();
      return;
    }
    if (msg.type === 'deleted') {
      clearSel();
      if (overlay.classList.contains('show') && !drawer.querySelector('form')) closeDrawer();
      return;
    }
    if (msg.type === 'editor' || msg.type === 'detail') {
      drawer.innerHTML = msg.html;
      openDrawer();
      return;
    }
    if (msg.type === 'scanReport') {
      drawer.innerHTML = msg.html;
      openDrawer();
      return;
    }
    if (msg.type === 'close') { closeDrawer(); return; }
    if (msg.type === 'toast') { showToast(msg.text, msg.kind); return; }
    if (msg.type === 'focusSearch') { setTab('memory'); if (q) q.focus(); return; }
    if (msg.type === 'compose') {
      setTab('compose');
      var ccontent = document.getElementById('ccontent');
      var csource = document.getElementById('csource');
      if (ccontent && msg.content) ccontent.value = msg.content;
      if (csource) csource.value = msg.source || '';
      return;
    }
    if (msg.type === 'gitList') { setTab('git'); renderGit(msg); return; }
    if (msg.type === 'ioText') {
      setTab('io');
      var iojson = document.getElementById('iojson');
      if (iojson) iojson.value = msg.text || '';
      return;
    }
    if (msg.type === 'ioState') {
      var ioroot = document.getElementById('ioroot');
      if (ioroot && !ioroot.value) ioroot.value = msg.root || '';
      return;
    }
    if (msg.type === 'confirm') { showConfirm(msg); return; }
    if (msg.type === 'tabState') { setTab(msg.tab); return; }
    if (msg.type === 'aiState') {
      aiState.prefs = msg.prefs;
      aiState.providers = msg.providers || [];
      aiState.presets = msg.presets || [];
      aiState.protocols = msg.protocols || [];
      aiState.lanes = msg.lanes || [];
      aiState.log = msg.log || [];
      // 预设地址镜像：供编辑表单回填 baseUrl/model
      var map = {};
      (msg.presetDetails || []).forEach(function (p) { map[p.id] = { baseUrl: p.baseUrl, model: p.model }; });
      if (Object.keys(map).length) aiState.presetUrls = map;
      renderAi();
      return;
    }
    if (msg.type === 'testResult') {
      aiState.test[msg.id] = msg;
      renderAi();
      showToast(msg.ok ? '测试通过（' + msg.ms + 'ms）' : '测试失败：' + (msg.error || ''), msg.ok ? '' : 'warn');
      return;
    }
  });

  if (live) updateSelInfo();
  ask();
})();
