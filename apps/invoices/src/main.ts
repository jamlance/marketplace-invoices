import "./index.css";
import {
  initBv, bvApi, makeToast, type BvToastFn,
  mountShell, statRow, dataTable, card, openModal, flash,
  fmtMoney, fmtDate, relTime, pill, emptyState, h, iconEl,
} from "./bv-init";

interface LineItem { description: string; qty: number; price: number; product_id?: number | null; }
interface Invoice {
  id: number; number: string; kind: string; customer_name: string | null; customer_email: string | null; customer_id: string | null;
  line_items: LineItem[]; subtotal: number; discount: number; tax_rate: number; tax_amount: number; amount: number; currency: string;
  status: string; overdue: boolean; due_date: string | null; notes: string | null;
  created_at: string; sent_at: string | null; paid_at: string | null; payment_url: string | null; public_url: string | null; pdf_url: string;
}
interface Recurring {
  id: number; customer_name: string | null; customer_email: string | null; customer_id: string | null; line_items: LineItem[];
  tax_rate: number; discount: number; currency: string; notes: string | null; due_days: number; day_of_month: number; active: boolean; auto_send: boolean; last_issued: string | null;
}
interface Settings { business_address: string | null; tax_id: string | null; terms: string | null; accent: string | null; footer: string | null; number_prefix: string | null; reply_to: string | null; auto_reminders: boolean; }
interface ProductHit { id: number; title: string; price: number; currency: string; }
interface CustomerHit { id: number; name: string; email: string | null; }

const root = document.getElementById("root")!;
let toast: BvToastFn;
let merchantName = "Merchant";
let currency = "JMD";
let invoices: Invoice[] = [];
let recurring: Recurring[] = [];
let settings: Settings = { business_address: null, tax_id: null, terms: null, accent: "#1f6feb", footer: null, number_prefix: "INV", reply_to: null, auto_reminders: false };
let stats: any = { count: 0, outstanding: 0, paid: 0, overdue: 0, drafts: 0, estimates: 0 };
let connected = false;
let webhookRealtime = false;
let filter = "all";
let search = "";
let shell: ReturnType<typeof mountShell>;

(async () => {
  let session;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session")) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  merchantName = session.merchant.name || session.merchant.username || "Merchant";
  currency = session.merchant.currency_code || "JMD";

  shell = mountShell({
    brandIcon: "receipt",
    brandLogo: "/logo.svg",
    title: "Invoices",
    subtitle: `${merchantName} · bill customers, get paid online`,
    poweredBy: "Marketplace",
    tabs: [
      { id: "invoices", label: "Invoices", icon: "receipt", render: renderInvoices },
      { id: "recurring", label: "Recurring", icon: "clock", render: renderRecurring },
      { id: "receipts", label: "Receipts", icon: "check", render: renderReceipts },
      { id: "settings", label: "Settings", icon: "edit", render: renderSettings },
    ],
  });
  bvApi<{ realtime: boolean }>(`/api/status`).then((s) => { webhookRealtime = s.realtime; }).catch(() => {});
})();

async function load(refresh = false) {
  const data = await bvApi<{ invoices: Invoice[]; connected: boolean; webhook_realtime: boolean; stats: any }>(`/api/invoices${refresh ? "?refresh=1" : ""}`);
  invoices = data.invoices; connected = data.connected; webhookRealtime = data.webhook_realtime; stats = data.stats; return data;
}

