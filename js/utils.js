/**
 * utils.js — 工具函数
 * heritage-analysis 前端公共模块
 */

const TAG_COLORS = {
  "三维扫描":       { bg: "#d6eaf8", text: "#2980b9", border: "#3498db" },
  "摄影测量":       { bg: "#d4e6f1", text: "#1a5276", border: "#2980b9" },
  "数字归档":       { bg: "#d1f2eb", text: "#0e6655", border: "#1abc9c" },
  "GIS制图":        { bg: "#d0ece7", text: "#0b5345", border: "#16a085" },
  "数字孪生":       { bg: "#d5f5e3", text: "#145a32", border: "#27ae60" },
  "虚拟展陈":       { bg: "#fdebd0", text: "#935116", border: "#e67e22" },
  "AR/VR/MR":       { bg: "#fadbd8", text: "#7b241c", border: "#e74c3c" },
  "AI应用":         { bg: "#e8daef", text: "#512e5f", border: "#8e44ad" },
  "藏品管理":       { bg: "#d5d8dc", text: "#1b2631", border: "#2c3e50" },
  "文化遗产数据库": { bg: "#fef5e7", text: "#7d6608", border: "#f39c12" },
  "智慧博物馆":    { bg: "#fae5d3", text: "#6e2c00", border: "#d35400" },
  "数字保护":       { bg: "#f2d7d5", text: "#641e16", border: "#c0392b" },
};

/** 生成彩色标签徽章HTML */
function generateTagBadge(tag) {
  const colors = TAG_COLORS[tag] || { bg: "#eee", text: "#333", border: "#999" };
  return `<span class="tag-badge" style="background:${colors.bg};color:${colors.text};border:1px solid ${colors.border}">${escapeHTML(tag)}</span>`;
}

/** 生成标签列表HTML */
function generateTagBadges(tags) {
  if (!tags || !tags.length) return '<span class="tag-empty">—</span>';
  return tags.map(generateTagBadge).join(" ");
}

/** 格式化金额 (万元 → 带单位) */
function formatAmount(amount) {
  if (amount === null || amount === undefined || amount === "" || amount === 0) return "—";
  const n = parseFloat(amount);
  if (isNaN(n)) return "—";
  if (n >= 10000) return `${(n / 10000).toFixed(2)} 亿`;
  return `${n.toFixed(2)} 万`;
}

/** 格式化日期 */
function formatDate(dateStr) {
  if (!dateStr) return "—";
  // 统一转为 yyyy-mm-dd
  const m = dateStr.match(/(\d{4})[/.年-](\d{1,2})[/.月-](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  return dateStr.substring(0, 10);
}

/** HTML转义 */
function escapeHTML(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

/** 截断文本 */
function truncate(str, maxLen) {
  if (!str) return "";
  return str.length > maxLen ? str.substring(0, maxLen) + "…" : str;
}

/** 防抖 */
function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/** 节流 */
function throttle(fn, interval) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last >= interval) {
      last = now;
      fn.apply(this, args);
    }
  };
}

/** 带超时和重试的 fetch JSON */
async function fetchJSON(url, options = {}) {
  const { timeout = 10000, retries = 2 } = options;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const resp = await fetch(url, { signal: controller.signal, headers: { "Accept": "application/json" } });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`fetchJSON retry ${attempt + 1}/${retries}: ${url}`, err.message);
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

/** HEAD请求获取响应头 */
async function headRequest(url, timeout = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

/** 按金额从高到低排序 */
function sortByAmount(a, b) {
  const va = parseFloat(a.amount) || 0;
  const vb = parseFloat(b.amount) || 0;
  return vb - va;
}

/** 按日期从新到旧排序 */
function sortByDate(a, b) {
  const da = a.date || "";
  const db = b.date || "";
  return db.localeCompare(da);
}

/** 根据分类标签过滤项目 */
function filterByTag(projects, tag) {
  if (!tag || tag === "全部") return projects;
  return projects.filter(p => {
    const tags = p.tags || [];
    return tags.includes(tag);
  });
}

export {
  TAG_COLORS, generateTagBadge, generateTagBadges,
  formatAmount, formatDate, escapeHTML, truncate,
  debounce, throttle, fetchJSON, headRequest,
  sortByAmount, sortByDate, filterByTag
};
