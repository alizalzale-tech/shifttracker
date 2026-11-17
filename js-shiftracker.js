// =========================================================
// ShiftTrack – Logic
// =========================================================

// ---------- Data storage ----------
// Shifts and settings are saved in the browser (localStorage),
// so they are still there after the page is closed.
function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; }
  catch (e) { return fallback; }
}
// Remove any old test data from earlier versions so the app starts fresh
try { localStorage.removeItem("shifts"); localStorage.removeItem("settings"); } catch (e) {}

let shifts = load("shifttrack_shifts", []);
let settings = load("shifttrack_settings", { rate: 20.00, otLimit: 44 });
let profile = load("shifttrack_profile", null); // { name, job } – null until the welcome screen is filled in
let editingId = null;

function save() {
  try {
    localStorage.setItem("shifttrack_shifts", JSON.stringify(shifts));
    localStorage.setItem("shifttrack_settings", JSON.stringify(settings));
    localStorage.setItem("shifttrack_profile", JSON.stringify(profile));
  } catch (e) {
    // Saving is blocked here (e.g. a preview window). The app still works, it just won't remember shifts.
  }
}

// ---------- Icons used in the table ----------
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
const ICON_DELETE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
const ICON_EMPTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M12 14v4M10 16h4"/></svg>';

// ---------- Helper functions ----------
const $ = id => document.getElementById(id);
const money = n => "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// ---------- Paycheque deductions (2026, Ontario) ----------
// Rates from the Canada Revenue Agency for 2026.
const TAX = {
  cppRate: 0.0595, cppExemption: 3500, cppMax: 74600,   // CPP: 5.95% of pay after a $3,500 yearly exemption
  cpp2Rate: 0.04, cpp2Max: 85000,                       // CPP2: 4% on pay between $74,600 and $85,000
  eiRate: 0.0163, eiMax: 68900,                         // EI: 1.63% of pay up to $68,900
  fedBPA: 16452, fedLow: 0.14,                          // Federal basic personal amount
  fedBrackets: [[58523, 0.14], [117045, 0.205], [181440, 0.26], [258482, 0.29], [Infinity, 0.33]],
  onBPA: 12989, onLow: 0.0505,                          // Ontario basic personal amount
  onBrackets: [[53891, 0.0505], [107785, 0.0915], [150000, 0.1116], [220000, 0.1216], [Infinity, 0.1316]]
};

// Tax for an income using a list of [top of bracket, rate]
function bracketTax(income, brackets) {
  let tax = 0, bottom = 0;
  for (const [top, rate] of brackets) {
    if (income > bottom) tax += (Math.min(income, top) - bottom) * rate;
    bottom = top;
  }
  return tax;
}

// Works out the yearly deductions for a yearly income
function yearlyDeductions(income) {
  const cpp1 = Math.max(0, Math.min(income, TAX.cppMax) - TAX.cppExemption) * TAX.cppRate;
  const cpp2 = Math.max(0, Math.min(income, TAX.cpp2Max) - TAX.cppMax) * TAX.cpp2Rate;
  const ei = Math.min(income, TAX.eiMax) * TAX.eiRate;

  // Part of CPP lowers your taxable income, the rest (plus EI) gives you a tax credit
  const cppCredit = cpp1 * (4.95 / 5.95);
  const taxable = income - (cpp1 - cppCredit) - cpp2;

  const federal = Math.max(0, bracketTax(taxable, TAX.fedBrackets) - TAX.fedLow * (TAX.fedBPA + cppCredit + ei));
  let ontario = Math.max(0, bracketTax(taxable, TAX.onBrackets) - TAX.onLow * (TAX.onBPA + cppCredit + ei));
  ontario += 0.20 * Math.max(0, ontario - 5818) + 0.36 * Math.max(0, ontario - 7446); // Ontario surtax

  return { federal, ontario, cpp: cpp1 + cpp2, ei };
}

