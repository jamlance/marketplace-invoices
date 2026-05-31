/** DEV-ONLY preview harness — tree-shaken from prod. */
import type { BvSession } from "./bv-init";

const origin = location.origin;
const round2 = (n: number) => Math.round(n * 100) / 100;
function totals(items: any[], taxRate = 0, discount = 0) {
  const subtotal = round2(items.reduce((s, it) => s + it.qty * it.price, 0));
  const disc = Math.min(subtotal, Math.max(0, round2(discount)));
  const taxable = round2(subtotal - disc);
  const tax = round2(taxable * (Number(taxRate) || 0) / 100);
  return { subtotal, discount: disc, tax_rate: Number(taxRate) || 0, tax_amount: tax, amount: round2(taxable + tax) };
}
function withDerived(v: any) {
  const overdue = v.status === "sent" && (v.kind || "invoice") === "invoice" && v.due_date && new Date(v.due_date) < new Date(new Date().toISOString().slice(0, 10));
  return { ...v, overdue, public_url: v.token ? origin + "/invoice/" + v.token : v.public_url, pdf_url: origin + "/api/invoices/" + v.id + "/pdf" };
}
let INV: any[] = [
  { id: 1, seq: 1, number: "INV-0001", kind: "invoice", customer_name: "Sandra Bennett", customer_email: "sandra@example.com", customer_id: "11", line_items: [{ description: "Logo design", qty: 1, price: 45000 }, { description: "Brand guide", qty: 1, price: 18000 }], ...totals([{ description: "Logo design", qty: 1, price: 45000 }, { description: "Brand guide", qty: 1, price: 18000 }], 0, 0), currency: "JMD", status: "paid", due_date: "2026-05-20", notes: "Net 14", token: "tok1", payment_url: origin + "/pay/1", created_at: new Date(Date.now() - 12 * 864e5).toISOString(), sent_at: new Date(Date.now() - 11 * 864e5).toISOString(), paid_at: new Date(Date.now() - 8 * 864e5).toISOString() },
  { id: 2, seq: 2, number: "INV-0002", kind: "invoice", customer_name: "Trevor Mills", customer_email: "trevor@example.com", customer_id: null, line_items: [{ description: "Monthly retainer — June", qty: 1, price: 80000 }], ...totals([{ description: "Monthly retainer — June", qty: 1, price: 80000 }], 15, 0), currency: "JMD", status: "sent", due_date: "2026-05-15", notes: null, token: "tok2", payment_url: origin + "/pay/2", created_at: new Date(Date.now() - 30 * 864e5).toISOString(), sent_at: new Date(Date.now() - 30 * 864e5).toISOString(), paid_at: null },
  { id: 3, seq: 3, number: "INV-0003", kind: "invoice", customer_name: "Kayla Foster", customer_email: "kayla@example.com", customer_id: null, line_items: [{ description: "Consultation (hrs)", qty: 3, price: 6000 }], ...totals([{ description: "Consultation (hrs)", qty: 3, price: 6000 }], 0, 2000), currency: "JMD", status: "draft", due_date: null, notes: null, token: null, payment_url: null, created_at: new Date(Date.now() - 36e5).toISOString(), sent_at: null, paid_at: null },
  { id: 4, seq: 1, number: "EST-0001", kind: "estimate", customer_name: "Devon Clarke", customer_email: "devon@example.com", customer_id: null, line_items: [{ description: "Website build", qty: 1, price: 220000 }], ...totals([{ description: "Website build", qty: 1, price: 220000 }], 0, 0), currency: "JMD", status: "draft", due_date: null, notes: "Valid 30 days", token: null, payment_url: null, created_at: new Date(Date.now() - 2 * 864e5).toISOString(), sent_at: null, paid_at: null },
];
let RECUR: any[] = [
  { id: 1, customer_name: "Trevor Mills", customer_email: "trevor@example.com", customer_id: null, line_items: [{ description: "Monthly retainer", qty: 1, price: 80000 }], tax_rate: 15, discount: 0, currency: "JMD", notes: null, due_days: 14, day_of_month: 1, active: true, auto_send: true, last_issued: null },
];
let SETTINGS: any = { business_address: "Pixel Studio JA\n12 Hope Road\nKingston 10, Jamaica", tax_id: "TRN 001-234-567", terms: "Payment due within 14 days.", accent: "#1f6feb", footer: "Thank you for your business.", number_prefix: "INV", reply_to: "billing@pixelstudio.ja", auto_reminders: true };
const PRODUCTS = [{ id: 101, title: "Logo design", price: 45000, currency: "JMD" }, { id: 102, title: "Brand guide", price: 18000, currency: "JMD" }, { id: 103, title: "Website build", price: 220000, currency: "JMD" }, { id: 104, title: "Monthly retainer", price: 80000, currency: "JMD" }];
const CUSTOMERS = [{ id: 11, name: "Sandra Bennett", email: "sandra@example.com" }, { id: 12, name: "Trevor Mills", email: "trevor@example.com" }, { id: 13, name: "Kayla Foster", email: "kayla@example.com" }, { id: 14, name: "Devon Clarke", email: "devon@example.com" }];
let SEQ = 3, EST = 1, IID = 4, RID = 1;
const tok = () => Math.random().toString(36).slice(2, 9);

