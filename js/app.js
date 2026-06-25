/**
 * app.js — Heritage Analysis 主控制器
 * 三级视图切换 (L1省概览 → L2省详情 → L3博物馆详情)
 * 数据加载、内存管理、搜索/排序/过滤
 */
import { fetchJSON, headRequest, formatAmount, formatDate, generateTagBadges, escapeHTML, truncate, debounce, sortByAmount, sortByDate, filterByTag } from "./utils.js";

// ═══ State ═══
const AppState = {
  currentView: "national",    // "national" | "province" | "museum"
  currentProvince: null,      // 省份名 string
  currentMuseum: null,        // 博物馆名 string

  allProvinces: null,         // summary/all_provinces.json 数据 (常驻)
  provinceData: null,         // 当前省 summary.json + charts.json (驻留)
  museumData: null,           // 当前博物馆 projects.json (驻留)

  versionInfo: null,          // data/version.json
  versionCheckTimer: null,    // 5分钟轮询timer
};

// ═══ DOM Refs ═══
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const viewNational = $("#view-national");
const viewProvince = $("#view-province");
const viewMuseum = $("#view-museum");
const breadcrumb = $("#breadcrumb");
const loading = $("#loading");
const toast = $("#toast");

// ═══ View Switching ═══
function showView(viewName) {
  AppState.currentView = viewName;
  viewNational.classList.toggle("active", viewName === "national");
  viewProvince.classList.toggle("active", viewName === "province");
  viewMuseum.classList.toggle("active", viewName === "museum");
  updateBreadcrumb();

  // 通知 chat.js 视图已切换
  window.dispatchEvent(new CustomEvent("viewChanged", {
    detail: { view: viewName, province: AppState.currentProvince, museum: AppState.currentMuseum }
  }));
}

function updateBreadcrumb() {
  let html = '<span class="crumb' + (AppState.currentView === "national" ? " active" : "") + '" data-nav="national">全国概览</span>';
  if (AppState.currentProvince) {
    html += '<span class="crumb' + (AppState.currentView === "province" ? " active" : "") + '" data-nav="province">' + escapeHTML(AppState.currentProvince) + '</span>';
  }
  if (AppState.currentMuseum) {
    html += '<span class="crumb active" data-nav="museum">' + escapeHTML(AppState.currentMuseum) + '</span>';
  }
  breadcrumb.innerHTML = html;

  // 面包屑导航点击
  breadcrumb.querySelectorAll(".crumb").forEach(el => {
    el.addEventListener("click", () => {
      const nav = el.dataset.nav;
      if (nav === "national") goToNational();
      else if (nav === "province" && AppState.currentProvince) goToProvince(AppState.currentProvince);
    });
  });
}

// ═══ Navigation ═══
function goToNational() {
  AppState.currentMuseum = null;
  AppState.currentProvince = null;
  clearProvinceData();
  showView("national");
  renderNationalView();
}

function goToProvince(provinceName) {
  if (!provinceName) return;
  // 只有当前已经在同一省份视图时才跳过
  if (AppState.currentView === "province" && provinceName === AppState.currentProvince) return;
  AppState.currentMuseum = null;
  AppState.museumData = null;
  clearProvinceData();
  AppState.currentProvince = provinceName;
  showView("province");
  loadProvinceData(provinceName);
}

function goToMuseum(museumName) {
  if (!museumName) return;
  AppState.currentMuseum = museumName;
  showView("museum");
  loadMuseumData(AppState.currentProvince, museumName);
}

// ═══ Data Loading ═══
async function loadAllProvinces() {
  if (AppState.allProvinces) {
    renderNationalView();
    return;
  }
  showLoading(true);
  try {
    const data = await fetchJSON("data/summary/all_provinces.json");
    AppState.allProvinces = data;
    updateGlobalStats(data);
    renderProvinceGrid(data.provinces || []);
  } catch (err) {
    showToast("无法加载省份数据: " + err.message);
    renderEmptyNational();
  } finally {
    showLoading(false);
  }
}