// Like a real paycheque: looks at your average weekly pay this year, works out
// what that would be over a full year, and turns the deductions into percentages.
function deductionRates() {
  const year = todayStr().slice(0, 4);
  const yearShifts = shifts.filter(s => s.date.startsWith(year));
  const zero = { federal: 0, ontario: 0, cpp: 0, ei: 0 };
  if (yearShifts.length === 0) return zero;

  const pay = calculatePay();
  const gross = yearShifts.reduce((sum, s) => sum + pay[s.id].pay, 0);
  const firstWeek = new Date(yearShifts.map(s => weekStart(s.date)).sort()[0] + "T00:00:00");
  const lastWeek = new Date(weekStart([todayStr(), ...yearShifts.map(s => s.date)].sort().pop()) + "T00:00:00");
  const weeks = Math.round((lastWeek - firstWeek) / (7 * 24 * 60 * 60 * 1000)) + 1;

  const yearly = (gross / weeks) * 52;
  if (yearly <= 0) return zero;
  const d = yearlyDeductions(yearly);
  return { federal: d.federal / yearly, ontario: d.ontario / yearly, cpp: d.cpp / yearly, ei: d.ei / yearly };
}

// Splits a gross amount into each deduction and take-home pay
function breakdown(gross, rates) {
  const federal = gross * rates.federal;
  const ontario = gross * rates.ontario;
  const cpp = gross * rates.cpp;
  const ei = gross * rates.ei;
  return { gross, federal, ontario, cpp, ei, net: gross - federal - ontario - cpp - ei };
}

function toMinutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

// Works out paid hours. If the end time is earlier than the start time,
// the shift went past midnight (an overnight shift).
function shiftHours(s) {
  let mins = toMinutes(s.end) - toMinutes(s.start);
  if (mins <= 0) mins += 24 * 60;
  return Math.max(0, (mins - s.breakMin) / 60);
}

// Turns a Date into YYYY-MM-DD using local time
function localDateStr(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function todayStr() {
  return localDateStr(new Date());
}

// Returns the Monday that starts the week for a date (YYYY-MM-DD)
function weekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  return localDateStr(d);
}

function formatDate(dateStr, options) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-CA", options);
}

function format12(time) {
  let [h, m] = time.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return h + ":" + String(m).padStart(2, "0") + " " + ap;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

// ---------- Pay calculation with overtime ----------
// Goes through each week in order. Once the weekly hours pass the
// overtime limit, the extra hours are paid at 1.5x the rate.
function calculatePay() {
  const sorted = [...shifts].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const weekTotals = {};
  const results = {};
  for (const s of sorted) {
    const wk = weekStart(s.date);
    const before = weekTotals[wk] || 0;
    const hours = shiftHours(s);
    const regular = Math.max(0, Math.min(hours, settings.otLimit - before));
    const overtime = hours - regular;
    weekTotals[wk] = before + hours;
    results[s.id] = { hours, overtime, pay: regular * s.rate + overtime * s.rate * 1.5 };
  }
  return results;
}

// ---------- Draw everything on the page ----------
function render() {
  const pay = calculatePay();
  const today = todayStr();
  const thisWeek = weekStart(today);
  const thisMonth = today.slice(0, 7);

  // Summary cards
  let wkH = 0, wkP = 0, wkOT = 0, moH = 0, moP = 0, allH = 0;
  for (const s of shifts) {
    const r = pay[s.id];
    allH += r.hours;
    if (weekStart(s.date) === thisWeek) { wkH += r.hours; wkP += r.pay; wkOT += r.overtime; }
    if (s.date.startsWith(thisMonth)) { moH += r.hours; moP += r.pay; }
  }
  $("weekHours").textContent = wkH.toFixed(1);
  $("weekOT").textContent = wkOT > 0
    ? wkOT.toFixed(1) + " h overtime this week"
    : (settings.otLimit - wkH).toFixed(1) + " h until overtime";
  $("weekOT").style.color = wkOT > 0 ? "var(--orange)" : "";
  $("otProgress").style.width = Math.min(100, (wkH / settings.otLimit) * 100) + "%";
  $("otProgress").classList.toggle("over", wkOT > 0);
  const rates = deductionRates();
  $("weekPay").textContent = money(wkP);
  $("weekNet").textContent = "≈ " + money(breakdown(wkP, rates).net) + " take-home";
  $("monthPay").textContent = money(moP);
  $("monthNet").textContent = moH.toFixed(1) + " hours · ≈ " + money(breakdown(moP, rates).net) + " take-home";
  periodTotals.week = wkP;
  periodTotals.month = moP;
  $("totalShifts").textContent = shifts.length;
  $("avgShift").textContent = "Average shift: " + (shifts.length ? (allH / shifts.length).toFixed(1) : "0.0") + " h";

  // Month filter dropdown
  const months = [...new Set(shifts.map(s => s.date.slice(0, 7)))].sort().reverse();
  const current = $("monthFilter").value || "all";
  $("monthFilter").innerHTML = '<option value="all">All months</option>' + months.map(m =>
    `<option value="${m}">${formatDate(m + "-01", { month: "long", year: "numeric" })}</option>`
  ).join("");
  $("monthFilter").value = months.includes(current) ? current : "all";

  // Shift history table
  const filter = $("monthFilter").value;
  const list = shifts
    .filter(s => filter === "all" || s.date.startsWith(filter))
    .sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start));

  if (list.length === 0) {
    $("shiftTable").innerHTML = `<tr><td colspan="8" class="empty">
      <div class="empty-icon">${ICON_EMPTY}</div>
      <strong>No shifts yet</strong>
      Add your first shift and it will show up here.
    </td></tr>`;
  } else {
    $("shiftTable").innerHTML = list.map(s => {
      const r = pay[s.id];
      const ot = r.overtime > 0 ? `<span class="tag">+${r.overtime.toFixed(1)}h OT</span>` : "";
      return `<tr>
        <td><span class="date-main">${formatDate(s.date, { month: "short", day: "numeric" })}</span>
            <span class="muted">· ${formatDate(s.date, { weekday: "short" })}</span></td>
        <td>${format12(s.start)} – ${format12(s.end)}</td>
        <td class="num muted">${s.breakMin} min</td>
        <td class="num">${r.hours.toFixed(2)}${ot}</td>
        <td class="num muted">${money(s.rate)}</td>
        <td class="num pay">${money(r.pay)}</td>
        <td class="muted">${escapeHtml(s.note) || "—"}</td>
        <td><div class="actions">
          <button class="btn-ghost btn-icon" title="Edit" onclick="startEdit('${s.id}')">${ICON_EDIT}</button>
          <button class="btn-danger btn-icon" title="Delete" onclick="deleteShift('${s.id}')">${ICON_DELETE}</button>
        </div></td>
      </tr>`;
    }).join("");
  }

  renderYear(pay, rates);
  renderPaycheque(rates);
  drawChart();
}