/* ------------------------------------------------------------------ Invoices */
async function renderInvoices(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  try { await load(true); }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";

  host.append(statRow([
    { k: "Outstanding", v: fmtMoney(stats.outstanding, currency), tone: "accent", icon: "clock" },
    { k: "Overdue", v: fmtMoney(stats.overdue, currency), tone: stats.overdue > 0 ? "bad" : undefined, icon: "alert" },
    { k: "Paid", v: fmtMoney(stats.paid, currency), tone: "ok", icon: "coins" },
    { k: "Drafts", v: String(stats.drafts), icon: "edit" },
  ]));

  const newInv = h("button", { class: "primary", onClick: () => openInvoice(null, "invoice") }, iconEl("plus", 15), "New invoice");
  const newEst = h("button", { class: "ghost", onClick: () => openInvoice(null, "estimate") }, iconEl("plus", 14), "Estimate");
  const csv = h("a", { class: "ghost sm", href: "/api/invoices.csv", onClick: (e: any) => downloadCsv(e) }, iconEl("download", 13), "CSV");
  const actions = h("div", { class: "iv-toolbar" }, newEst, csv, newInv);

  // filter + search bar
  const counts: Record<string, number> = {
    all: invoices.filter((v) => v.kind === "invoice").length,
    draft: invoices.filter((v) => v.kind === "invoice" && v.status === "draft").length,
    sent: invoices.filter((v) => v.kind === "invoice" && v.status === "sent" && !v.overdue).length,
    overdue: invoices.filter((v) => v.overdue).length,
    paid: invoices.filter((v) => v.kind === "invoice" && v.status === "paid").length,
    estimate: invoices.filter((v) => v.kind === "estimate").length,
  };
  const seg = h("div", { class: "iv-seg" },
    ...["all", "draft", "sent", "overdue", "paid", "estimate"].map((f) =>
      h("button", { class: "iv-seg-btn" + (filter === f ? " is-on" : ""), onClick: () => { filter = f; shell.select("invoices"); } },
        f === "all" ? "All" : f === "estimate" ? "Estimates" : f.charAt(0).toUpperCase() + f.slice(1), counts[f] ? h("span", { class: "iv-seg-n" }, String(counts[f])) : null)));
  const searchInput = h("input", { class: "iv-search", placeholder: "Search number, customer…", value: search,
    onInput: (e: any) => { search = e.target.value; renderList(); } }) as HTMLInputElement;
  host.append(h("div", { class: "iv-filterbar" }, seg, searchInput));

  const listWrap = h("div");
  host.append(card({ title: filter === "estimate" ? "Estimates" : "Invoices", action: actions, body: listWrap }));
  renderList();
  function renderList() {
    listWrap.innerHTML = "";
    let rows = invoices.slice();
    if (filter === "estimate") rows = rows.filter((v) => v.kind === "estimate");
    else { rows = rows.filter((v) => v.kind === "invoice");
      if (filter === "draft") rows = rows.filter((v) => v.status === "draft");
      else if (filter === "sent") rows = rows.filter((v) => v.status === "sent" && !v.overdue);
      else if (filter === "overdue") rows = rows.filter((v) => v.overdue);
      else if (filter === "paid") rows = rows.filter((v) => v.status === "paid");
    }
    const q = search.trim().toLowerCase();
    if (q) rows = rows.filter((v) => [v.number, v.customer_name, v.customer_email].some((s) => (s || "").toLowerCase().includes(q)));
    if (!rows.length) {
      listWrap.append(emptyState({ icon: filter === "estimate" ? "edit" : "receipt", title: q ? "No matches" : "Nothing here yet",
        text: q ? "Try a different search." : "Create an invoice, send it, and your customer pays online — you'll see it marked paid here." }));
      return;
    }
    listWrap.append(dataTable<Invoice>({
      columns: [
        { head: filter === "estimate" ? "Estimate" : "Invoice", cell: (v) => h("div", null, h("strong", { class: "iv-num" }, v.number), v.due_date ? h("div", { class: "bv-muted" }, `due ${fmtDate(v.due_date)}`) : null) },
        { head: "Customer", cell: (v) => h("div", null, h("span", null, v.customer_name || "—"), v.customer_email ? h("div", { class: "bv-muted" }, v.customer_email) : null) },
        { head: "Amount", num: true, cell: (v) => h("div", null, h("span", null, fmtMoney(v.amount, v.currency)), v.tax_amount > 0 || v.discount > 0 ? h("div", { class: "bv-muted" }, taxLabel(v)) : null) },
        { head: "Status", cell: (v) => statusPill(v) },
      ],
      rows,
      rowActions: (v) => rowActions(v),
    }));
  }
  if (!connected) host.append(h("div", { class: "iv-note bv-muted" }, iconEl("alert", 14), "Connecting to your Inkress account — sending invoices activates momentarily."));
  else if (webhookRealtime) host.append(h("div", { class: "iv-note bv-muted" }, iconEl("check", 14), "Real-time: invoices mark themselves paid the instant your customer pays."));
}