export function installMockFetch() {
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url, location.origin);
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
    await new Promise((r) => setTimeout(r, 80));
    const im = u.pathname.match(/\/api\/invoices\/(\d+)(\/send|\/convert|\/pdf)?$/);
    const rm = u.pathname.match(/\/api\/recurring\/(\d+)/);

    if (u.pathname === "/api/status") return json({ realtime: true, webhook_registered: true, can_register: true, webhook_secret_configured: true });
    if (u.pathname === "/api/products") { const q = (u.searchParams.get("q") || "").toLowerCase(); return json({ products: PRODUCTS.filter((p) => !q || p.title.toLowerCase().includes(q)) }); }
    if (u.pathname === "/api/customers") { const q = (u.searchParams.get("q") || "").toLowerCase(); return json({ customers: CUSTOMERS.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.email || "").includes(q)) }); }
    if (u.pathname === "/api/settings" && method === "GET") return json({ settings: SETTINGS });
    if (u.pathname === "/api/settings" && method === "POST") { SETTINGS = { ...SETTINGS, ...body }; return json({ settings: SETTINGS }); }
    if (u.pathname === "/api/recurring" && method === "GET") return json({ recurring: RECUR });
    if (u.pathname === "/api/recurring" && method === "POST") { const r = { id: ++RID, active: true, last_issued: null, ...body, tax_rate: Number(body.tax_rate) || 0, discount: Number(body.discount) || 0, currency: "JMD" }; RECUR.push(r); return json({ recurring: r }, 201); }
    if (rm && method === "PATCH") { const r = RECUR.find((x) => x.id === Number(rm[1])); Object.assign(r, body); return json({ recurring: r }); }
    if (rm && method === "DELETE") { RECUR = RECUR.filter((x) => x.id !== Number(rm[1])); return json({ ok: true }); }
    if (u.pathname === "/api/invoices.csv") return new Response("number,kind,status,total\nINV-0001,invoice,paid,63000", { status: 200, headers: { "Content-Type": "text/csv" } });

    if (u.pathname === "/api/invoices" && method === "GET") {
      const invs = INV.filter((v) => (v.kind || "invoice") === "invoice").map(withDerived);
      const outstanding = invs.filter((v) => v.status === "sent").reduce((s, v) => s + v.amount, 0);
      const paid = invs.filter((v) => v.status === "paid").reduce((s, v) => s + v.amount, 0);
      const overdue = invs.filter((v) => v.overdue).reduce((s, v) => s + v.amount, 0);
      return json({ invoices: INV.map(withDerived), connected: true, webhook_realtime: true, stats: { count: invs.length, outstanding, paid, overdue, drafts: invs.filter((v) => v.status === "draft").length, estimates: INV.filter((v) => v.kind === "estimate").length } });
    }
    if (u.pathname === "/api/invoices" && method === "POST") {
      const items = body.line_items || []; const kind = body.kind === "estimate" ? "estimate" : "invoice";
      const seq = kind === "estimate" ? ++EST : ++SEQ; const prefix = kind === "estimate" ? "EST" : (SETTINGS.number_prefix || "INV");
      const v = { id: ++IID, seq, number: prefix + "-" + String(seq).padStart(4, "0"), kind, customer_name: body.customer_name, customer_email: body.customer_email, customer_id: body.customer_id || null, line_items: items, ...totals(items, body.tax_rate, body.discount), currency: "JMD", status: "draft", due_date: body.due_date || null, notes: body.notes || null, token: null, payment_url: null, created_at: new Date().toISOString(), sent_at: null, paid_at: null };
      INV.unshift(v); return json({ invoice: withDerived(v) }, 201);
    }
    if (im && im[2] === "/send") { const v = INV.find((x) => x.id === Number(im[1])); v.status = "sent"; v.sent_at = new Date().toISOString(); v.payment_url = origin + "/pay/" + v.id; v.token = tok(); return json({ invoice: withDerived(v), emailed: true }); }
    if (im && im[2] === "/convert") { const v = INV.find((x) => x.id === Number(im[1])); v.kind = "invoice"; v.seq = ++SEQ; v.number = (SETTINGS.number_prefix || "INV") + "-" + String(v.seq).padStart(4, "0"); v.status = "draft"; return json({ invoice: withDerived(v) }); }
    if (im && im[2] === "/pdf") return new Response(new Blob(["%PDF-1.4 mock"], { type: "application/pdf" }), { status: 200, headers: { "Content-Type": "application/pdf" } });
    if (im && method === "PATCH") { const v = INV.find((x) => x.id === Number(im[1])); if (body.status === "void") { v.status = "void"; } else { Object.assign(v, body); Object.assign(v, totals(body.line_items || v.line_items, body.tax_rate ?? v.tax_rate, body.discount ?? v.discount)); } return json({ invoice: withDerived(v) }); }
    if (im && method === "DELETE") { INV = INV.filter((x) => x.id !== Number(im[1])); return json({ ok: true }); }
    return new Response("{}", { status: 404 });
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { notify: ({ message }: any) => console.log("[toast]", message) } as any,
    merchant: { id: 183, username: "pixel-studio", name: "Pixel Studio JA", currency_code: "JMD", email: "hello@pixelstudio.ja", logo: null },
    user: { id: 90, name: "Owner", email: "owner@pixelstudio.ja" },
    scopes: ["orders:write", "products:read", "webhooks:manage", "offline_access"],
  };
}