// ---------- Earned this year ----------
// Adds up all pay for the current year, and shows a small bar for each month.
function renderYear(pay, rates) {
  const today = todayStr();
  const year = today.slice(0, 4);
  const currentMonth = Number(today.slice(5, 7)) - 1;
  const monthPay = new Array(12).fill(0);
  let total = 0, hours = 0, count = 0;

  for (const s of shifts) {
    if (!s.date.startsWith(year)) continue;
    const r = pay[s.id];
    total += r.pay;
    hours += r.hours;
    count++;
    monthPay[Number(s.date.slice(5, 7)) - 1] += r.pay;
  }

  $("yearLabel").textContent = "Earned in " + year;
  $("yearPay").textContent = money(total);
  $("yearSub").textContent = hours.toFixed(1) + " hours · " + count + (count === 1 ? " shift" : " shifts");
  $("yearNet").textContent = money(breakdown(total, rates).net);
  periodTotals.year = total;

  const best = Math.max(...monthPay, 1);
  const names = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
  $("yearMonths").innerHTML = monthPay.map((p, i) => {
    const full = formatDate(year + "-" + String(i + 1).padStart(2, "0") + "-01", { month: "long" });
    return `<div class="month ${i === currentMonth ? "current" : ""}" title="${full}: ${money(p)}">
      <div class="month-bar ${p > 0 ? "filled" : ""}" style="height:${Math.max(4, (p / best) * 70)}px"></div>
      <span>${names[i]}</span>
    </div>`;
  }).join("");
}

// ---------- Paycheque breakdown card ----------
let currentPeriod = "week";
const periodTotals = { week: 0, month: 0, year: 0 };