function taxLabel(v: Invoice) {
  const parts: string[] = [];
  if (v.discount > 0) parts.push(`−${fmtMoney(v.discount, v.currency)}`);
  if (v.tax_amount > 0) parts.push(`+${fmtMoney(v.tax_amount, v.currency)} tax`);
  return parts.join(" · ");
}
function statusPill(v: Invoice) {
  if (v.kind === "estimate") return pill("estimate", undefined);
  if (v.overdue) return pill("overdue", "bad");
  return pill(v.status, v.status === "paid" ? "ok" : v.status === "sent" ? "warn" : v.status === "void" ? "bad" : undefined);
}

function rowActions(v: Invoice) {
  const acts: (HTMLElement | null)[] = [];
  if (v.kind === "estimate") {
    acts.push(h("button", { class: "primary sm", onClick: () => convertEstimate(v) }, iconEl("check", 13), "To invoice"));
    acts.push(h("button", { class: "ghost sm", onClick: () => openInvoice(v, "estimate") }, iconEl("edit", 13)));
    acts.push(h("button", { class: "ghost sm", onClick: () => openPdf(v) }, iconEl("download", 13)));
    acts.push(h("button", { class: "ghost sm", onClick: () => del(v) }, iconEl("trash", 13)));
  } else if (v.status === "draft") {
    acts.push(h("button", { class: "primary sm", onClick: () => send(v) }, iconEl("send", 13), "Send"));
    acts.push(h("button", { class: "ghost sm", onClick: () => openInvoice(v, "invoice") }, iconEl("edit", 13)));
    acts.push(h("button", { class: "ghost sm", onClick: () => openPdf(v) }, iconEl("download", 13)));
    acts.push(h("button", { class: "ghost sm", onClick: () => del(v) }, iconEl("trash", 13)));
  } else if (v.status === "sent") {
    acts.push(h("button", { class: "ghost sm", onClick: () => { if (v.public_url) { navigator.clipboard?.writeText(v.public_url); flash("Pay link copied", "success"); } } }, iconEl("copy", 13), "Pay link"));
    if (v.public_url) acts.push(h("a", { class: "ghost sm", href: v.public_url, target: "_blank", rel: "noopener" }, iconEl("external", 13)));
    acts.push(h("button", { class: "ghost sm", onClick: () => openPdf(v) }, iconEl("download", 13)));
    acts.push(h("button", { class: "ghost sm", onClick: () => send(v) }, "Resend"));
    acts.push(h("button", { class: "ghost sm", onClick: () => voidInvoice(v) }, "Void"));
  } else if (v.status === "paid") {
    if (v.public_url) acts.push(h("a", { class: "ghost sm", href: v.public_url, target: "_blank", rel: "noopener" }, iconEl("receipt", 13), "Receipt"));
    acts.push(h("button", { class: "ghost sm", onClick: () => openPdf(v) }, iconEl("download", 13), "PDF"));
  }
  return h("div", { class: "iv-row-actions" }, ...acts.filter(Boolean) as HTMLElement[]);
}

async function send(v: Invoice) {
  try { const r = await bvApi<{ emailed: boolean }>(`/api/invoices/${v.id}/send`, { method: "POST" }); flash(r.emailed ? `Invoice ${v.number} emailed` : `Invoice ${v.number} ready — pay link created`, "success"); shell.select("invoices"); }
  catch (err: any) { toast(err?.message || "Couldn't send", "error"); }
}
async function voidInvoice(v: Invoice) {
  try { await bvApi(`/api/invoices/${v.id}`, { method: "PATCH", body: JSON.stringify({ status: "void" }) }); flash("Voided", "success"); shell.select("invoices"); }
  catch (err: any) { toast(err?.message || "error", "error"); }
}
async function del(v: Invoice) {
  try { await bvApi(`/api/invoices/${v.id}`, { method: "DELETE" }); flash("Deleted", "success"); shell.select("invoices"); }
  catch (err: any) { toast(err?.message || "error", "error"); }
}
async function convertEstimate(v: Invoice) {
  try { await bvApi(`/api/invoices/${v.id}/convert`, { method: "POST" }); flash(`Converted ${v.number} to a draft invoice`, "success"); filter = "draft"; shell.select("invoices"); }
  catch (err: any) { toast(err?.message || "error", "error"); }
}
async function openPdf(v: Invoice) {
  try {
    if (v.public_url) { window.open(`${v.public_url}/pdf`, "_blank", "noopener"); return; }
    const sid = sessionStorage.getItem("bv_app_session_id") || localStorage.getItem("bv_app_session_id") || "";
    const r = await fetch(`/api/invoices/${v.id}/pdf`, { headers: { "X-BV-Session": sid } });
    if (!r.ok) throw new Error("PDF generation failed");
    const url = URL.createObjectURL(await r.blob());
    window.open(url, "_blank", "noopener"); setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err: any) { toast(err?.message || "Couldn't open PDF", "error"); }
}
function downloadCsv(e: any) {
  e.preventDefault();
  const sid = sessionStorage.getItem("bv_app_session_id") || localStorage.getItem("bv_app_session_id") || "";
  fetch(`/api/invoices.csv`, { headers: { "X-BV-Session": sid } }).then((r) => r.blob()).then((b) => {
    const url = URL.createObjectURL(b); const a = document.createElement("a"); a.href = url; a.download = "invoices.csv"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }).catch(() => toast("Couldn't export", "error"));
}

