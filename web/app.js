// table · 渲染层（DOM 编排）
//
// 派生自 agents/reference/upstream/index.html。本文件只负责**只读渲染**：
// 分区分页、项目卡片（含双轨，F-TABLE-1）、任务列表（含播放钮，F-TABLE-2）、
// 概览统计、计时档案，数据来自 data.js 的 fetchTree()/fetchGantt()/fetchArchive()、
// rails.js 的 computeProjectRail()。增删改的弹窗/表单交互在同目录 crud.js
// （人类裁决 2026-07-31：table 恢复编辑能力，四前端里唯一例外，见
// module_docs/contract.md v0.2 与任务单 2026-07-31-任务单-table-CRUD.md）
// ——拆成两个文件是为了单文件不超 500 行（铁律 9），也让"读"与"写+表单
// 状态机"的关注点不混在一起。本文件只做两件事让 crud.js 能接得上：渲染时
// 打上 data-action/data-*-id 属性（供 crud.js 做事件委托），以及在 load()
// 之后通过 notifyTreeListeners() 把最新 tree 广播出去（供 crud.js 填充下拉框
// /做改前改后对比，见 C6）。
//
// 计时档案（2026-08-01 任务单 R5-R10）：只读展示 GET /api/core/events 返回的
// session.completed 事实，**不加计时按钮**（那是 ring 模块的活）。
// 双轨（2026-08-08 cockpit-v1 任务单 F-TABLE-1）：数据来自 GET /api/core/views/gantt
// （既有投影，见 data.js fetchGantt 注释），与 tree 分开拉、分开渲染失败态——
// gantt 拉失败不该拖垮整棵树的展示，只是那几个项目卡的双轨退化成"未定计划"外观
// （renderRails 对 state.gantt 为 null/查不到都有兜底，不崩）。
(function () {
  "use strict";

  var D = window.NexusTableData;
  var Rails = window.NexusTableRails;
  var PAGE_SIZE = 3;

  // F-ACTOR-3：控制台的项目卡/任务行角标，数据源是 gtd-app.js 维护的 lastWriter
  // 缓存（views/tree 本身不带这个字段——见 gtd-data.js 文件头注释 4 的详细理由）。
  // 用 typeof 防御式判断而不是硬依赖：gtd-app.js 未加载时（理论上不会发生，
  // 但防御一下比让整页面因为一个可选装饰功能崩掉更便宜）本函数安静地不画角标，
  // 其余渲染逻辑不受影响。
  function aiBadge(kind, id) {
    var G = window.NexusTableGtdData;
    var App = window.NexusTableApp;
    if (!G || !App || typeof App.getLastWriterMap !== "function") return "";
    var map = App.getLastWriterMap(kind);
    return G.isAiWritten(map, id) ? '<span class="ai-badge" title="上次由 AI 写入（lastWriter=ai）">🤖</span>' : "";
  }
  var state = { tree: null, page: 0, source: "none", error: null };
  var archiveState = { rawItems: [], total: 0, offset: 0, error: null, loaded: false };
  // gantt 双轨数据：{ byProjectId, today } 或 null（还没加载完 / 加载失败）。
  var ganttState = { byProjectId: {}, today: null, loaded: false };

  var $ = function (selector) { return document.querySelector(selector); };

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char];
    });
  }

  function formatDeadline(deadline) {
    // R8：deadline 是 YYYY-MM-DD 或 null，直接展示，不做额外计算
    return deadline ? "DUE // " + deadline : "DUE // 未设定";
  }

  function getPages(zones) {
    var pages = [];
    for (var i = 0; i < zones.length; i += PAGE_SIZE) {
      pages.push(zones.slice(i, i + PAGE_SIZE));
    }
    return pages.length ? pages : [[]];
  }

  function renderFlags(flags) {
    // R7：flags 只读不解释——原样展示成不可交互的标签，不按值分支
    if (!flags || !flags.length) return "";
    return '<span class="tag-row">' + flags.map(function (flag) {
      return '<span class="tag" title="flag（只读，前端不解释含义）">' + escapeHtml(flag) + "</span>";
    }).join("") + "</span>";
  }

  // 项目头部的 chip：计划期日期范围 + 已结束（琥珀，不标红）/ 未定计划。
  // rail 来自 Rails.computeProjectRail()，见文件头注释。
  function renderProjectChips(rail) {
    if (!rail.hasPlan) return '<span class="chip">未定计划</span>';
    // 日期本应是后端 YYYY-MM-DD 的规整形状，仍过 escapeHtml——本文件里"拼进
    // innerHTML 的动态值都过 escapeHtml()"没有例外（既有纪律，见 handoff.md）。
    var range = '<span class="chip plan">计划 ' + escapeHtml(Rails.formatMonthDay(rail.start)) +
      " → " + escapeHtml(Rails.formatMonthDay(rail.end)) + "</span>";
    var endedBadge = rail.ended ? '<span class="chip warn">已结束</span>' : "";
    return range + endedBadge;
  }

  // 双轨本体（F-TABLE-1）：紫轨=计划期已走比例，青轨=有事实天数比例。
  // 无计划期：两轨都空轨 + "还没有计划期"（设计稿 §4 原文）。
  function renderRails(rail) {
    if (!rail.hasPlan) {
      return '<div class="rails">' +
        '<div class="rail plan"></div>' +
        '<div class="rail fact"></div>' +
        '<div class="rail-cap"><span>还没有计划期</span><span class="mono">事实 ' +
          rail.factDaysTotal + " 天</span></div>" +
      "</div>";
    }
    return '<div class="rails">' +
      '<div class="rail plan"><div class="fill" style="width:' + rail.planRatio + '%"></div></div>' +
      '<div class="rail fact"><div class="fill" style="width:' + rail.factRatio + '%"></div></div>' +
      '<div class="rail-cap"><span>' + escapeHtml(Rails.formatPlanCaption(rail)) + "</span>" +
        '<span class="mono">' + escapeHtml(Rails.formatFactCaption(rail)) + "</span></div>" +
    "</div>";
  }

  function renderTask(task) {
    var kindBadge = task.kind === "ephemeral" ? '<span class="task-kind">临时</span>' : "";
    var checked = task.done ? " checked" : "";
    return '<div class="task ' + (task.done ? "done" : "") + '">' +
      '<input type="checkbox" class="task-check" data-action="toggle-task" ' +
        'data-task-id="' + escapeHtml(task.id) + '" aria-label="切换完成状态"' + checked + ">" +
      '<span class="task-name">' + escapeHtml(task.name) + aiBadge("task", task.id) + "</span>" +
      kindBadge + renderFlags(task.flags) +
      // F-TABLE-2：播放钮跳计时页并带任务预选，不在本模块起表（点击处理见 crud.js）。
      '<button type="button" class="task-go" data-action="go-task" ' +
        'data-task-id="' + escapeHtml(task.id) + '" aria-label="对这个任务开始计时（跳转到计时页）">' +
        '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">' +
        '<path d="M4 2.5v9l7-4.5-7-4.5Z"/></svg></button>' +
      '<button type="button" class="task-edit" data-action="edit-task" ' +
        'data-task-id="' + escapeHtml(task.id) + '" aria-label="编辑任务">✎</button>' +
      // 补登（2026-08-19，backfill.js）：给「完成了但没计时」的历史段补一条真实
      // 记录，对接 nexus-core POST /api/core/timer/backfill（契约 v1.8）。
      '<button type="button" class="task-backfill" data-action="backfill-task" ' +
        'data-task-id="' + escapeHtml(task.id) + '" aria-label="给这个任务补登一段时间">补登</button>' +
      "</div>";
  }

  function renderProject(project, zonesById) {
    var tasks = project.tasks || [];
    var color = D.deriveProjectColor(project, zonesById);
    var icon = D.deriveProjectIcon(project);
    var progress = Number(project.progress || 0);
    var manualBadge = project.progressSource === "manual"
      ? '<span class="progress-manual" title="人工覆盖值，后端原样返回不重算">人工</span>' : "";
    var taskHtml = tasks.length
      ? tasks.map(renderTask).join("")
      : '<div class="tasks-empty">暂无任务</div>';
    var ganttProject = ganttState.byProjectId[project.id];
    var rail = Rails.computeProjectRail(ganttProject, ganttState.today || "");

    return '<article class="project" style="--project:' + escapeHtml(color) + '">' +
      '<button type="button" class="project-edit" data-action="edit-project" ' +
        'data-project-id="' + escapeHtml(project.id) + '" aria-label="编辑项目">✎</button>' +
      '<div class="project-top">' +
        '<div class="project-icon">' + escapeHtml(icon) + "</div>" +
        '<div class="project-copy">' +
          '<div class="project-name" title="' + escapeHtml(project.name) + '">' + escapeHtml(project.name) +
            aiBadge("project", project.id) + "</div>" +
          '<div class="project-chips">' + renderProjectChips(rail) + "</div>" +
        "</div>" +
      "</div>" +
      renderRails(rail) +
      '<div class="progress-row">' +
        '<div class="progress-track"><span style="width:' + progress + '%"></span></div>' +
        '<span class="progress-number">' + progress + "%" + manualBadge + "</span>" +
      "</div>" +
      '<div class="tasks">' + taskHtml + "</div>" +
      '<button type="button" class="zone-add" data-action="add-task" ' +
        'data-project-id="' + escapeHtml(project.id) + '">＋ 新建任务</button>' +
    "</article>";
  }

  function renderZone(zone, absoluteIndex, projectsByZone, zonesById) {
    var projects = projectsByZone[zone.id] || [];
    var cards = projects.length
      ? projects.map(function (p) { return renderProject(p, zonesById); }).join("")
      : '<div class="empty-zone">暂无项目</div>';

    return '<section class="zone" style="--zone:' + escapeHtml(zone.color || "var(--accent)") + '">' +
      '<div class="zone-head">' +
        '<div class="zone-ident">' +
          '<div class="zone-index">' + String(absoluteIndex + 1).padStart(2, "0") + "</div>" +
          '<div><div class="zone-name">' + escapeHtml(zone.name) + '</div><div class="zone-meta">' +
            String(projects.length).padStart(2, "0") + " 个项目</div></div>" +
        "</div>" +
        '<button type="button" class="zone-menu" data-action="edit-zone" ' +
          'data-zone-id="' + escapeHtml(zone.id) + '" aria-label="编辑分区">⌁</button>' +
      "</div>" +
      '<div class="project-grid">' + cards + "</div>" +
      '<button type="button" class="zone-add" data-action="add-project" ' +
        'data-zone-id="' + escapeHtml(zone.id) + '">＋ 在' + escapeHtml(zone.name) + "新建项目</button>" +
    "</section>";
  }

  function groupProjectsByZone(projects) {
    var map = {};
    (projects || []).forEach(function (project) {
      (map[project.zoneId] = map[project.zoneId] || []).push(project);
    });
    return map;
  }

  function renderStatusBanner() {
    var el = $("#statusBanner");
    if (state.source === "cache") {
      el.textContent = "⚠ 离线/缓存数据 — 网络请求失败，正在展示上次成功获取的数据（" +
        (D.readCacheTimestamp(window.localStorage) || "时间未知") + "）";
      el.classList.add("show");
    } else if (state.source === "none" && state.error) {
      el.textContent = "⚠ 无法连接服务，且没有可用的缓存数据";
      el.classList.add("show");
    } else {
      el.classList.remove("show");
      el.textContent = "";
    }
  }

  function render() {
    renderStatusBanner();
    var tree = state.tree || { zones: [], projects: [] };
    var zones = tree.zones || [];
    var projects = tree.projects || [];
    var zonesById = D.indexZonesById(zones);
    var projectsByZone = groupProjectsByZone(projects);

    if (D.isEmptyTree(tree)) {
      $("#zoneGrid").innerHTML = '<div class="empty-board">暂无分区/项目数据。</div>';
      $("#pageLabel").textContent = "00 / 00";
      $("#pageMeta").textContent = "第 00 页";
      $("#previousPage").disabled = true;
      $("#nextPage").disabled = true;
    } else {
      var pages = getPages(zones);
      state.page = Math.max(0, Math.min(state.page, pages.length - 1));
      var visible = pages[state.page];
      var offset = state.page * PAGE_SIZE;
      $("#zoneGrid").innerHTML = visible.map(function (zone, index) {
        return renderZone(zone, offset + index, projectsByZone, zonesById);
      }).join("");
      $("#pageLabel").textContent = String(state.page + 1).padStart(2, "0") + " / " + String(pages.length).padStart(2, "0");
      $("#pageMeta").textContent = "第 " + String(state.page + 1).padStart(2, "0") + " 页";
      $("#previousPage").disabled = state.page === 0;
      $("#nextPage").disabled = state.page >= pages.length - 1;
    }

    var summary = D.computeSummary(tree);
    // v0.1 发布版的首页没有那一排指标卡（人类：「这一栏去掉」），
    // 所以这里按"元素不在就跳过"写 —— 开发版有卡片时照旧更新，两边共用同一段代码。
    var mProj = $("#projectCount"), mRatio = $("#taskRatio"), mProg = $("#averageProgress");
    if (mProj) mProj.innerHTML = summary.projectCount + " <small>项</small>";
    if (mRatio) mRatio.textContent = summary.taskDone + "/" + summary.taskTotal;
    if (mProg) mProg.textContent = summary.avgProgress + "%";

    renderArchive();
  }

  // ── 计时档案（R5-R10）──────────────────────────────────────────────
  // 名字解析用 state.tree（可能比档案条目更新，也可能还没加载完——
  // D.mapArchiveEvent 对 tree=null 或查不到都有兜底，见 data.js R7 注释）。
  function renderArchive() {
    var list = $("#archiveList");
    var moreBtn = $("#archiveLoadMore");
    if (!list || !moreBtn) return; // 防御：极端情况下 DOM 未就绪

    if (!archiveState.loaded) {
      // 首次请求还没返回：保留 HTML 里的初始占位文案，不提前判定成"空档案"。
      list.innerHTML = '<li class="archive-empty">加载中…</li>';
      moreBtn.hidden = true;
      return;
    }
    if (archiveState.error) {
      list.innerHTML = '<li class="archive-empty">⚠ 档案加载失败：' + escapeHtml(archiveState.error) + "</li>";
      moreBtn.hidden = true;
      return;
    }
    if (!archiveState.rawItems.length) {
      // R9：空档案是友好空态，不是错误
      list.innerHTML = '<li class="archive-empty">暂无计时档案，完成一段计时后会出现在这里。</li>';
      moreBtn.hidden = true;
      return;
    }
    list.innerHTML = archiveState.rawItems.map(function (event) {
      var entry = D.mapArchiveEvent(event, state.tree);
      return '<li class="archive-entry">' + escapeHtml(entry.summary) + "</li>";
    }).join("");
    moreBtn.hidden = archiveState.rawItems.length >= archiveState.total;
  }

  // reset=true：从头拉（初次加载/点刷新）；reset=false：追加下一页（R8 limit/offset）。
  function loadArchive(reset) {
    if (reset) {
      archiveState.offset = 0;
      archiveState.rawItems = [];
      archiveState.total = 0;
    }
    return D.fetchArchive({ limit: D.ARCHIVE_DEFAULT_LIMIT, offset: archiveState.offset }).then(function (result) {
      archiveState.loaded = true;
      if (!result.ok) {
        archiveState.error = result.message;
        renderArchive();
        return;
      }
      archiveState.error = null;
      var payload = result.data || {};
      var items = payload.items || [];
      archiveState.rawItems = archiveState.rawItems.concat(items);
      archiveState.total = payload.total || 0;
      archiveState.offset += items.length;
      renderArchive();
    });
  }

  // ── 双轨数据（F-TABLE-1）──────────────────────────────────────────
  // 独立于 tree 加载，失败不影响其余展示——renderRails 对查不到的项目按
  // "未定计划"外观兜底（Rails.computeProjectRail 拿到 undefined 时同样返回
  // hasPlan:false，不需要在这里特判）。
  function loadGantt() {
    return D.fetchGantt().then(function (result) {
      ganttState.loaded = true;
      if (!result.ok) {
        // 静默降级：不拿双轨数据不该把整页拖成错误态，项目卡就照"未定计划"展示。
        ganttState.byProjectId = {};
        ganttState.today = null;
        return;
      }
      var payload = result.data || {};
      ganttState.byProjectId = Rails.indexGanttByProjectId(payload.projects);
      ganttState.today = payload.today || null;
      render(); // gantt 数据可能比 tree 晚到，到了要补一次渲染让双轨显示出来
    });
  }

  // ── 导出数据（顶栏「导出数据」按钮，只读，contract.md v1.3）─────────
  // 惰性：点了才拉，不在 load() 里跟着首屏一起请求——导出是偶发动作，不该
  // 让每次刷新都多打一条全量请求。404/未上线（含端点不存在时网关本身返回
  // 的 404，或连不上时的网络失败）统一归一成「导出端点未就绪」文案，
  // 不 throw、不 console，D.fetchExport 走跟其余写操作同款的 request()，
  // 已经保证「从不 reject」。
  function downloadExport(payload) {
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = D.exportFileName(payload && payload.exportedAt);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function loadExport() {
    var shell = $("#exportShell");
    var status = $("#exportStatus");
    var pre = $("#exportPre");
    var downloadBtn = $("#exportDownload");
    if (!shell || !status || !pre || !downloadBtn) return; // 防御：DOM 未就绪

    shell.hidden = false;
    status.textContent = "正在导出…";
    pre.hidden = true;
    downloadBtn.hidden = true;

    return D.fetchExport().then(function (result) {
      if (!result.ok) {
        // 404（端点不存在）与 0（连不上，同样视为"未就绪"）给统一提示；
        // 其余状态码（如 500）如实展示后端消息，不伪装成"未就绪"。
        status.textContent = (result.status === 404 || result.status === 0)
          ? "⚠ 导出端点未就绪"
          : "⚠ 导出失败：" + result.message;
        return;
      }
      var payload = result.data || {};
      status.textContent = "导出于 " + (payload.exportedAt || "未知时间");
      pre.hidden = false;
      pre.textContent = JSON.stringify(payload, null, 2);
      downloadBtn.hidden = false;
      downloadBtn.onclick = function () { downloadExport(payload); };
    });
  }

  // crud.js 监听最新 tree（填下拉框、算改前改后 diff，见 C6），不重复发请求。
  var treeListeners = [];
  function notifyTreeListeners() {
    treeListeners.forEach(function (fn) { fn(state.tree); });
  }

  function load() {
    // R6：includeEphemeral 默认 false，上游没有对应开关，本任务不补（升级条款允许跳过）
    // C2：写操作完成后 crud.js 调用本函数重新拉取 views/tree，不做本地乐观更新。
    return D.fetchTree({ includeEphemeral: false }).then(function (result) {
      state.tree = result.tree;
      state.source = result.source;
      state.error = result.error || null;
      state.page = 0;
      render();
      notifyTreeListeners();
    });
  }

  function updateClock() {
    var now = new Date();
    var clockEl = $("#clock");
    var todayEl = $("#today");
    if (clockEl) clockEl.textContent = now.toLocaleTimeString("zh-CN", { hour12: false });
    if (todayEl) {
      todayEl.textContent = now.toLocaleDateString("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit", weekday: "short"
      });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("#previousPage").addEventListener("click", function () { state.page -= 1; render(); });
    $("#nextPage").addEventListener("click", function () { state.page += 1; render(); });
    $("#refreshTree").addEventListener("click", function () { load(); loadArchive(true); loadGantt(); });
    $("#archiveLoadMore").addEventListener("click", function () { loadArchive(false); });
    $("#exportData").addEventListener("click", function () { loadExport(); });

    updateClock();
    window.setInterval(updateClock, 1000);
    // 先拉树再拉档案：mapArchiveEvent 现查任务/项目名字要用 state.tree（R7），
    // 树先到位能让档案首次渲染就带上正确名字，不用等第二次 render() 才补上。
    // gantt 独立并行拉，到了自己触发一次补渲染（见 loadGantt 注释）。
    load().then(function () { return loadArchive(true); });
    loadGantt();
  });

  // crud.js 通过这个小接口接入：refresh() 供写操作成功后调用（C2），
  // onTreeChange() 订阅最新 tree（立即补发一次当前值，晚注册也不丢）。
  // rerender()（gtd-v1 波2-B 新增）：不重新拉网络，只用当前已有的 state 重画一次——
  // 供 gtd-app.js 在 lastWriter 角标缓存刷新后触发一次纯本地重渲染（同 loadGantt
  // 拿到数据后调 render() 补一次渲染同一个模式，只是搬到跨文件接口上）。
  window.NexusTableApp = {
    refresh: load,
    rerender: render,
    onTreeChange: function (fn) {
      treeListeners.push(fn);
      if (state.tree) fn(state.tree);
    }
  };
}());