function renderPaycheque(rates) {
  const b = breakdown(periodTotals[currentPeriod], rates);
  const parts = [
    { name: "Federal tax", value: b.federal, color: "#ff6b7a" },
    { name: "Ontario tax", value: b.ontario, color: "#ff9f6b" },
    { name: "CPP", value: b.cpp, color: "#ffb547", note: "Canada Pension Plan" },
    { name: "EI", value: b.ei, color: "#7c6cff", note: "Employment Insurance" }
  ];

  $("pcRows").innerHTML =
    `<div class="pc-row gross"><span class="name">Gross pay <small>before deductions</small></span><span class="amount">${money(b.gross)}</span></div>` +
    parts.map(p => `<div class="pc-row">
      <span class="name"><i style="background:${p.color}"></i>${p.name}${p.note ? ` <small>${p.note}</small>` : ""}</span>
      <span class="amount minus">− ${money(p.value)}</span>
    </div>`).join("") +
    `<div class="pc-row total"><span class="name">Take-home pay</span><span class="amount">${money(b.net)}</span></div>`;

  $("pcNet").textContent = money(b.net);
  const keep = b.gross > 0 ? (b.net / b.gross) * 100 : 100;
  $("pcPercent").textContent = "You keep about " + keep.toFixed(0) + "% of your pay";
  const pct = v => (b.gross > 0 ? (v / b.gross) * 100 : 0) + "%";
  $("pcBar").innerHTML = `<div style="width:${pct(b.net)};background:var(--green)"></div>` +
    parts.map(p => `<div style="width:${pct(p.value)};background:${p.color}"></div>`).join("");
}

document.querySelectorAll("#periodTabs button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#periodTabs button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentPeriod = btn.dataset.period;
    renderPaycheque(deductionRates());
  });
});

// ---------- Bar chart (drawn with canvas, no libraries) ----------
function drawChart() {
  const canvas = $("chart");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  // Weeks to show: from the week of your first shift up to this week (max 8)
  const thisWeek = weekStart(todayStr());
  const firstWeek = shifts.length ? shifts.map(s => weekStart(s.date)).sort()[0] : thisWeek;
  const weeks = [];
  const d = new Date(thisWeek + "T00:00:00");
  while (weeks.length < 8) {
    const wk = localDateStr(d);
    weeks.unshift(wk);
    if (wk <= firstWeek) break;
    d.setDate(d.getDate() - 7);
  }
  const totals = weeks.map(wk =>
    shifts.filter(s => weekStart(s.date) === wk).reduce((sum, s) => sum + shiftHours(s), 0)
  );
  const max = Math.ceil(Math.max(settings.otLimit + 6, ...totals) / 10) * 10;

  const left = 36, bottom = 30, top = 20;
  const chartH = h - bottom - top;
  const slot = (w - left) / weeks.length;
  const font = '"Inter", "Segoe UI", Arial';

  // Grid lines and numbers on the left
  ctx.font = "11px " + font;
  ctx.textAlign = "right";
  for (let v = 0; v <= max; v += 10) {
    const y = top + chartH - (v / max) * chartH;
    ctx.strokeStyle = "#1e2027";
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.fillStyle = "#6b6f7b";
    ctx.fillText(v, left - 10, y + 4);
  }

  // Overtime line
  const otY = top + chartH - (settings.otLimit / max) * chartH;
  ctx.strokeStyle = "rgba(255, 181, 71, 0.7)";
  ctx.setLineDash([6, 5]);
  ctx.beginPath(); ctx.moveTo(left, otY); ctx.lineTo(w, otY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffb547";
  ctx.font = "600 11px " + font;
  ctx.fillText("Overtime · " + settings.otLimit + "h", w - 4, otY - 7);

  // Bars
  ctx.textAlign = "center";
  totals.forEach((t, i) => {
    const bw = Math.min(slot * 0.55, 64);
    const cx = left + i * slot + slot / 2;
    const x = cx - bw / 2;
    const bh = (t / max) * chartH;
    const y = top + chartH - bh;

    if (t > 0) {
      const grad = ctx.createLinearGradient(0, y, 0, top + chartH);
      if (t > settings.otLimit) { grad.addColorStop(0, "#ffb547"); grad.addColorStop(1, "#ff8a47"); }
      else { grad.addColorStop(0, "#4f9dff"); grad.addColorStop(1, "#7c6cff"); }
      ctx.fillStyle = grad;
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, bw, bh, [8, 8, 2, 2]); ctx.fill(); }
      else ctx.fillRect(x, y, bw, bh);

      ctx.fillStyle = "#f4f5f7";
      ctx.font = "700 12px " + font;
      ctx.fillText(t.toFixed(1) + "h", cx, y - 8);
    }

    // Week label underneath
    ctx.fillStyle = weeks[i] === thisWeek ? "#f4f5f7" : "#6b6f7b";
    ctx.font = (weeks[i] === thisWeek ? "600 " : "") + "11px " + font;
    const label = weeks[i] === thisWeek ? "This week" : formatDate(weeks[i], { month: "short", day: "numeric" });
    ctx.fillText(label, cx, h - 8);
  });

  // Message when there is nothing to show yet
  if (totals.every(t => t === 0)) {
    ctx.fillStyle = "#8b8f9c";
    ctx.font = "14px " + font;
    ctx.fillText("Add a shift and your hours will show up here", left + (w - left) / 2, top + chartH / 2);
  }
  ctx.textAlign = "left";
}