async function loadProvinceData(provinceName) {
  showLoading(true);
  try {
    const [summary, charts] = await Promise.all([
      fetchJSON(`data/${encodeURIComponent(provinceName)}/summary.json`).catch(() => null),
      fetchJSON(`data/${encodeURIComponent(provinceName)}/charts.json`).catch(() => null),
    ]);
    AppState.provinceData = { summary, charts };
    renderProvinceView(summary, charts, provinceName);
  } catch (err) {
    showToast("无法加载省份数据: " + err.message);
  } finally {
    showLoading(false);
  }
}

async function loadMuseumData(provinceName, museumName) {
  if (!provinceName || !museumName) return;
  showLoading(true);
  try {
    const data = await fetchJSON(`data/${encodeURIComponent(provinceName)}/${encodeURIComponent(museumName)}/projects.json`);
    AppState.museumData = data;
    renderMuseumView(data);
  } catch (err) {
    showToast("无法加载博物馆数据: " + err.message);
  } finally {
    showLoading(false);
  }
}

function clearProvinceData() {
  AppState.provinceData = null;
  AppState.museumData = null;
  // 销毁图表实例 (charts.js 提供)
  if (typeof ChartsManager !== "undefined" && ChartsManager.disposeAll) {
    ChartsManager.disposeAll();
  }
}

// ═══ L1: National View Rendering ═══
function updateGlobalStats(data) {
  const provinces = data.provinces || [];
  const totalProjects = provinces.reduce((s, p) => s + (p.total_projects || 0), 0);
  const totalAmount = provinces.reduce((s, p) => s + (p.total_amount || 0), 0);
  const totalMuseums = provinces.reduce((s, p) => s + (p.total_museums || 0), 0);
  const totalSuppliers = provinces.reduce((s, p) => s + (p.total_suppliers || 0), 0);

  $("#stat-projects").textContent = totalProjects.toLocaleString();
  $("#stat-amount").textContent = formatAmount(totalAmount);
  $("#stat-museums").textContent = totalMuseums.toLocaleString();
  $("#stat-suppliers").textContent = totalSuppliers.toLocaleString();
}

function renderProvinceGrid(provinces) {
  const grid = $("#province-grid");
  if (!provinces || provinces.length === 0) {
    grid.innerHTML = '<div class="loading">暂无省份数据。请先运行 scraper/build_data_files.py 生成数据文件。</div>';
    return;
  }

  grid.innerHTML = provinces.map(p => `
    <div class="province-card" data-province="${escapeHTML(p.province)}">
      <h3>${escapeHTML(p.province)}</h3>
      <div class="card-meta">
        <span>📋 ${p.total_projects || 0} 个项目</span>
        <span class="card-amount">💰 ${formatAmount(p.total_amount)}</span>
      </div>
      <div class="card-meta">
        <span>🏛️ ${p.total_museums || 0} 个博物馆</span>
        <span>🏭 ${p.total_suppliers || 0} 个供应商</span>
      </div>
    </div>
  `).join("");

  // 点击省份卡片 → 进入L2
  grid.querySelectorAll(".province-card").forEach(card => {
    card.addEventListener("click", () => {
      goToProvince(card.dataset.province);
    });
  });
}

function renderEmptyNational() {
  const grid = $("#province-grid");
  grid.innerHTML = '<div class="loading">暂无省份数据。请运行 <code>python scraper/build_data_files.py --input output/raw/</code> 生成数据。</div>';
}

function renderNationalView() {
  if (AppState.allProvinces) {
    updateGlobalStats(AppState.allProvinces);
    renderProvinceGrid(AppState.allProvinces.provinces || []);
  } else {
    loadAllProvinces();
  }
}

