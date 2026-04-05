const STORAGE_KEYS = {
  snapshot: "durian-bank-snapshot-v1",
  remember: "durian-bank-remember-v1",
  pending: "durian-bank-pending-v1"
};

const DEFAULT_SETTINGS = {
  durian_varieties: ["หมอนทอง", "ชะนี", "ก้านยาว", "พวงมณี", "กระดุมทอง", "หลงลับแล"],
  grade_labels: ["เกรด A", "เกรด B", "เกรด C", "เกรด D", "ตกไซซ์", "คละ"],
  business_profile: {
    booth_name: "แผงขายทุเรียน",
    owner_name: "เจ้าของแผง",
    phone: "",
    address: "",
    receipt_note: "ขอบคุณที่อุดหนุน ทุกรายการถูกบันทึกเข้าระบบเรียบร้อยแล้ว"
  }
};

const CATEGORY_OPTIONS = [
  { value: "buy_durian", label: "ซื้อทุเรียน", type: "expense" },
  { value: "sell_durian", label: "ขายทุเรียน", type: "income" },
  { value: "labor", label: "ค่าแรง", type: "expense" },
  { value: "fuel", label: "น้ำมัน", type: "expense" },
  { value: "other", label: "อื่นๆ", type: "expense" }
];

const ROLE_LABELS = {
  owner: "Owner",
  admin: "Admin",
  employee: "Employee"
};

const app = document.getElementById("app");

const state = {
  online: navigator.onLine,
  loading: true,
  initialized: false,
  user: null,
  offlineMode: false,
  currentView: "dashboard",
  dashboardRange: "7d",
  settings: deepClone(DEFAULT_SETTINGS),
  employees: [],
  transactions: [],
  logs: [],
  dashboard: null,
  loginForm: {
    username: "",
    password: "",
    rememberCredentials: false,
    autoLogin: false
  },
  pendingTransactions: [],
  transactionDraft: createDefaultTransactionDraft(),
  transactionStep: "edit",
  transactionPreview: null,
  editingTransactionId: null,
  selectedTransactionId: null,
  employeeDraft: createDefaultEmployeeDraft(),
  editingEmployeeId: null,
  toast: "",
  syncing: false
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDefaultLineItem() {
  return {
    durian_variety: "",
    grade_name: "",
    weight_kg: "",
    price_per_kg: "",
    total_price: "",
    fruit_count: "",
    note: ""
  };
}

function createDefaultTransactionDraft() {
  return {
    transaction_at: "",
    category: "buy_durian",
    sale_mode: "wholesale",
    subcategory: "",
    amount: "",
    fruit_count: "",
    note: "",
    grade_labels: deepClone(DEFAULT_SETTINGS.grade_labels),
    items: [createDefaultLineItem()]
  };
}

function getTypeByCategory(category) {
  return category === "sell_durian" ? "income" : "expense";
}

function createDefaultEmployeeDraft() {
  return {
    username: "",
    password: "",
    full_name: "",
    nickname: "",
    role: "employee",
    id_number: "",
    phone: "",
    line_id: "",
    card_image_data_url: "",
    photo_image_data_url: "",
    card_image_url: "",
    photo_image_url: "",
    status: "active"
  };
}

function boot() {
  loadLocalState();
  attachGlobalListeners();
  registerServiceWorker();
  initializeSession();
}

async function initializeSession() {
  try {
    if (state.online) {
      const bootstrap = await apiRequest("GET", "/api/auth/me");
      applyBootstrap(bootstrap, { offline: false });
      if (state.pendingTransactions.length) {
        await syncPendingTransactions();
      }
    } else if (canAutoLoginOffline()) {
      applyCachedSnapshot(true);
    }
  } catch (error) {
    if (canAutoLoginOffline()) {
      applyCachedSnapshot(true);
    }
  } finally {
    state.loading = false;
    state.initialized = true;
    rebuildDashboard();
    render();
  }
}

function attachGlobalListeners() {
  app.addEventListener("click", handleClick);
  app.addEventListener("change", handleChange);
  app.addEventListener("input", handleInput);
  app.addEventListener("submit", handleSubmit);
  window.addEventListener("online", async () => {
    state.online = true;
    showToast("กลับมาออนไลน์แล้ว กำลังซิงก์ข้อมูล...");
    render();
    if (state.user) {
      await syncPendingTransactions();
    }
  });
  window.addEventListener("offline", () => {
    state.online = false;
    showToast("กำลังทำงานในโหมดออฟไลน์ ข้อมูลใหม่จะรอซิงก์อัตโนมัติ");
    render();
  });
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js").catch(() => undefined);
  }
}

function loadLocalState() {
  try {
    const remembered = JSON.parse(localStorage.getItem(STORAGE_KEYS.remember) || "null");
    if (remembered) {
      state.loginForm = {
        username: remembered.username || "",
        password: remembered.password || "",
        rememberCredentials: Boolean(remembered.rememberCredentials),
        autoLogin: Boolean(remembered.autoLogin)
      };
    }
  } catch (_error) {}

  try {
    state.pendingTransactions = JSON.parse(localStorage.getItem(STORAGE_KEYS.pending) || "[]");
  } catch (_error) {
    state.pendingTransactions = [];
  }

  try {
    const snapshot = JSON.parse(localStorage.getItem(STORAGE_KEYS.snapshot) || "null");
    if (snapshot) {
      hydrateSnapshot(snapshot, { keepUser: true });
    }
  } catch (_error) {}
}

function persistLocalState() {
  const snapshot = {
    user: state.user,
    settings: state.settings,
    employees: state.employees,
    transactions: state.transactions,
    logs: state.logs,
    dashboardRange: state.dashboardRange,
    updatedAt: new Date().toISOString()
  };
  localStorage.setItem(STORAGE_KEYS.snapshot, JSON.stringify(snapshot));
  localStorage.setItem(STORAGE_KEYS.pending, JSON.stringify(state.pendingTransactions));
  if (state.loginForm.rememberCredentials) {
    localStorage.setItem(
      STORAGE_KEYS.remember,
      JSON.stringify({
        username: state.loginForm.username,
        password: state.loginForm.password,
        rememberCredentials: state.loginForm.rememberCredentials,
        autoLogin: state.loginForm.autoLogin
      })
    );
  } else {
    localStorage.removeItem(STORAGE_KEYS.remember);
  }
}

function hydrateSnapshot(snapshot, { keepUser = false } = {}) {
  state.settings = snapshot.settings || deepClone(DEFAULT_SETTINGS);
  state.employees = Array.isArray(snapshot.employees) ? snapshot.employees : [];
  state.transactions = sortTransactions(Array.isArray(snapshot.transactions) ? snapshot.transactions : []);
  state.logs = Array.isArray(snapshot.logs) ? snapshot.logs : [];
  if (snapshot.dashboardRange) {
    state.dashboardRange = snapshot.dashboardRange;
  }
  if (!keepUser || !state.user) {
    state.user = snapshot.user || state.user;
  }
}

function applyBootstrap(bootstrap, { offline }) {
  hydrateSnapshot(bootstrap);
  state.user = bootstrap.user;
  state.offlineMode = offline;
  rebuildDashboard();
  persistLocalState();
}

function applyCachedSnapshot(offline = true) {
  const snapshot = JSON.parse(localStorage.getItem(STORAGE_KEYS.snapshot) || "null");
  if (!snapshot || !snapshot.user) {
    throw new Error("ไม่มีข้อมูลสำหรับเข้าใช้งานแบบออฟไลน์");
  }
  hydrateSnapshot(snapshot);
  state.user = snapshot.user;
  state.offlineMode = offline;
  rebuildDashboard();
}

function canAutoLoginOffline() {
  const snapshot = JSON.parse(localStorage.getItem(STORAGE_KEYS.snapshot) || "null");
  return Boolean(
    state.loginForm.autoLogin &&
    state.loginForm.username &&
    state.loginForm.password &&
    snapshot &&
    snapshot.user &&
    snapshot.user.username === state.loginForm.username
  );
}

async function apiRequest(method, path, body) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "เกิดข้อผิดพลาดจากเซิร์ฟเวอร์");
  }
  return data;
}

async function ensureOnlineSession() {
  if (!state.online) {
    throw new Error("ขณะนี้ออฟไลน์อยู่");
  }
  if (!state.offlineMode) {
    return;
  }
  if (!state.loginForm.username || !state.loginForm.password) {
    throw new Error("ต้องเข้าสู่ระบบออนไลน์อีกครั้งก่อนซิงก์");
  }
  const bootstrap = await apiRequest("POST", "/api/auth/login", {
    username: state.loginForm.username,
    password: state.loginForm.password,
    auto_login: state.loginForm.autoLogin
  });
  applyBootstrap(bootstrap, { offline: false });
}

function rebuildDashboard() {
  state.dashboard = computeDashboard(state.transactions, state.dashboardRange);
}