// ---------- Form: add or edit a shift ----------
function readForm() {
  return {
    date: $("date").value,
    start: $("start").value,
    end: $("end").value,
    breakMin: Number($("breakMin").value) || 0,
    rate: Number($("rate").value),
    note: $("note").value.trim()
  };
}

// Shows the hours and pay for the shift while you type
function showPreview() {
  const s = readForm();
  const box = $("preview");
  if (s.start && s.end && shiftHours(s) > 0) {
    const hrs = shiftHours(s);
    box.innerHTML = `<span>${hrs.toFixed(2)} paid hours</span><strong>${money(hrs * (s.rate || 0))}</strong>`;
    box.classList.add("show");
  } else {
    box.classList.remove("show");
  }
}

function addOrUpdateShift() {
  const s = readForm();

  // Check the input
  if (!s.date) return $("formError").textContent = "Please pick a date.";
  if (!s.start) return $("formError").textContent = "Please enter a full start time (including AM/PM).";
  if (!s.end) return $("formError").textContent = "Please enter a full end time (including AM/PM).";
  if (!s.rate || s.rate <= 0) return $("formError").textContent = "Please enter an hourly rate above $0.";
  if (shiftHours(s) <= 0) return $("formError").textContent = "The break is longer than the shift.";
  $("formError").textContent = "";

  if (editingId) {
    const i = shifts.findIndex(x => x.id === editingId);
    shifts[i] = { ...s, id: editingId };
    toast("Shift updated");
  } else {
    shifts.push({ ...s, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) });
    toast("Shift added");
  }
  save();
  resetForm();
  render();
}

