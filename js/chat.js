/**
 * chat.js — AI悬浮球聊天模块
 * 拖拽、展开/收起、上下文绑定、对话历史管理、localStorage清理
 */

const CLOUDFLARE_WORKER_URL = "https://heritage-ai-proxy.daofansen.workers.dev/";
const MAX_HISTORY_ITEMS = 10;   // 每次发送给AI的上下文轮次
const MAX_STORAGE_ITEMS = 50;   // localStorage每上下文最多保留条数
const MS_PER_DAY = 86400000;

const ChatState = {
  minimized: true,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
  elemStartX: 0,
  elemStartY: 0,
  bubbleEl: null,
  panelEl: null,
  messagesEl: null,
  inputEl: null,
  chatHistory: [],        // 当前对话 [{role, content, timestamp}]
  contextId: "national",  // "national" | "province_XX" | "museum_XX"
  isLoading: false,
};

// ═══ Init ═══
function initChat() {
  // 创建悬浮球DOM
  createChatDOM();

  // 加载历史
  loadChatHistory();

  // 监听视图切换 (由 app.js 触发)
  window.addEventListener("viewChanged", (e) => {
    const { view, province, museum } = e.detail || {};
    onViewChanged(view, province, museum);
  });

  // 定时清理过期记录
  scheduleCleanup();
}

function createChatDOM() {
  const bubble = document.getElementById("chat-bubble");
  bubble.innerHTML = `
    <div id="chat-ball" class="chat-ball" title="AI分析助手">💬</div>
    <div id="chat-panel" class="chat-panel hidden">
      <div class="chat-titlebar" id="chat-titlebar">
        <span>AI 分析助手</span>
        <div class="chat-actions">
          <button id="chat-minimize" title="最小化">—</button>
          <button id="chat-close" title="关闭">✕</button>
        </div>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-box">
        <input type="text" id="chat-input" placeholder="输入问题…" />
        <button id="chat-send">发送</button>
      </div>
    </div>
  `;

  ChatState.bubbleEl = document.getElementById("chat-ball");
  ChatState.panelEl = document.getElementById("chat-panel");
  ChatState.messagesEl = document.getElementById("chat-messages");
  ChatState.inputEl = document.getElementById("chat-input");

  // 初始化位置: 右下角
  ChatState.bubbleEl.style.position = "fixed";
  ChatState.bubbleEl.style.right = "24px";
  ChatState.bubbleEl.style.bottom = "80px";
  ChatState.bubbleEl.style.top = "auto";
  ChatState.bubbleEl.style.left = "auto";

  ChatState.panelEl.style.position = "fixed";
  ChatState.panelEl.style.right = "24px";
  ChatState.panelEl.style.bottom = "80px";
  ChatState.panelEl.style.top = "auto";
  ChatState.panelEl.style.left = "auto";

  // 事件绑定
  setupChatEvents();
}

function setupChatEvents() {
  const bubble = ChatState.bubbleEl;
  const panel = ChatState.panelEl;
  const titlebar = document.getElementById("chat-titlebar");

  // 悬浮球: 点击 → 展开
  bubble.addEventListener("click", (e) => {
    if (ChatState.isDragging) return;
    toggleChat(true);
  });

  // 悬浮球: mousedown → 开始拖拽
  bubble.addEventListener("mousedown", (e) => {
    startDrag(e, bubble);
  });

  // 面板标题栏: mousedown → 开始拖拽面板
  titlebar.addEventListener("mousedown", (e) => {
    startDrag(e, panel);
  });

  // 最小化按钮
  document.getElementById("chat-minimize").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleChat(false);
  });

  // 关闭按钮
  document.getElementById("chat-close").addEventListener("click", (e) => {
    e.stopPropagation();
    if (ChatState.chatHistory.length && !confirm("关闭后将清空当前对话，确定吗？")) return;
    clearCurrentChat();
    toggleChat(false);
  });

  // 发送按钮
  document.getElementById("chat-send").addEventListener("click", sendMessage);

  // Enter发送
  ChatState.inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 全局 mouseup/mousemove 拖拽结束
  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup", onDragEnd);
}

// ═══ Drag ═══
function startDrag(e, elem) {
  ChatState.isDragging = true;
  ChatState.dragStartX = e.clientX;
  ChatState.dragStartY = e.clientY;

  const rect = elem.getBoundingClientRect();
  ChatState.elemStartX = rect.left;
  ChatState.elemStartY = rect.top;

  elem.classList.add("dragging");
}

function onDragMove(e) {
  if (!ChatState.isDragging) return;

  const dx = e.clientX - ChatState.dragStartX;
  const dy = e.clientY - ChatState.dragStartY;

  let newLeft = ChatState.elemStartX + dx;
  let newTop = ChatState.elemStartY + dy;

  const panel = ChatState.panelEl;
  const bubble = ChatState.bubbleEl;

  // 对当前活动元素应用位置
  const activeEl = ChatState.minimized ? bubble : panel;
  const elWidth = activeEl.offsetWidth;
  const elHeight = activeEl.offsetHeight;

  // 边界检测
  if (newLeft < 0) newLeft = 0;
  if (newTop < 0) newTop = 0;
  if (newLeft + elWidth > window.innerWidth) newLeft = window.innerWidth - elWidth;
  if (newTop + elHeight > window.innerHeight) newTop = window.innerHeight - elHeight;

  activeEl.style.left = newLeft + "px";
  activeEl.style.top = newTop + "px";
  activeEl.style.right = "auto";
  activeEl.style.bottom = "auto";
}