// ═══ L2: Province View Rendering ═══
function renderProvinceView(summary, charts, provinceName) {
  if (!summary) {
    $("#prov-title").textContent = provinceName + " — 无数据";
    return;
  }

  $("#prov-title").textContent = summary.province || provinceName;
  $("#pstat-projects").textContent = (summary.total_projects || 0).toLocaleString();
  $("#pstat-amount").textContent = formatAmount(summary.total_amount);
  $("#pstat-museums").textContent = (summary.total_museums || 0).toLocaleString();
  $("#pstat-suppliers").textContent = (summary.total_suppliers || 0).toLocaleString();

  // 渲染图表 (由 charts.js 处理)
  if (charts && typeof ChartsManager !== "undefined") {
    ChartsManager.renderProvinceCharts(charts);
  }

  // 渲染博物馆列表
  renderMuseumTable(summary);

  // 加载Gap数据
  loadGapData(provinceName);

  // Tab切换
  setupProvinceTabs();
}

function renderMuseumTable(summary) {
  const museums = summary.museums || [];
  const tbody = $("#museum-table tbody");
  if (!museums.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#888">暂无博物馆数据</td></tr>';
    return;
  }

  // 简化版: 用项目数等汇总信息构造表格行
  // 实际应从 summary.json 的 museum 字段获取; 这里用现有数据做快速渲染
  // v2: 使用 summary.museum_details 中的数据
  const details = summary.museum_details || {};
  tbody.innerHTML = museums.map(m => {
    const d = details[m] || {};
    const count = d.count || 0;
    const amount = d.amount ? d.amount.toFixed(2) + ' 万' : '—';
    const level = d.level || '—';
    const city = d.city || '—';
    const mainTags = (d.main_tags || []).join(', ') || '—';
    return `
      <tr class="clickable" data-museum="${escapeHTML(m)}">
        <td>${escapeHTML(m)}</td>
        <td>${escapeHTML(level)}</td>
        <td>${escapeHTML(city)}</td>
        <td>${count}</td>
        <td>${escapeHTML(amount)}</td>
        <td>${escapeHTML(mainTags)}</td>
      </tr>
    `;
  }).join("");

  // 点击行 → L3
  tbody.querySelectorAll("tr.clickable").forEach(row => {
    row.addEventListener("click", () => {
      goToMuseum(row.dataset.museum);
    });
  });
}

function setupProvinceTabs() {
  const tabs = $$("#view-province .tab-btn");
  const panels = $$("#view-province .tab-panel");

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      panels.forEach(p => p.classList.remove("active"));
      const target = $("#" + tab.dataset.tab);
      if (target) target.classList.add("active");
    });
  });
}

// ═══ Gap Tab (L2) ═══
async function loadGapData(provinceName) {
  try {
    const gap = await fetchJSON(`data/${encodeURIComponent(provinceName)}/gap.json`);
    renderGapView(gap);
  } catch (err) {
    const digitalized = $("#gap-digitalized-list");
    digitalized.innerHTML = '<div style="padding:16px;color:#888">暂无Gap分析数据。请运行 build_data_files.py (含museums.json) 生成。</div>';
  }
}

function renderGapView(gap) {
  if (!gap || !gap.matched && !gap.gap) {
    return;
  }

  // 已数字化
  const matched = gap.matched || [];
  $("#gap-digitalized-count").textContent = matched.length;
  $("#gap-digitalized-list").innerHTML = matched.slice(0, 50).map(m =>
    `<div class="gap-item"><span class="gap-name">${escapeHTML(m.name)}</span><span class="gap-meta">${escapeHTML(m.city||"")} · ${escapeHTML(m.level||"")}</span></div>`
  ).join("") + (matched.length > 50 ? `<div class="gap-item" style="color:#888">...还有 ${matched.length - 50} 条</div>` : "");

  // 待确认
  const uncertain = gap.uncertain || [];
  $("#gap-uncertain-count").textContent = uncertain.length;
  $("#gap-uncertain-list").innerHTML = uncertain.map(m =>
    `<div class="gap-item"><span class="gap-name">${escapeHTML(m.name)}</span><span class="gap-meta">匹配: ${escapeHTML(m.match?.buyer || "")} (${m.match?.confidence || "low"})</span><button class="gap-btn" data-action="confirm" data-name="${escapeHTML(m.name)}">确认</button><button class="gap-btn" data-action="exclude" data-name="${escapeHTML(m.name)}">排除</button></div>`
  ).join("");

  // Gap目标
  const gapItems = gap.gap || [];
  $("#gap-target-count").textContent = gapItems.length;
  $("#gap-target-list").innerHTML = gapItems.map(m =>
    `<div class="gap-item"><span class="gap-name">${escapeHTML(m.name)}</span><span class="gap-meta">${escapeHTML(m.city||"")} · ${escapeHTML(m.level||"")} · ${escapeHTML(m.type||"")}</span></div>`
  ).join("");
}