function startEdit(id) {
  const s = shifts.find(x => x.id === id);
  editingId = id;
  $("date").value = s.date;
  $("start").value = s.start;
  $("end").value = s.end;
  $("breakMin").value = s.breakMin;
  $("rate").value = s.rate;
  $("note").value = s.note;
  $("formTitle").textContent = "Edit shift";
  $("submitBtn").textContent = "Save Changes";
  $("cancelEdit").style.display = "block";
  showPreview();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetForm() {
  editingId = null;
  $("shiftForm").reset();
  $("date").value = todayStr();
  $("breakMin").value = 30;
  $("rate").value = settings.rate;
  $("formTitle").textContent = "Add a shift";
  $("submitBtn").textContent = "Add Shift";
  $("cancelEdit").style.display = "none";
  $("preview").classList.remove("show");
  $("formError").textContent = "";
}

function deleteShift(id) {
  if (!safeConfirm("Delete this shift?")) return;
  shifts = shifts.filter(s => s.id !== id);
  if (editingId === id) resetForm();
  save();
  render();
  toast("Shift deleted");
}

function clearAll() {
  if (shifts.length === 0) return;
  if (!safeConfirm("Delete ALL shifts? This cannot be undone.")) return;
  shifts = [];
  resetForm();
  save();
  render();
  toast("All shifts cleared");
}

// ---------- Export to CSV (opens in Excel) ----------
function exportCSV() {
  if (shifts.length === 0) return toast("No shifts to export");
  const pay = calculatePay();
  const rates = deductionRates();
  const rows = [["Date", "Start", "End", "Break (min)", "Hours", "Overtime hours", "Rate", "Gross pay", "Take-home (estimate)", "Note"]];
  [...shifts].sort((a, b) => a.date.localeCompare(b.date)).forEach(s => {
    const r = pay[s.id];
    rows.push([s.date, s.start, s.end, s.breakMin, r.hours.toFixed(2), r.overtime.toFixed(2),
      s.rate.toFixed(2), r.pay.toFixed(2), breakdown(r.pay, rates).net.toFixed(2), '"' + s.note.replace(/"/g, '""') + '"']);
  });
  const blob = new Blob([rows.map(r => r.join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "shifts.csv";
  a.click();
}

// Some preview windows block pop-up boxes, so fall back to "yes" there
function safeConfirm(msg) {
  try { return confirm(msg); } catch (e) { return true; }
}

// ---------- Small pop-up message ----------
let toastTimer;
function toast(msg) {
  $("toast").textContent = msg;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2200);
}

// ---------- Welcome screen and profile ----------
function openWelcome() {
  const editing = profile !== null;
  $("welcomeTitle").innerHTML = editing ? "Edit your profile" : "Welcome to Shift<span>Track</span>";
  $("welcomeText").textContent = editing
    ? "Update your details below."
    : "Keep track of your shifts, hours and pay in one place. Let's set up your profile first.";
  $("welcomeBtn").textContent = editing ? "Save Profile" : "Get Started";
  $("welcomeCancel").style.display = editing ? "block" : "none";
  $("wName").value = editing ? profile.name : "";
  $("wJob").value = editing ? profile.job : "";
  $("wRate").value = editing ? settings.rate : "";
  $("wOT").value = settings.otLimit;
  $("welcomeError").textContent = "";
  $("welcome").classList.add("show");
  setTimeout(() => $("wName").focus(), 50);
}

function closeWelcome() {
  $("welcome").classList.remove("show");
}

function saveWelcome() {
  let name = $("wName").value.trim();
  name = name.charAt(0).toUpperCase() + name.slice(1); // "ali" becomes "Ali"
  const job = $("wJob").value.trim();
  const rate = Number($("wRate").value);
  const ot = Number($("wOT").value);

  if (!name) return $("welcomeError").textContent = "Please enter your name.";
  if (!rate || rate <= 0) return $("welcomeError").textContent = "Please enter your hourly rate.";
  if (!ot || ot <= 0) return $("welcomeError").textContent = "Please enter when overtime starts.";

  const firstTime = profile === null;
  profile = { name, job };
  settings.rate = rate;
  settings.otLimit = ot;
  save();

  $("defaultRate").value = settings.rate;
  $("otLimit").value = settings.otLimit;
  if (!editingId) $("rate").value = settings.rate;

  closeWelcome();
  showProfile();
  render();
  toast(firstTime ? "Welcome, " + name + "!" : "Profile updated");
}

// Shows the greeting, avatar and name at the top of the page
function showProfile() {
  if (!profile) return;
  const hour = new Date().getHours();
  const part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  $("greeting").textContent = part + ", " + profile.name + " 👋";
  $("avatar").textContent = profile.name.charAt(0).toUpperCase();
  $("profileName").textContent = profile.name;
  $("profileJob").textContent = profile.job || "Edit profile";
}

$("welcomeBtn").addEventListener("click", saveWelcome);
$("welcomeCancel").addEventListener("click", closeWelcome);
$("profileBtn").addEventListener("click", openWelcome);
$("welcome").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); saveWelcome(); }
  if (e.key === "Escape" && profile) closeWelcome();
});

// ---------- Settings ----------
$("defaultRate").value = settings.rate;
$("otLimit").value = settings.otLimit;
$("defaultRate").addEventListener("change", e => {
  settings.rate = Number(e.target.value) || 0;
  if (!editingId) $("rate").value = settings.rate;
  save();
  showPreview();
});
$("otLimit").addEventListener("change", e => {
  settings.otLimit = Number(e.target.value) || 44;
  save();
  render();
});

// ---------- Connect buttons and inputs ----------
$("submitBtn").addEventListener("click", addOrUpdateShift);
$("cancelEdit").addEventListener("click", resetForm);
$("exportBtn").addEventListener("click", exportCSV);
$("clearBtn").addEventListener("click", clearAll);
$("monthFilter").addEventListener("change", render);
["start", "end", "breakMin", "rate"].forEach(id => $(id).addEventListener("input", showPreview));
// Pressing Enter in any box also adds the shift
$("shiftForm").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); addOrUpdateShift(); }
});
window.addEventListener("resize", drawChart);

// ---------- Start the app ----------
resetForm();
render();
if (profile) showProfile();
else openWelcome(); // first visit: show the welcome screen
// Redraw the chart once the font has loaded so the text looks right
if (document.fonts) document.fonts.ready.then(drawChart);