function onDragEnd() {
  if (!ChatState.isDragging) return;
  ChatState.isDragging = false;
  ChatState.bubbleEl.classList.remove("dragging");
  const titlebar = document.getElementById("chat-titlebar");
  if (titlebar) titlebar.classList.remove("dragging");
}

// ═══ Toggle ═══
function toggleChat(open) {
  ChatState.minimized = !open;
  ChatState.bubbleEl.style.display = open ? "none" : "flex";
  ChatState.panelEl.classList.toggle("hidden", !open);

  if (open) {
    // 面板同步悬浮球位置
    const top = ChatState.bubbleEl.style.top;
    const left = ChatState.bubbleEl.style.left;
    const right = ChatState.bubbleEl.style.right;
    const bottom = ChatState.bubbleEl.style.bottom;
    ChatState.panelEl.style.top = top !== "auto" ? top : "auto";
    ChatState.panelEl.style.left = left !== "auto" ? left : (right !== "auto" ? "auto" : "24px");
    ChatState.panelEl.style.right = right !== "auto" ? right : "auto";
    ChatState.panelEl.style.bottom = bottom !== "auto" ? bottom : "auto";
    ChatState.inputEl.focus();
  }
}

// ═══ Context Binding ═══
function onViewChanged(view, province, museum) {
  let newContextId = "national";
  if (view === "province" && province) {
    newContextId = "province_" + province;
  } else if (view === "museum" && province && museum) {
    newContextId = "museum_" + province + "_" + museum;
  }

  if (newContextId !== ChatState.contextId) {
    // 保存当前对话
    saveChatHistory();
    // 上下文切换消息
    const contextName = view === "national" ? "全国数据" : (view === "province" ? province : museum);
    const sysMsg = "📌 已切换到: " + contextName + "的数据范围";
    ChatState.contextId = newContextId;
    loadChatHistory();

    // 在当前对话中插入系统消息
    addSystemMessage(sysMsg);
  }
}

