/* table/frontend · hex-zone-plan.js —— 分区规划面板（短按分区名打开，2026-09-12）。
 *
 * 人类：「热度排序的热度值加一个到分区规划里。短按分区跳出分区规划页面」
 * 「分区规划页面能做哪些功能和信息？……这些问题连带那个需求你一并做了，不用我说什么改什么」。
 *
 * 一个分区"规划"要回答的就是四件事，按这个顺序排：
 *   1. 这块地现在热不热 —— 分区热度 + 全场排名（蜂巢里越热越靠中心，这里给出那个数）
 *   2. 时间花在哪 —— 近 7 天 / 今天投入（事实，来自 views/gantt 的 actual）
 *   3. 每个项目的状态 —— 按热度排（= 蜂巢里由内到外的顺序），热度值、7 天投入、
 *      7 天完成、待办数、排期（逾期标红）；点一行 = 关面板、在蜂巢里展开那个项目
 *   4. 接下来做什么 / 最近做完了什么 —— 本分区的下一步（逾期、今天到期、权重）与最近完成
 * 外加一个动作：在本分区直接新建项目（和经典列表同一个 D.createProject）。
 *
 * **后端零改动**：数据全是蜂巢已经拿着的（tree / heat / todos / completions），
 * 只多拉一次 views/gantt（打开时拉，拿不到就那一栏写"读取失败"，其余照常）。
 * 热度口径与 hex-data.js::completionHeat 同一份：近期完成次数按 7 天半衰期加权。
 */