/* ----------------------------------------------------- customer autocomplete */
function customerPicker(initial: { name: string; email: string; id: string | null }, onPick: (c: { name: string; email: string; id: string | null }) => void) {
  const name = h("input", { value: initial.name, placeholder: "Customer name", autocomplete: "off" }) as HTMLInputElement;
  const email = h("input", { type: "email", value: initial.email, placeholder: "customer@email.com", autocomplete: "off" }) as HTMLInputElement;
  const results = h("div", { class: "iv-ac-results", style: { display: "none" } });
  let cid = initial.id; let t: any;
  const close = () => { results.style.display = "none"; };
  name.addEventListener("input", () => {
    cid = null; clearTimeout(t); const q = name.value.trim(); if (q.length < 2) return close();
    t = setTimeout(async () => {
      try { const { customers } = await bvApi<{ customers: CustomerHit[] }>(`/api/customers?q=${encodeURIComponent(q)}`);
        results.innerHTML = ""; if (!customers.length) return close();
        for (const c of customers) results.append(h("div", { class: "iv-ac-row", onClick: () => {
          name.value = c.name; if (c.email) email.value = c.email; cid = String(c.id); close(); onPick({ name: name.value, email: email.value, id: cid });
        } }, h("strong", null, c.name), c.email ? h("span", { class: "bv-muted" }, c.email) : null));
        results.style.display = "block";
      } catch { close(); }
    }, 220);
  });
  name.addEventListener("blur", () => setTimeout(close, 180));
  const get = () => ({ name: name.value.trim() || "", email: email.value.trim() || "", id: cid });
  const wrap = h("div", { class: "iv-form-grid" },
    h("label", { class: "iv-field" }, h("span", { class: "bv-label" }, "Customer name"), h("div", { class: "iv-ac" }, name, results)),
    field("Customer email", email));
  return { wrap, get };
}

/* ----------------------------------------------------- line-item + product picker */
function lineItemEditor(initial: LineItem[], onChange: () => void) {
  const rowsWrap = h("div", { class: "iv-items" });
  const addRow = (it?: LineItem) => {
    let pid: number | null = it?.product_id ?? null;
    const desc = h("input", { class: "iv-desc", value: it?.description || "", placeholder: "Description", autocomplete: "off" }) as HTMLInputElement;
    const qty = h("input", { class: "iv-qty", type: "number", min: "0", step: "1", value: it ? String(it.qty) : "1" }) as HTMLInputElement;
    const price = h("input", { class: "iv-price", type: "number", min: "0", step: "0.01", value: it ? String(it.price) : "", placeholder: "0.00" }) as HTMLInputElement;
    const results = h("div", { class: "iv-ac-results", style: { display: "none" } });
    let t: any;
    desc.addEventListener("input", () => {
      pid = null; clearTimeout(t); const q = desc.value.trim(); if (q.length < 2) { results.style.display = "none"; return; }
      t = setTimeout(async () => {
        try { const { products } = await bvApi<{ products: ProductHit[] }>(`/api/products?q=${encodeURIComponent(q)}`);
          results.innerHTML = ""; if (!products.length) { results.style.display = "none"; return; }
          for (const p of products) results.append(h("div", { class: "iv-ac-row", onClick: () => {
            desc.value = p.title; if (p.price) { price.value = String(p.price); } pid = p.id; results.style.display = "none"; onChange();
          } }, h("strong", null, p.title), h("span", { class: "bv-muted" }, fmtMoney(p.price, p.currency))));
          results.style.display = "block";
        } catch { results.style.display = "none"; }
      }, 220);
    });
    desc.addEventListener("blur", () => setTimeout(() => { results.style.display = "none"; }, 180));
    const row = h("div", { class: "iv-item-wrap" },
      h("div", { class: "iv-item-row" }, h("div", { class: "iv-ac" }, desc, results), qty, price,
        h("button", { class: "ghost sm iv-del", onClick: () => { row.remove(); onChange(); } }, iconEl("x", 13))));
    (row as any)._get = () => ({ description: desc.value, qty: Number(qty.value) || 0, price: Number(price.value) || 0, product_id: pid });
    [qty, price].forEach((el) => el.addEventListener("input", onChange));
    rowsWrap.append(row);
  };
  (initial.length ? initial : [undefined as any]).forEach((it) => addRow(it));
  const head = h("div", { class: "iv-items-head" }, h("span", { class: "bv-label" }, "Line items"),
    h("button", { class: "ghost sm", onClick: () => addRow() }, iconEl("plus", 13), "Add line"));
  const collect = (): LineItem[] => Array.from(rowsWrap.querySelectorAll<HTMLElement>(".iv-item-wrap")).map((r) => (r as any)._get())
    .filter((it: LineItem) => it.description.trim() && it.qty > 0);
  return { el: h("div", null, head, rowsWrap), collect };
}