// ═══ Message Sending ═══
async function sendMessage() {
  const input = ChatState.inputEl;
  const text = input.value.trim();
  if (!text || ChatState.isLoading) return;

  input.value = "";
  addMessage("user", text);
  ChatState.isLoading = true;

  // 构建上下文数据
  const contextData = buildContextData();
  const history = ChatState.chatHistory.slice(-MAX_HISTORY_ITEMS);

  const payload = {
    question: text,
    context_type: ChatState.contextId.startsWith("museum") ? "museum" :
                 ChatState.contextId.startsWith("province") ? "province" : "national",
    context_id: ChatState.contextId,
    context_data: contextData,
    history: history.map(h => ({ role: h.role, content: h.content })),
  };

  try {
    const resp = await fetch(CLOUDFLARE_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const result = await resp.json();
    const reply = result.choices?.[0]?.message?.content || result.content || "抱歉，AI暂时无法回答。";

    addMessage("assistant", reply);
  } catch (err) {
    addMessage("assistant", "❌ 请求失败: " + (err.message || "网络错误"));
  } finally {
    ChatState.isLoading = false;
  }
}

function buildContextData() {
  // 从 AppState 获取当前视图数据
  const ctx = {};
  if (!window.AppState) return ctx;

  if (ChatState.contextId.startsWith("museum")) {
    const data = window.AppState.museumData;
    if (data) {
      ctx.museum = data.museum || "";
      ctx.province = data.province || "";
      ctx.city = data.city || "";
      ctx.total_projects = (data.projects || []).length;
      ctx.total_amount = (data.projects || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
      ctx.tags = [...new Set((data.projects || []).flatMap(p => p.tags || []))];
    }
  } else if (ChatState.contextId.startsWith("province")) {
    const summary = window.AppState.provinceData?.summary;
    if (summary) {
      ctx.province = summary.province || "";
      ctx.total_projects = summary.total_projects || 0;
      ctx.total_amount = summary.total_amount || 0;
      ctx.total_museums = summary.total_museums || 0;
      ctx.tag_distribution = summary.tag_distribution || {};
    }
  } else {
    const all = window.AppState.allProvinces;
    if (all) {
      ctx.total_provinces = (all.provinces || []).length;
      ctx.total_projects = (all.provinces || []).reduce((s, p) => s + (p.total_projects || 0), 0);
      ctx.total_amount = (all.provinces || []).reduce((s, p) => s + (p.total_amount || 0), 0);
    }
  }
  return ctx;
}

// ═══ Messages ═══
function addMessage(role, content) {
  const msg = { role, content, timestamp: Date.now() };
  ChatState.chatHistory.push(msg);

  // 渲染
  const div = document.createElement("div");
  div.className = "chat-msg " + role;
  div.innerHTML = renderMessageContent(content) +
    `<div class="msg-time">${formatTime(msg.timestamp)}</div>`;
  ChatState.messagesEl.appendChild(div);
  ChatState.messagesEl.scrollTop = ChatState.messagesEl.scrollHeight;

  // 保存
  saveChatHistory();
  trimHistory();
}

function addSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "chat-msg system";
  div.textContent = text;
  ChatState.messagesEl.appendChild(div);
  ChatState.messagesEl.scrollTop = ChatState.messagesEl.scrollHeight;
}

function renderMessageContent(content) {
  // 简单 Markdown: bold, para, list
  let html = content
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br>");
  html = "<p>" + html.replace(/<\/p><p>/g, "\n</p><p>") + "</p>";
  html = html.replace(/<li>(.+?)<\/li>/g, (match) => {
    return "<ul>" + match + "</ul>";
  });
  return html;
}

// ═══ History Persistence ═══
function getStorageKey() {
  return "chat_history_" + ChatState.contextId;
}

function saveChatHistory() {
  try {
    localStorage.setItem(getStorageKey(), JSON.stringify(ChatState.chatHistory));
  } catch (e) {
    // localStorage 满了, 清理
    ChatState.chatHistory = ChatState.chatHistory.slice(-30);
    localStorage.setItem(getStorageKey(), JSON.stringify(ChatState.chatHistory));
  }
}

function loadChatHistory() {
  try {
    const raw = localStorage.getItem(getStorageKey());
    ChatState.chatHistory = raw ? JSON.parse(raw) : [];
    renderHistory();
  } catch (e) {
    ChatState.chatHistory = [];
  }
}

function renderHistory() {
  if (!ChatState.messagesEl) return;
  ChatState.messagesEl.innerHTML = "";
  ChatState.chatHistory.forEach(msg => {
    const div = document.createElement("div");
    div.className = "chat-msg " + msg.role;
    div.innerHTML = renderMessageContent(msg.content) +
      `<div class="msg-time">${formatTime(msg.timestamp)}</div>`;
    ChatState.messagesEl.appendChild(div);
  });
  ChatState.messagesEl.scrollTop = ChatState.messagesEl.scrollHeight;
}

function clearCurrentChat() {
  ChatState.chatHistory = [];
  if (ChatState.messagesEl) ChatState.messagesEl.innerHTML = "";
  localStorage.removeItem(getStorageKey());
}

function trimHistory() {
  if (ChatState.chatHistory.length > MAX_STORAGE_ITEMS) {
    ChatState.chatHistory = ChatState.chatHistory.slice(-MAX_STORAGE_ITEMS);
    saveChatHistory();
  }
}

// ═══ Cleanup (2天保留) ═══
function cleanupExpired() {
  const now = Date.now();
  const threshold = now - 2 * MS_PER_DAY; // 2天前

  // 遍历 localStorage 中所有 chat_history_ 前缀的 key
  const keysToClean = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith("chat_history_")) {
      try {
        const raw = localStorage.getItem(key);
        const history = JSON.parse(raw);
        const fresh = history.filter(m => m.timestamp >= threshold);
        if (fresh.length !== history.length) {
          if (fresh.length === 0) {
            keysToClean.push(key);
          } else {
            localStorage.setItem(key, JSON.stringify(fresh));
          }
        }
      } catch (e) { /* 跳过损坏数据 */ }
    }
  }
  keysToClean.forEach(k => localStorage.removeItem(k));
}

function scheduleCleanup() {
  cleanupExpired(); // 立即执行一次

  // 计算到次日零点的时间
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const msToMidnight = midnight.getTime() - now.getTime();

  setTimeout(() => {
    cleanupExpired();
    // 之后每24h执行一次
    setInterval(cleanupExpired, MS_PER_DAY);
  }, msToMidnight);
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2, "0") + ":" +
         d.getMinutes().toString().padStart(2, "0");
}

// ═══ 集成到 app.js 视图切换 ═══
// 拦截 app.js 的 goToProvince / goToMuseum / goToNational
const origGoToProvince = window.goToProvince;
const origGoToMuseum = window.goToMuseum;
const origGoToNational = window.goToNational;

if (origGoToProvince) {
  window.goToProvince = function(provinceName) {
    origGoToProvince(provinceName);
    window.dispatchEvent(new CustomEvent("viewChanged", {
      detail: { view: "province", province: provinceName }
    }));
  };
}
if (origGoToMuseum) {
  window.goToMuseum = function(museumName) {
    origGoToMuseum(museumName);
    window.dispatchEvent(new CustomEvent("viewChanged", {
      detail: { view: "museum", province: window.AppState?.currentProvince, museum: museumName }
    }));
  };
}
if (origGoToNational) {
  window.goToNational = function() {
    origGoToNational();
    window.dispatchEvent(new CustomEvent("viewChanged", {
      detail: { view: "national" }
    }));
  };
}

// Start
document.addEventListener("DOMContentLoaded", initChat);