function computeDashboard(transactions, range) {
  const now = new Date();
  const totalDays = range === "30d" ? 30 : range === "month" ? now.getDate() : 7;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(now.getDate() - (totalDays - 1));
  const active = transactions.filter((transaction) => transaction.status === "active");
  const rows = active.filter((transaction) => new Date(transaction.transaction_at) >= start);

  let income = 0;
  let expense = 0;
  let saleIncome = 0;
  let purchaseCost = 0;
  const categoryTotals = {};
  const daily = {};
  const entryByUser = {};
  const varietyRollups = {};

  rows.forEach((transaction) => {
    const amount = Number(transaction.amount || 0);
    const dateKey = transaction.transaction_at.slice(0, 10);
    if (!daily[dateKey]) {
      daily[dateKey] = { income: 0, expense: 0 };
    }
    if (transaction.type === "income") {
      income += amount;
      daily[dateKey].income += amount;
    } else {
      expense += amount;
      daily[dateKey].expense += amount;
    }
    if (transaction.category === "sell_durian") {
      saleIncome += amount;
    }
    if (transaction.category === "buy_durian") {
      purchaseCost += amount;
    }
    categoryTotals[transaction.category] = (categoryTotals[transaction.category] || 0) + amount;
    entryByUser[transaction.recorded_by_name] = (entryByUser[transaction.recorded_by_name] || 0) + 1;
    (transaction.items || []).forEach((item) => {
      const variety = item.durian_variety || "ไม่ระบุ";
      if (!varietyRollups[variety]) {
        varietyRollups[variety] = {
          purchase_weight: 0,
          purchase_amount: 0,
          sale_weight: 0,
          sale_amount: 0
        };
      }
      if (transaction.category === "buy_durian") {
        varietyRollups[variety].purchase_weight += Number(item.weight_kg || 0);
        varietyRollups[variety].purchase_amount += Number(item.total_price || 0);
      }
      if (transaction.category === "sell_durian") {
        varietyRollups[variety].sale_weight += Number(item.weight_kg || 0);
        varietyRollups[variety].sale_amount += Number(item.total_price || 0);
      }
    });
  });

  const cashflow = [];
  for (let offset = 0; offset < totalDays; offset += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + offset);
    const key = date.toISOString().slice(0, 10);
    const bucket = daily[key] || { income: 0, expense: 0 };
    cashflow.push({
      date: key,
      income: roundMoney(bucket.income),
      expense: roundMoney(bucket.expense),
      net: roundMoney(bucket.income - bucket.expense)
    });
  }

  return {
    range,
    summary: {
      income: roundMoney(income),
      expense: roundMoney(expense),
      net_profit: roundMoney(income - expense),
      sale_income: roundMoney(saleIncome),
      purchase_cost: roundMoney(purchaseCost),
      gross_margin: roundMoney(saleIncome - purchaseCost),
      transaction_count: rows.length
    },
    cashflow,
    category_breakdown: Object.entries(categoryTotals)
      .map(([key, amount]) => ({
        key,
        label: CATEGORY_OPTIONS.find((option) => option.value === key)?.label || key,
        amount: roundMoney(amount)
      }))
      .sort((left, right) => right.amount - left.amount),
    top_varieties: Object.entries(varietyRollups)
      .map(([name, data]) => ({
        name,
        ...Object.fromEntries(Object.entries(data).map(([key, value]) => [key, roundMoney(value)])),
        avg_sale_price_per_kg: data.sale_weight ? roundMoney(data.sale_amount / data.sale_weight) : 0
      }))
      .sort((left, right) => right.sale_amount + right.purchase_amount - (left.sale_amount + left.purchase_amount))
      .slice(0, 6),
    entry_by_user: Object.entries(entryByUser)
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count)
  };
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function prepareTransactionPayload(draft) {
  const category = draft.category;
  const transactionType = getTypeByCategory(category);
  const payload = {
    category,
    sale_mode: category === "sell_durian" ? draft.sale_mode : "",
    subcategory: draft.subcategory.trim(),
    note: draft.note.trim()
  };
  if (draft.transaction_at) {
    payload.transaction_at = `${draft.transaction_at}:00`;
  }

  if (category === "buy_durian" || category === "sell_durian") {
    const items = draft.items.map((item) => normalizeDraftItem(item, category, draft.sale_mode));
    payload.items = items;
    payload.amount = roundMoney(items.reduce((sum, item) => sum + Number(item.total_price || 0), 0));
    payload.fruit_count = items.reduce((sum, item) => sum + Number(item.fruit_count || 0), 0);
  } else {
    payload.amount = roundMoney(Number(draft.amount || 0));
    payload.fruit_count = Number(draft.fruit_count || 0);
    if (payload.amount <= 0) {
      throw new Error("กรุณากรอกจำนวนเงินให้มากกว่า 0");
    }
  }
  payload.type = transactionType;
  return payload;
}

function normalizeDraftItem(item, category, saleMode) {
  const weight = parseNumber(item.weight_kg);
  const price = parseNumber(item.price_per_kg);
  const total = parseNumber(item.total_price);
  const filled = [weight, price, total].filter((value) => value > 0).length;
  if (filled < 2) {
    throw new Error("รายการทุเรียนต้องกรอกอย่างน้อย 2 ช่องจาก น้ำหนัก, ราคาต่อกก., ราคารวม");
  }
  let nextWeight = weight;
  let nextPrice = price;
  let nextTotal = total;
  if (!nextTotal && nextWeight && nextPrice) {
    nextTotal = roundMoney(nextWeight * nextPrice);
  }
  if (!nextPrice && nextTotal && nextWeight) {
    nextPrice = roundMoney(nextTotal / nextWeight);
  }
  if (!nextWeight && nextTotal && nextPrice) {
    nextWeight = roundMoney(nextTotal / nextPrice);
  }
  if ((category === "buy_durian" || category === "sell_durian") && !item.durian_variety.trim()) {
    throw new Error("กรุณากรอกพันธุ์ทุเรียน");
  }
  if (category === "sell_durian" && saleMode === "graded" && !item.grade_name.trim()) {
    throw new Error("กรุณากรอกเกรดสำหรับการขายแบบคัดเกรด");
  }
  return {
    durian_variety: item.durian_variety.trim(),
    grade_name: item.grade_name.trim(),
    weight_kg: roundMoney(nextWeight),
    price_per_kg: roundMoney(nextPrice),
    total_price: roundMoney(nextTotal),
    fruit_count: Number(item.fruit_count || 0) || 0,
    note: item.note.trim()
  };
}

function parseNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function buildLocalTransaction(payload) {
  const localId = `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const categoryLabel = CATEGORY_OPTIONS.find((item) => item.value === payload.category)?.label || payload.category;
  const transactionType = payload.type || getTypeByCategory(payload.category);
  const receiptTransaction = {
    id: localId,
    bill_number: `OFFLINE-${String(Date.now()).slice(-8)}`,
    transaction_at: payload.transaction_at || new Date().toISOString(),
    type: transactionType,
    type_label: transactionType === "income" ? "รายรับ" : "รายจ่าย",
    category: payload.category,
    category_label: categoryLabel,
    subcategory: payload.subcategory,
    sale_mode: payload.sale_mode,
    amount: payload.amount,
    fruit_count: payload.fruit_count || 0,
    note: payload.note,
    status: "active",
    recorded_by_user_id: state.user.id,
    recorded_by_name: state.user.display_name,
    updated_by_name: null,
    deleted_by_name: null,
    deleted_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    offline_source: localId,
    items: payload.items || [],
    pending_sync: true
  };
  receiptTransaction.receipt_snapshot = generateReceiptHTML(receiptTransaction, state.settings);
  return receiptTransaction;
}

function generateReceiptHTML(transaction, settings) {
  const profile = settings.business_profile || DEFAULT_SETTINGS.business_profile;
  const items = (transaction.items || []).length
    ? transaction.items
    : [{
        durian_variety: transaction.category_label,
        grade_name: "",
        weight_kg: 0,
        price_per_kg: 0,
        total_price: transaction.amount,
        fruit_count: transaction.fruit_count
      }];
  const rows = items.map((item, index) => {
    const title = [item.durian_variety, item.grade_name].filter(Boolean).join(" / ");
    return `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(title || transaction.category_label)}</td>
        <td>${item.fruit_count || "-"}</td>
        <td>${formatNumber(item.weight_kg)}</td>
        <td>${formatCurrency(item.price_per_kg)}</td>
        <td>${formatCurrency(item.total_price)}</td>
      </tr>
    `;
  }).join("");
  return `<!DOCTYPE html>
  <html lang="th">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>บิล ${escapeHtml(transaction.bill_number)}</title>
    <style>
      body{margin:0;padding:24px;background:linear-gradient(180deg,#f4f8ec,#fffdf8);font-family:"Leelawadee UI","Segoe UI","Noto Sans Thai",sans-serif;color:#18301d}
      .sheet{max-width:840px;margin:0 auto;background:#fff;border-radius:24px;padding:28px;box-shadow:0 24px 60px rgba(15,56,28,.12)}
      .hero{display:flex;justify-content:space-between;gap:16px;margin-bottom:24px}
      .pill{display:inline-flex;align-items:center;padding:8px 14px;border-radius:999px;background:#eaf6c8;color:#31520f;font-weight:800}
      .title{margin:0 0 6px;font-size:28px;font-weight:800}
      .subtitle{margin:0;color:#55715f}
      .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:24px}
      .card{background:#f7faf1;border:1px solid #e3ebd3;border-radius:18px;padding:14px 16px}
      .label{color:#55715f;font-size:12px;text-transform:uppercase;letter-spacing:.08em}
      .value{margin-top:8px;font-size:16px;font-weight:700}
      table{width:100%;border-collapse:collapse}
      th,td{padding:12px 10px;border-bottom:1px solid #edf2e2;text-align:left;font-size:14px}
      th{color:#55715f}
      .total{display:flex;justify-content:space-between;align-items:center;margin-top:22px;padding:18px 20px;border-radius:18px;background:linear-gradient(135deg,#1f6a37,#2f8f46);color:#fff;font-size:18px;font-weight:800}
      .note{margin-top:18px;padding:16px;border-radius:16px;background:#fff8e7;color:#77591f}
    </style>
  </head>
  <body>
    <div class="sheet">
      <div class="hero">
        <div>
          <h1 class="title">${escapeHtml(profile.booth_name || "แผงขายทุเรียน")}</h1>
          <p class="subtitle">บิลเลขที่ ${escapeHtml(transaction.bill_number)}</p>
          <p class="subtitle">${escapeHtml(profile.address || "พร้อมใช้งานทั้งหน้าร้านและหน้างาน")}</p>
        </div>
        <div class="pill">${transaction.type === "income" ? "รายรับ" : "รายจ่าย"}</div>
      </div>
      <div class="grid">
        <div class="card"><div class="label">วันที่บันทึก</div><div class="value">${escapeHtml(formatDateTime(transaction.transaction_at))}</div></div>
        <div class="card"><div class="label">หมวดหมู่</div><div class="value">${escapeHtml(transaction.category_label)}</div></div>
        <div class="card"><div class="label">ผู้บันทึก</div><div class="value">${escapeHtml(transaction.recorded_by_name)}</div></div>
        <div class="card"><div class="label">ติดต่อ</div><div class="value">${escapeHtml(profile.phone || "-")}</div></div>
      </div>
      <table>
        <thead><tr><th>#</th><th>รายการ</th><th>จำนวนลูก</th><th>น้ำหนัก (กก.)</th><th>ราคาต่อกก.</th><th>รวม</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="total"><span>ยอดรวมสุทธิ</span><span>${formatCurrency(transaction.amount)} บาท</span></div>
      <div class="note"><strong>หมายเหตุ:</strong> ${escapeHtml(transaction.note || "-")}<br><span>${escapeHtml(profile.receipt_note || "")}</span></div>
    </div>
  </body>
  </html>`;
}

function formatCurrency(value) {
  return Number(value || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false
  });
}

function toDateTimeLocalInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function showToast(message) {
  state.toast = message;
  render();
  window.clearTimeout(showToast._timer);
  showToast._timer = window.setTimeout(() => {
    state.toast = "";
    render();
  }, 2600);
}

function isManager() {
  return state.user && (state.user.role === "owner" || state.user.role === "admin");
}

function isOwner() {
  return state.user?.role === "owner";
}

function render() {
  if (state.loading) {
    app.innerHTML = `
      <div class="boot-screen">
        <div class="boot-card">
          <div class="boot-badge">Durian Booth</div>
          <h1>กำลังเชื่อมต่อระบบ</h1>
          <p>เตรียมข้อมูลรายรับรายจ่ายและประวัติการบันทึกให้พร้อมใช้งาน...</p>
        </div>
      </div>
    `;
    return;
  }

  if (!state.user) {
    app.innerHTML = renderLoginView();
    return;
  }

  rebuildDashboard();
  app.innerHTML = `
    ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ""}
    <div class="app-shell">
      <header class="topbar">
        <div class="topbar-card">
          <div class="topbar-main">
            <div>
              <div class="eyebrow">${escapeHtml(state.settings.business_profile.booth_name || "แผงขายทุเรียน")}</div>
              <h1 class="topbar-title">${renderTopbarTitle()}</h1>
              <div class="topbar-subtitle">ผู้ใช้งาน: ${escapeHtml(state.user.display_name)} (${ROLE_LABELS[state.user.role]})</div>
            </div>
            <div class="button-row">
              <button class="btn btn-soft" data-action="logout">ออกจากระบบ</button>
            </div>
          </div>
          <div class="status-row">
            <div class="status-pill">${state.online ? "ออนไลน์" : "ออฟไลน์"}</div>
            <div class="status-pill">${state.offlineMode ? "กำลังใช้ข้อมูลแคช" : "เชื่อมกับฐานข้อมูลหลัก"}</div>
            <div class="status-pill ${state.pendingTransactions.length ? "warn" : ""}">รอซิงก์ ${state.pendingTransactions.length} รายการ</div>
          </div>
        </div>
      </header>
      <main class="content">
        ${renderDataLists()}
        ${renderCurrentView()}
      </main>
      <nav class="bottom-nav">
        ${renderNavButton("dashboard", "Dashboard")}
        ${renderNavButton("transactions", "รายการ")}
        ${renderNavButton("add", "เพิ่มบิล")}
        ${renderNavButton("employees", "พนักงาน")}
        ${renderNavButton("more", "เพิ่มเติม")}
      </nav>
    </div>
  `;
}

function renderTopbarTitle() {
  if (state.currentView === "dashboard") {
    return "ภาพรวมธุรกิจวันนี้";
  }
  if (state.currentView === "transactions") {
    return "รายการรายรับรายจ่าย";
  }
  if (state.currentView === "add") {
    return state.transactionStep === "preview" ? "สรุปบิลก่อนบันทึก" : "บันทึกรายการใหม่";
  }
  if (state.currentView === "employees") {
    return "จัดการพนักงาน";
  }
  return "ตั้งค่าและประวัติการแก้ไข";
}

function renderNavButton(view, label) {
  return `
    <button class="nav-btn ${state.currentView === view ? "active" : ""}" data-action="set-view" data-view="${view}">
      ${label}
    </button>
  `;
}

function renderDataLists() {
  return `
    <datalist id="durian-varieties">
      ${(state.settings.durian_varieties || []).map((item) => `<option value="${escapeHtml(item)}"></option>`).join("")}
    </datalist>
    <datalist id="grade-labels">
      ${(state.transactionDraft.grade_labels || []).map((item) => `<option value="${escapeHtml(item)}"></option>`).join("")}
    </datalist>
  `;
}

function renderCurrentView() {
  if (state.currentView === "transactions") {
    return renderTransactionsView();
  }
  if (state.currentView === "add") {
    return renderAddView();
  }
  if (state.currentView === "employees") {
    return renderEmployeesView();
  }
  if (state.currentView === "more") {
    return renderMoreView();
  }
  return renderDashboardView();
}

function renderLoginView() {
  return `
    ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ""}
    <div class="login-shell">
      <div class="login-card">
        <div class="eyebrow">Durian Booth</div>
        <h1>ระบบบันทึกรายรับรายจ่าย</h1>
        <p>เข้าสู่ระบบด้วยบัญชีที่ผู้ดูแลระบบกำหนดไว้ พร้อมใช้งานบนมือถือ</p>
        <form data-form="login" class="field-grid">
          <div class="field">
            <label for="login-username">ชื่อผู้ใช้</label>
            <input class="input" id="login-username" name="login-username" value="${escapeHtml(state.loginForm.username)}" autocomplete="username">
          </div>
          <div class="field">
            <label for="login-password">รหัสผ่าน</label>
            <input class="input" id="login-password" type="password" name="login-password" value="${escapeHtml(state.loginForm.password)}" autocomplete="current-password">
          </div>
          <div class="check-row">
            <label class="check"><input type="checkbox" name="remember-credentials" ${state.loginForm.rememberCredentials ? "checked" : ""}> จำ User และ Password</label>
            <label class="check"><input type="checkbox" name="auto-login" ${state.loginForm.autoLogin ? "checked" : ""}> ล็อกอินอัตโนมัติ</label>
          </div>
          <button class="btn btn-primary btn-block" type="submit">เข้าสู่ระบบ</button>
          <div class="mini-note">ถ้าเครื่องนี้เคยล็อกอินและเลือกจำข้อมูลไว้ ระบบสามารถเปิดแบบออฟไลน์ได้</div>
        </form>
      </div>
    </div>
  `;
}

function renderDashboardView() {
  const summary = state.dashboard?.summary || {};
  return `
    <section class="section">
      ${state.pendingTransactions.length ? `
        <div class="hero-banner">
          มีรายการรอซิงก์ ${state.pendingTransactions.length} รายการ สามารถบันทึกหน้างานต่อได้ทันที
          <div class="button-row" style="margin-top:12px;">
            <button class="btn btn-primary" data-action="sync-pending">ซิงก์ตอนนี้</button>
            <button class="btn btn-soft" data-action="set-view" data-view="transactions">ดูรายการ</button>
          </div>
        </div>
      ` : ""}
      <div class="card">
        <div class="section-title">
          <div>
            <h2>Dashboard</h2>
            <small>วิเคราะห์ภาพรวมธุรกิจสำหรับแผงขายทุเรียน</small>
          </div>
          <div class="chip-row">
            ${renderRangeChip("7d", "7 วัน")}
            ${renderRangeChip("30d", "30 วัน")}
            ${renderRangeChip("month", "เดือนนี้")}
          </div>
        </div>
        <div class="metrics-grid" style="margin-top:16px;">
          ${renderMetricCard("รายรับ", summary.income, "positive")}
          ${renderMetricCard("รายจ่าย", summary.expense, "negative")}
          ${renderMetricCard("กำไรสุทธิ", summary.net_profit, summary.net_profit >= 0 ? "positive" : "negative")}
          ${renderMetricCard("ยอดขายทุเรียน", summary.sale_income, "positive")}
          ${renderMetricCard("ต้นทุนซื้อทุเรียน", summary.purchase_cost, "negative")}
          ${renderMetricCard("กำไรขั้นต้น", summary.gross_margin, summary.gross_margin >= 0 ? "positive" : "negative")}
          ${renderMetricCard("จำนวนบิล", summary.transaction_count || 0, "")}
          ${renderMetricCard("ผู้บันทึก", state.dashboard?.entry_by_user?.length || 0, "")}
        </div>
      </div>
      <div class="card">
        <div class="section-title">
          <div>
            <h3>กระแสเงินสดรายวัน</h3>
            <small>แท่งเขียวคือรายรับ แท่งส้มคือรายจ่าย</small>
          </div>
          <div class="button-row">
            <button class="btn btn-secondary" data-action="quick-buy">ซื้อทุเรียน</button>
            <button class="btn btn-primary" data-action="quick-sell">ขายทุเรียน</button>
          </div>
        </div>
        ${renderCashflowChart()}
      </div>
      <div class="card">
        <div class="section-title">
          <div>
            <h3>กิจกรรมล่าสุด</h3>
            <small>ดูว่าใครบันทึกข้อมูลรายการล่าสุด</small>
          </div>
          <button class="btn btn-soft" data-action="set-view" data-view="transactions">ดูทั้งหมด</button>
        </div>
        <div class="list" style="margin-top:14px;">${renderTransactionCards(state.transactions.slice(0, 5))}</div>
      </div>
    </section>
  `;
}

function renderRangeChip(value, label) {
  return `<button class="chip ${state.dashboardRange === value ? "active" : ""}" data-action="set-range" data-range="${value}">${label}</button>`;
}

function renderMetricCard(label, value, tone) {
  return `
    <div class="metric">
      <div class="metric-label">${label}</div>
      <div class="metric-value ${tone}">${typeof value === "number" ? formatCurrency(value) : value}</div>
    </div>
  `;
}

function renderCashflowChart() {
  const cashflow = state.dashboard?.cashflow || [];
  const highest = Math.max(1, ...cashflow.flatMap((item) => [item.income, item.expense]));
  return `
    <div class="chart" style="margin-top:18px;">
      ${cashflow.map((item) => `
        <div class="bar">
          <div class="bar-stack">
            <div class="bar-income" style="height:${Math.max(6, (item.income / highest) * 120)}px"></div>
            <div class="bar-expense" style="height:${Math.max(6, (item.expense / highest) * 120)}px"></div>
          </div>
          <div class="bar-label">${item.date.slice(8, 10)}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderTransactionsView() {
  const transaction = state.transactions.find((item) => String(item.id) === String(state.selectedTransactionId));
  return `
    <section class="section">
      <div class="card">
        <div class="section-title">
          <div>
            <h2>ประวัติรายการ</h2>
            <small>Owner และ Admin แก้ไข/ลบได้ พร้อม Audit Log</small>
          </div>
          <div class="button-row">
            <button class="btn btn-primary" data-action="set-view" data-view="add">เพิ่มรายการใหม่</button>
            ${state.pendingTransactions.length ? `<button class="btn btn-secondary" data-action="sync-pending">ซิงก์ ${state.pendingTransactions.length}</button>` : ""}
          </div>
        </div>
        <div class="list" style="margin-top:16px;">
          ${renderTransactionCards(state.transactions)}
        </div>
      </div>
      ${transaction ? renderTransactionDetail(transaction) : ""}
    </section>
  `;
}

function renderTransactionCards(transactions) {
  if (!transactions.length) {
    return `<div class="empty">ยังไม่มีรายการบันทึก</div>`;
  }
  return transactions.map((transaction) => {
    const badgeClass = transaction.status === "deleted" ? "badge pending" : transaction.type === "expense" ? "badge expense" : "badge";
    const badgeLabel = transaction.status === "deleted"
      ? "ลบแล้ว"
      : transaction.pending_sync
        ? "รอซิงก์"
        : transaction.type_label;
    return `
      <button class="tile" data-action="select-transaction" data-id="${escapeHtml(String(transaction.id))}">
        <div class="tile-header">
          <div>
            <div class="tile-title">${escapeHtml(transaction.bill_number)}</div>
            <div class="mini-note">${escapeHtml(transaction.category_label)} • ${formatDateTime(transaction.transaction_at)}</div>
          </div>
          <div class="${badgeClass}">${badgeLabel}</div>
        </div>
        <div class="detail-grid">
          <div class="detail"><div class="detail-label">ยอดรวม</div><div class="detail-value">${formatCurrency(transaction.amount)} บาท</div></div>
          <div class="detail"><div class="detail-label">ผู้บันทึก</div><div class="detail-value">${escapeHtml(transaction.recorded_by_name)}</div></div>
          <div class="detail"><div class="detail-label">จำนวนลูก</div><div class="detail-value">${transaction.fruit_count || "-"}</div></div>
        </div>
        <div class="list">
          ${renderTransactionCardItems(transaction)}
        </div>
        ${transaction.note ? `<div class="mini-note">หมายเหตุ: ${escapeHtml(transaction.note)}</div>` : ""}
      </button>
    `;
  }).join("");
}

function renderTransactionCardItems(transaction) {
  if (!transaction.items?.length) {
    return `
      <div class="panel">
        <div class="mini-note">${escapeHtml(transaction.category_label)} • ${formatCurrency(transaction.amount)} บาท</div>
      </div>
    `;
  }
  return transaction.items.map((item, index) => `
    <div class="panel">
      <div class="tile-header">
        <div class="tile-title">${index + 1}. ${escapeHtml([item.durian_variety, item.grade_name].filter(Boolean).join(" / ") || transaction.category_label)}</div>
        <div class="badge">${formatCurrency(item.total_price)} บาท</div>
      </div>
      <div class="mini-note">
        ${item.weight_kg ? `${formatNumber(item.weight_kg)} กก.` : ""}
        ${item.price_per_kg ? ` • ${formatCurrency(item.price_per_kg)} บาท/กก.` : ""}
        ${item.fruit_count ? ` • ${item.fruit_count} ลูก` : ""}
        ${item.note ? ` • ${escapeHtml(item.note)}` : ""}
      </div>
    </div>
  `).join("");
}

function renderTransactionDetail(transaction) {
  return `
    <div class="card">
      <div class="section-title">
        <div>
          <h3>รายละเอียดบิล ${escapeHtml(transaction.bill_number)}</h3>
          <small>ผู้บันทึก: ${escapeHtml(transaction.recorded_by_name)} • ${formatDateTime(transaction.transaction_at)}</small>
        </div>
        <div class="button-row">
          <button class="btn btn-soft" data-action="download-receipt" data-id="${escapeHtml(String(transaction.id))}">เซฟบิล PDF</button>
          ${isManager() && transaction.status === "active" && !transaction.pending_sync ? `<button class="btn btn-secondary" data-action="edit-transaction" data-id="${escapeHtml(String(transaction.id))}">แก้ไข</button>` : ""}
          ${isManager() && transaction.status === "active" && !transaction.pending_sync ? `<button class="btn btn-danger" data-action="delete-transaction" data-id="${escapeHtml(String(transaction.id))}">ลบ</button>` : ""}
        </div>
      </div>
      <div class="list" style="margin-top:16px;">
        ${(transaction.items || []).map((item) => `
          <div class="panel">
            <div class="tile-header">
              <div class="tile-title">${escapeHtml([item.durian_variety, item.grade_name].filter(Boolean).join(" / ") || transaction.category_label)}</div>
              <div class="badge">${formatCurrency(item.total_price)} บาท</div>
            </div>
            <div class="detail-grid">
              <div class="detail"><div class="detail-label">น้ำหนัก</div><div class="detail-value">${formatNumber(item.weight_kg)} กก.</div></div>
              <div class="detail"><div class="detail-label">ราคาต่อกก.</div><div class="detail-value">${formatCurrency(item.price_per_kg)} บาท</div></div>
              <div class="detail"><div class="detail-label">จำนวนลูก</div><div class="detail-value">${item.fruit_count || "-"}</div></div>
            </div>
          </div>
        `).join("") || `
          <div class="panel">
            <div class="detail-grid">
              <div class="detail"><div class="detail-label">จำนวนเงิน</div><div class="detail-value">${formatCurrency(transaction.amount)} บาท</div></div>
              <div class="detail"><div class="detail-label">จำนวนลูก</div><div class="detail-value">${transaction.fruit_count || "-"}</div></div>
            </div>
          </div>
        `}
      </div>
      ${transaction.note ? `<div class="notice" style="margin-top:16px;">หมายเหตุ: ${escapeHtml(transaction.note)}</div>` : ""}
    </div>
  `;
}

function renderAddView() {
  return state.transactionStep === "preview" ? renderTransactionPreview() : renderTransactionEditor();
}

function renderTransactionEditor() {
  const needsItems = state.transactionDraft.category === "buy_durian" || state.transactionDraft.category === "sell_durian";
  const isGraded = state.transactionDraft.category === "sell_durian" && state.transactionDraft.sale_mode === "graded";
  return `
    <section class="section">
      <div class="card">
        <div class="section-title">
          <div>
            <h2>${state.editingTransactionId ? "แก้ไขรายการ" : "บันทึกรายการใหม่"}</h2>
            <small>หมวดหมู่ขายทุเรียนจะเป็นรายรับ ส่วนที่เหลือเป็นรายจ่ายอัตโนมัติ</small>
          </div>
        </div>
        <div class="sheet" style="margin-top:16px;">
          <div class="notice">
            ${state.editingTransactionId
              ? `เวลาบันทึกเดิม: ${formatDateTime(`${state.transactionDraft.transaction_at || ""}:00`)}`
              : "วันและเวลาบันทึกจะใช้อัตโนมัติตามเวลาจริงตอนกดบันทึกเข้าระบบ"}
          </div>
          <div class="field-grid cols-2">
            <div class="field">
              <label>หมวดหมู่</label>
              <select name="draft-category">
                ${CATEGORY_OPTIONS.map((option) => `<option value="${option.value}" ${state.transactionDraft.category === option.value ? "selected" : ""}>${option.label}</option>`).join("")}
              </select>
            </div>
            <div class="field ${state.transactionDraft.category === "sell_durian" ? "" : "hidden"}">
              <label>รูปแบบการขาย</label>
              <select name="draft-sale_mode">
                <option value="wholesale" ${state.transactionDraft.sale_mode === "wholesale" ? "selected" : ""}>แบบเหมา</option>
                <option value="graded" ${state.transactionDraft.sale_mode === "graded" ? "selected" : ""}>แบบคัดเกรด</option>
              </select>
            </div>
            <div class="field ${needsItems ? "hidden" : ""}">
              <label>จำนวนเงิน</label>
              <input class="input" inputmode="decimal" name="draft-amount" value="${escapeHtml(state.transactionDraft.amount)}" placeholder="0.00">
            </div>
            <div class="field ${needsItems ? "hidden" : ""}">
              <label>จำนวนลูก (ถ้ามี)</label>
              <input class="input" inputmode="numeric" name="draft-fruit_count" value="${escapeHtml(state.transactionDraft.fruit_count)}" placeholder="0">
            </div>
            <div class="field ${state.transactionDraft.category === "other" ? "" : "hidden"}">
              <label>รายละเอียดเพิ่มเติม</label>
              <input class="input" name="draft-subcategory" value="${escapeHtml(state.transactionDraft.subcategory)}" placeholder="เช่น อุปกรณ์, แพ็กกิ้ง">
            </div>
          </div>
          ${isGraded ? renderGradeLabelsEditor() : ""}
          ${needsItems ? `
            <div class="sheet">
              ${state.transactionDraft.items.map((item, index) => renderLineItemEditor(item, index, isGraded)).join("")}
              <div class="button-row">
                <button class="btn btn-secondary" data-action="add-line-item">เพิ่มรายการย่อย</button>
              </div>
            </div>
          ` : ""}
          <div class="field">
            <label>หมายเหตุ</label>
            <textarea name="draft-note" placeholder="เช่น รับซื้อจากสวน A, ขายลูกค้าประจำ, จ่ายค่าน้ำมันขนส่ง">${escapeHtml(state.transactionDraft.note)}</textarea>
          </div>
          <div class="button-row">
            <button class="btn btn-soft" data-action="reset-transaction-draft">ยกเลิก</button>
            <button class="btn btn-primary" data-action="preview-transaction">สรุปบิล</button>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderGradeLabelsEditor() {
  return `
    <div class="panel">
      <div class="section-title">
        <div>
          <h3>ชื่อเกรด 6 ช่อง</h3>
          <small>ปรับชื่อเกรดให้ตรงกับหน้างานได้</small>
        </div>
      </div>
      <div class="field-grid cols-3" style="margin-top:14px;">
        ${state.transactionDraft.grade_labels.map((item, index) => `
          <div class="field">
            <label>เกรด ${index + 1}</label>
            <input class="input" name="grade-label-${index}" value="${escapeHtml(item)}">
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderLineItemEditor(item, index, isGraded) {
  return `
    <div class="line-item">
      <div class="section-title">
        <div>
          <h3>รายการย่อย ${index + 1}</h3>
          <small>กรอก 2 ช่องจาก น้ำหนัก, ราคาต่อกก., ราคารวม ระบบจะคำนวณให้อัตโนมัติ</small>
        </div>
        ${state.transactionDraft.items.length > 1 ? `<button class="btn btn-danger" data-action="remove-line-item" data-index="${index}">ลบ</button>` : ""}
      </div>
      <div class="field-grid cols-2">
        <div class="field">
          <label>พันธุ์ทุเรียน</label>
          <input class="input" list="durian-varieties" name="item-durian_variety-${index}" value="${escapeHtml(item.durian_variety)}" placeholder="เลือกหรือพิมพ์พันธุ์">
        </div>
        <div class="field ${isGraded ? "" : "hidden"}">
          <label>เกรด</label>
          <input class="input" list="grade-labels" name="item-grade_name-${index}" value="${escapeHtml(item.grade_name)}" placeholder="เลือกหรือพิมพ์เกรด">
        </div>
        <div class="field">
          <label>น้ำหนัก (กก.)</label>
          <input class="input" inputmode="decimal" name="item-weight_kg-${index}" value="${escapeHtml(item.weight_kg)}" placeholder="0.00">
        </div>
        <div class="field">
          <label>ราคาต่อกิโลกรัม</label>
          <input class="input" inputmode="decimal" name="item-price_per_kg-${index}" value="${escapeHtml(item.price_per_kg)}" placeholder="0.00">
        </div>
        <div class="field">
          <label>ราคารวม</label>
          <input class="input" inputmode="decimal" name="item-total_price-${index}" value="${escapeHtml(item.total_price)}" placeholder="0.00">
        </div>
        <div class="field">
          <label>จำนวนลูก</label>
          <input class="input" inputmode="numeric" name="item-fruit_count-${index}" value="${escapeHtml(item.fruit_count)}" placeholder="0">
        </div>
      </div>
      <div class="field">
        <label>หมายเหตุรายการย่อย</label>
        <input class="input" name="item-note-${index}" value="${escapeHtml(item.note)}" placeholder="เช่น ไซซ์ใหญ่, คละสวน, ลูกสวย">
      </div>
    </div>
  `;
}

function renderTransactionPreview() {
  const transaction = state.transactionPreview;
  return `
    <section class="section">
      <div class="card">
        <div class="section-title">
          <div>
            <h2>สรุปบิลก่อนบันทึก</h2>
            <small>เลือกบันทึกเข้าระบบหรือบันทึกพร้อมเซฟบิลเป็น PDF</small>
          </div>
        </div>
        <iframe class="receipt-frame" title="receipt-preview" srcdoc="${escapeHtml(transaction.receipt_snapshot)}"></iframe>
      </div>
      <div class="receipt-actions">
        <button class="btn btn-soft" data-action="back-to-edit">ย้อนกลับ</button>
        <button class="btn btn-danger" data-action="reset-transaction-draft">ยกเลิก</button>
        <button class="btn btn-secondary" data-action="save-transaction">บันทึกเข้าระบบ</button>
        <button class="btn btn-primary" data-action="save-and-download-transaction">บันทึกและเซฟ PDF</button>
      </div>
    </section>
  `;
}

function renderEmployeesView() {
  return `
    <section class="section">
      ${isManager() ? renderEmployeeForm() : ""}
      <div class="card">
        <div class="section-title">
          <div>
            <h2>พนักงานทั้งหมด</h2>
            <small>Owner และ Admin สามารถเพิ่ม ลบ แก้ไข และระงับพนักงานได้</small>
          </div>
        </div>
        <div class="list" style="margin-top:16px;">
          ${state.employees.map((employee) => `
            <div class="tile">
              <div class="tile-header">
                <div>
                  <div class="tile-title">${escapeHtml(employee.full_name)}</div>
                  <div class="mini-note">${escapeHtml(employee.nickname || "-")} • ${escapeHtml(employee.username)} • ${ROLE_LABELS[employee.role]}</div>
                </div>
                <div class="badge ${employee.status !== "active" ? "expense" : ""}">${employee.status}</div>
              </div>
              <div class="detail-grid">
                <div class="detail"><div class="detail-label">เบอร์โทร</div><div class="detail-value">${escapeHtml(employee.phone || "-")}</div></div>
                <div class="detail"><div class="detail-label">Line ID</div><div class="detail-value">${escapeHtml(employee.line_id || "-")}</div></div>
                <div class="detail"><div class="detail-label">เลขบัตร/พาสปอร์ต</div><div class="detail-value">${escapeHtml(employee.id_number || "-")}</div></div>
              </div>
              ${isManager() ? `
                <div class="button-row">
                  <button class="btn btn-secondary" data-action="edit-employee" data-id="${employee.id}">${employee.role === "owner" ? "แก้ไขข้อมูล" : "แก้ไข"}</button>
                  <button class="btn btn-soft" data-action="toggle-employee-status" data-id="${employee.id}">
                    ${employee.status === "suspended" ? "ยกเลิกระงับ" : "ระงับ"}
                  </button>
                  ${employee.role !== "owner" ? `<button class="btn btn-danger" data-action="delete-employee" data-id="${employee.id}">ลบ</button>` : ""}
                </div>
              ` : ""}
            </div>
          `).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderEmployeeForm() {
  const editing = Boolean(state.editingEmployeeId);
  return `
    <div class="card">
      <div class="section-title">
        <div>
          <h2>${editing ? "แก้ไขพนักงาน" : "เพิ่มพนักงาน"}</h2>
          <small>รองรับการอัปโหลดรูปบัตรและรูปพนักงานจากมือถือ</small>
        </div>
        ${editing ? `<button class="btn btn-soft" data-action="cancel-employee-edit">ยกเลิก</button>` : ""}
      </div>
      <form data-form="employee" class="sheet" style="margin-top:16px;">
        <div class="field-grid cols-2">
          <div class="field"><label>ชื่อผู้ใช้</label><input class="input" name="employee-username" value="${escapeHtml(state.employeeDraft.username)}" ${editing ? "disabled" : ""}></div>
          <div class="field"><label>รหัสผ่าน ${editing ? "(เว้นว่างได้)" : ""}</label><input class="input" type="password" name="employee-password" value="${escapeHtml(state.employeeDraft.password)}"></div>
          <div class="field"><label>ชื่อ-นามสกุล</label><input class="input" name="employee-full_name" value="${escapeHtml(state.employeeDraft.full_name)}"></div>
          <div class="field"><label>ชื่อเล่น</label><input class="input" name="employee-nickname" value="${escapeHtml(state.employeeDraft.nickname)}"></div>
          <div class="field"><label>บทบาท</label><select name="employee-role">
            <option value="employee" ${state.employeeDraft.role === "employee" ? "selected" : ""}>Employee</option>
            <option value="admin" ${state.employeeDraft.role === "admin" ? "selected" : ""}>Admin</option>
            ${state.user.role === "owner" ? `<option value="owner" ${state.employeeDraft.role === "owner" ? "selected" : ""}>Owner</option>` : ""}
          </select></div>
          <div class="field"><label>สถานะ</label><select name="employee-status">
            <option value="active" ${state.employeeDraft.status === "active" ? "selected" : ""}>active</option>
            <option value="suspended" ${state.employeeDraft.status === "suspended" ? "selected" : ""}>suspended</option>
          </select></div>
          <div class="field"><label>เลขบัตรประชาชน/พาสปอร์ต</label><input class="input" name="employee-id_number" value="${escapeHtml(state.employeeDraft.id_number)}"></div>
          <div class="field"><label>เบอร์โทร</label><input class="input" name="employee-phone" value="${escapeHtml(state.employeeDraft.phone)}"></div>
          <div class="field"><label>Line ID</label><input class="input" name="employee-line_id" value="${escapeHtml(state.employeeDraft.line_id)}"></div>
          <div class="field"><label>รูปบัตร</label><input class="input" type="file" accept="image/*" name="employee-card_image_data_url"></div>
          <div class="field"><label>รูปพนักงาน</label><input class="input" type="file" accept="image/*" name="employee-photo_image_data_url"></div>
        </div>
        <div class="button-row">
          <button class="btn btn-primary" type="submit">${editing ? "บันทึกการแก้ไข" : "เพิ่มพนักงาน"}</button>
        </div>
      </form>
    </div>
  `;
}

function renderMoreView() {
  return `
    <section class="section">
      ${isOwner() ? renderOwnerProfileCard() : ""}
      <div class="card">
        <div class="section-title">
          <div>
            <h2>ตั้งค่าธุรกิจ</h2>
            <small>ปรับชื่อแผง, พันธุ์ทุเรียน, เกรด และข้อความในบิล</small>
          </div>
        </div>
        ${isManager() ? renderSettingsForm() : `<div class="notice" style="margin-top:16px;">เฉพาะ Owner และ Admin เท่านั้นที่แก้ไขการตั้งค่าได้</div>`}
      </div>
      <div class="card">
        <div class="section-title">
          <div>
            <h2>Audit Log</h2>
            <small>ประวัติการแก้ไขและลบข้อมูลสำหรับตรวจสอบย้อนหลัง</small>
          </div>
        </div>
        <div class="list" style="margin-top:16px;">
          ${state.logs.length ? state.logs.map((log) => renderAuditLogCard(log)).join("") : `<div class="empty">ยังไม่มีประวัติการแก้ไข</div>`}
        </div>
      </div>
    </section>
  `;
}

function renderOwnerProfileCard() {
  return `
    <div class="card">
      <div class="section-title">
        <div>
          <h2>ข้อมูล Owner</h2>
          <small>เข้าถึงการแก้ไขข้อมูลเจ้าของระบบได้รวดเร็ว</small>
        </div>
        <button class="btn btn-primary" data-action="edit-owner-profile">แก้ไขข้อมูล</button>
      </div>
      <div class="detail-grid" style="margin-top:16px;">
        <div class="detail"><div class="detail-label">ชื่อผู้ใช้</div><div class="detail-value">${escapeHtml(state.user.username)}</div></div>
        <div class="detail"><div class="detail-label">ชื่อแสดง</div><div class="detail-value">${escapeHtml(state.user.display_name)}</div></div>
        <div class="detail"><div class="detail-label">บทบาท</div><div class="detail-value">Owner</div></div>
      </div>
    </div>
  `;
}

function renderSettingsForm() {
  const profile = state.settings.business_profile || DEFAULT_SETTINGS.business_profile;
  return `
    <form data-form="settings" class="sheet" style="margin-top:16px;">
      <div class="field-grid cols-2">
        <div class="field"><label>ชื่อแผง</label><input class="input" name="settings-booth_name" value="${escapeHtml(profile.booth_name || "")}"></div>
        <div class="field"><label>ชื่อเจ้าของ</label><input class="input" name="settings-owner_name" value="${escapeHtml(profile.owner_name || "")}"></div>
        <div class="field"><label>เบอร์โทร</label><input class="input" name="settings-phone" value="${escapeHtml(profile.phone || "")}"></div>
        <div class="field"><label>ที่อยู่</label><input class="input" name="settings-address" value="${escapeHtml(profile.address || "")}"></div>
      </div>
      <div class="field"><label>ข้อความท้ายบิล</label><textarea name="settings-receipt_note">${escapeHtml(profile.receipt_note || "")}</textarea></div>
      <div class="field"><label>พันธุ์ทุเรียน (คั่นด้วยจุลภาค)</label><textarea name="settings-varieties">${escapeHtml((state.settings.durian_varieties || []).join(", "))}</textarea></div>
      <div class="field-grid cols-3">
        ${(state.settings.grade_labels || []).map((item, index) => `
          <div class="field">
            <label>เกรด ${index + 1}</label>
            <input class="input" name="settings-grade-${index}" value="${escapeHtml(item)}">
          </div>
        `).join("")}
      </div>
      <div class="button-row">
        <button class="btn btn-primary" type="submit">บันทึกการตั้งค่า</button>
      </div>
    </form>
  `;
}

function renderAuditLogCard(log) {
  return `
    <div class="tile">
      <div class="tile-header">
        <div>
          <div class="tile-title">${escapeHtml(log.action_label || log.action)}</div>
          <div class="mini-note">${escapeHtml(log.actor_name)} • ${escapeHtml(log.target_type)} #${escapeHtml(String(log.target_id))}</div>
        </div>
        <div class="badge">${formatDateTime(log.created_at)}</div>
      </div>
      ${log.summary ? renderAuditSummaryBlock("ข้อมูลล่าสุด", log.summary) : ""}
      ${log.before_summary && log.action !== "create_transaction" ? renderAuditSummaryBlock("ก่อนแก้ไข", log.before_summary) : ""}
      ${log.reason ? `<div class="notice">เหตุผล: ${escapeHtml(log.reason)}</div>` : ""}
    </div>
  `;
}

function renderAuditSummaryBlock(title, summary) {
  return `
    <div class="panel">
      <div class="detail-label">${escapeHtml(title)}</div>
      <div class="tile-title" style="margin-top:6px;">${escapeHtml(summary.headline || "-")}</div>
      ${summary.meta?.length ? `<div class="mini-note" style="margin-top:6px;">${summary.meta.map((item) => escapeHtml(item)).join(" • ")}</div>` : ""}
      ${summary.details?.length ? `
        <div class="list" style="margin-top:10px;">
          ${summary.details.map((item) => `<div class="mini-note">${escapeHtml(item)}</div>`).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

async function handleClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }
  const { action } = target.dataset;

  if (action === "set-view") {
    state.currentView = target.dataset.view;
    render();
    return;
  }
  if (action === "set-range") {
    state.dashboardRange = target.dataset.range;
    rebuildDashboard();
    persistLocalState();
    render();
    return;
  }
  if (action === "quick-buy") {
    presetTransactionDraft("buy_durian");
    return;
  }
  if (action === "quick-sell") {
    presetTransactionDraft("sell_durian");
    return;
  }
  if (action === "sync-pending") {
    await syncPendingTransactions();
    return;
  }
  if (action === "select-transaction") {
    state.selectedTransactionId = target.dataset.id;
    state.currentView = "transactions";
    render();
    return;
  }
  if (action === "preview-transaction") {
    previewTransaction();
    return;
  }
  if (action === "back-to-edit") {
    state.transactionStep = "edit";
    render();
    return;
  }
  if (action === "reset-transaction-draft") {
    resetTransactionDraft();
    return;
  }
  if (action === "add-line-item") {
    state.transactionDraft.items.push(createDefaultLineItem());
    render();
    return;
  }
  if (action === "remove-line-item") {
    state.transactionDraft.items.splice(Number(target.dataset.index), 1);
    render();
    return;
  }
  if (action === "save-transaction") {
    await saveCurrentTransaction(false);
    return;
  }
  if (action === "save-and-download-transaction") {
    await saveCurrentTransaction(true);
    return;
  }
  if (action === "download-receipt") {
    const transaction = state.transactions.find((item) => String(item.id) === String(target.dataset.id));
    if (transaction) {
      await saveReceiptToDevice(transaction);
    }
    return;
  }
  if (action === "edit-transaction") {
    loadTransactionForEdit(target.dataset.id);
    return;
  }
  if (action === "delete-transaction") {
    await deleteTransaction(target.dataset.id);
    return;
  }
  if (action === "edit-employee") {
    loadEmployeeForEdit(target.dataset.id);
    return;
  }
  if (action === "edit-owner-profile") {
    loadEmployeeForEdit(state.user.id);
    return;
  }
  if (action === "cancel-employee-edit") {
    resetEmployeeDraft();
    return;
  }
  if (action === "toggle-employee-status") {
    await toggleEmployeeStatus(target.dataset.id);
    return;
  }
  if (action === "delete-employee") {
    await deleteEmployee(target.dataset.id);
    return;
  }
  if (action === "logout") {
    await logout();
  }
}

async function handleChange(event) {
  const { name, type, checked, files } = event.target;
  if (!name) {
    return;
  }

  if (name === "remember-credentials") {
    state.loginForm.rememberCredentials = checked;
    persistLocalState();
    return;
  }
  if (name === "auto-login") {
    state.loginForm.autoLogin = checked;
    persistLocalState();
    return;
  }
  if (name.startsWith("draft-")) {
    updateDraftField(name.replace("draft-", ""), event.target.value);
    return;
  }
  if (name.startsWith("grade-label-")) {
    const index = Number(name.split("-").pop());
    state.transactionDraft.grade_labels[index] = event.target.value;
    render();
    return;
  }
  if (name.startsWith("item-")) {
    const [, field, index] = name.split("-");
    updateLineItemField(Number(index), field, event.target.value);
    return;
  }
  if (name.startsWith("employee-") && type === "file" && files?.[0]) {
    const dataUrl = await readFileAsDataUrl(files[0]);
    state.employeeDraft[name.replace("employee-", "")] = dataUrl;
    showToast("แนบรูปเรียบร้อยแล้ว");
    return;
  }
  if (name.startsWith("employee-")) {
    state.employeeDraft[name.replace("employee-", "")] = event.target.value;
  }
}

function handleInput(event) {
  const { name, value } = event.target;
  if (!name) {
    return;
  }

  if (name === "login-username") {
    state.loginForm.username = value;
    return;
  }
  if (name === "login-password") {
    state.loginForm.password = value;
    return;
  }
  if (name.startsWith("draft-")) {
    updateDraftField(name.replace("draft-", ""), value, false);
    return;
  }
  if (name.startsWith("item-")) {
    const [, field, index] = name.split("-");
    updateLineItemField(Number(index), field, value, false);
    return;
  }
  if (name.startsWith("employee-")) {
    state.employeeDraft[name.replace("employee-", "")] = value;
  }
}

async function handleSubmit(event) {
  const form = event.target.closest("form[data-form]");
  if (!form) {
    return;
  }
  event.preventDefault();
  const formType = form.dataset.form;
  if (formType === "login") {
    await login();
    return;
  }
  if (formType === "employee") {
    await saveEmployee();
    return;
  }
  if (formType === "settings") {
    await saveSettings(new FormData(form));
  }
}

function updateDraftField(field, value, shouldRender = true) {
  state.transactionDraft[field] = value;
  if (field === "category") {
    if (value === "sell_durian") {
      state.transactionDraft.sale_mode = state.transactionDraft.sale_mode || "wholesale";
      if (!state.transactionDraft.items.length) {
        state.transactionDraft.items = [createDefaultLineItem()];
      }
    }
    if (value === "buy_durian" && !state.transactionDraft.items.length) {
      state.transactionDraft.items = [createDefaultLineItem()];
    }
  }
  if (shouldRender && ["category", "sale_mode"].includes(field)) {
    render();
  }
}

function updateLineItemField(index, field, value, shouldRender = false) {
  const item = state.transactionDraft.items[index];
  if (!item) {
    return;
  }
  item[field] = value;
  if (["weight_kg", "price_per_kg", "total_price"].includes(field)) {
    autoCalculateLineItem(index, field);
  }
  if (shouldRender && field === "grade_name") {
    render();
  }
}

function autoCalculateLineItem(index, changedField) {
  const item = state.transactionDraft.items[index];
  const weight = parseNumber(item.weight_kg);
  const price = parseNumber(item.price_per_kg);
  const total = parseNumber(item.total_price);

  if (changedField !== "total_price" && weight > 0 && price > 0) {
    item.total_price = String(roundMoney(weight * price));
  } else if (changedField !== "price_per_kg" && weight > 0 && total > 0) {
    item.price_per_kg = String(roundMoney(total / weight));
  } else if (changedField !== "weight_kg" && price > 0 && total > 0) {
    item.weight_kg = String(roundMoney(total / price));
  }

  ["weight_kg", "price_per_kg", "total_price"].forEach((field) => {
    const input = app.querySelector(`[name="item-${field}-${index}"]`);
    if (input && document.activeElement !== input) {
      input.value = item[field];
    }
  });
}

function presetTransactionDraft(category) {
  resetTransactionDraft(false);
  state.transactionDraft.category = category;
  state.transactionDraft.sale_mode = category === "sell_durian" ? "wholesale" : "";
  state.currentView = "add";
  render();
}

function previewTransaction() {
  try {
    const payload = prepareTransactionPayload(state.transactionDraft);
    state.transactionPreview = buildPreviewTransaction(payload);
    state.transactionStep = "preview";
    render();
  } catch (error) {
    showToast(error.message);
  }
}

function buildPreviewTransaction(payload) {
  const previewPayload = {
    ...payload,
    transaction_at: payload.transaction_at || new Date().toISOString()
  };
  const preview = buildLocalTransaction(previewPayload);
  preview.bill_number = state.editingTransactionId ? `EDIT-${state.editingTransactionId}` : `PREVIEW-${String(Date.now()).slice(-6)}`;
  preview.pending_sync = false;
  preview.receipt_snapshot = generateReceiptHTML(preview, state.settings);
  return preview;
}

function resetTransactionDraft(shouldRender = true) {
  state.transactionDraft = createDefaultTransactionDraft();
  state.transactionDraft.grade_labels = deepClone(state.settings.grade_labels || DEFAULT_SETTINGS.grade_labels);
  state.transactionStep = "edit";
  state.transactionPreview = null;
  state.editingTransactionId = null;
  if (shouldRender) {
    state.currentView = "add";
    render();
  }
}

function resetEmployeeDraft() {
  state.employeeDraft = createDefaultEmployeeDraft();
  state.editingEmployeeId = null;
  render();
}

function loadTransactionForEdit(id) {
  const transaction = state.transactions.find((item) => String(item.id) === String(id));
  if (!transaction) {
    return;
  }
  state.editingTransactionId = transaction.id;
  state.transactionDraft = {
    transaction_at: toDateTimeLocalInput(new Date(transaction.transaction_at)),
    category: transaction.category,
    sale_mode: transaction.sale_mode || "wholesale",
    subcategory: transaction.subcategory || "",
    amount: String(transaction.amount || ""),
    fruit_count: String(transaction.fruit_count || ""),
    note: transaction.note || "",
    grade_labels: deepClone(state.settings.grade_labels || DEFAULT_SETTINGS.grade_labels),
    items: transaction.items?.length
      ? transaction.items.map((item) => ({
          durian_variety: item.durian_variety || "",
          grade_name: item.grade_name || "",
          weight_kg: String(item.weight_kg || ""),
          price_per_kg: String(item.price_per_kg || ""),
          total_price: String(item.total_price || ""),
          fruit_count: String(item.fruit_count || ""),
          note: item.note || ""
        }))
      : [createDefaultLineItem()]
  };
  state.currentView = "add";
  state.transactionStep = "edit";
  render();
}

function loadEmployeeForEdit(id) {
  const employee = state.employees.find((item) => String(item.id) === String(id));
  if (!employee) {
    return;
  }
  state.editingEmployeeId = employee.id;
  state.employeeDraft = {
    username: employee.username,
    password: "",
    full_name: employee.full_name,
    nickname: employee.nickname || "",
    role: employee.role,
    id_number: employee.id_number || "",
    phone: employee.phone || "",
    line_id: employee.line_id || "",
    card_image_data_url: "",
    photo_image_data_url: "",
    card_image_url: employee.card_image_url || "",
    photo_image_url: employee.photo_image_url || "",
    status: employee.status
  };
  state.currentView = "employees";
  render();
}

async function login() {
  try {
    if (state.online) {
      const bootstrap = await apiRequest("POST", "/api/auth/login", {
        username: state.loginForm.username,
        password: state.loginForm.password,
        auto_login: state.loginForm.autoLogin
      });
      state.offlineMode = false;
      applyBootstrap(bootstrap, { offline: false });
      persistLocalState();
      showToast("เข้าสู่ระบบสำเร็จ");
      return;
    }
    loginOffline();
  } catch (error) {
    showToast(error.message);
  }
}

function loginOffline() {
  const snapshot = JSON.parse(localStorage.getItem(STORAGE_KEYS.snapshot) || "null");
  if (!snapshot?.user) {
    throw new Error("ออฟไลน์อยู่และยังไม่มีข้อมูลเคยล็อกอินบนเครื่องนี้");
  }
  const remembered = JSON.parse(localStorage.getItem(STORAGE_KEYS.remember) || "null");
  if (
    !remembered ||
    remembered.username !== state.loginForm.username ||
    remembered.password !== state.loginForm.password ||
    snapshot.user.username !== state.loginForm.username
  ) {
    throw new Error("ออฟไลน์อยู่ ต้องใช้บัญชีที่เคยเลือกจำไว้บนเครื่องนี้");
  }
  applyCachedSnapshot(true);
  persistLocalState();
  showToast("เข้าสู่ระบบแบบออฟไลน์แล้ว");
}

async function logout() {
  try {
    if (state.online && !state.offlineMode) {
      await apiRequest("POST", "/api/auth/logout");
    }
  } catch (_error) {}
  state.user = null;
  state.offlineMode = false;
  state.currentView = "dashboard";
  state.selectedTransactionId = null;
  render();
}

async function saveCurrentTransaction(downloadAfter) {
  try {
    const payload = prepareTransactionPayload(state.transactionDraft);
    if (!state.online) {
      const offlinePayload = {
        ...payload,
        transaction_at: payload.transaction_at || new Date().toISOString()
      };
      const localTransaction = buildLocalTransaction(offlinePayload);
      state.transactions = sortTransactions([localTransaction, ...state.transactions]);
      state.pendingTransactions.push({ localId: localTransaction.id, payload: offlinePayload });
      persistLocalState();
      rebuildDashboard();
      if (downloadAfter) {
        await saveReceiptToDevice(localTransaction);
      }
      resetTransactionDraft();
      state.currentView = "transactions";
      showToast("บันทึกออฟไลน์แล้ว ระบบจะซิงก์ให้อัตโนมัติ");
      return;
    }

    await ensureOnlineSession();
    let transaction;
    if (state.editingTransactionId) {
      const result = await apiRequest("PUT", `/api/transactions/${state.editingTransactionId}`, payload);
      transaction = result.transaction;
      state.transactions = sortTransactions(state.transactions.map((item) => String(item.id) === String(transaction.id) ? transaction : item));
    } else {
      const createPayload = { ...payload };
      delete createPayload.transaction_at;
      const result = await apiRequest("POST", "/api/transactions", createPayload);
      transaction = result.transaction;
      state.transactions = sortTransactions([transaction, ...state.transactions]);
    }
    await refreshLogs();
    persistLocalState();
    if (downloadAfter) {
      await saveReceiptToDevice(transaction);
    }
    resetTransactionDraft();
    state.currentView = "transactions";
    state.selectedTransactionId = transaction.id;
    showToast("บันทึกรายการเรียบร้อยแล้ว");
  } catch (error) {
    showToast(error.message);
  }
}

async function syncPendingTransactions() {
  if (!state.online || !state.pendingTransactions.length || state.syncing) {
    render();
    return;
  }
  state.syncing = true;
  render();
  try {
    await ensureOnlineSession();
    const nextPending = [];
    for (const queued of state.pendingTransactions) {
      try {
        const result = await apiRequest("POST", "/api/transactions", {
          ...queued.payload,
          offline_ref: queued.localId
        });
        state.transactions = state.transactions
          .map((item) => String(item.id) === String(queued.localId) ? result.transaction : item);
      } catch (error) {
        nextPending.push(queued);
      }
    }
    state.pendingTransactions = nextPending;
    state.transactions = sortTransactions(state.transactions);
    await refreshLogs();
    persistLocalState();
    if (!nextPending.length) {
      state.offlineMode = false;
      showToast("ซิงก์ข้อมูลออฟไลน์ครบแล้ว");
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    state.syncing = false;
    rebuildDashboard();
    render();
  }
}

async function deleteTransaction(id) {
  if (!state.online) {
    showToast("การลบรายการต้องทำตอนออนไลน์เพื่อเก็บ Log");
    return;
  }
  const reason = window.prompt("เหตุผลในการลบรายการนี้", "") || "";
  try {
    await ensureOnlineSession();
    const result = await apiRequest("DELETE", `/api/transactions/${id}`, { reason });
    state.transactions = sortTransactions(state.transactions.map((item) => String(item.id) === String(id) ? result.transaction : item));
    await refreshLogs();
    persistLocalState();
    render();
    showToast("ลบรายการเรียบร้อยแล้ว");
  } catch (error) {
    showToast(error.message);
  }
}

async function saveEmployee() {
  if (!state.online) {
    showToast("การจัดการพนักงานต้องเชื่อมต่อระบบก่อน");
    return;
  }
  try {
    await ensureOnlineSession();
    const payload = { ...state.employeeDraft };
    delete payload.card_image_url;
    delete payload.photo_image_url;
    let employee;
    if (state.editingEmployeeId) {
      const result = await apiRequest("PUT", `/api/employees/${state.editingEmployeeId}`, payload);
      employee = result.employee;
      state.employees = state.employees.map((item) => item.id === employee.id ? employee : item);
    } else {
      const result = await apiRequest("POST", "/api/employees", payload);
      employee = result.employee;
      state.employees = [...state.employees, employee];
    }
    state.employees.sort((left, right) => left.full_name.localeCompare(right.full_name, "th"));
    resetEmployeeDraft();
    await refreshLogs();
    persistLocalState();
    showToast("บันทึกพนักงานเรียบร้อยแล้ว");
  } catch (error) {
    showToast(error.message);
  }
}

async function toggleEmployeeStatus(id) {
  if (!state.online) {
    showToast("การระงับพนักงานต้องเชื่อมต่อระบบก่อน");
    return;
  }
  try {
    await ensureOnlineSession();
    const result = await apiRequest("POST", `/api/employees/${id}/suspend`, {});
    state.employees = state.employees.map((item) => item.id === result.employee.id ? result.employee : item);
    await refreshLogs();
    persistLocalState();
    render();
    showToast("อัปเดตสถานะพนักงานแล้ว");
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteEmployee(id) {
  if (!state.online) {
    showToast("การลบพนักงานต้องเชื่อมต่อระบบก่อน");
    return;
  }
  const reason = window.prompt("เหตุผลในการลบพนักงาน", "") || "";
  try {
    await ensureOnlineSession();
    const result = await apiRequest("DELETE", `/api/employees/${id}`, { reason });
    state.employees = state.employees.map((item) => item.id === result.employee.id ? result.employee : item);
    await refreshLogs();
    persistLocalState();
    render();
    showToast("ลบพนักงานเรียบร้อยแล้ว");
  } catch (error) {
    showToast(error.message);
  }
}

async function saveSettings(formData) {
  if (!state.online) {
    showToast("การแก้ไขตั้งค่าต้องเชื่อมต่อระบบก่อน");
    return;
  }
  try {
    await ensureOnlineSession();
    const gradeLabels = Array.from({ length: 6 }, (_, index) => formData.get(`settings-grade-${index}`) || "");
    const payload = {
      business_profile: {
        booth_name: formData.get("settings-booth_name") || "",
        owner_name: formData.get("settings-owner_name") || "",
        phone: formData.get("settings-phone") || "",
        address: formData.get("settings-address") || "",
        receipt_note: formData.get("settings-receipt_note") || ""
      },
      durian_varieties: String(formData.get("settings-varieties") || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      grade_labels: gradeLabels
    };
    const result = await apiRequest("PUT", "/api/settings", payload);
    state.settings = result.settings;
    state.transactionDraft.grade_labels = deepClone(state.settings.grade_labels || DEFAULT_SETTINGS.grade_labels);
    await refreshLogs();
    persistLocalState();
    render();
    showToast("บันทึกการตั้งค่าแล้ว");
  } catch (error) {
    showToast(error.message);
  }
}

async function refreshLogs() {
  if (!isManager() || !state.online) {
    return;
  }
  try {
    const result = await apiRequest("GET", "/api/logs?limit=80");
    state.logs = result.logs;
  } catch (_error) {}
}

function sortTransactions(transactions) {
  return [...transactions].sort((left, right) => {
    const dateDiff = new Date(right.transaction_at) - new Date(left.transaction_at);
    if (dateDiff !== 0) {
      return dateDiff;
    }
    return String(right.id).localeCompare(String(left.id));
  });
}

async function saveReceiptToDevice(transaction) {
  const blob = await buildReceiptPdfBlob(transaction);
  const filename = `${transaction.bill_number}.pdf`;
  if (navigator.canShare && navigator.share) {
    try {
      const file = new File([blob], filename, { type: "application/pdf" });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: transaction.bill_number });
        return;
      }
    } catch (_error) {}
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function buildReceiptPdfBlob(transaction) {
  const canvas = renderReceiptCanvas(transaction);
  const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.92);
  const jpegBytes = base64ToUint8Array(jpegDataUrl.split(",")[1]);
  return createPdfBlobFromJpeg(jpegBytes, canvas.width, canvas.height);
}

function renderReceiptCanvas(transaction) {
  const items = (transaction.items || []).length
    ? transaction.items
    : [{
        durian_variety: transaction.category_label,
        grade_name: "",
        weight_kg: 0,
        price_per_kg: 0,
        total_price: transaction.amount,
        fruit_count: transaction.fruit_count || 0,
        note: transaction.note || ""
      }];
  const profile = state.settings.business_profile || DEFAULT_SETTINGS.business_profile;
  const width = 1240;
  const padding = 72;
  const noteLinesSeed = [
    `หมายเหตุ: ${transaction.note || "-"}`,
    profile.receipt_note || ""
  ].filter(Boolean).join(" ");

  const measureCanvas = document.createElement("canvas");
  measureCanvas.width = width;
  measureCanvas.height = 1200;
  const measureCtx = measureCanvas.getContext("2d");
  measureCtx.font = '400 30px "Leelawadee UI", "Noto Sans Thai", "Segoe UI", sans-serif';
  const noteLines = wrapCanvasText(measureCtx, noteLinesSeed, width - padding * 3);

  const height = Math.max(1480, 760 + items.length * 92 + noteLines.length * 36);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "top";

  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, "#eef7d5");
  bg.addColorStop(0.5, "#f7f2dd");
  bg.addColorStop(1, "#fffaf0");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "rgba(70, 102, 41, 0.12)";
  ctx.beginPath();
  ctx.arc(170, 170, 120, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(width - 140, 120, 90, 0, Math.PI * 2);
  ctx.fill();

  drawRoundedRect(ctx, padding, 52, width - padding * 2, height - 104, 40, "#ffffff");

  ctx.fillStyle = "#2a5c2b";
  ctx.font = '800 54px "Leelawadee UI", "Noto Sans Thai", "Segoe UI", sans-serif';
  ctx.fillText(profile.booth_name || "แผงขายทุเรียน", padding + 28, 96);

  ctx.fillStyle = "#5c6f5e";
  ctx.font = '400 28px "Leelawadee UI", "Noto Sans Thai", "Segoe UI", sans-serif';
  ctx.fillText(`บิลเลขที่ ${transaction.bill_number}`, padding + 28, 166);
  ctx.fillText(profile.address || "พร้อมใช้งานทั้งหน้าร้านและหน้างาน", padding + 28, 206);

  drawRoundedRect(ctx, width - 320, 96, 200, 64, 32, transaction.type === "income" ? "#d8efb0" : "#ffe2cd");
  ctx.fillStyle = transaction.type === "income" ? "#284d16" : "#8a4520";
  ctx.font = '800 28px "Leelawadee UI", "Noto Sans Thai", "Segoe UI", sans-serif';
  ctx.fillText(transaction.type_label, width - 268, 114);

  const infoCards = [
    ["วันที่บันทึก", formatDateTime(transaction.transaction_at)],
    ["หมวดหมู่", transaction.category_label],
    ["ผู้บันทึก", transaction.recorded_by_name],
    ["ติดต่อ", profile.phone || "-"]
  ];
  infoCards.forEach(([label, value], index) => {
    const x = padding + 28 + (index % 2) * ((width - padding * 2 - 96) / 2);
    const y = 282 + Math.floor(index / 2) * 124;
    drawRoundedRect(ctx, x, y, (width - padding * 2 - 132) / 2, 98, 24, "#f8fbf1", "#e1ebd2");
    ctx.fillStyle = "#647663";
    ctx.font = '700 20px "Leelawadee UI", "Noto Sans Thai", "Segoe UI", sans-serif';
    ctx.fillText(label, x + 20, y + 18);
    ctx.fillStyle = "#1f311f";
    ctx.font = '700 28px "Leelawadee UI", "Noto Sans Thai", "Segoe UI", sans-serif';
    wrapCanvasText(ctx, value, (width - padding * 2 - 180) / 2).slice(0, 2).forEach((line, lineIndex) => {
      ctx.fillText(line, x + 20, y + 46 + lineIndex * 28);
    });
  });

  let cursorY = 560;
  drawRoundedRect(ctx, padding + 28, cursorY, width - padding * 2 - 56, 64, 22, "#f1f6e7");
  const headers = [
    { text: "#", x: padding + 50 },
    { text: "รายการ", x: padding + 110 },
    { text: "จำนวนลูก", x: width - 520 },
    { text: "น้ำหนัก", x: width - 390 },
    { text: "ราคาต่อกก.", x: width - 270 },
    { text: "รวม", x: width - 130 }
  ];
  ctx.fillStyle = "#607164";
  ctx.font = '700 22px "Leelawadee UI", "Noto Sans Thai", "Segoe UI", sans-serif';
  headers.forEach((header) => ctx.fillText(header.text, header.x, cursorY + 20));
  cursorY += 82;

  items.forEach((item, index) => {
    drawRoundedRect(ctx, padding + 28, cursorY, width - padding * 2 - 56, 74, 20, "#ffffff", "#edf2e2");
    const itemTitle = [item.durian_variety, item.grade_name].filter(Boolean).join(" / ") || transaction.category_label;
    ctx.fillStyle = "#1e2f1e";
    ctx.font = '700 24px "Leelawadee UI", "Noto Sans Thai", "Segoe UI", sans-serif';
    ctx.fillText(String(index + 1), padding + 54, cursorY + 24);
    ctx.fillText(itemTitle, padding + 110, cursorY + 24);
    ctx.font = '600 22px "Leelawadee UI", "Noto Sans Thai", "Segoe UI", sans-serif';
    ctx.fillText(String(item.fruit_count || "-"), width - 490, cursorY + 24);
    ctx.fillText(formatNumber(item.weight_kg), width - 390, cursorY + 24);
    ctx.fillText(formatCurrency(item.price_per_kg), width - 270, cursorY + 24);
    ctx.fillText(formatCurrency(item.total_price), width - 130, cursorY + 24);
    cursorY += 86;
  });

  drawRoundedRect(ctx, padding + 28, cursorY + 12, width - padding * 2 - 56, 92, 28, "#245c2a");
  ctx.fillStyle = "#ffffff";
  ctx.font = '800 30px "Leelawadee UI", "Noto Sans Thai", "Segoe UI", sans-serif';
  ctx.fillText("ยอดรวมสุทธิ", padding + 60, cursorY + 40);
  ctx.fillText(`${formatCurrency(transaction.amount)} บาท`, width - 300, cursorY + 40);
  cursorY += 136;

  drawRoundedRect(ctx, padding + 28, cursorY, width - padding * 2 - 56, 84 + Math.max(0, noteLines.length - 2) * 34, 26, "#fff7df", "#f1e2a9");
  ctx.fillStyle = "#77591f";
  ctx.font = '800 24px "Leelawadee UI", "Noto Sans Thai", "Segoe UI", sans-serif';
  ctx.fillText("หมายเหตุ", padding + 54, cursorY + 20);
  ctx.font = '500 26px "Leelawadee UI", "Noto Sans Thai", "Segoe UI", sans-serif';
  noteLines.forEach((line, index) => {
    ctx.fillText(line, padding + 54, cursorY + 54 + index * 32);
  });

  return canvas;
}

function wrapCanvasText(ctx, text, maxWidth) {
  const safeText = String(text || "").trim();
  if (!safeText) {
    return ["-"];
  }
  const useSpaces = safeText.includes(" ");
  const segments = useSpaces ? safeText.split(/\s+/) : Array.from(safeText);
  const lines = [];
  let currentLine = "";
  segments.forEach((segment) => {
    const candidate = currentLine
      ? `${currentLine}${useSpaces ? " " : ""}${segment}`
      : segment;
    if (ctx.measureText(candidate).width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = segment;
    } else {
      currentLine = candidate;
    }
  });
  if (currentLine) {
    lines.push(currentLine);
  }
  return lines;
}

function drawRoundedRect(ctx, x, y, width, height, radius, fillStyle, strokeStyle = "") {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
  if (strokeStyle) {
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function createPdfBlobFromJpeg(jpegBytes, imageWidth, imageHeight) {
  const encoder = new TextEncoder();
  const header = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 37, 255, 255, 255, 255, 10]);
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 18;
  const scale = Math.min((pageWidth - margin * 2) / imageWidth, (pageHeight - margin * 2) / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  const originX = (pageWidth - drawWidth) / 2;
  const originY = (pageHeight - drawHeight) / 2;
  const contentStream = `q\n${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ${originX.toFixed(2)} ${originY.toFixed(2)} cm\n/Im0 Do\nQ\n`;
  const contentBytes = encoder.encode(contentStream);

  const objects = [
    encoder.encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encoder.encode("2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n"),
    encoder.encode(
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] /Resources << /XObject << /Im0 4 0 R >> /ProcSet [/PDF /ImageC] >> /Contents 5 0 R >>\nendobj\n`
    ),
    concatUint8Arrays([
      encoder.encode(
        `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`
      ),
      jpegBytes,
      encoder.encode("\nendstream\nendobj\n")
    ]),
    concatUint8Arrays([
      encoder.encode(`5 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`),
      contentBytes,
      encoder.encode("\nendstream\nendobj\n")
    ])
  ];

  let offset = header.length;
  const offsets = [0];
  objects.forEach((objectBytes) => {
    offsets.push(offset);
    offset += objectBytes.length;
  });

  const xrefOffset = offset;
  const xrefEntries = ["0000000000 65535 f "];
  offsets.slice(1).forEach((itemOffset) => {
    xrefEntries.push(`${String(itemOffset).padStart(10, "0")} 00000 n `);
  });
  const trailer = encoder.encode(
    `xref\n0 ${objects.length + 1}\n${xrefEntries.join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  );

  return new Blob([header, ...objects, trailer], { type: "application/pdf" });
}

function concatUint8Arrays(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.length;
  });
  return merged;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("อ่านไฟล์ไม่สำเร็จ"));
    reader.readAsDataURL(file);
  });
}

boot();