// ═══ L3: Museum View Rendering ═══
function renderMuseumView(data) {
  if (!data) return;

  $("#museum-title").textContent = data.museum || "—";

  // 信息卡片
  const projects = data.projects || [];
  const totalAmount = projects.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const tagSet = new Set();
  projects.forEach(p => (p.tags || []).forEach(t => tagSet.add(t)));

  $("#museum-info").innerHTML = `
    <div class="info-item"><div class="info-label">省份</div><div class="info-value">${escapeHTML(data.province||"—")}</div></div>
    <div class="info-item"><div class="info-label">城市</div><div class="info-value">${escapeHTML(data.city||"—")}</div></div>
    <div class="info-item"><div class="info-label">项目数</div><div class="info-value">${projects.length}</div></div>
    <div class="info-item"><div class="info-label">总金额</div><div class="info-value">${formatAmount(totalAmount)}</div></div>
    <div class="info-item"><div class="info-label">业务标签</div><div class="info-value">${generateTagBadges([...tagSet]) || "—"}</div></div>
  `;

  // 标签筛选下拉
  const filterSelect = $("#project-tag-filter");
  filterSelect.innerHTML = '<option value="">全部类型</option>' +
    [...tagSet].map(t => `<option value="${escapeHTML(t)}">${escapeHTML(t)}</option>`).join("");

  // 渲染项目表格
  renderProjectTable(projects);

  // 搜索/排序/筛选 事件
  setupProjectControls(projects);

  // 返回按钮
  $("#back-to-province").onclick = () => goToProvince(AppState.currentProvince);
}

function renderProjectTable(projects, filtered = null) {
  const items = filtered || projects;
  const tbody = $("#project-table tbody");

  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#888">暂无项目数据</td></tr>';
    return;
  }

  tbody.innerHTML = items.map((p, i) => `
    <tr class="clickable" data-index="${i}" data-title="${escapeHTML(p.title)}">
      <td>${truncate(escapeHTML(p.title), 50)}</td>
      <td>${formatAmount(p.amount)}</td>
      <td>${truncate(escapeHTML(p.supplier), 18) || "—"}</td>
      <td>${generateTagBadges(p.tags)}</td>
      <td>${formatDate(p.date)}</td>
    </tr>
  `).join("");

  // 点击行 → 展开详情
  tbody.querySelectorAll("tr.clickable").forEach(row => {
    row.addEventListener("click", () => {
      const idx = parseInt(row.dataset.index);
      showProjectDetail(items[idx]);
      // 高亮当前行
      tbody.querySelectorAll("tr").forEach(r => r.classList.remove("expanded"));
      row.classList.add("expanded");
    });
  });
}

