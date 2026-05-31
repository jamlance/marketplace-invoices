import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore, inkressApi, createInkressOrder, getInkressOrder, isPaidStatus } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";
import { openMerchantTokens } from "@inkress/apps-core/merchant-tokens";
import { sendEmail, sesConfigured } from "@inkress/apps-core/ses";
import { documentPdf } from "@inkress/apps-core/pdf";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const WEBHOOK_SECRET = process.env.INKRESS_WEBHOOK_SECRET || "";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[invoices] Missing env: ${k}`); process.exit(1); }
}

const db = await openPg("invoices", `
  CREATE TABLE IF NOT EXISTS invoices (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, seq INTEGER NOT NULL,
    number TEXT NOT NULL, customer_name TEXT, customer_email TEXT, customer_id TEXT,
    line_items JSONB NOT NULL DEFAULT '[]', amount NUMERIC NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'JMD',
    status TEXT NOT NULL DEFAULT 'draft', due_date DATE, notes TEXT, token TEXT,
    ref TEXT, inkress_order_id TEXT, payment_url TEXT,
    merchant_name TEXT, merchant_logo TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), sent_at TIMESTAMPTZ, paid_at TIMESTAMPTZ
  );
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'invoice';
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subtotal NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_rate NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_amount NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_id TEXT;
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reminder_at TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS idx_inv ON invoices (merchant_id, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_token ON invoices (token) WHERE token IS NOT NULL;

  CREATE TABLE IF NOT EXISTS inv_settings (
    merchant_id BIGINT PRIMARY KEY, business_address TEXT, tax_id TEXT, terms TEXT,
    accent TEXT, footer TEXT, number_prefix TEXT, reply_to TEXT,
    auto_reminders BOOLEAN NOT NULL DEFAULT false, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS recurring_invoices (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL,
    customer_name TEXT, customer_email TEXT, customer_id TEXT,
    line_items JSONB NOT NULL DEFAULT '[]', tax_rate NUMERIC NOT NULL DEFAULT 0, discount NUMERIC NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'JMD', notes TEXT, due_days INTEGER NOT NULL DEFAULT 14,
    day_of_month INTEGER NOT NULL DEFAULT 1, active BOOLEAN NOT NULL DEFAULT true,
    auto_send BOOLEAN NOT NULL DEFAULT true, last_issued DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS webhook_subs (merchant_id BIGINT PRIMARY KEY, url TEXT NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS webhook_seen (webhook_id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL DEFAULT now());
`);

const app = express();
app.use("/webhooks/inkress", express.raw({ type: () => true, limit: "1mb" }));
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID, clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE, frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
  onBootstrap: (entry) => { tokens.save(entry.merchantId, entry.refreshToken).catch(() => {}); },
});
const tokens = await openMerchantTokens("invoices", core.cfg);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const PUBLIC_BASE = (req) => process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`;
function cleanItems(raw) {
  return (Array.isArray(raw) ? raw : []).map((it) => ({
    description: String(it?.description || "").slice(0, 200),
    qty: Math.max(0, Number(it?.qty) || 0), price: round2(it?.price),
    product_id: it?.product_id != null && it.product_id !== "" ? Number(it.product_id) : null,
  })).filter((it) => it.description && it.qty > 0);
}
function computeTotals(items, taxRate, discount) {
  const subtotal = round2(items.reduce((s, it) => s + it.qty * it.price, 0));
  const disc = Math.min(subtotal, Math.max(0, round2(discount)));
  const taxable = round2(subtotal - disc);
  const rate = Math.max(0, Math.min(100, Number(taxRate) || 0));
  const tax = round2(taxable * rate / 100);
  return { subtotal, discount: disc, tax_rate: rate, tax_amount: tax, total: round2(taxable + tax) };
}
const isOverdue = (v) => v.status === "sent" && v.kind === "invoice" && v.due_date && new Date(v.due_date) < new Date(new Date().toISOString().slice(0, 10));
const serialize = (v, req) => ({
  id: v.id, number: v.number, kind: v.kind || "invoice", customer_name: v.customer_name, customer_email: v.customer_email, customer_id: v.customer_id,
  line_items: v.line_items || [], subtotal: Number(v.subtotal || 0), discount: Number(v.discount || 0), tax_rate: Number(v.tax_rate || 0), tax_amount: Number(v.tax_amount || 0),
  amount: Number(v.amount), currency: v.currency, status: v.status, overdue: isOverdue(v),
  due_date: v.due_date, notes: v.notes, created_at: v.created_at, sent_at: v.sent_at, paid_at: v.paid_at,
  payment_url: v.payment_url, public_url: v.token ? `${PUBLIC_BASE(req)}/invoice/${v.token}` : null,
  pdf_url: `${PUBLIC_BASE(req)}/api/invoices/${v.id}/pdf`,
});

async function settingsFor(mid) {
  const s = await db.one(`SELECT * FROM inv_settings WHERE merchant_id=$1`, [mid]).catch(() => null);
  return s || { merchant_id: mid, business_address: null, tax_id: null, terms: null, accent: "#1f6feb", footer: null, number_prefix: "INV", reply_to: null, auto_reminders: false };
}

async function pollPaid(req) {
  const rows = await db.q(`SELECT * FROM invoices WHERE merchant_id=$1 AND status='sent' AND inkress_order_id IS NOT NULL ORDER BY sent_at DESC LIMIT 25`, [req.session.merchantId]);
  for (const v of rows) {
    try {
      const ink = await getInkressOrder(core.cfg, req.session.accessToken, v.inkress_order_id);
      if (ink && isPaidStatus(ink)) { await db.run(`UPDATE invoices SET status='paid', paid_at=now() WHERE id=$1`, [v.id]); emailReceipt(v).catch(() => {}); }
    } catch { /* */ }
  }
}

app.get("/api/invoices", core.requireSession, async (req, res) => {
  if (req.query.refresh === "1" && !WEBHOOK_SECRET) await pollPaid(req);
  const rows = await db.q(`SELECT * FROM invoices WHERE merchant_id=$1 ORDER BY created_at DESC`, [req.session.merchantId]);
  const out = rows.map((v) => serialize(v, req));
  const invs = rows.filter((v) => (v.kind || "invoice") === "invoice");
  const outstanding = invs.filter((v) => v.status === "sent").reduce((s, v) => s + Number(v.amount), 0);
  const paid = invs.filter((v) => v.status === "paid").reduce((s, v) => s + Number(v.amount), 0);
  const overdue = invs.filter(isOverdue).reduce((s, v) => s + Number(v.amount), 0);
  res.json({ invoices: out, connected: await tokens.hasToken(req.session.merchantId), webhook_realtime: Boolean(WEBHOOK_SECRET),
    stats: { count: invs.length, outstanding, paid, overdue, drafts: invs.filter((v) => v.status === "draft").length, estimates: rows.filter((v) => v.kind === "estimate").length } });
});

app.post("/api/invoices", core.requireSession, async (req, res) => {
  const b = req.body || {}; const m = req.session.data?.merchant || {};
  const items = cleanItems(b.line_items);
  if (!items.length) return res.status(400).json({ error: "no_items", message: "Add at least one line item." });
  const t = computeTotals(items, b.tax_rate, b.discount);
  if (!(t.total > 0)) return res.status(400).json({ error: "bad_amount", message: "Total must be greater than zero." });
  const kind = b.kind === "estimate" ? "estimate" : "invoice";
  const st = await settingsFor(req.session.merchantId);
  const prefix = kind === "estimate" ? "EST" : (st.number_prefix || "INV");
  const seqRow = await db.one(`SELECT COALESCE(MAX(seq),0)+1 AS s FROM invoices WHERE merchant_id=$1 AND kind=$2`, [req.session.merchantId, kind]);
  const number = `${prefix}-${String(seqRow.s).padStart(4, "0")}`;
  const row = await db.one(`INSERT INTO invoices (merchant_id, seq, number, kind, customer_name, customer_email, customer_id, line_items, subtotal, discount, tax_rate, tax_amount, amount, currency, due_date, notes, merchant_name, merchant_logo)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [req.session.merchantId, seqRow.s, number, kind, b.customer_name || null, String(b.customer_email || "").trim().toLowerCase() || null, b.customer_id ? String(b.customer_id) : null,
      JSON.stringify(items), t.subtotal, t.discount, t.tax_rate, t.tax_amount, t.total, m.currency_code || "JMD",
      /^\d{4}-\d{2}-\d{2}$/.test(b.due_date) ? b.due_date : null, String(b.notes || "").trim() || null, m.name || null, m.logo || m.logo_url || null]);
  res.status(201).json({ invoice: serialize(row, req) });
});

app.patch("/api/invoices/:id", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const v = await db.one(`SELECT * FROM invoices WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!v) return res.status(404).json({ error: "not_found" });
  if (b.status === "void") { const u = await db.one(`UPDATE invoices SET status='void' WHERE id=$1 RETURNING *`, [v.id]); return res.json({ invoice: serialize(u, req) }); }
  if (v.status !== "draft") return res.status(400).json({ error: "locked", message: "Only drafts can be edited — void & reissue a sent invoice instead." });
  const items = b.line_items !== undefined ? cleanItems(b.line_items) : (v.line_items || []);
  if (!items.length) return res.status(400).json({ error: "no_items", message: "Add at least one line item." });
  const t = computeTotals(items, b.tax_rate ?? v.tax_rate, b.discount ?? v.discount);
  const u = await db.one(`UPDATE invoices SET customer_name=$1, customer_email=$2, customer_id=$3, line_items=$4, subtotal=$5, discount=$6, tax_rate=$7, tax_amount=$8, amount=$9, due_date=$10, notes=$11 WHERE id=$12 RETURNING *`,
    [b.customer_name ?? v.customer_name, b.customer_email !== undefined ? (String(b.customer_email).trim().toLowerCase() || null) : v.customer_email, b.customer_id !== undefined ? (b.customer_id ? String(b.customer_id) : null) : v.customer_id,
      JSON.stringify(items), t.subtotal, t.discount, t.tax_rate, t.tax_amount, t.total,
      b.due_date !== undefined ? (/^\d{4}-\d{2}-\d{2}$/.test(b.due_date) ? b.due_date : null) : v.due_date, b.notes !== undefined ? (String(b.notes).trim() || null) : v.notes, v.id]);
  res.json({ invoice: serialize(u, req) });
});

app.delete("/api/invoices/:id", core.requireSession, async (req, res) => {
  await db.run(`DELETE FROM invoices WHERE id=$1 AND merchant_id=$2 AND status='draft'`, [req.params.id, req.session.merchantId]);
  res.json({ ok: true });
});

// Estimate → invoice conversion
app.post("/api/invoices/:id/convert", core.requireSession, async (req, res) => {
  const v = await db.one(`SELECT * FROM invoices WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!v) return res.status(404).json({ error: "not_found" });
  if (v.kind !== "estimate") return res.status(400).json({ error: "not_estimate" });
  const st = await settingsFor(req.session.merchantId);
  const seqRow = await db.one(`SELECT COALESCE(MAX(seq),0)+1 AS s FROM invoices WHERE merchant_id=$1 AND kind='invoice'`, [req.session.merchantId]);
  const number = `${st.number_prefix || "INV"}-${String(seqRow.s).padStart(4, "0")}`;
  const u = await db.one(`UPDATE invoices SET kind='invoice', status='draft', seq=$2, number=$3 WHERE id=$1 RETURNING *`, [v.id, seqRow.s, number]);
  res.json({ invoice: serialize(u, req) });
});

app.post("/api/invoices/:id/send", core.requireSession, async (req, res) => {
  const v = await db.one(`SELECT * FROM invoices WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!v) return res.status(404).json({ error: "not_found" });
  if (v.kind === "estimate") return res.status(400).json({ error: "estimate", message: "Convert this estimate to an invoice first." });
  if (v.status === "paid") return res.status(400).json({ error: "paid", message: "This invoice is already paid." });
  if (!v.customer_email) return res.status(400).json({ error: "no_email", message: "Add a customer email before sending." });
  let accessToken;
  try { accessToken = req.session.accessToken || await tokens.accessTokenFor(v.merchant_id); } catch { return res.status(503).json({ error: "not_connected" }); }
  const ref = v.ref || `inv-${v.merchant_id}-${v.id}-${Date.now().toString(36)}`;
  const tok = v.token || crypto.randomBytes(9).toString("base64url");
  const [first, ...rest] = String(v.customer_name || "Customer").split(/\s+/);
  const items = v.line_items || [];
  // Native order_lines only when every line maps to a catalog product AND no tax/discount adjusts the total.
  const lineProducts = items.length && items.every((i) => i.product_id) && !(Number(v.discount) > 0) && !(Number(v.tax_amount) > 0)
    ? items.map((i) => ({ id: i.product_id, quantity: i.qty })) : null;
  let created;
  try {
    created = await createInkressOrder(core.cfg, accessToken, {
      referenceId: ref, total: round2(v.amount), currencyCode: v.currency, kind: "online", title: `Invoice ${v.number}`,
      customer: { email: v.customer_email, first_name: first || "Customer", last_name: rest.join(" ") || "" },
      ...(lineProducts ? { products: lineProducts } : {}),
      metaData: { source: "invoices", invoice: v.number, invoice_id: v.id },
    });
  } catch (err) { return res.status(502).json({ error: "order_failed", message: err?.message }); }
  const u = await db.one(`UPDATE invoices SET status='sent', sent_at=now(), ref=$2, token=$3, inkress_order_id=$4, payment_url=$5 WHERE id=$1 RETURNING *`,
    [v.id, ref, tok, created.id != null ? String(created.id) : null, created.payment_url || null]);
  const st = await settingsFor(v.merchant_id);
  let sent = false;
  if (sesConfigured()) { try { await sendEmail({ to: v.customer_email, replyTo: st.reply_to || undefined, subject: `Invoice ${v.number} from ${v.merchant_name || "us"}`, html: invoiceEmail(u, `${PUBLIC_BASE(req)}/invoice/${tok}`, st) }); sent = true; } catch { /* */ } }
  res.json({ invoice: serialize(u, req), emailed: sent });
});

// PDF (merchant, authenticated)
app.get("/api/invoices/:id/pdf", core.requireSession, async (req, res) => {
  const v = await db.one(`SELECT * FROM invoices WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!v) return res.status(404).json({ error: "not_found" });
  const st = await settingsFor(v.merchant_id);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${v.number}.pdf"`);
  res.send(Buffer.from(await invoicePdf(v, st)));
});

// Product picker + customer autocomplete
app.get("/api/products", core.requireSession, async (req, res) => {
  const q = String(req.query.q || "").trim();
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, `products?limit=30&order=id desc${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    const products = (r?.result?.entries || []).map((p) => {
      const cur = p.currency || {}; const raw = Number(p.price ?? 0);
      return { id: p.id, title: p.title || p.name || `Product ${p.id}`, price: cur.is_float === true ? raw / 100 : raw, currency: cur.code || req.session.data?.merchant?.currency_code || "JMD" };
    });
    res.json({ products });
  } catch (err) { res.status(502).json({ error: "products_failed", message: err?.message }); }
});
app.get("/api/customers", core.requireSession, async (req, res) => {
  const q = String(req.query.q || "").trim();
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, `users?limit=20${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    const entries = r?.result?.entries || r?.result || [];
    const customers = (Array.isArray(entries) ? entries : []).map((u) => ({ id: u.id, name: u.full_name || [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || `Customer ${u.id}`, email: u.email || null }));
    res.json({ customers });
  } catch (err) { res.status(502).json({ error: "customers_failed", message: err?.message }); }
});

// Settings (business details, branding, numbering, reminders)
app.get("/api/settings", core.requireSession, async (req, res) => res.json({ settings: await settingsFor(req.session.merchantId) }));
app.post("/api/settings", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const row = await db.one(`INSERT INTO inv_settings (merchant_id, business_address, tax_id, terms, accent, footer, number_prefix, reply_to, auto_reminders, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
    ON CONFLICT (merchant_id) DO UPDATE SET business_address=$2, tax_id=$3, terms=$4, accent=$5, footer=$6, number_prefix=$7, reply_to=$8, auto_reminders=$9, updated_at=now() RETURNING *`,
    [req.session.merchantId, String(b.business_address || "").slice(0, 400) || null, String(b.tax_id || "").slice(0, 80) || null, String(b.terms || "").slice(0, 400) || null,
      /^#[0-9a-fA-F]{6}$/.test(b.accent) ? b.accent : "#1f6feb", String(b.footer || "").slice(0, 200) || null,
      String(b.number_prefix || "INV").replace(/[^A-Za-z0-9-]/g, "").slice(0, 8) || "INV", String(b.reply_to || "").trim().toLowerCase() || null, !!b.auto_reminders]);
  res.json({ settings: row });
});

// Recurring invoices CRUD
app.get("/api/recurring", core.requireSession, async (req, res) => res.json({ recurring: await db.q(`SELECT * FROM recurring_invoices WHERE merchant_id=$1 ORDER BY id`, [req.session.merchantId]) }));
app.post("/api/recurring", core.requireSession, async (req, res) => {
  const b = req.body || {}; const m = req.session.data?.merchant || {};
  const items = cleanItems(b.line_items);
  if (!items.length) return res.status(400).json({ error: "no_items" });
  const row = await db.one(`INSERT INTO recurring_invoices (merchant_id, customer_name, customer_email, customer_id, line_items, tax_rate, discount, currency, notes, due_days, day_of_month, auto_send)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [req.session.merchantId, b.customer_name || null, String(b.customer_email || "").trim().toLowerCase() || null, b.customer_id ? String(b.customer_id) : null,
      JSON.stringify(items), Math.max(0, Math.min(100, Number(b.tax_rate) || 0)), round2(b.discount), m.currency_code || "JMD",
      String(b.notes || "").trim() || null, Math.max(0, Math.min(120, Number(b.due_days) || 14)), Math.max(1, Math.min(28, Number(b.day_of_month) || 1)), b.auto_send !== false]);
  res.status(201).json({ recurring: row });
});
app.patch("/api/recurring/:id", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const r = await db.one(`SELECT * FROM recurring_invoices WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!r) return res.status(404).json({ error: "not_found" });
  const items = b.line_items !== undefined ? cleanItems(b.line_items) : (r.line_items || []);
  const u = await db.one(`UPDATE recurring_invoices SET customer_name=$1, customer_email=$2, customer_id=$3, line_items=$4, tax_rate=$5, discount=$6, notes=$7, due_days=$8, day_of_month=$9, active=$10, auto_send=$11 WHERE id=$12 RETURNING *`,
    [b.customer_name ?? r.customer_name, b.customer_email !== undefined ? (String(b.customer_email).trim().toLowerCase() || null) : r.customer_email, b.customer_id !== undefined ? (b.customer_id ? String(b.customer_id) : null) : r.customer_id,
      JSON.stringify(items), b.tax_rate != null ? Math.max(0, Math.min(100, Number(b.tax_rate))) : r.tax_rate, b.discount != null ? round2(b.discount) : r.discount,
      b.notes !== undefined ? (String(b.notes).trim() || null) : r.notes, b.due_days != null ? Math.max(0, Math.min(120, Number(b.due_days))) : r.due_days,
      b.day_of_month != null ? Math.max(1, Math.min(28, Number(b.day_of_month))) : r.day_of_month, b.active != null ? !!b.active : r.active, b.auto_send != null ? !!b.auto_send : r.auto_send, r.id]);
  res.json({ recurring: u });
});
app.delete("/api/recurring/:id", core.requireSession, async (req, res) => { await db.run(`DELETE FROM recurring_invoices WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]); res.json({ ok: true }); });

// CSV export
app.get("/api/invoices.csv", core.requireSession, async (req, res) => {
  const rows = await db.q(`SELECT * FROM invoices WHERE merchant_id=$1 ORDER BY created_at DESC`, [req.session.merchantId]);
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const head = ["number", "kind", "status", "customer", "email", "currency", "subtotal", "discount", "tax", "total", "due_date", "created_at", "paid_at"];
  const lines = rows.map((v) => [v.number, v.kind, v.status, v.customer_name, v.customer_email, v.currency, v.subtotal, v.discount, v.tax_amount, v.amount, v.due_date || "", v.created_at?.toISOString?.() || v.created_at, v.paid_at ? (v.paid_at.toISOString?.() || v.paid_at) : ""].map(esc).join(","));
  res.setHeader("Content-Type", "text/csv"); res.setHeader("Content-Disposition", `attachment; filename="invoices.csv"`);
  res.send([head.join(","), ...lines].join("\n"));
});

// Webhook self-registration status
app.get("/api/status", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  let sub = await db.one(`SELECT * FROM webhook_subs WHERE merchant_id=$1`, [mid]);
  const canRegister = WEBHOOK_SECRET && (req.session.scope || []).includes("webhooks:manage");
  if (!sub && canRegister) {
    const url = `${PUBLIC_BASE(req)}/webhooks/inkress/${mid}`;
    try {
      await inkressApi(core.cfg, req.session.accessToken, `webhook_urls`, { method: "POST", body: JSON.stringify({ url, event: "orders" }) });
      await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO UPDATE SET url=$2`, [mid, url]); sub = { merchant_id: mid, url };
    } catch (err) { if (String(err?.message || "").match(/already|unique|exist|422/i)) { await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO NOTHING`, [mid, url]); sub = { merchant_id: mid, url }; } }
  }
  res.json({ realtime: Boolean(sub) && Boolean(WEBHOOK_SECRET), webhook_registered: Boolean(sub), can_register: Boolean(canRegister), webhook_secret_configured: Boolean(WEBHOOK_SECRET) });
});

// Public invoice page + PDF
app.get("/invoice/:token", async (req, res) => {
  const v = await db.one(`SELECT * FROM invoices WHERE token=$1`, [req.params.token]).catch(() => null);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!v || v.status === "void") return res.status(404).send(publicShell("Not found", `<div class="pad"><h1>Invoice not found</h1></div>`));
  if (v.status === "sent" && v.inkress_order_id) {
    try { const ink = await getInkressOrder(core.cfg, await tokens.accessTokenFor(v.merchant_id), v.inkress_order_id); if (ink && isPaidStatus(ink)) { await db.run(`UPDATE invoices SET status='paid', paid_at=now() WHERE id=$1`, [v.id]); v.status = "paid"; emailReceipt(v).catch(() => {}); } } catch { /* */ }
  }
  res.send(invoicePage(v, await settingsFor(v.merchant_id)));
});
app.get("/invoice/:token/pdf", async (req, res) => {
  const v = await db.one(`SELECT * FROM invoices WHERE token=$1`, [req.params.token]).catch(() => null);
  if (!v || v.status === "void") return res.status(404).send("Not found");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${v.number}.pdf"`);
  res.send(Buffer.from(await invoicePdf(v, await settingsFor(v.merchant_id))));
});

// Webhook receiver — real-time paid → invoice paid + receipt
app.post("/webhooks/inkress/:merchantId", async (req, res) => {
  const merchantId = Number(req.params.merchantId);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  if (WEBHOOK_SECRET) {
    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("base64");
    const got = String(req.get("x-inkress-webhook-signature") || "");
    const a = Buffer.from(expected), b = Buffer.from(got);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "bad_signature" });
  }
  res.json({ received: true });
  try {
    const evt = JSON.parse(raw.toString("utf8"));
    const o = evt?.order || evt?.data?.order;
    if (!o || !merchantId || String(o.status || "").toLowerCase() !== "paid") return;
    const wid = String(req.get("x-inkress-webhook-id") || `${o.id}.${o.status}`);
    if (await db.one(`SELECT 1 FROM webhook_seen WHERE webhook_id=$1`, [wid])) return;
    await db.run(`INSERT INTO webhook_seen (webhook_id) VALUES ($1) ON CONFLICT DO NOTHING`, [wid]);
    const inv = await db.one(`SELECT * FROM invoices WHERE merchant_id=$1 AND inkress_order_id=$2 AND status='sent'`, [merchantId, String(o.id)]);
    if (inv) { await db.run(`UPDATE invoices SET status='paid', paid_at=now() WHERE id=$1`, [inv.id]); emailReceipt(inv).catch(() => {}); }
  } catch (err) { console.error(`[invoices] webhook failed: ${err?.message}`); }
});

async function emailReceipt(v) {
  if (!sesConfigured() || !v.customer_email) return;
  const st = await settingsFor(v.merchant_id);
  await sendEmail({ to: v.customer_email, replyTo: st.reply_to || undefined, subject: `Receipt for invoice ${v.number}`, html: receiptEmail(v, st) });
}

// ---- Schedulers ------------------------------------------------------------
async function runRecurring() {
  try {
    const day = new Date().getDate(); const month = new Date().toISOString().slice(0, 7); const today = new Date().toISOString().slice(0, 10);
    const due = await db.q(`SELECT * FROM recurring_invoices WHERE active=true AND day_of_month <= $1 AND (last_issued IS NULL OR to_char(last_issued,'YYYY-MM') < $2)`, [day, month]);
    for (const r of due) {
      try {
        const items = r.line_items || []; if (!items.length) continue;
        const t = computeTotals(items, r.tax_rate, r.discount);
        if (!(t.total > 0)) continue;
        const st = await settingsFor(r.merchant_id);
        const seqRow = await db.one(`SELECT COALESCE(MAX(seq),0)+1 AS s FROM invoices WHERE merchant_id=$1 AND kind='invoice'`, [r.merchant_id]);
        const number = `${st.number_prefix || "INV"}-${String(seqRow.s).padStart(4, "0")}`;
        const dueDate = new Date(Date.now() + (r.due_days || 14) * 86400000).toISOString().slice(0, 10);
        const inv = await db.one(`INSERT INTO invoices (merchant_id, seq, number, kind, customer_name, customer_email, customer_id, line_items, subtotal, discount, tax_rate, tax_amount, amount, currency, due_date, notes)
          VALUES ($1,$2,$3,'invoice',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [r.merchant_id, seqRow.s, number, r.customer_name, r.customer_email, r.customer_id, JSON.stringify(items), t.subtotal, t.discount, t.tax_rate, t.tax_amount, t.total, r.currency, dueDate, r.notes]);
        await db.run(`UPDATE recurring_invoices SET last_issued=$2 WHERE id=$1`, [r.id, today]);
        if (r.auto_send && r.customer_email) { try { await sendRecurring(inv); } catch { /* */ } }
      } catch (err) { console.error(`[invoices] recurring ${r.id}: ${err?.message}`); }
    }
  } catch (err) { console.error(`[invoices] runRecurring: ${err?.message}`); }
}
async function sendRecurring(v) {
  const accessToken = await tokens.accessTokenFor(v.merchant_id);
  const ref = `inv-${v.merchant_id}-${v.id}-${Date.now().toString(36)}`;
  const tok = crypto.randomBytes(9).toString("base64url");
  const [first, ...rest] = String(v.customer_name || "Customer").split(/\s+/);
  const created = await createInkressOrder(core.cfg, accessToken, {
    referenceId: ref, total: round2(v.amount), currencyCode: v.currency, kind: "online", title: `Invoice ${v.number}`,
    customer: { email: v.customer_email, first_name: first || "Customer", last_name: rest.join(" ") || "" },
    metaData: { source: "invoices", invoice: v.number, invoice_id: v.id, recurring: true },
  });
  const u = await db.one(`UPDATE invoices SET status='sent', sent_at=now(), ref=$2, token=$3, inkress_order_id=$4, payment_url=$5 WHERE id=$1 RETURNING *`,
    [v.id, ref, tok, created.id != null ? String(created.id) : null, created.payment_url || null]);
  const st = await settingsFor(v.merchant_id);
  const base = process.env.PUBLIC_BASE_URL || "";
  if (sesConfigured() && base) { try { await sendEmail({ to: v.customer_email, replyTo: st.reply_to || undefined, subject: `Invoice ${v.number} from ${st.business_address ? st.business_address.split("\n")[0] : "us"}`, html: invoiceEmail(u, `${base}/invoice/${tok}`, st) }); } catch { /* */ } }
}
async function runReminders() {
  try {
    const hour = new Date().getHours(); if (hour < 8 || hour > 19) return; // quiet hours
    if (!sesConfigured()) return;
    const today = new Date().toISOString().slice(0, 10);
    const due = await db.q(`SELECT i.* FROM invoices i JOIN inv_settings s ON s.merchant_id=i.merchant_id
      WHERE s.auto_reminders=true AND i.kind='invoice' AND i.status='sent' AND i.due_date < $1 AND i.customer_email IS NOT NULL
        AND (i.reminder_at IS NULL OR i.reminder_at < now() - interval '3 days') LIMIT 50`, [today]);
    for (const v of due) {
      try {
        const st = await settingsFor(v.merchant_id);
        const base = process.env.PUBLIC_BASE_URL || "";
        if (!base || !v.token) continue;
        await sendEmail({ to: v.customer_email, replyTo: st.reply_to || undefined, subject: `Reminder: invoice ${v.number} is overdue`, html: reminderEmail(v, `${base}/invoice/${v.token}`, st) });
        await db.run(`UPDATE invoices SET reminder_at=now() WHERE id=$1`, [v.id]);
      } catch (err) { console.error(`[invoices] reminder ${v.id}: ${err?.message}`); }
    }
  } catch (err) { console.error(`[invoices] runReminders: ${err?.message}`); }
}
setInterval(runRecurring, 6 * 3600 * 1000); setTimeout(runRecurring, 30000);
setInterval(runReminders, 3600 * 1000); setTimeout(runReminders, 60000);

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[invoices] listening on ${HOST}:${PORT}`));

// ---- HTML / PDF rendering --------------------------------------------------
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function money(n, c) { try { return new Intl.NumberFormat("en-JM", { style: "currency", currency: c, minimumFractionDigits: 0 }).format(n); } catch { return `${c} ${n}`; } }
function breakdownRows(v) {
  const rows = [];
  const sub = Number(v.subtotal || 0), disc = Number(v.discount || 0), tax = Number(v.tax_amount || 0);
  if (disc > 0 || tax > 0) {
    rows.push(["Subtotal", sub]);
    if (disc > 0) rows.push(["Discount", -disc]);
    if (tax > 0) rows.push([`Tax${Number(v.tax_rate) ? ` (${Number(v.tax_rate)}%)` : ""}`, tax]);
  }
  return rows;
}
function itemRowsHtml(v) {
  const items = v.line_items || [];
  if (!items.length) return `<tr><td>${esc(v.notes || "Amount due")}</td><td class="r">${money(Number(v.amount), v.currency)}</td></tr>`;
  return items.map((it) => `<tr><td>${esc(it.description)} <span class="qty">× ${it.qty}</span></td><td class="r">${money(it.qty * it.price, v.currency)}</td></tr>`).join("");
}
function invoiceEmail(v, url, st) {
  const accent = (st?.accent && /^#[0-9a-fA-F]{6}$/.test(st.accent)) ? st.accent : "#1f6feb";
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">
    <h2 style="margin:0 0 4px;">Invoice ${esc(v.number)}</h2>
    <p style="color:#666;margin:0 0 14px;">${esc(v.merchant_name || "")}${v.due_date ? ` · due ${esc(v.due_date)}` : ""}</p>
    <div style="font-size:24px;font-weight:800;margin:0 0 14px;">${money(Number(v.amount), v.currency)}</div>
    <a href="${esc(url)}" style="display:inline-block;padding:13px 26px;background:${accent};color:#fff;border-radius:10px;text-decoration:none;font-weight:700;">View &amp; pay invoice</a>
    <p style="color:#aaa;font-size:12px;margin-top:18px;">${esc(st?.footer || "via Marketplace")}</p></div>`;
}
function reminderEmail(v, url, st) {
  const accent = (st?.accent && /^#[0-9a-fA-F]{6}$/.test(st.accent)) ? st.accent : "#1f6feb";
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">
    <h2 style="margin:0 0 4px;">Friendly reminder</h2>
    <p style="color:#666;margin:0 0 12px;">Invoice ${esc(v.number)} for ${money(Number(v.amount), v.currency)} was due ${esc(v.due_date)}.</p>
    <a href="${esc(url)}" style="display:inline-block;padding:13px 26px;background:${accent};color:#fff;border-radius:10px;text-decoration:none;font-weight:700;">Pay now</a>
    <p style="color:#aaa;font-size:12px;margin-top:18px;">${esc(st?.footer || "via Marketplace")}</p></div>`;
}
function receiptEmail(v, st) {
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;text-align:center;color:#1a1a1a;">
    <div style="font-size:38px;">✅</div><h2 style="margin:4px 0;">Payment received</h2>
    <p style="color:#666;">Invoice ${esc(v.number)} · ${money(Number(v.amount), v.currency)}</p>
    <p style="color:#aaa;font-size:12px;">Thank you! · ${esc(st?.footer || "via Marketplace")}</p></div>`;
}
function publicShell(title, inner, accent = "#1f6feb") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f5f7fa;color:#1f2430;display:grid;place-items:center;min-height:100vh;padding:20px}
  .card{background:#fff;border:1px solid #e6eaf0;border-radius:18px;box-shadow:0 14px 44px rgba(20,30,60,.1);max-width:480px;width:100%;overflow:hidden}
  .accent{height:4px;background:${accent}} .pad{padding:28px}
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:16px}
  .logo{width:48px;height:48px;border-radius:12px;object-fit:cover;border:1px solid #eee}
  h1{font-size:1.3rem;margin:0} .muted{color:#6b7280;font-size:.9rem;margin:2px 0 0}
  .biz{white-space:pre-line;color:#6b7280;font-size:.82rem;margin:6px 0 0}
  .badge{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:4px 10px;border-radius:20px}
  .b-sent{background:#fef3c7;color:#92400e}.b-paid{background:#dcfce7;color:#166534}.b-over{background:#fee2e2;color:#991b1b}
  table{width:100%;border-collapse:collapse;margin:8px 0 4px}td{padding:9px 0;border-bottom:1px solid #eef1f5;font-size:.95rem}
  td.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.qty{color:#9aa4b2;font-size:.85rem}
  .brk td{border:none;padding:3px 0;color:#6b7280;font-size:.9rem}.brk td.r{color:#1f2430}
  .total{display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:1.25rem;font-weight:800;border-top:2px solid #eef1f5;padding-top:12px}
  a.pay{display:block;text-align:center;margin-top:18px;padding:14px;background:${accent};color:#fff;border-radius:10px;text-decoration:none;font-weight:700}
  a.dl{display:block;text-align:center;margin-top:10px;color:${accent};text-decoration:none;font-weight:600;font-size:.9rem}
  .paid-note{text-align:center;margin-top:16px;color:#166534;font-weight:600}
  .foot{text-align:center;color:#aab;font-size:12px;padding:14px;white-space:pre-line}</style></head>
  <body><div class="card"><div class="accent"></div>${inner}<div class="foot">${esc("powered by Marketplace")}</div></div></body></html>`;
}
function invoicePage(v, st) {
  const accent = (st?.accent && /^#[0-9a-fA-F]{6}$/.test(st.accent)) ? st.accent : "#1f6feb";
  const paid = v.status === "paid"; const over = isOverdue(v);
  const logo = v.merchant_logo ? `<img class="logo" src="${esc(v.merchant_logo)}" alt="">` : "";
  const brk = breakdownRows(v).map(([label, amt]) => `<tr class="brk"><td>${esc(label)}</td><td class="r">${amt < 0 ? "−" : ""}${money(Math.abs(amt), v.currency)}</td></tr>`).join("");
  return publicShell(`Invoice ${v.number}`, `<div class="pad">
    <div class="head"><div>${logo ? logo + "<br>" : ""}<h1>Invoice ${esc(v.number)}</h1>
      <p class="muted">${esc(v.merchant_name || "")}${v.customer_name ? ` · for ${esc(v.customer_name)}` : ""}</p>
      ${v.due_date ? `<p class="muted">Due ${esc(v.due_date)}</p>` : ""}
      ${st?.business_address ? `<div class="biz">${esc(st.business_address)}${st.tax_id ? `\nTax ID: ${esc(st.tax_id)}` : ""}</div>` : ""}</div>
      <span class="badge ${paid ? "b-paid" : over ? "b-over" : "b-sent"}">${paid ? "Paid" : over ? "Overdue" : "Unpaid"}</span></div>
    <table>${itemRowsHtml(v)}</table>
    ${brk ? `<table style="margin-top:0">${brk}</table>` : ""}
    <div class="total"><span>Total</span><span>${money(Number(v.amount), v.currency)}</span></div>
    ${v.notes && (v.line_items || []).length ? `<p class="muted" style="margin-top:10px">${esc(v.notes)}</p>` : ""}
    ${st?.terms ? `<p class="muted" style="margin-top:8px;font-size:.8rem">${esc(st.terms)}</p>` : ""}
    ${paid ? `<div class="paid-note">✅ Paid${v.paid_at ? ` on ${new Date(v.paid_at).toLocaleDateString()}` : ""} — thank you!</div>`
      : v.payment_url ? `<a class="pay" href="${esc(v.payment_url)}">Pay ${money(Number(v.amount), v.currency)}</a>` : ""}
    <a class="dl" href="/invoice/${esc(v.token)}/pdf" target="_blank" rel="noopener">Download PDF</a></div>`, accent);
}
async function invoicePdf(v, st) {
  const accent = (st?.accent && /^#[0-9a-fA-F]{6}$/.test(st.accent)) ? st.accent : "#1f6feb";
  const items = (v.line_items || []).map((it) => ({ description: it.description, qty: it.qty, amount: money(it.qty * it.price, v.currency) }));
  if (!items.length) items.push({ description: v.notes || "Amount due", amount: money(Number(v.amount), v.currency) });
  const totals = [];
  for (const [label, amt] of breakdownRows(v)) totals.push({ label, value: `${amt < 0 ? "−" : ""}${money(Math.abs(amt), v.currency)}` });
  totals.push({ label: "Total", value: money(Number(v.amount), v.currency), bold: true });
  const meta = [];
  if (v.customer_name) meta.push({ label: "Bill to", value: v.customer_name });
  meta.push({ label: "Date", value: new Date(v.created_at).toISOString().slice(0, 10) });
  if (v.due_date) meta.push({ label: "Due", value: String(v.due_date).slice(0, 10) });
  if (st?.tax_id) meta.push({ label: "Tax ID", value: st.tax_id });
  return documentPdf({
    brand: { name: v.merchant_name || "Invoice", accent },
    title: v.kind === "estimate" ? "Estimate" : "Invoice", number: v.number,
    badge: v.status === "paid" ? "PAID" : null, meta, items, totals,
    note: [st?.business_address, v.notes, st?.terms].filter(Boolean).join("\n\n"),
    footer: st?.footer || "Thank you for your business.",
  });
}