(function () {
  "use strict";

  var DAY = 86400000;
  var ctx = null;   // { state, fetchGantt, createProject, openProject, reload, halfLifeDays }
  var dlg = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function hm(seconds) {
    if (seconds == null) return "—";
    var m = Math.round(seconds / 60);
    return m < 60 ? m + " 分" : Math.floor(m / 60) + " 时 " + (m % 60) + " 分";
  }
  function heatText(v) { return (v || 0).toFixed(1); }

  // 把 views/gantt 折成 { projectId: { d7, today, plan } }。「今天」用服务端给的 today
  // （契约：不许用客户端时钟判断"今天"），近 7 天 = today 往前数 6 天含 today。
  function ganttIndex(g) {
    var out = {};
    if (!g || !g.today || !g.projects) return null;
    var today = g.today, t0 = Date.parse(today + "T00:00:00Z");
    (g.projects || []).forEach(function (p) {
      var d7 = 0, td = 0;
      (p.actual || []).forEach(function (a) {
        var age = (t0 - Date.parse(a.date + "T00:00:00Z")) / DAY;
        if (age >= 0 && age < 7) d7 += a.seconds || 0;
        if (a.date === today) td += a.seconds || 0;
      });
      out[p.id] = { d7: d7, today: td, plan: p.plan || null };
    });
    out.__today = today;
    return out;
  }

  function model(zoneId, gi) {
    var st = ctx.state;
    var zone = st.hive.zones.filter(function (z) { return z.id === zoneId; })[0];
    if (!zone) return null;
    var ranked = st.hive.zones.slice().sort(function (a, b) { return (b.heat || 0) - (a.heat || 0); });
    var rank = ranked.indexOf(zone) + 1;
    var now = Date.now();
    var projects = ((st.tree && st.tree.projects) || []).filter(function (p) { return p.zoneId === zoneId; });
    var rows = projects.map(function (p) {
      var done7 = (st.completions || []).filter(function (c) {
        return c.projectId === p.id && now - Date.parse(c.at) < 7 * DAY;
      }).length;
      var g = gi ? gi[p.id] : null;
      return {
        id: p.id, name: p.name, heat: (st.heat || {})[p.id] || 0,
        todos: (st.todos[p.id] || []).length, done7: done7,
        d7: g ? g.d7 : null, today: g ? g.today : null, plan: g ? g.plan : null
      };
    });
    // 与 buildHoneycomb 同一个排序：热度降序，并列按项目 order —— 所以这张表的顺序
    // 就是这些项目在蜂巢里由内到外的顺序。
    var order = {};
    projects.forEach(function (p, i) { order[p.id] = p.order == null ? i : p.order; });
    rows.sort(function (a, b) { return (b.heat - a.heat) || (order[a.id] - order[b.id]); });
    var next = [];
    projects.forEach(function (p) { (st.todos[p.id] || []).forEach(function (t) { next.push(t); }); });
    next.sort(function (a, b) {
      return (b.overdue - a.overdue) || (b.dueToday - a.dueToday) || (b.plannedWeight - a.plannedWeight);
    });
    var recent = (st.completions || []).filter(function (c) {
      return projects.some(function (p) { return p.id === c.projectId; });
    });
    var sum = function (k) {
      return rows.reduce(function (s, r) { return r[k] == null ? s : s + r[k]; }, gi ? 0 : null);
    };
    return {
      zone: zone, rank: rank, zoneCount: ranked.length, rows: rows,
      next: next.slice(0, 5), recent: recent.slice(0, 5),
      d7: sum("d7"), today: sum("today"),
      done7: rows.reduce(function (s, r) { return s + r.done7; }, 0),
      todos: rows.reduce(function (s, r) { return s + r.todos; }, 0),
      maxHeat: rows.reduce(function (m, r) { return Math.max(m, r.heat); }, 0),
      todayStr: gi ? gi.__today : null, ganttOk: !!gi
    };
  }

  function planCell(r, todayStr) {
    if (!r.plan) return '<span class="zp-muted">未排期</span>';
    var late = todayStr && r.plan.end < todayStr;
    return '<span class="' + (late ? "zp-late" : "") + '">' + esc(r.plan.start.slice(5)) +
      " → " + esc(r.plan.end.slice(5)) + (late ? " · 逾期" : "") + "</span>";
  }

  function render(m, loading) {
    var z = m.zone;
    var dash = loading ? "…" : null;
    var rows = m.rows.map(function (r, i) {
      var w = m.maxHeat > 0 ? Math.round(r.heat / m.maxHeat * 100) : 0;
      return '<tr data-zp-open="' + esc(r.id) + '" tabindex="0">' +
        '<td class="zp-num">' + (i + 1) + "</td>" +
        '<td class="zp-name">' + esc(r.name) + "</td>" +
        '<td class="zp-heat"><span class="zp-bar"><i style="width:' + w + '%"></i></span>' +
          '<span class="zp-num">' + heatText(r.heat) + "</span></td>" +
        '<td class="zp-num">' + (dash || (m.ganttOk ? hm(r.d7) : "—")) + "</td>" +
        '<td class="zp-num">' + r.done7 + "</td>" +
        '<td class="zp-num">' + r.todos + "</td>" +
        "<td>" + (dash || (m.ganttOk ? planCell(r, m.todayStr) : "—")) + "</td></tr>";
    }).join("");
    var next = m.next.length ? m.next.map(function (t) {
      return "<li>" + (t.overdue ? '<span class="zp-chip is-late">逾期</span>' :
        t.dueToday ? '<span class="zp-chip is-today">今天</span>' : "") +
        esc(t.name) + '<span class="zp-muted"> · ' + esc(t.projectName || "") + "</span></li>";
    }).join("") : '<li class="zp-muted">没有待办</li>';
    var recent = m.recent.length ? m.recent.map(function (c) {
      return "<li>" + esc(c.taskName || "（已删除的任务）") +
        '<span class="zp-muted"> · ' + esc(c.projectName || "") + " · " + esc(c.stamp || "") + "</span></li>";
    }).join("") : '<li class="zp-muted">最近没有完成记录</li>';
    var tile = function (label, val) {
      return '<div class="zp-tile"><span class="zp-eyebrow">' + label + '</span><b class="zp-num">' + val + "</b></div>";
    };
    return '<form method="dialog" class="zp-head">' +
        '<span class="zp-dot" style="--zone-color:' + esc(z.color) + '"></span>' +
        '<div><h2>' + esc(z.name) + "</h2>" +
        '<p class="zp-muted">' + m.rows.length + " 个项目 · 热度 <b>" + heatText(z.heat) + "</b> · " +
          // 热度为 0 的分区彼此并列，给名次是假精确
          (z.heat > 0 ? "全场第 " + m.rank + " / " + m.zoneCount : "近期没有完成记录") + "</p></div>" +
        '<button class="zp-close" value="close" aria-label="关闭">×</button></form>' +
      '<div class="zp-tiles">' +
        tile("近 7 天投入", dash || (m.ganttOk ? hm(m.d7) : "读取失败")) +
        tile("今天", dash || (m.ganttOk ? hm(m.today) : "—")) +
        tile("近 7 天完成", m.done7 + " 条") +
        tile("待办", m.todos + " 条") +
      "</div>" +
      '<section><h3>项目 · 按热度 <span class="zp-muted">（越热越靠近蜂巢中心）</span></h3>' +
        (m.rows.length ? '<div class="zp-scroll"><table class="zp-table"><thead><tr>' +
          '<th></th><th>项目</th><th>热度</th><th>7 天投入</th><th>7 天完成</th><th>待办</th><th>排期</th>' +
          "</tr></thead><tbody>" + rows + "</tbody></table></div>"
          : '<p class="zp-muted">这个分区还没有项目。</p>') +
        '<p class="zp-note">热度 = 近期完成次数按 ' + (ctx.halfLifeDays || 7) +
          " 天半衰期加权：今天完成一条算 1，" + (ctx.halfLifeDays || 7) + " 天前的一条算 0.5。点一行 = 在蜂巢里展开那个项目。</p>" +
      "</section>" +
      '<div class="zp-cols"><section><h3>接下来</h3><ul class="zp-list">' + next + "</ul></section>" +
        '<section><h3>最近完成</h3><ul class="zp-list">' + recent + "</ul></section></div>" +
      '<form class="zp-new" data-zp-new>' +
        '<input name="name" maxlength="80" placeholder="在「' + esc(z.name) + '」新建项目…" aria-label="新项目名">' +
        '<button type="submit">新建项目</button><span class="zp-msg" role="status"></span></form>';
  }

  function open(zoneId) {
    if (!ctx) return;
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.className = "hex-zone-plan";
      document.body.appendChild(dlg);
      // 点遮罩（dialog 自己，而不是里面的内容）= 关
      dlg.addEventListener("click", function (ev) {
        if (ev.target === dlg) { dlg.close(); return; }
        var row = ev.target.closest("[data-zp-open]");
        if (row) { dlg.close(); ctx.openProject(row.dataset.zpOpen); }
      });
      dlg.addEventListener("keydown", function (ev) {
        var row = ev.target.closest && ev.target.closest("[data-zp-open]");
        if (row && (ev.key === "Enter" || ev.key === " ")) {
          ev.preventDefault(); dlg.close(); ctx.openProject(row.dataset.zpOpen);
        }
      });
      dlg.addEventListener("submit", function (ev) {
        var form = ev.target.closest("[data-zp-new]");
        if (!form) return;
        ev.preventDefault();
        var input = form.querySelector("input"), msg = form.querySelector(".zp-msg");
        var name = input.value.trim();
        if (!name) { msg.textContent = "项目名不能为空"; return; }
        form.querySelector("button").disabled = true;
        ctx.createProject(dlg.dataset.zoneId, name).then(function (r) {
          form.querySelector("button").disabled = false;
          if (!r || !r.ok) { msg.textContent = "新建失败：" + ((r && r.message) || "未知错误"); return; }
          msg.textContent = "已新建「" + name + "」";
          input.value = "";
          ctx.reload().then(function () { if (dlg.open) paint(dlg.dataset.zoneId); });
        });
      });
    }
    dlg.dataset.zoneId = zoneId;
    var m = model(zoneId, null);
    if (!m) return;
    dlg.innerHTML = render(m, true);
    if (!dlg.open) dlg.showModal();
    paint(zoneId);
  }

  // 拉一次 gantt 再画实数。拿不到就把依赖它的格子写成"读取失败 / —"，其余照常。
  function paint(zoneId) {
    ctx.fetchGantt().then(function (r) {
      if (!dlg || !dlg.open || dlg.dataset.zoneId !== zoneId) return;
      var gi = r && r.ok ? ganttIndex(r.data) : null;
      var m = model(zoneId, gi);
      if (m) {
        var keep = dlg.querySelector("[data-zp-new] input");
        var typed = keep ? keep.value : "";
        dlg.innerHTML = render(m, false);
        var input = dlg.querySelector("[data-zp-new] input");
        if (input && typed) input.value = typed;
      }
    });
  }

  function init(c) { ctx = c; }

  window.NexusTableHexZonePlan = { init: init, open: open, ganttIndex: ganttIndex };
})();
