/* 记忆列表面板的纯计算：虚拟窗口、分页拼接。
 * 不碰 DOM。浏览器里随 panel.js 拼进同一段脚本；Node 测试可 require。
 *
 * 虚拟窗口必须用「列表在文档中的起点」，不能直接用 window.scrollY。
 * 列表上面还有标题、统计、筛选、工具条，把页面滚动量当成行号会空出顶部、漏画可见行。
 */
var AiMemoryList = (function () {
  function listWindow(o) {
    var scrollTop = Number(o && o.scrollTop) || 0;
    var viewportH = Number(o && o.viewportH) || 0;
    var listDocTop = Number(o && o.listDocTop) || 0;
    var rowH = Number(o && o.rowH) > 0 ? Number(o.rowH) : 76;
    var total = Math.max(0, Number(o && o.total) || 0);
    var buffer = o && o.buffer != null ? Number(o.buffer) : 4;
    if (!total) return { start: 0, end: 0, rowH: rowH };
    var relStart = scrollTop - listDocTop;
    var relEnd = scrollTop + viewportH - listDocTop;
    if (relStart >= total * rowH) return { start: total, end: total, rowH: rowH };
    if (relEnd <= 0) {
      // 列表还在视口下方：一两屏内仍预画开头几行，滚进来时顶部不是空白
      var prefetch = Math.max(buffer * rowH, 1600);
      if (relEnd < -prefetch) return { start: 0, end: 0, rowH: rowH };
      return { start: 0, end: Math.min(total, Math.max(buffer, 8)), rowH: rowH };
    }
    var start = Math.max(0, Math.floor(relStart / rowH) - buffer);
    var end = Math.min(total, Math.ceil(relEnd / rowH) + buffer);
    if (end < start) end = start;
    return { start: start, end: end, rowH: rowH };
  }

  function shouldLoadMore(o) {
    var loaded = Number(o && o.loaded) || 0;
    var total = Number(o && o.total) || 0;
    if (loaded >= total) return false;
    var lead = o && o.lead != null ? Number(o.lead) : 40;
    var visibleEnd = Number(o && o.visibleEnd) || 0;
    return visibleEnd + lead >= loaded;
  }

  /** 按 offset 覆盖写入一页。同一 offset 重放不会追加出重复行；epoch 不一致则丢弃。 */
  function applyPage(rows, msg, epoch) {
    var page = msg && Array.isArray(msg.rows) ? msg.rows : [];
    var offset = Math.max(0, Number(msg && msg.offset) || 0);
    var msgEpoch = Number(msg && msg.epoch) || 0;
    var cur = Number(epoch) || 0;
    if (!msg || msg.stale || msgEpoch !== cur) return { rows: rows, applied: false, reason: 'epoch' };
    if (offset > rows.length) return { rows: rows, applied: false, reason: 'gap' };
    var next = rows.slice(0, offset).concat(page);
    var total = Number(msg.total);
    return {
      rows: next,
      applied: true,
      reason: 'ok',
      total: Number.isFinite(total) ? total : next.length,
    };
  }

  return { listWindow: listWindow, shouldLoadMore: shouldLoadMore, applyPage: applyPage };
})();

if (typeof globalThis !== 'undefined') globalThis.AiMemoryList = AiMemoryList;
if (typeof module === 'object' && module && module.exports) module.exports = AiMemoryList;
