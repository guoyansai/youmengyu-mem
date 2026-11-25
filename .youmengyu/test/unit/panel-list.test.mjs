/**
 * 回归锁：记忆面板列表窗口 + 分页拼接 + 交互路由 + AI 整理按钮外形。
 *
 * 列表曾经用 window.scrollY 当行号。标题/筛选在列表上方，滚到列表顶时前几行被跳过，看起来像列表坏了。
 * loadMore 曾经无条件 append，筛选切换后的旧页会拼进新结果。
 * 空列表把高度写成 0，空状态被 overflow:hidden 裁掉。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const listApi = require(path.join(repoRoot, 'media', 'list-window.js'));
const panelJs = fs.readFileSync(path.join(repoRoot, 'media', 'panel.js'), 'utf8');
const panelTs = fs.readFileSync(path.join(repoRoot, 'src', 'panel.ts'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

const row = (id) => ({
  id,
  t: '标题' + id,
  c: '正文' + id,
  g: ['事实'],
  p: 3,
  pin: false,
  ar: false,
  ex: false,
  s: '默认',
  u: 1,
  d: '刚刚',
});

test('虚拟窗口按列表文档起点计算，滚到列表顶仍从第 0 行画', () => {
  const aligned = listApi.listWindow({
    scrollTop: 800,
    viewportH: 600,
    listDocTop: 800,
    rowH: 76,
    total: 100,
  });
  assert.equal(aligned.start, 0, '列表顶对齐视口顶时必须画出第 0 行');
  assert.ok(aligned.end > 8 && aligned.end < 20);
  const oldStart = Math.max(0, Math.floor(800 / 76) - 4);
  assert.notEqual(aligned.start, oldStart, '不能退回「用页面滚动量当行号」');

  const mid = listApi.listWindow({
    scrollTop: 800 + 76 * 10,
    viewportH: 600,
    listDocTop: 800,
    rowH: 76,
    total: 100,
  });
  assert.ok(mid.start <= 10 && mid.end > 10, '滚过 10 行后窗口要盖住第 10 行');
  assert.ok(mid.start > 0, '已经滚过的行应离开窗口');

  const far = listApi.listWindow({ scrollTop: 0, viewportH: 400, listDocTop: 5000, rowH: 76, total: 50 });
  assert.equal(far.end, 0);

  const near = listApi.listWindow({ scrollTop: 0, viewportH: 400, listDocTop: 450, rowH: 76, total: 50 });
  assert.equal(near.start, 0);
  assert.equal(near.end, 8, '列表在视口下方一两屏内时预画开头，避免一滚就空白');
  const below = listApi.listWindow({ scrollTop: 0, viewportH: 600, listDocTop: 1400, rowH: 76, total: 50 });
  assert.equal(below.start, 0);
  assert.ok(below.end >= 8);
});

test('分页按 offset 覆盖，旧 epoch 与重复回包都不会把行加倍', () => {
  const base = [row('a'), row('b')];
  const page = listApi.applyPage(base, { offset: 2, epoch: 3, total: 4, rows: [row('c'), row('d')] }, 3);
  assert.equal(page.applied, true);
  assert.deepEqual(page.rows.map((r) => r.id), ['a', 'b', 'c', 'd']);
  const again = listApi.applyPage(page.rows, { offset: 2, epoch: 3, total: 4, rows: [row('c'), row('d')] }, 3);
  assert.deepEqual(again.rows.map((r) => r.id), ['a', 'b', 'c', 'd']);
  const stale = listApi.applyPage(page.rows, { offset: 2, epoch: 1, total: 9, rows: [row('x')] }, 3);
  assert.equal(stale.applied, false);
  assert.equal(stale.rows.length, 4);
  const gap = listApi.applyPage(base, { offset: 5, epoch: 3, rows: [row('z')] }, 3);
  assert.equal(gap.reason, 'gap');
  assert.equal(listApi.shouldLoadMore({ visibleEnd: 4, loaded: 2, total: 5 }), true);
  assert.equal(listApi.shouldLoadMore({ visibleEnd: 10, loaded: 200, total: 500 }), false);
  assert.equal(listApi.shouldLoadMore({ visibleEnd: 180, loaded: 200, total: 500 }), true);
});

test('AI 整理按钮与刷新不是同一套外形', () => {
  const cmd = (id) => pkg.contributes.commands.find((c) => c.command === id);
  const organize = cmd('aimemory.ai.organize');
  const refresh = cmd('aimemory.refresh');
  assert.equal(organize.icon, '$(sparkle)');
  assert.equal(refresh.icon, '$(refresh)');
  assert.notEqual(organize.icon, refresh.icon);
  assert.equal(organize.title, 'AI 立即整理记忆');
  assert.match(panelTs, /class="btn ai-organize"/);
  assert.match(panelTs, /data-act="aiOrganize"/);
  assert.match(panelTs, /icon\('sparkle'\)\}AI 立即整理记忆/);
  assert.match(panelTs, /data-act="refresh">\$\{icon\('refresh'\)\}刷新/);
  assert.match(panelTs, /\.btn\.ai-organize\s*\{[^}]*border-radius:\s*999px/);
  assert.match(panelTs, /#0b8f86/);
  assert.match(panelJs, /class="btn ai-organize" id="runConsolidateBtn"/);
  assert.match(panelJs, /AI 立即整理记忆/);
  assert.doesNotMatch(panelJs, /id="runConsolidateBtn">立即整理</);
  assert.match(panelTs, /list-window\.js/);
  assert.match(panelTs, /viewEpoch/);
  assert.match(panelTs, /stale:\s*true/);
  assert.match(panelJs, /AiMemoryList\.listWindow/);
  assert.match(panelJs, /function listDocTop/);
  assert.doesNotMatch(panelJs, /Math\.floor\(st \/ rowH\)/);
  assert.match(panelTs, /\.row-tools \{ opacity: 1;/);
});

function matchSel(el, sel) {
  if (!el || !sel) return false;
  if (sel.endsWith(':checked')) return !!el.checked && matchSel(el, sel.slice(0, -8));
  const named = /^\[name=([^\]]+)\]$/.exec(sel);
  if (named) return el.name === named[1];
  const inputNamed = /^input\[name=([^\]]+)\]$/.exec(sel);
  if (inputNamed) return el.tagName === 'INPUT' && el.name === inputNamed[1];
  const data = /^\[data-([a-zA-Z0-9_-]+)\]$/.exec(sel);
  if (data) return Object.prototype.hasOwnProperty.call(el.dataset, data[1]);
  if (sel === '.tab.on') return el.classList.contains('tab') && el.classList.contains('on');
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (/^[a-z0-9]+$/i.test(sel)) return el.tagName === sel.toUpperCase();
  return false;
}

function queryAll(root, sel) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      if (matchSel(c, sel)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

function boot(opts = {}) {
  const messages = [];
  const ids = {};
  const listDocTop = opts.listDocTop == null ? 800 : opts.listDocTop;

  function applyAttrs(node, attrs) {
    const idm = /(?:^|\s)id="([^"]*)"/.exec(attrs);
    if (idm) {
      node.id = idm[1];
      ids[node.id] = node;
    }
    const cm = /(?:^|\s)class="([^"]*)"/.exec(attrs);
    if (cm) cm[1].split(/\s+/).forEach((c) => c && node.classList.add(c));
    const dm = /data-([a-zA-Z0-9_-]+)="([^"]*)"/g;
    let d;
    while ((d = dm.exec(attrs))) node.dataset[d[1]] = d[2];
    const nm = /(?:^|\s)name="([^"]*)"/.exec(attrs);
    if (nm) node.name = nm[1];
    const vm = /(?:^|\s)value="([^"]*)"/.exec(attrs);
    if (vm) node.value = vm[1];
    if (/(?:^|\s)checked(?:\s|=|$)/.test(attrs)) node.checked = true;
  }

  function makeEl(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      id: '',
      name: '',
      children: [],
      parent: null,
      dataset: {},
      style: {},
      value: '',
      checked: false,
      textContent: '',
      className: '',
      _html: '',
      _listeners: {},
    };
    el.classList = {
      add(...cs) { cs.forEach((c) => c && this._set.add(c)); },
      remove(...cs) { cs.forEach((c) => this._set.delete(c)); },
      toggle(c, on) {
        if (on === undefined) {
          if (this._set.has(c)) { this._set.delete(c); return false; }
          this._set.add(c);
          return true;
        }
        if (on) this._set.add(c);
        else this._set.delete(c);
        return this._set.has(c);
      },
      contains: (c) => el.classList._set.has(c),
      _set: new Set(),
    };
    el.addEventListener = (type, fn) => { (el._listeners[type] ||= []).push(fn); };
    el.dispatch = (type, ev = {}) => {
      const e = { preventDefault() {}, ...ev };
      if (!e.target) e.target = el;
      for (const fn of el._listeners[type] || []) fn(e);
    };
    el.querySelector = (sel) => queryAll(el, sel)[0] || null;
    el.querySelectorAll = (sel) => queryAll(el, sel);
    el.closest = (sel) => {
      let n = el;
      while (n) {
        if (matchSel(n, sel)) return n;
        n = n.parent;
      }
      return null;
    };
    el.matches = (sel) => matchSel(el, sel);
    el.focus = () => { document.activeElement = el; };
    el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 10, height: 10 });
    Object.defineProperty(el, 'innerHTML', {
      get() { return el._html; },
      set(h) {
        el._html = String(h ?? '');
        el.children = [];
        parseInto(el._html, el);
      },
    });
    return el;
  }

  const voidTags = new Set(['input', 'br', 'img', 'path', 'meta', 'link', 'hr', 'source']);
  function parseInto(html, parent) {
    const stack = [parent];
    const re = /<\/?([a-zA-Z0-9]+)([^>]*)>/g;
    let m;
    while ((m = re.exec(html))) {
      const tag = m[1].toLowerCase();
      const raw = m[0];
      if (raw.startsWith('</')) {
        for (let i = stack.length - 1; i > 0; i -= 1) {
          if (stack[i].tagName.toLowerCase() === tag) {
            stack.length = i;
            break;
          }
        }
        continue;
      }
      const node = makeEl(tag);
      applyAttrs(node, m[2] || '');
      const host = stack[stack.length - 1];
      node.parent = host;
      host.children.push(node);
      const selfClose = /\/>$/.test(raw) || voidTags.has(tag);
      if (!selfClose) stack.push(node);
    }
  }

  const document = {
    activeElement: null,
    _listeners: {},
    documentElement: null,
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    dispatch(type, ev = {}) {
      const e = { preventDefault() {}, ...ev };
      if (!e.target) e.target = document;
      for (const fn of this._listeners[type] || []) fn(e);
    },
    getElementById: (id) => ids[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  document.documentElement = makeEl('html');

  function register(id, tag) {
    const el = makeEl(tag || 'div');
    el.id = id;
    ids[id] = el;
    return el;
  }

  const q = register('q', 'input');
  const sort = register('sort', 'select');
  sort.value = 'relevance';
  const space = register('space', 'select');
  const archived = register('archived', 'input');
  const list = register('list', 'div');
  const listbox = register('listbox', 'main');
  const loadmore = register('loadmore', 'div');
  loadmore.classList.add('off');
  const chips = register('chips', 'section');
  const stats = register('stats', 'section');
  const profile = register('profile', 'section');
  const overlay = register('overlay', 'div');
  const drawer = register('drawer', 'aside');
  const toastEl = register('toast', 'div');
  const totalEl = register('total', 'b');
  const selcountEl = register('selcount', 'b');
  const tabs = register('tabs', 'nav');
  const memapp = register('memapp', 'div');
  const aiapp = register('aiapp', 'section');
  const tabMem = makeEl('button');
  tabMem.classList.add('tab', 'on');
  tabMem.dataset.tab = 'memory';
  tabMem.parent = tabs;
  tabs.children.push(tabMem);
  const tabAi = makeEl('button');
  tabAi.classList.add('tab');
  tabAi.dataset.tab = 'ai';
  tabAi.parent = tabs;
  tabs.children.push(tabAi);

  list.getBoundingClientRect = () => ({
    top: listDocTop - (global.scrollY || 0),
    left: 0,
    width: 300,
    height: 400,
  });

  const windowListeners = {};
  global.window = global;
  global.document = document;
  global.scrollY = 0;
  global.innerHeight = opts.viewportH || 600;
  global.scrollTo = (x, y) => {
    global.scrollY = typeof x === 'object' && x ? (x.top || 0) : (y || 0);
  };
  global.requestAnimationFrame = (fn) => { fn(); return 1; };
  global.getComputedStyle = () => ({ getPropertyValue: (p) => (p === '--row-h' ? '76px' : '') });
  global.addEventListener = (type, fn) => { (windowListeners[type] ||= []).push(fn); };
  global.dispatch = (type, ev) => {
    for (const fn of windowListeners[type] || []) fn(ev);
  };
  global.acquireVsCodeApi = () => ({ postMessage: (m) => messages.push(JSON.parse(JSON.stringify(m))) });

  vm.runInThisContext(panelJs, { filename: 'panel.js' });

  function send(msg) { global.dispatch('message', { data: msg }); }
  function click(node) { document.dispatch('click', { target: node }); }
  function acts(type) { return messages.filter((m) => m.type === type); }

  return {
    messages, q, sort, space, archived, list, listbox, chips, drawer, toastEl, totalEl, selcountEl,
    tabs, memapp, aiapp, overlay, tabAi, loadmore, send, click, acts, document,
  };
}

function resultMsg(over = {}) {
  const rows = over.rows || [row('r0'), row('r1'), row('r2')];
  return {
    type: 'results',
    epoch: over.epoch == null ? 1 : over.epoch,
    state: { query: '', tag: '', space: '', sort: 'relevance', archived: false, ...(over.state || {}) },
    emptyKind: over.emptyKind || (rows.length ? '' : 'filter'),
    statsHtml: '<div class="stat">1</div>',
    chipsHtml: '<button class="chip on" data-tag="">全部</button><button class="chip" data-tag="fact">事实</button>',
    spacesHtml: '<option value="">全部空间</option>',
    profileHtml: '<span class="muted">画像</span>',
    rows,
    total: over.total == null ? rows.length : over.total,
  };
}

test('滚到列表顶仍渲染第 0 行；再往下滚才让开头离开窗口', () => {
  const ui = boot();
  ui.messages.length = 0;
  ui.send(resultMsg({ rows: Array.from({ length: 30 }, (_, i) => row('r' + i)), total: 30 }));
  assert.match(ui.list.innerHTML, /data-row="r0"/);
  assert.match(ui.list.innerHTML, /top:0px/);
  global.scrollY = 800;
  global.dispatch('scroll', {});
  assert.match(ui.list.innerHTML, /data-row="r0"/, '列表顶对齐视口时第 0 行必须还在');
  assert.match(ui.list.innerHTML, /top:0px/);
  global.scrollY = 800 + 76 * 10;
  global.dispatch('scroll', {});
  assert.doesNotMatch(ui.list.innerHTML, /data-row="r0"/);
  assert.match(ui.list.innerHTML, /data-row="r10"/);
  assert.match(ui.list.innerHTML, /top:760px/);
});

test('空列表保持可看见的空状态，不再把高度打成 0', () => {
  const ui = boot();
  ui.send(resultMsg({ rows: [], total: 0, emptyKind: 'none' }));
  assert.equal(ui.list.style.height, 'auto');
  assert.equal(ui.listbox.classList.contains('is-empty'), true);
  assert.match(ui.list.innerHTML, /还没有记忆/);
  assert.notEqual(ui.list.style.height, '0px');
});

test('筛选不变不抢滚动；筛选一变就回顶并清掉勾选', () => {
  const ui = boot();
  ui.send(resultMsg());
  global.scrollY = 400;
  ui.send(resultMsg({ epoch: 2 }));
  assert.equal(global.scrollY, 400);
  const box = ui.list.querySelectorAll('[data-sel]')[0];
  box.checked = true;
  ui.document.dispatch('change', { target: box });
  assert.equal(ui.selcountEl.textContent, '1');
  ui.send(resultMsg({ epoch: 3, state: { query: '鱼' } }));
  assert.equal(global.scrollY, 0);
  assert.equal(ui.selcountEl.textContent, '0');
});

test('分页回包按 offset 落地，过期回包不把旧页拼进来', () => {
  const ui = boot({ listDocTop: 0 });
  ui.messages.length = 0;
  ui.send(resultMsg({ rows: [row('a'), row('b')], total: 5, epoch: 4 }));
  const more = ui.acts('loadMore');
  assert.ok(more.length >= 1);
  assert.equal(more[0].offset, 2);
  assert.equal(more[0].epoch, 4);
  ui.send({ type: 'rows', epoch: 4, offset: 2, total: 5, rows: [row('c'), row('d')] });
  assert.match(ui.list.innerHTML, /data-row="c"/);
  ui.send({ type: 'rows', epoch: 4, offset: 2, total: 5, rows: [row('c'), row('d')] });
  assert.equal((ui.list.innerHTML.match(/data-row="c"/g) || []).length, 1);
  ui.send({ type: 'rows', epoch: 1, offset: 4, total: 9, rows: [row('stale')] });
  assert.doesNotMatch(ui.list.innerHTML, /stale/);
  ui.send({ type: 'rows', stale: true, epoch: 4, offset: 4, total: 5, rows: [row('stale2')] });
  assert.doesNotMatch(ui.list.innerHTML, /stale2/);
});

test('列表与抽屉上的交互都会发到对应消息', async () => {
  const ui = boot({ listDocTop: 0 });
  ui.messages.length = 0;
  ui.send(resultMsg({ rows: [row('e1'), row('e2'), row('e3')], total: 3 }));
  ui.messages.length = 0;

  const findAct = (act) => ui.list.querySelectorAll('[data-act]').find((n) => n.dataset.act === act);
  ui.click(findAct('detail'));
  ui.click(findAct('pin'));
  ui.click(findAct('edit'));
  ui.click(findAct('archive'));
  ui.click(findAct('delete'));
  assert.deepEqual(ui.acts('detail').map((m) => m.id), ['e1']);
  assert.deepEqual(ui.acts('pin').map((m) => m.id), ['e1']);
  assert.deepEqual(ui.acts('edit').map((m) => m.id), ['e1']);
  assert.deepEqual(ui.acts('archive').map((m) => m.id), ['e1']);
  assert.deepEqual(ui.acts('delete').map((m) => m.id), ['e1']);

  const box = ui.list.querySelectorAll('[data-sel]')[0];
  ui.messages.length = 0;
  ui.click(box);
  assert.equal(ui.acts('detail').length, 0, '勾选框不能误开详情');
  box.checked = true;
  ui.document.dispatch('change', { target: box });
  assert.equal(ui.selcountEl.textContent, '1');

  const selAll = { dataset: { act: 'selAll' }, closest: (s) => (s === '[data-act]' ? selAll : null) };
  ui.click(selAll);
  assert.equal(ui.selcountEl.textContent, '3');
  const selNone = { dataset: { act: 'selNone' }, closest: (s) => (s === '[data-act]' ? selNone : null) };
  ui.click(selNone);
  assert.equal(ui.selcountEl.textContent, '0');
  const batch = { dataset: { act: 'batchDelete' }, closest: (s) => (s === '[data-act]' ? batch : null) };
  ui.click(batch);
  assert.match(ui.toastEl.textContent, /先勾选/);
  ui.click(selAll);
  ui.messages.length = 0;
  ui.click(batch);
  assert.equal(ui.acts('batchDelete')[0].all, true);

  const scan = { dataset: { act: 'scan' }, closest: (s) => (s === '[data-act]' ? scan : null) };
  const cleanup = { dataset: { act: 'cleanup', kind: 'duplicate' }, closest: (s) => (s === '[data-act]' ? cleanup : null) };
  const refresh = { dataset: { act: 'refresh' }, closest: (s) => (s === '[data-act]' ? refresh : null) };
  const ai = { dataset: { act: 'aiOrganize' }, closest: (s) => (s === '[data-act]' ? ai : null) };
  const rollback = { dataset: { act: 'rollback', id: 'e1', vindex: '2' }, closest: (s) => (s === '[data-act]' ? rollback : null) };
  ui.messages.length = 0;
  ui.click(scan);
  ui.click(cleanup);
  ui.click(refresh);
  ui.click(ai);
  ui.click(rollback);
  assert.equal(ui.acts('scan').length, 1);
  assert.deepEqual(ui.acts('cleanup')[0].kinds, ['duplicate']);
  assert.equal(ui.acts('action').find((m) => m.action === 'refresh').action, 'refresh');
  assert.equal(ui.acts('action').find((m) => m.action === 'aiOrganize').action, 'aiOrganize');
  assert.equal(ui.acts('rollback')[0].index, 2);

  ui.chips.dispatch('click', { target: ui.chips.querySelectorAll('[data-tag]').find((n) => n.dataset.tag === 'fact') });
  assert.equal(ui.acts('query').at(-1).state.tag, 'fact');

  ui.sort.value = 'recent';
  ui.sort.dispatch('change', {});
  assert.equal(ui.acts('query').at(-1).state.sort, 'recent');
  ui.space.value = 'notes';
  ui.space.dispatch('change', {});
  assert.equal(ui.acts('query').at(-1).state.space, 'notes');
  ui.archived.checked = true;
  ui.archived.dispatch('change', {});
  assert.equal(ui.acts('query').at(-1).state.archived, true);

  ui.q.value = '游梦';
  ui.q.dispatch('input', {});
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(ui.acts('query').at(-1).state.query, '游梦');

  ui.messages.length = 0;
  ui.document.dispatch('keydown', { key: '/' });
  assert.equal(ui.document.activeElement, ui.q);
  ui.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(ui.acts('closed').length, 1);

  ui.send({
    type: 'editor',
    html: `<form data-id="e1">
      <input name="title" value="标题">
      <input name="content" value="正文">
      <input name="importance" value="4">
      <input name="space" value="demo">
      <input name="pinned" type="checkbox" checked>
      <input name="expiresAt" value="">
      <input name="meta" value="k=v">
      <input name="tag" type="checkbox" value="fact" checked>
      <button type="button" data-act="save">保存</button>
    </form>`,
  });
  assert.equal(ui.overlay.classList.contains('show'), true);
  ui.messages.length = 0;
  ui.click(ui.drawer.querySelector('[data-act]'));
  const saved = ui.acts('update')[0];
  assert.equal(saved.id, 'e1');
  assert.equal(saved.patch.title, '标题');
  assert.equal(saved.patch.content, '正文');
  assert.equal(saved.patch.importance, 4);
  assert.equal(saved.patch.space, 'demo');
  assert.equal(saved.patch.pinned, true);
  assert.deepEqual(saved.patch.tags, ['fact']);
  assert.deepEqual(saved.patch.metadata, { k: 'v' });

  ui.tabs.dispatch('click', { target: ui.tabAi });
  assert.equal(ui.acts('tab')[0].tab, 'ai');
  assert.equal(ui.memapp.classList.contains('off'), true);

  ui.send({
    type: 'aiState',
    prefs: {
      lane: 'free', offlineId: '', onlineId: '', freeId: '',
      autoRecord: true, autoConsolidate: true, consolidateHours: 24,
      maxAutoEntries: 5, freeTimeoutSec: 20, freeFailover: true, chatWatchPatterns: [],
    },
    providers: [], presets: [], protocols: [{ id: 'openai', label: 'OpenAI' }],
    lanes: [{ id: 'free', label: '免费' }], log: [], presetDetails: [],
  });
  const btn = ui.document.getElementById('runConsolidateBtn');
  assert.ok(btn, '设置页应渲染 AI 整理按钮');
  assert.equal(btn.classList.contains('ai-organize'), true);
  assert.equal(btn.classList.contains('btn'), true);
  assert.match(ui.aiapp.innerHTML, /AI 立即整理记忆/);
  ui.messages.length = 0;
  btn.dispatch('click', {});
  assert.equal(ui.acts('runConsolidate').length, 1);

  ui.send({ type: 'toast', text: '已置顶', kind: '' });
  assert.match(ui.toastEl.textContent, /已置顶/);
  ui.send({ type: 'scanReport', html: '<button data-act="close">关闭</button>' });
  assert.equal(ui.overlay.classList.contains('show'), true);
  ui.click(ui.drawer.querySelector('[data-act]'));
  assert.equal(ui.overlay.classList.contains('show'), false);
});