function openInvoice(v: Invoice | null, kind: "invoice" | "estimate") {
  const cust = customerPicker({ name: v?.customer_name || "", email: v?.customer_email || "", id: v?.customer_id || null }, () => {});
  const due = h("input", { type: "date", value: v?.due_date?.slice(0, 10) || "" }) as HTMLInputElement;
  const taxRate = h("input", { type: "number", min: "0", max: "100", step: "0.01", value: v?.tax_rate ? String(v.tax_rate) : "", placeholder: "0" }) as HTMLInputElement;
  const discount = h("input", { type: "number", min: "0", step: "0.01", value: v?.discount ? String(v.discount) : "", placeholder: "0.00" }) as HTMLInputElement;
  const notes = h("input", { value: v?.notes || "", placeholder: "Notes / payment terms (optional)" }) as HTMLInputElement;

  const subEl = h("span", null, fmtMoney(0, currency));
  const discRow = h("div", { class: "iv-brk-row", style: { display: "none" } }, h("span", null, "Discount"), h("span", { class: "iv-brk-disc" }, "—"));
  const taxRow = h("div", { class: "iv-brk-row", style: { display: "none" } }, h("span", { class: "iv-brk-taxlbl" }, "Tax"), h("span", { class: "iv-brk-tax" }, "—"));
  const totalEl = h("span", { class: "iv-total-val" }, fmtMoney(0, currency));

  const recompute = () => {
    const items = items_.collect();
    const subtotal = Math.round(items.reduce((s, it) => s + it.qty * it.price, 0) * 100) / 100;
    const disc = Math.min(subtotal, Math.max(0, Number(discount.value) || 0));
    const taxable = Math.round((subtotal - disc) * 100) / 100;
    const rate = Math.max(0, Math.min(100, Number(taxRate.value) || 0));
    const tax = Math.round(taxable * rate / 100 * 100) / 100;
    subEl.textContent = fmtMoney(subtotal, currency);
    (discRow as HTMLElement).style.display = disc > 0 ? "" : "none";
    (discRow.querySelector(".iv-brk-disc") as HTMLElement).textContent = `−${fmtMoney(disc, currency)}`;
    (taxRow as HTMLElement).style.display = tax > 0 ? "" : "none";
    (taxRow.querySelector(".iv-brk-taxlbl") as HTMLElement).textContent = `Tax${rate ? ` (${rate}%)` : ""}`;
    (taxRow.querySelector(".iv-brk-tax") as HTMLElement).textContent = `+${fmtMoney(tax, currency)}`;
    totalEl.textContent = fmtMoney(Math.round((taxable + tax) * 100) / 100, currency);
  };
  const items_ = lineItemEditor(v?.line_items || [], recompute);
  [taxRate, discount].forEach((el) => el.addEventListener("input", recompute));
  recompute();

  const body = h("div", { class: "iv-form" },
    cust.wrap,
    h("div", { class: "iv-form-grid" }, field("Due date", due), field("Discount", discount)),
    items_.el,
    h("div", { class: "iv-form-grid" }, field(`Tax rate %`, taxRate), field("", h("span"))),
    h("div", { class: "iv-brk" },
      h("div", { class: "iv-brk-row" }, h("span", null, "Subtotal"), subEl),
      discRow, taxRow,
      h("div", { class: "iv-total" }, h("span", { class: "bv-muted" }, "Total"), totalEl)),
    field("Notes", notes));

  const save = async () => {
    const items = items_.collect();
    if (!items.length) { toast("Add at least one line item", "warning"); return; }
    const c = cust.get();
    const payload: any = { kind, customer_name: c.name || null, customer_email: c.email || null, customer_id: c.id, due_date: due.value || null,
      notes: notes.value || null, line_items: items, tax_rate: Number(taxRate.value) || 0, discount: Number(discount.value) || 0 };
    try {
      if (v) await bvApi(`/api/invoices/${v.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      else await bvApi("/api/invoices", { method: "POST", body: JSON.stringify(payload) });
      flash(v ? "Saved" : kind === "estimate" ? "Estimate created" : "Invoice created", "success"); shell.select("invoices");
    } catch (err: any) { toast(err?.message || "error", "error"); }
  };
  openModal({ title: v ? `Edit ${v.number}` : kind === "estimate" ? "New estimate" : "New invoice", body,
    actions: [{ label: v ? "Save" : kind === "estimate" ? "Create estimate" : "Create draft", primary: true, onClick: () => { void save(); } }] });
}

/* ------------------------------------------------------------------ Recurring */
async function renderRecurring(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  try { const r = await bvApi<{ recurring: Recurring[] }>(`/api/recurring`); recurring = r.recurring; }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";
  const add = h("button", { class: "primary", onClick: () => openRecurring(null) }, iconEl("plus", 15), "New recurring invoice");
  host.append(card({
    title: "Recurring invoices",
    action: add,
    body: recurring.length ? dataTable<Recurring>({
      columns: [
        { head: "Customer", cell: (r) => h("div", null, h("strong", null, r.customer_name || "—"), r.customer_email ? h("div", { class: "bv-muted" }, r.customer_email) : null) },
        { head: "Amount", num: true, cell: (r) => fmtMoney(recurTotal(r), r.currency) },
        { head: "Schedule", cell: (r) => h("span", { class: "bv-muted" }, `day ${r.day_of_month} · net ${r.due_days}${r.auto_send ? " · auto-send" : ""}`) },
        { head: "Status", cell: (r) => pill(r.active ? "active" : "paused", r.active ? "ok" : undefined) },
      ],
      rows: recurring,
      rowActions: (r) => h("div", { class: "iv-row-actions" },
        h("button", { class: "ghost sm", onClick: () => toggleRecur(r) }, r.active ? "Pause" : "Resume"),
        h("button", { class: "ghost sm", onClick: () => openRecurring(r) }, iconEl("edit", 13)),
        h("button", { class: "ghost sm", onClick: () => delRecur(r) }, iconEl("trash", 13))),
    }) : emptyState({ icon: "clock", title: "No recurring invoices", text: "Set up retainers or subscriptions that auto-issue every month." }),
  }));
  host.append(h("div", { class: "iv-note bv-muted" }, iconEl("clock", 14), "Recurring invoices issue automatically on their day each month and (optionally) email the pay link."));
}
function recurTotal(r: Recurring) {
  const sub = (r.line_items || []).reduce((s, it) => s + it.qty * it.price, 0);
  const disc = Math.min(sub, Number(r.discount) || 0); const taxable = sub - disc;
  return Math.round((taxable + taxable * (Number(r.tax_rate) || 0) / 100) * 100) / 100;
}
async function toggleRecur(r: Recurring) { try { await bvApi(`/api/recurring/${r.id}`, { method: "PATCH", body: JSON.stringify({ active: !r.active }) }); shell.select("recurring"); } catch (err: any) { toast(err?.message || "error", "error"); } }
async function delRecur(r: Recurring) { try { await bvApi(`/api/recurring/${r.id}`, { method: "DELETE" }); flash("Removed", "success"); shell.select("recurring"); } catch (err: any) { toast(err?.message || "error", "error"); } }

function openRecurring(r: Recurring | null) {
  const cust = customerPicker({ name: r?.customer_name || "", email: r?.customer_email || "", id: r?.customer_id || null }, () => {});
  const taxRate = h("input", { type: "number", min: "0", max: "100", step: "0.01", value: r?.tax_rate ? String(r.tax_rate) : "", placeholder: "0" }) as HTMLInputElement;
  const discount = h("input", { type: "number", min: "0", step: "0.01", value: r?.discount ? String(r.discount) : "", placeholder: "0.00" }) as HTMLInputElement;
  const day = h("input", { type: "number", min: "1", max: "28", value: String(r?.day_of_month || 1) }) as HTMLInputElement;
  const dueDays = h("input", { type: "number", min: "0", max: "120", value: String(r?.due_days ?? 14) }) as HTMLInputElement;
  const notes = h("input", { value: r?.notes || "", placeholder: "Notes (optional)" }) as HTMLInputElement;
  const autoSend = h("input", { type: "checkbox", checked: r ? r.auto_send : true }) as HTMLInputElement;
  const items_ = lineItemEditor(r?.line_items || [], () => {});
  const body = h("div", { class: "iv-form" },
    cust.wrap,
    items_.el,
    h("div", { class: "iv-form-grid" }, field("Tax rate %", taxRate), field("Discount", discount)),
    h("div", { class: "iv-form-grid" }, field("Day of month (1–28)", day), field("Due in (days)", dueDays)),
    field("Notes", notes),
    h("label", { class: "iv-check" }, autoSend, " Auto-send the invoice (email pay link) when issued"));
  const save = async () => {
    const items = items_.collect();
    if (!items.length) { toast("Add at least one line item", "warning"); return; }
    const c = cust.get();
    if (!c.email) { toast("Add a customer email so the invoice can be sent", "warning"); return; }
    const payload: any = { customer_name: c.name || null, customer_email: c.email || null, customer_id: c.id, line_items: items,
      tax_rate: Number(taxRate.value) || 0, discount: Number(discount.value) || 0, day_of_month: Number(day.value) || 1, due_days: Number(dueDays.value) || 14, auto_send: autoSend.checked };
    try {
      if (r) await bvApi(`/api/recurring/${r.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      else await bvApi(`/api/recurring`, { method: "POST", body: JSON.stringify(payload) });
      flash(r ? "Saved" : "Recurring invoice created", "success"); shell.select("recurring");
    } catch (err: any) { toast(err?.message || "error", "error"); }
  };
  openModal({ title: r ? "Edit recurring invoice" : "New recurring invoice", body, actions: [{ label: r ? "Save" : "Create", primary: true, onClick: () => { void save(); } }] });
}

/* ------------------------------------------------------------------ Receipts */
async function renderReceipts(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  try { await load(); }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";
  const paid = invoices.filter((v) => v.status === "paid");
  host.append(card({ title: "Paid receipts", body: paid.length ? dataTable<Invoice>({
    columns: [
      { head: "Invoice", cell: (v) => h("strong", { class: "iv-num" }, v.number) },
      { head: "Customer", cell: (v) => h("span", null, v.customer_name || v.customer_email || "—") },
      { head: "Paid", cell: (v) => v.paid_at ? h("span", { class: "bv-muted" }, relTime(v.paid_at)) : h("span", { class: "bv-muted" }, "—") },
      { head: "Amount", num: true, cell: (v) => fmtMoney(v.amount, v.currency) },
    ],
    rows: paid,
    rowActions: (v) => h("div", { class: "iv-row-actions" },
      v.public_url ? h("a", { class: "ghost sm", href: v.public_url, target: "_blank", rel: "noopener" }, iconEl("external", 13), "View") : null,
      h("button", { class: "ghost sm", onClick: () => openPdf(v) }, iconEl("download", 13), "PDF"),
      v.public_url ? h("button", { class: "ghost sm", onClick: () => { navigator.clipboard?.writeText(v.public_url!); flash("Link copied", "success"); } }, iconEl("copy", 13)) : null),
  }) : emptyState({ icon: "check", title: "No paid invoices yet", text: "Once a customer pays, the receipt shows up here." }) }));
}

/* ------------------------------------------------------------------ Settings */
async function renderSettings(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  try { const s = await bvApi<{ settings: Settings }>(`/api/settings`); settings = s.settings; }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";

  const addr = h("textarea", { rows: "3", placeholder: "Business name\nAddress line\nCity, country" }, settings.business_address || "") as HTMLTextAreaElement;
  const taxId = h("input", { value: settings.tax_id || "", placeholder: "TRN / Tax ID" }) as HTMLInputElement;
  const terms = h("input", { value: settings.terms || "", placeholder: "e.g. Payment due within 14 days" }) as HTMLInputElement;
  const accent = h("input", { type: "color", value: settings.accent || "#1f6feb" }) as HTMLInputElement;
  const footer = h("input", { value: settings.footer || "", placeholder: "Footer line (e.g. Thank you!)" }) as HTMLInputElement;
  const prefix = h("input", { value: settings.number_prefix || "INV", placeholder: "INV" }) as HTMLInputElement;
  const replyTo = h("input", { type: "email", value: settings.reply_to || "", placeholder: "billing@yourbiz.com" }) as HTMLInputElement;
  const reminders = h("input", { type: "checkbox", checked: settings.auto_reminders }) as HTMLInputElement;

  const preview = h("div", { class: "iv-preview" });
  const renderPreview = () => {
    preview.innerHTML = "";
    preview.style.setProperty("--ac", accent.value);
    preview.append(
      h("div", { class: "iv-pv-bar" }),
      h("div", { class: "iv-pv-body" },
        h("div", { class: "iv-pv-head" },
          h("div", null, h("strong", null, (addr.value.split("\n")[0]) || merchantName), h("div", { class: "iv-pv-addr" }, addr.value.split("\n").slice(1).join("\n")), taxId.value ? h("div", { class: "iv-pv-addr" }, `Tax ID: ${taxId.value}`) : null),
          h("span", { class: "iv-pv-num" }, `${prefix.value || "INV"}-0001`)),
        h("div", { class: "iv-pv-line" }, h("span", null, "Design services × 1"), h("span", null, fmtMoney(50000, currency))),
        h("div", { class: "iv-pv-total" }, h("span", null, "Total"), h("span", null, fmtMoney(50000, currency))),
        terms.value ? h("div", { class: "iv-pv-terms" }, terms.value) : null,
        h("div", { class: "iv-pv-foot" }, footer.value || "Thank you for your business.")));
  };
  [addr, taxId, terms, footer, prefix].forEach((el) => el.addEventListener("input", renderPreview));
  accent.addEventListener("input", renderPreview);
  renderPreview();

  const save = h("button", { class: "primary", onClick: async () => {
    try {
      await bvApi(`/api/settings`, { method: "POST", body: JSON.stringify({
        business_address: addr.value || null, tax_id: taxId.value || null, terms: terms.value || null, accent: accent.value,
        footer: footer.value || null, number_prefix: prefix.value || "INV", reply_to: replyTo.value || null, auto_reminders: reminders.checked }) });
      flash("Settings saved", "success");
    } catch (err: any) { toast(err?.message || "error", "error"); }
  } }, iconEl("check", 15), "Save settings");

  const formCard = card({ title: "Business details & branding", body: h("div", { class: "iv-form" },
    field("Business name & address", addr),
    h("div", { class: "iv-form-grid" }, field("Tax ID", taxId), field("Invoice number prefix", prefix)),
    field("Default payment terms", terms),
    h("div", { class: "iv-form-grid" }, fieldColor("Accent colour", accent), field("Receipt footer", footer)),
    field("Reply-to email", replyTo),
    h("label", { class: "iv-check" }, reminders, " Automatically email reminders for overdue invoices"),
    h("div", { style: { marginTop: "8px" } }, save)) });

  const cols = h("div", { class: "iv-settings-cols" }, formCard, card({ title: "Live preview", body: preview }));
  host.append(cols);
}

function field(label: string, el: HTMLElement) { return h("label", { class: "iv-field" }, label ? h("span", { class: "bv-label" }, label) : null, el); }
function fieldColor(label: string, el: HTMLElement) { return h("label", { class: "iv-field iv-field-color" }, h("span", { class: "bv-label" }, label), el); }
function fatal(msg?: string) { return h("div", { class: "bv-empty", style: { margin: "40px auto" } }, h("h3", null, "Invoices couldn't load"), h("p", null, msg || "Open this app from the Inkress dashboard.")); }