function showProjectDetail(project) {
  if (!project) return;
  const detail = $("#project-detail");
  const content = $("#project-detail-content");

  content.innerHTML = `
    <p><span class="detail-label">标题:</span> ${escapeHTML(project.title)}</p>
    <p><span class="detail-label">发布时间:</span> ${formatDate(project.date)}</p>
    <p><span class="detail-label">公告类型:</span> ${escapeHTML(project.bid_type || "—")}</p>
    <p><span class="detail-label">采购人:</span> ${escapeHTML(project.supplier_addr ? project.supplier : (data?.museum || "—"))}</p>
    <p><span class="detail-label">供应商:</span> ${escapeHTML(project.supplier || "—")}</p>
    <p><span class="detail-label">供应商地址:</span> ${escapeHTML(project.supplier_addr || "—")}</p>
    <p><span class="detail-label">代理机构:</span> ${escapeHTML(project.agent || "—")}</p>
    <p><span class="detail-label">中标金额:</span> ${formatAmount(project.amount)}</p>
    <p><span class="detail-label">标签:</span> ${generateTagBadges(project.tags)}</p>
    <p><span class="detail-label">原文链接:</span> <a class="detail-link" href="${escapeHTML(project.url)}" target="_blank" rel="noopener">${escapeHTML(project.url)}</a></p>
    <p><span class="detail-label">数据来源:</span> ${escapeHTML(project.source || "—")}</p>
  `;
  detail.classList.remove("hidden");
}

function setupProjectControls(allProjects) {
  const searchInput = $("#project-search");
  const tagFilter = $("#project-tag-filter");
  const sortSelect = $("#project-sort");

  const refreshTable = () => {
    let filtered = [...allProjects];

    // 搜索过滤
    const q = searchInput.value.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter(p => (p.title || "").toLowerCase().includes(q));
    }

    // 标签过滤
    const tag = tagFilter.value;
    if (tag) {
      filtered = filtered.filter(p => (p.tags || []).includes(tag));
    }

    // 排序
    const sort = sortSelect.value;
    if (sort === "amount-desc") filtered.sort(sortByAmount);
    else if (sort === "date-desc") filtered.sort(sortByDate);
    else if (sort === "title-asc") filtered.sort((a, b) => (a.title || "").localeCompare(b.title || ""));

    renderProjectTable(allProjects, filtered);
  };

  searchInput.addEventListener("input", debounce(refreshTable, 300));
  tagFilter.addEventListener("change", refreshTable);
  sortSelect.addEventListener("change", refreshTable);
}

// ═══ Data Refresh ═══
async function checkVersion() {
  try {
    const resp = await headRequest("data/version.json", 5000);
    if (resp && resp.ok) {
      const json = await fetchJSON("data/version.json", { retries: 0 });
      if (json && AppState.versionInfo && json.timestamp !== AppState.versionInfo.timestamp) {
        showToast("📡 数据已更新，点击刷新按钮加载最新数据");
      }
      AppState.versionInfo = json;
      if (json) {
        $("#update-time").textContent = "数据更新: " + (json.updated_at || "—");
      }
    }
  } catch (e) {
    // 静默失败
  }
}

function startVersionPolling() {
  checkVersion();
  AppState.versionCheckTimer = setInterval(checkVersion, 5 * 60 * 1000);
}

// ═══ Loading / Toast ═══
function showLoading(show) {
  loading.classList.toggle("hidden", !show);
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 3000);
}

// ═══ Init ═══
function init() {
  // 面包屑导航
  document.getElementById("home-btn").addEventListener("click", goToNational);

  // 刷新按钮
  $("#refresh-btn").addEventListener("click", () => {
    AppState.allProvinces = null;
    AppState.provinceData = null;
    AppState.museumData = null;
    if (AppState.currentView === "national") loadAllProvinces();
    else if (AppState.currentView === "province" && AppState.currentProvince) loadProvinceData(AppState.currentProvince);
    else if (AppState.currentView === "museum" && AppState.currentProvince && AppState.currentMuseum) loadMuseumData(AppState.currentProvince, AppState.currentMuseum);
  });

  // 启动
  loadAllProvinces();
  startVersionPolling();
}

// 导出给 chat.js / charts.js 使用
window.AppState = AppState;
window.goToNational = goToNational;
window.goToProvince = goToProvince;
window.goToMuseum = goToMuseum;

document.addEventListener("DOMContentLoaded", init);
