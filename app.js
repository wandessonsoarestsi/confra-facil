import { CONFIG } from "./config.js";
import { makeFinalImage } from "./share-image.js";

const app = document.getElementById("app");
const WD_SHORT = ["D", "S", "T", "Q", "Q", "S", "S"];
const WD_NAMES = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const MAX_DAYS = 120;

let api = null;
let user = null;
let profile = null;
let pendingProfile = null;
let login = { step: "phone", phone: "", phoneRaw: "" };
let page = emptyPage(null);

function emptyPage(id) {
  return {
    eventId: id, ev: null, responses: [], unsub: [], tab: "minhas", draft: null, dirty: false, loaded: false, showAll: false,
    coAdmin: false, adminInit: false, adminCode: null, contacts: {}, migrated: new Set(), claimOpen: false,
  };
}

// ---------- utilidades ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtLong = (s) => cap(fromISO(s).toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" }));
const fmtShort = (s) => fromISO(s).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function toast(msg, ms = 3000) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}

function normalizePhone(raw) {
  let s = String(raw).replace(/[^\d+]/g, "");
  if (!s.startsWith("+")) s = CONFIG.defaultCountryCode + s.replace(/^0+/, "");
  return s;
}
const validPhone = (p) => /^\+\d{10,15}$/.test(p);
function fmtPhone(p) {
  const m = String(p || "").match(/^\+55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p || "";
}

function errMsg(e) {
  const map = {
    "auth/invalid-phone-number": "Número de telefone inválido. Use DDD + número.",
    "auth/missing-phone-number": "Informe o telefone.",
    "auth/too-many-requests": "Muitas tentativas. Aguarde alguns minutos e tente de novo.",
    "auth/quota-exceeded": "Limite de SMS atingido por hoje. Tente mais tarde.",
    "auth/invalid-verification-code": "Código incorreto. Confira e tente de novo.",
    "auth/code-expired": "O código expirou. Peça um novo.",
    "auth/billing-not-enabled": "O login por SMS precisa do plano Blaze no Firebase (veja o LEIA-ME).",
    "auth/operation-not-allowed": "Esse tipo de login não está ativado no Firebase.",
    "auth/captcha-check-failed": "Falha na verificação anti-robô. Recarregue a página.",
    "auth/network-request-failed": "Sem conexão. Verifique a internet.",
    "permission-denied": "Sem permissão para essa ação.",
    unavailable: "Sem conexão. Verifique a internet.",
  };
  return map[e?.code] || "Algo deu errado. Tente de novo.";
}
function showError(e) { console.error(e); toast(errMsg(e), 5000); }

// Quem pode criar eventos: todos, ou só os telefones em CONFIG.adminPhones.
// A lista guarda o SHA-256 do telefone (ex.: "+5583999999999"), para não expor o número.
let organizer = false;
async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function refreshOrganizer() {
  const list = CONFIG.adminPhones || [];
  if (!list.length) { organizer = true; return; }
  const phone = normalizePhone(profile?.phone || user?.phone || "");
  // Aceita também quem digitou o 55 sem o "+" (ex.: 5583999999999).
  const variants = [phone];
  const m = phone.match(/^\+(55)(55\d{10,11})$/);
  if (m) variants.push("+" + m[2]);
  const hashes = await Promise.all(variants.map(sha256));
  organizer = list.some((x) => hashes.includes(x) || variants.includes(normalizePhone(x)));
}
function canCreate() { return organizer; }

// Código do organizador: 8 letras/números fáceis de ler (sem 0/O, 1/I).
function newAdminCode() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const n = crypto.getRandomValues(new Uint32Array(8));
  return [...n].map((x) => abc[x % abc.length]).join("");
}
const isEventAdmin = (ev) => !!ev && (ev.adminUid === user?.uid || page.coAdmin);

// Ao virar organizador: assina os telefones, busca o código e move telefones antigos.
function startAdmin(ev) {
  if (page.adminInit) return;
  page.adminInit = true;
  const id = ev.id;
  page.unsub.push(api.watchContacts(id, (cs) => {
    if (page.eventId !== id) return;
    page.contacts = Object.fromEntries(cs.map((c) => [c.uid, c]));
    renderEvent();
  }, (e) => console.error(e)));
  api.getAdminCode(id).then(async (code) => {
    if (!code && ev.adminUid === user.uid) { code = newAdminCode(); await api.setAdminCode(id, code); }
    if (page.eventId === id) { page.adminCode = code; renderEvent(); }
  }).catch((e) => { console.error(e); if (page.eventId === id) { page.adminCode = "erro"; renderEvent(); } });
}
function migrateOldPhones() {
  for (const r of page.responses) {
    if (!r.phone || page.migrated.has(r.uid)) continue;
    page.migrated.add(r.uid);
    api.migrateContact(page.eventId, r).catch((e) => console.error(e));
  }
}

// ---------- cálculo ----------
function candidateDates(ev) {
  const out = [];
  const wds = new Set(ev.weekdays ?? [0, 1, 2, 3, 4, 5, 6]);
  const d = fromISO(ev.start);
  const end = fromISO(ev.end);
  while (d <= end && out.length <= MAX_DAYS) {
    if (wds.has(d.getDay())) out.push(toISO(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// Para cada data candidata, conta quem pode ir.
// Quem marcou "posso": pode nas datas marcadas.
// Quem marcou "não posso": pode em todas as datas, menos as marcadas.
export function computeRanking(ev, responses) {
  const people = responses.map((r) => ({ name: r.name, mode: r.mode, set: new Set(r.dates || []) }));
  return candidateDates(ev)
    .map((date) => {
      const yes = [], no = [];
      for (const p of people) {
        const ok = p.mode === "can" ? p.set.has(date) : !p.set.has(date);
        (ok ? yes : no).push(p.name);
      }
      return { date, yes, no };
    })
    .sort((a, b) => b.yes.length - a.yes.length || a.date.localeCompare(b.date));
}

// ---------- navegação ----------
const currentEventId = () => new URLSearchParams(location.search).get("e");

function go(eventId) {
  const url = eventId ? `${location.pathname}?e=${encodeURIComponent(eventId)}` : location.pathname;
  history.pushState({}, "", url);
  route();
}
window.addEventListener("popstate", () => route());

function route() {
  const id = currentEventId();
  if (!user) { closeEvent(); return renderLogin(id); }
  if (!profile?.name) return renderProfile();
  if (id) return openEvent(id);
  closeEvent();
  renderHome();
}

function closeEvent() {
  page.unsub.forEach((u) => { try { u(); } catch {} });
  page = emptyPage(null);
}

function openEvent(id) {
  if (page.eventId === id) return renderEvent();
  closeEvent();
  page = emptyPage(id);
  renderShell(`<div class="loading">Carregando evento…</div>`);
  page.unsub.push(api.watchEvent(id, (ev) => { if (page.eventId !== id) return; page.ev = ev; page.loaded = true; renderEvent(); }, showError));
  api.isCoAdmin(id, user.uid).then((v) => { if (page.eventId === id && v) { page.coAdmin = true; renderEvent(); } }).catch(() => {});
  page.unsub.push(api.watchResponses(id, (rs) => {
    if (page.eventId !== id) return;
    page.responses = rs;
    if (!page.dirty) page.draft = null;
    renderEvent();
  }, showError));
}

// ---------- ícones e marca ----------
const ICONS = {
  calendar: '<rect x="3" y="4.5" width="18" height="17" rx="3.5"/><path d="M16 2.5v4M8 2.5v4M3 10h18"/>',
  calCheck: '<rect x="3" y="4.5" width="18" height="17" rx="3.5"/><path d="M16 2.5v4M8 2.5v4M3 10h18M9 15.5l2 2 4-4"/>',
  calX: '<rect x="3" y="4.5" width="18" height="17" rx="3.5"/><path d="M16 2.5v4M8 2.5v4M3 10h18M10 14l4 4M14 14l-4 4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4.5A2.5 2.5 0 0 1 2 12.5v-8A2.5 2.5 0 0 1 4.5 2h8A2.5 2.5 0 0 1 15 4.5V5"/>',
  send: '<path d="M21.5 2.5 10.6 13.4M21.5 2.5l-7 19-3.9-8.1-8.1-3.9 19-7Z"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-12.6 7.3L3 20l1.3-5.1A8.5 8.5 0 1 1 21 11.5Z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 7.8-1.2"/>',
  trash: '<path d="M3 6h18M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6m2.5 0-.8 13.1a2 2 0 0 1-2 1.9H8.3a2 2 0 0 1-2-1.9L5.5 6M10 11v5M14 11v5"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
  moon: '<path d="M20.5 14.1A8.5 8.5 0 0 1 9.9 3.5 8.5 8.5 0 1 0 20.5 14.1Z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  clock: '<circle cx="12" cy="12" r="9.5"/><path d="M12 7v5l3 2"/>',
  trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0V4ZM7 6H4.5v1.5A3.5 3.5 0 0 0 7 10.9M17 6h2.5v1.5a3.5 3.5 0 0 1-2.5 3.4M12 14v4M8 21h8M9.5 18h5"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
  user: '<circle cx="12" cy="8" r="4.5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 16v-4.5M12 8h.01"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  link: '<path d="M10 13.5a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2M14 10.5a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 10h18M9 10v10"/>',
  alert: '<path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4.5M12 17h.01"/>',
};
const icon = (n, cls = "") =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

// Logo: um calendário com um "check", em azul.
const logoMark = (cls = "") => `<svg class="logo ${cls}" viewBox="0 0 40 40" aria-hidden="true">
  <defs><linearGradient id="lg-${cls || "x"}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b8cff"/><stop offset="1" stop-color="#0b3fa8"/></linearGradient></defs>
  <rect x="3" y="6" width="34" height="31" rx="10" fill="url(#lg-${cls || "x"})"/>
  <rect x="11" y="2.5" width="4" height="8" rx="2" fill="#0b3fa8"/><rect x="25" y="2.5" width="4" height="8" rx="2" fill="#0b3fa8"/>
  <path d="M13 22.5l5 5 9.5-10" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
const wordmark = () => `<span class="wordmark">Bora<b>Marcar</b></span>`;

// ---------- tema ----------
function currentTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? "#0b1220" : "#f4f6fb");
}
try { const saved = localStorage.getItem("bm-theme"); if (saved) applyTheme(saved); } catch {}
const themeBtn = () => `<button class="icon-btn" data-act="theme" aria-label="${currentTheme() === "dark" ? "Usar tema claro" : "Usar tema escuro"}" title="Trocar tema">${icon(currentTheme() === "dark" ? "sun" : "moon")}</button>`;

const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

// ---------- telas ----------
function header() {
  return `<header class="top">
    <a href="${location.pathname}" class="brand" data-act="home" aria-label="Início">${logoMark("sm")}${wordmark()}</a>
    <div class="top-actions">
      ${themeBtn()}
      ${user && profile?.name ? `<button class="avatar" data-act="account" title="Sua conta" aria-label="Sua conta">${esc(initials(profile.name))}</button>` : ""}
    </div>
  </header>`;
}

function renderShell(inner, opts = {}) {
  app.innerHTML = `${opts.bare ? "" : header()}<main class="${opts.bare ? "bare" : ""}">${inner}</main>${api?.isDemo ? `<p class="demo-banner">${icon("info")} Modo demonstração: os dados ficam só neste navegador. Código de login: <b>123456</b>.</p>` : ""}`;
}

function field(label, iconName, input) {
  return `<label class="field"><span class="field-label">${label}</span><span class="input-wrap">${icon(iconName)}${input}</span></label>`;
}

function renderLogin(eventId) {
  const intro = eventId
    ? "Você foi convidado para escolher a data do encontro. Entre para marcar seus dias."
    : "Cada pessoa marca os dias em que pode ou não pode ir. A gente encontra a data em que mais gente consegue.";
  let form;
  if (api.authMode === "simples") {
    form = `<form id="f-simple" class="sheet stack">
      <div><h2>Entrar</h2><p class="muted">Sem senha e sem cadastro.</p></div>
      ${field("Seu nome", "user", `<input name="name" required maxlength="40" autocomplete="name" placeholder="Como o grupo te conhece">`)}
      ${field("Seu telefone (WhatsApp)", "phone", `<input name="phone" type="tel" inputmode="tel" required placeholder="(11) 98765-4321" autocomplete="tel">`)}
      <button class="btn primary block" type="submit">Entrar ${icon("arrow")}</button>
    </form>`;
  } else if (login.step === "phone") {
    form = `<form id="f-phone" class="sheet stack">
      <div><h2>Entrar</h2><p class="muted">Você vai receber um código por SMS.</p></div>
      ${field("Seu telefone", "phone", `<input name="phone" type="tel" inputmode="tel" required placeholder="(11) 98765-4321" autocomplete="tel" value="${esc(login.phoneRaw)}">`)}
      <button class="btn primary block" type="submit">Receber código ${icon("arrow")}</button>
    </form>`;
  } else {
    form = `<form id="f-code" class="sheet stack">
      <div><h2>Digite o código</h2><p class="muted">Enviamos um SMS para <b>${esc(fmtPhone(login.phone))}</b>.</p></div>
      <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required pattern="[0-9]{6}" class="code-input" aria-label="Código de 6 dígitos">
      <button class="btn primary block" type="submit">Entrar ${icon("arrow")}</button>
      <button type="button" class="link" data-act="change-phone">Trocar número ou reenviar</button>
    </form>`;
  }
  renderShell(`
    <section class="splash">
      <div class="splash-top">${themeBtn()}</div>
      <div class="splash-brand">${logoMark("lg")}<h1>${wordmark()}</h1><p>${intro}</p></div>
    </section>
    ${form}`, { bare: true });
}

function renderProfile() {
  renderShell(`<form id="f-profile" class="card stack">
    <div><h2>Como você quer ser chamado?</h2><p class="muted">Seu nome aparece junto com as suas datas.</p></div>
    ${field("Seu nome", "user", `<input name="name" required maxlength="40" autocomplete="name" value="${esc(profile?.name || "")}">`)}
    <button class="btn primary block" type="submit">Continuar ${icon("arrow")}</button>
  </form>`);
  app.querySelector("input")?.focus();
}

// Tela da conta: antes de sair, mostra os códigos de organizador para não perder acesso.
async function renderAccount() {
  closeEvent();
  renderShell(`<div class="loading">Carregando…</div>`);
  let events = [];
  try { events = await api.listMyEvents(user.uid); } catch (e) { console.error(e); }
  const codes = await Promise.all(events.map(async (ev) => {
    try {
      let code = await api.getAdminCode(ev.id);
      if (!code && ev.adminUid === user.uid) { code = newAdminCode(); await api.setAdminCode(ev.id, code); }
      return code;
    } catch { return null; }
  }));
  const anon = api.authMode === "simples";
  const list = events.length
    ? `<ul class="code-list">${events.map((ev, i) => `<li><span><b>${esc(ev.name)}</b><span class="muted">${fmtShort(ev.start)} a ${fmtShort(ev.end)}</span></span><code>${codes[i] ? esc(codes[i]) : "sem código"}</code></li>`).join("")}</ul>`
    : `<p class="muted">Você não organiza nenhum evento neste aparelho.</p>`;
  renderShell(`
    <section class="greet"><h1>Sua conta</h1><p class="muted">${esc(profile?.name || "")}${profile?.phone ? " · " + esc(fmtPhone(profile.phone)) : ""}</p><p class="muted uid">ID da conta: <code>${esc(user.uid)}</code></p></section>
    <div class="card stack">
      <h3 class="card-title">${icon("key")} Seus códigos de organizador</h3>
      <p class="muted">Anote estes códigos. Com eles você volta a gerenciar seus eventos em qualquer aparelho.</p>
      ${list}
    </div>
    <div class="card stack danger-zone">
      <h3 class="card-title">${icon("logout")} Sair</h3>
      ${anon ? `<div class="note warn">${icon("alert")}<p>Ao sair, este aparelho perde o acesso de organizador. Para voltar a gerenciar, você vai precisar do código de cada evento.</p></div>` : ""}
      <button class="btn danger" data-act="logout">${icon("logout")} Sair mesmo assim</button>
    </div>
    <button class="btn block" data-act="home">${icon("back")} Voltar</button>`);
}

let homeCreateOpen = false;
async function renderHome() {
  renderShell(`<div class="loading">Carregando…</div>`);
  let events = [];
  try { events = await api.listMyEvents(user.uid); } catch (e) { showError(e); }
  if (currentEventId() || !user) return;
  events.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const first = String(profile?.name || "").split(/\s+/)[0];
  const greet = `<section class="greet"><h1>Olá, ${esc(first)}</h1><p class="muted">Qual encontro vamos marcar?</p></section>`;
  const list = events.length
    ? `<div class="ev-list">${events.map(eventCard).join("")}</div>`
    : `<div class="empty card">${icon("calendar", "lg")}<p><b>Nenhum evento ainda</b></p><p class="muted">Crie um evento e mande o link no grupo. Se você recebeu um link, é só abrir.</p></div>`;
  if (!canCreate()) {
    return renderShell(`${greet}${events.length ? `<div class="section-head"><h2>Seus eventos</h2></div>${list}` : ""}
      <div class="card stack"><h3 class="card-title">${icon("link")} Abra o link do grupo</h3><p class="muted">Para marcar suas datas, toque no link do evento enviado no grupo do WhatsApp.</p></div>`);
  }
  const showForm = homeCreateOpen || !events.length;
  renderShell(`${greet}
    <div class="section-head"><h2>Seus eventos</h2>${events.length ? `<span class="count">${events.length}</span>` : ""}</div>
    ${list}
    ${showForm ? createForm() : `<button class="btn primary block" data-act="new-event">${icon("plus")} Novo evento</button>`}`);
}

function eventCard(ev) {
  const status = ev.finalDate ? `Data: ${fmtShort(ev.finalDate)}` : ev.closed ? "Encerrado" : "Votação aberta";
  return `<a class="ev-card" href="?e=${esc(ev.id)}" data-act="open" data-id="${esc(ev.id)}">
    <span class="pill glass">${status}</span>
    <span class="ev-card-body">
      <b>${esc(ev.name)}</b>
      <span>${icon("calendar")} ${fmtShort(ev.start)} a ${fmtShort(ev.end)}</span>
    </span>
    <span class="ev-card-go">${icon("chevron")}</span>
  </a>`;
}

function createForm() {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  const end = new Date(t.getFullYear(), 11, 31);
  return `<form id="f-create" class="card stack">
    <h3 class="card-title">${icon("plus")} Novo evento</h3>
    ${field("Nome do evento", "edit", `<input name="name" required maxlength="60" placeholder="Confra de fim de ano ${t.getFullYear()}">`)}
    <label class="field"><span class="field-label">Descrição (opcional)</span><textarea name="desc" rows="2" maxlength="300" placeholder="Local, ideias, valor…"></textarea></label>
    <div class="row">
      ${field("De", "calendar", `<input type="date" name="start" required value="${toISO(t)}">`)}
      ${field("Até", "calendar", `<input type="date" name="end" required value="${toISO(end)}">`)}
    </div>
    <fieldset>
      <legend class="field-label">Dias da semana possíveis</legend>
      <div class="chips">${WD_NAMES.map((n, i) => `<label class="chip"><input type="checkbox" name="wd" value="${i}" ${i === 0 || i === 6 ? "checked" : ""}><span>${n}</span></label>`).join("")}</div>
    </fieldset>
    <label class="switch"><input type="checkbox" name="public" checked><span class="track"></span> Participantes podem ver o resultado parcial</label>
    <button class="btn primary block" type="submit">Criar evento ${icon("arrow")}</button>
  </form>`;
}

function renderEvent() {
  if (!page.loaded) return;
  const ev = page.ev;
  if (!ev) {
    return renderShell(`<div class="empty card">${icon("alert", "lg")}<p><b>Evento não encontrado</b></p><p class="muted">${api.isDemo
      ? "O site está em modo demonstração, então os eventos ficam salvos só no aparelho de quem criou."
      : "Confira se o link está completo ou peça o link de novo ao organizador. O evento pode ter sido apagado."}</p>
      <button class="btn" data-act="home">Ir para o início</button></div>`);
  }
  const isAdmin = isEventAdmin(ev);
  if (isAdmin) { startAdmin(ev); migrateOldPhones(); }
  const mine = page.responses.find((r) => r.uid === user.uid);
  if (!page.draft) page.draft = { mode: mine?.mode || "can", dates: new Set(mine?.dates || []) };
  const canSee = isAdmin || ev.showResults || ev.closed;
  const tabs = [["minhas", "Minhas datas"]];
  if (canSee) tabs.push(["resultado", "Resultado"]);
  if (isAdmin) tabs.push(["admin", "Gerenciar"]);
  if (!tabs.some((t) => t[0] === page.tab)) page.tab = "minhas";
  const nDates = candidateDates(ev).length;

  const body = page.tab === "resultado" ? tabResults(ev) : page.tab === "admin" ? tabAdmin(ev) : tabMine(ev, mine);
  renderShell(`
    <section class="hero">
      <div class="hero-bar">
        <a href="${location.pathname}" class="glass-btn" data-act="home" aria-label="Voltar">${icon("back")}</a>
        ${isAdmin ? `<button class="glass-btn" data-act="tab" data-tab="admin" aria-label="Convidar o grupo">${icon("share")}</button>` : ""}
      </div>
      <div class="hero-info glass">
        <h1>${esc(ev.name)}</h1>
        ${ev.desc ? `<p class="hero-desc">${esc(ev.desc)}</p>` : ""}
        <p class="hero-meta">${icon("calendar")} ${fmtShort(ev.start)} a ${fmtShort(ev.end)}</p>
      </div>
    </section>
    <div class="stats">
      <span class="stat"><span class="stat-ic">${icon("users")}</span>${plural(page.responses.length, "resposta", "respostas")}</span>
      <span class="stat"><span class="stat-ic">${icon("calendar")}</span>${plural(nDates, "dia", "dias")}</span>
      <span class="stat"><span class="stat-ic">${icon(ev.closed ? "lock" : "unlock")}</span>${ev.closed ? "Encerrada" : "Aberta"}</span>
    </div>
    ${ev.finalDate ? `<div class="final">${icon("flag")}<div><span>Data definida</span><strong>${fmtLong(ev.finalDate)}</strong></div></div>` : ""}
    ${tabs.length > 1 ? `<nav class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${page.tab === k}" class="${page.tab === k ? "on" : ""}" data-act="tab" data-tab="${k}">${l}</button>`).join("")}</nav>` : ""}
    ${body}
    ${isAdmin ? "" : claimBox()}
  `);
}

function claimBox() {
  if (!page.claimOpen) return `<p class="claim-link"><button class="link" data-act="claim-open">${icon("key")} Sou o organizador deste evento</button></p>`;
  return `<form id="f-claim" class="card stack">
    <h3 class="card-title">${icon("key")} Entrar como organizador</h3>
    <p class="muted">Digite o código do organizador. Ele aparece na aba Gerenciar do aparelho onde o evento foi criado.</p>
    <input name="code" required maxlength="12" autocomplete="off" autocapitalize="characters" class="code-input" aria-label="Código do organizador">
    <button class="btn primary block" type="submit">Entrar ${icon("arrow")}</button>
  </form>`;
}

// Resposta antiga da mesma pessoa (mesmo telefone), feita com outro acesso.
// Só o organizador consegue ver os telefones para fazer essa ligação.
function oldOwnResponse() {
  const myPhone = normalizePhone(profile?.phone || user?.phone || "");
  if (!myPhone || myPhone === CONFIG.defaultCountryCode) return null;
  return page.responses.find((r) => {
    if (r.uid === user.uid) return false;
    const ph = r.phone || page.contacts[r.uid]?.phone;
    return ph && normalizePhone(ph) === myPhone;
  }) || null;
}

function tabMine(ev, mine) {
  const d = page.draft;
  const old = !mine && !page.dirty ? oldOwnResponse() : null;
  if (ev.closed) {
    return `<section class="stack">
      <div class="note">${icon("lock")}<p>A votação foi encerrada pelo organizador.${mine ? " Estas foram as suas respostas." : ""}</p></div>
      ${mine ? `${mySummary(ev, mine)}<div class="card">${calendar(ev, "readonly")}</div>` : ""}
    </section>`;
  }
  const valid = new Set(candidateDates(ev));
  const n = [...d.dates].filter((x) => valid.has(x)).length;
  const summary = d.mode === "can"
    ? (n ? `Você pode em <b>${plural(n, "dia", "dias")}</b>` : "Nenhum dia marcado")
    : (n ? `Você não pode em <b>${plural(n, "dia", "dias")}</b>` : "Nenhum dia marcado: você pode em todos");
  return `<section class="stack">
    ${old ? `<div class="note">${icon("info")}<div class="stack" style="gap:10px"><p>Encontramos datas que você marcou com outro acesso (${esc(old.name)}, ${plural(availability(ev, old)[old.mode === "can" ? "can" : "cannot"].length, "dia", "dias")}).</p><button class="btn primary" data-act="import-old" data-uid="${esc(old.uid)}">${icon("check")} Usar essas datas</button></div></div>` : ""}
    <div class="segmented" role="radiogroup" aria-label="Como marcar">
      <button class="seg ${d.mode === "can" ? "on can" : ""}" data-act="mode" data-mode="can" role="radio" aria-checked="${d.mode === "can"}" ${n && d.mode !== "can" ? "disabled" : ""}>${icon("calCheck")} Dias que posso</button>
      <button class="seg ${d.mode === "cannot" ? "on cannot" : ""}" data-act="mode" data-mode="cannot" role="radio" aria-checked="${d.mode === "cannot"}" ${n && d.mode !== "cannot" ? "disabled" : ""}>${icon("calX")} Dias que não posso</button>
    </div>
    <p class="hint">${d.mode === "can" ? "Toque nos dias em que você <b>pode</b> ir." : "Toque nos dias em que você <b>não pode</b> ir. Os outros contam como livres."}${n ? " Para trocar de opção, limpe a seleção primeiro." : ""}</p>
    <div class="card">${calendar(ev, "pick")}
      <div class="legend"><span><i class="lg-on ${d.mode}"></i>${d.mode === "can" ? "Posso" : "Não posso"}</span><span><i class="lg-free"></i>Em votação</span><span><i class="lg-off"></i>Fora da votação</span></div>
    </div>
    <div class="savebar">
      <span class="savebar-text">${summary}${n ? `<button class="link" data-act="clear">Limpar</button>` : ""}</span>
      <button class="btn primary" data-act="save" ${!page.dirty && mine ? "disabled" : ""}>${mine ? (page.dirty ? `Salvar ${icon("send")}` : `Salvo ${icon("check")}`) : `Salvar ${icon("send")}`}</button>
    </div>
    ${mine && !page.dirty ? mySummary(ev, mine) : ""}
  </section>`;
}

function calendar(ev, kind, heat) {
  const allowed = new Set(candidateDates(ev));
  const start = fromISO(ev.start);
  const end = fromISO(ev.end);
  const d = page.draft;
  let html = `<div class="cal">`;
  let y = start.getFullYear(), m = start.getMonth();
  while (y < end.getFullYear() || (y === end.getFullYear() && m <= end.getMonth())) {
    const first = new Date(y, m, 1);
    const days = new Date(y, m + 1, 0).getDate();
    html += `<div class="month"><h3>${cap(first.toLocaleDateString("pt-BR", { month: "long" }))} <span>${y}</span></h3><div class="grid">`;
    html += WD_SHORT.map((w) => `<div class="wd">${w}</div>`).join("");
    for (let i = 0; i < first.getDay(); i++) html += `<div></div>`;
    for (let day = 1; day <= days; day++) {
      const iso = toISO(new Date(y, m, day));
      if (!allowed.has(iso)) { html += `<div class="day off">${day}</div>`; continue; }
      if (kind === "heat") {
        const h = heat.get(iso);
        const r = h.total ? h.yes / h.total : 0;
        html += `<div class="day heat ${h.best ? "best" : ""} ${r > 0.55 ? "strong" : ""}" style="--r:${r.toFixed(2)}" title="${fmtLong(iso)}: ${h.yes} de ${h.total}"><span>${day}</span><small>${h.yes}</small></div>`;
      } else {
        const sel = d.dates.has(iso);
        const cls = sel ? (d.mode === "can" ? "sel-can" : "sel-cannot") : "";
        html += kind === "pick"
          ? `<button type="button" class="day pick ${cls}" data-act="toggle" data-date="${iso}" aria-pressed="${sel}" aria-label="${fmtLong(iso)}">${day}</button>`
          : `<div class="day ${cls}">${day}</div>`;
      }
    }
    html += `</div></div>`;
    if (m === 11) { y++; m = 0; } else m++;
  }
  return html + `</div>`;
}

function tabResults(ev) {
  const rs = page.responses;
  if (!rs.length) return `<div class="empty card">${icon("users", "lg")}<p><b>Ninguém respondeu ainda</b></p><p class="muted">Compartilhe o link no grupo.</p></div>`;
  const rank = computeRanking(ev, rs);
  if (!rank.length) return `<div class="empty card"><p>Não há datas em votação neste período.</p></div>`;
  const total = rs.length;
  const max = rank[0].yes.length;
  const best = rank.filter((r) => r.yes.length === max);
  const heat = new Map(rank.map((r) => [r.date, { yes: r.yes.length, total, best: max > 0 && r.yes.length === max }]));

  let headline;
  if (max === 0) headline = `<p>Nenhuma data funciona ainda. Peça para o grupo revisar as datas.</p>`;
  else if (best.length === 1) headline = `<p class="kicker">Melhor data até agora</p><p class="big">${fmtLong(best[0].date)}</p><p class="sub">${max === total ? "Todo mundo pode" : `${max} de ${total} pessoas podem`}</p>`;
  else headline = `<p class="kicker">Empate entre ${best.length} datas</p><p class="big-list">${best.slice(0, 6).map((b) => fmtLong(b.date)).join("<br>")}${best.length > 6 ? `<br>e mais ${best.length - 6}` : ""}</p><p class="sub">${max === total ? "Todo mundo pode em qualquer uma" : `${max} de ${total} pessoas podem em cada uma`}</p>`;

  const shown = page.showAll ? rank : rank.slice(0, 8);
  const items = shown.map((r, i) => {
    const pct = Math.round((r.yes.length / total) * 100);
    return `<li class="${r.yes.length === max && max > 0 ? "top" : ""}">
      <div class="rk-top"><span class="pos">${i + 1}</span><b>${fmtLong(r.date)}</b><span class="cnt">${r.yes.length}<small>/${total}</small></span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      ${r.no.length ? `<details><summary>Não podem (${r.no.length})</summary><p>${r.no.map(esc).join(", ")}</p></details>` : `<p class="all">${icon("check")} Todos podem</p>`}
    </li>`;
  }).join("");

  return `<section class="stack">
    <div class="highlight">${icon("trophy", "hl-ic")}<div>${headline}</div></div>
    <div class="section-head"><h2>Ranking das datas</h2></div>
    <ol class="rank">${items}</ol>
    ${rank.length > 8 ? `<button class="link center" data-act="show-all">${page.showAll ? "Mostrar menos" : `Ver todas as ${rank.length} datas`}</button>` : ""}
    <div class="section-head"><h2>Calendário</h2></div>
    <div class="card">${calendar(ev, "heat", heat)}<p class="hint">Quanto mais forte a cor, mais gente pode. O número é quantas pessoas podem no dia.</p></div>
    <div class="section-head"><h2>Quem respondeu</h2><span class="count">${total}</span></div>
    <ul class="people">${rs.slice().sort((a, b) => a.name.localeCompare(b.name)).map((r) => `<li><span class="mini-av">${esc(initials(r.name))}</span>${esc(r.name)}</li>`).join("")}</ul>
  </section>`;
}

// Datas agrupadas por mês, cada uma como uma "pílula" com dia da semana e dia.
function dateGroups(list, kind) {
  if (!list.length) return `<p class="muted">Nenhum dia</p>`;
  const byMonth = new Map();
  for (const d of list) {
    const key = d.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(d);
  }
  return [...byMonth.entries()].map(([key, ds]) => {
    const month = cap(fromISO(key + "-01").toLocaleDateString("pt-BR", { month: "long" }));
    return `<div class="dg-month"><span class="dg-label">${month}</span><div class="dg-chips">${ds.map((d) => {
      const dt = fromISO(d);
      return `<span class="dchip ${kind}"><small>${WD_NAMES[dt.getDay()]}</small>${pad(dt.getDate())}</span>`;
    }).join("")}</div></div>`;
  }).join("");
}
function availabilityBlocks(can, cannot) {
  return `<div class="avail">
    <div class="avail-col">
      <div class="avail-head y">${icon("check")}<span>Pode</span><b>${plural(can.length, "dia", "dias")}</b></div>
      ${dateGroups(can, "y")}
    </div>
    <div class="avail-col">
      <div class="avail-head n">${icon("x")}<span>Não pode</span><b>${plural(cannot.length, "dia", "dias")}</b></div>
      ${dateGroups(cannot, "n")}
    </div>
  </div>`;
}

// Resumo para o participante conferir o que marcou.
function mySummary(ev, mine) {
  const { can, cannot } = availability(ev, mine);
  return `<div class="card stack mine-summary">
    <h3 class="card-title">${icon("eye")} O que você marcou</h3>
    ${availabilityBlocks(can, cannot)}
  </div>`;
}

// Visão do organizador: quem pode e quem não pode em cada data.
function availability(ev, r) {
  const set = new Set(r.dates || []);
  const can = [], cannot = [];
  for (const d of candidateDates(ev)) {
    const ok = r.mode === "can" ? set.has(d) : !set.has(d);
    (ok ? can : cannot).push(d);
  }
  return { can, cannot };
}

function adminResponses(ev) {
  const dates = candidateDates(ev);
  const people = page.responses.slice().sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({ r, ...availability(ev, r) }));
  const wd = (d) => WD_NAMES[fromISO(d).getDay()];
  const table = `<div class="matrix-wrap"><table class="matrix">
    <thead><tr><th>Nome</th>${dates.map((d) => `<th><span>${wd(d)}</span>${fmtShort(d)}</th>`).join("")}</tr></thead>
    <tbody>${people.map(({ r, can }) => {
      const c = new Set(can);
      return `<tr><th>${esc(r.name)}</th>${dates.map((d) => c.has(d) ? `<td class="y" title="Pode">${icon("check")}</td>` : `<td class="n" title="Não pode">${icon("x")}</td>`).join("")}</tr>`;
    }).join("")}</tbody>
    <tfoot><tr><th>Podem</th>${dates.map((d) => `<td>${people.filter((p) => p.can.includes(d)).length}</td>`).join("")}</tr></tfoot>
  </table></div>`;
  const list = `<ul class="admin-people">${people.map(({ r, can, cannot }) => {
    const phone = page.contacts[r.uid]?.phone || r.phone;
    return `<li><details>
      <summary><span class="mini-av">${esc(initials(r.name))}</span><span class="ap-main"><b>${esc(r.name)}</b><span class="muted">${phone ? esc(fmtPhone(phone)) + " · " : ""}marcou os dias que ${r.mode === "can" ? "pode" : "não pode"}</span></span>${icon("chevron", "chev")}</summary>
      <div class="ap-body">
        ${availabilityBlocks(can, cannot)}
        <button class="link danger" data-act="del-resp" data-uid="${esc(r.uid)}" data-name="${esc(r.name)}">${icon("trash")} Remover resposta</button>
      </div>
    </details></li>`;
  }).join("")}</ul>`;
  return `${table}<p class="hint">Arraste a tabela para o lado para ver todas as datas. Toque no nome para ver os detalhes.</p>${list}`;
}

function shareLink(id) { return `${location.origin}${location.pathname}?e=${encodeURIComponent(id)}`; }

function tabAdmin(ev) {
  const link = shareLink(ev.id);
  const invite = `*${ev.name}*\n\nMarque os dias em que você pode (ou não pode) ir. O Bora Marcar encontra a data em que mais gente consegue:\n${link}`;
  const rank = page.responses.length ? computeRanking(ev, page.responses) : [];
  const total = page.responses.length;
  const options = (rank.length ? rank.slice(0, 15).map((r) => ({ date: r.date, label: `${fmtLong(r.date)} (${r.yes.length}/${total})` })) : candidateDates(ev).map((d) => ({ date: d, label: fmtLong(d) })));
  const finalMsg = ev.finalDate ? `*${ev.name}*\n\nData definida: *${fmtLong(ev.finalDate)}*\n${link}` : "";
  if (ev.finalDate) setTimeout(() => finalImage(ev).catch(() => {}), 0);
  return `<section class="stack">
    ${api.isDemo ? `<div class="note warn">${icon("alert")}<p>Modo demonstração: este evento existe só neste aparelho. Configure o Firebase (veja o LEIA-ME) antes de mandar o link.</p></div>` : ""}
    <div class="card stack">
      <h3 class="card-title">${icon("share")} Convidar o grupo</h3>
      <p class="muted">Envie o link no grupo do WhatsApp. Cada pessoa entra e marca os dias.</p>
      <div class="input-wrap">${icon("link")}<input readonly value="${esc(link)}" class="linkbox" aria-label="Link do evento"></div>
      <div class="row">
        <button class="btn" data-act="copy" data-text="${esc(link)}">${icon("copy")} Copiar</button>
        <a class="btn primary" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(invite)}">${icon("chat")} WhatsApp</a>
      </div>
    </div>
    <div class="card stack">
      <h3 class="card-title">${icon("key")} Código do organizador</h3>
      ${page.adminCode === "erro"
        ? `<p class="muted">O código fica disponível depois que as novas regras de segurança forem publicadas no Firebase.</p>`
        : `<p class="code-show">${page.adminCode ? esc(page.adminCode) : "········"}</p>`}
      <p class="muted">Para gerenciar em outro aparelho, abra o link do evento, toque em "Sou o organizador deste evento" e digite o código. Não compartilhe no grupo.</p>
    </div>
    <div class="card stack">
      <h3 class="card-title">${icon(ev.closed ? "lock" : "unlock")} Votação ${ev.closed ? "encerrada" : "aberta"}</h3>
      <p class="muted">${ev.closed ? "Ninguém pode alterar as datas agora." : "As pessoas podem marcar e alterar as datas."}</p>
      <button class="btn" data-act="toggle-closed">${ev.closed ? `${icon("unlock")} Reabrir votação` : `${icon("lock")} Encerrar votação`}</button>
      <label class="switch"><input type="checkbox" data-act="toggle-public" ${ev.showResults ? "checked" : ""}><span class="track"></span> Participantes veem o resultado parcial</label>
    </div>
    <div class="card stack">
      <h3 class="card-title">${icon("sliders")} Dias da semana em votação</h3>
      <p class="muted">Mudar os dias não apaga nenhuma resposta. O ranking passa a considerar só os dias marcados.</p>
      <div class="chips" id="wd-edit">${WD_NAMES.map((n, i) => `<label class="chip"><input type="checkbox" value="${i}" ${(ev.weekdays ?? [0, 1, 2, 3, 4, 5, 6]).includes(i) ? "checked" : ""}><span>${n}</span></label>`).join("")}</div>
      <button class="btn" data-act="save-wd">${icon("check")} Salvar dias</button>
    </div>
    <div class="card stack">
      <h3 class="card-title">${icon("flag")} Definir a data final</h3>
      <p class="muted">Ao confirmar, a votação é encerrada e todos veem a data escolhida.</p>
      <div class="select-wrap"><select id="final-sel" aria-label="Data final">${options.map((o) => `<option value="${o.date}" ${o.date === ev.finalDate ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>${icon("chevron", "sel-chev")}</div>
      <button class="btn primary block" data-act="set-final">Confirmar data ${icon("check")}</button>
      ${ev.finalDate ? `<button class="btn block" data-act="share-final">${icon("chat")} Avisar o grupo no WhatsApp</button>
      <p class="hint center">Envia uma imagem com a data, quantos vão e quem não pode.</p>
      <a class="link center" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(finalMsg)}">Enviar só o texto</a>
      <button class="link center" data-act="clear-final">Remover data definida</button>` : ""}
    </div>
    <div class="card stack">
      <h3 class="card-title">${icon("table")} Respostas <span class="count">${total}</span></h3>
      ${total ? adminResponses(ev) : `<p class="muted">Nenhuma resposta ainda.</p>`}
    </div>
    <div class="card stack danger-zone">
      <h3 class="card-title">${icon("trash")} Apagar evento</h3>
      <p class="muted">Apaga o evento e todas as respostas. O link deixa de funcionar.</p>
      <button class="btn danger" data-act="del-event">${icon("trash")} Apagar este evento</button>
    </div>
    ${api.isDemo ? `<div class="card stack"><h3 class="card-title">${icon("users")} Testar o cálculo</h3><p class="muted">Só no modo demonstração: adiciona respostas fictícias.</p><button class="btn" data-act="fake">${icon("plus")} Adicionar 8 participantes</button></div>` : ""}
  </section>`;
}

// ---------- ações ----------
const forms = {
  async "f-phone"(fd) {
    const raw = fd.get("phone");
    const phone = normalizePhone(raw);
    if (!validPhone(phone)) return toast("Digite o telefone com DDD, ex.: (11) 98765-4321");
    login.phoneRaw = raw;
    const r = await api.sendCode(phone);
    login.step = "code";
    login.phone = phone;
    renderLogin(currentEventId());
    if (r?.demoCode) toast(`Modo demonstração: use o código ${r.demoCode}`, 6000);
  },
  async "f-code"(fd) {
    await api.confirmCode(String(fd.get("code")).trim());
  },
  async "f-simple"(fd) {
    const name = String(fd.get("name")).trim();
    const phone = normalizePhone(fd.get("phone"));
    if (!name) return toast("Digite seu nome.");
    if (!validPhone(phone)) return toast("Digite o telefone com DDD, ex.: (11) 98765-4321");
    pendingProfile = { name, phone };
    await api.signInSimple(phone);
  },
  async "f-profile"(fd) {
    const name = String(fd.get("name")).trim();
    if (!name) return toast("Digite seu nome.");
    const p = { ...(profile || {}), name, phone: user.phone || profile?.phone || null };
    await api.saveProfile(user.uid, p);
    profile = p;
    await refreshOrganizer();
    route();
  },
  async "f-claim"(fd) {
    const code = String(fd.get("code") || "").trim().toUpperCase().replace(/\s/g, "");
    if (!code) return;
    try { await api.claimAdmin(page.eventId, user.uid, code); }
    catch (e) {
      if (e?.code === "permission-denied") return toast("Código incorreto. Confira e tente de novo.");
      throw e;
    }
    page.coAdmin = true;
    page.claimOpen = false;
    page.tab = "admin";
    renderEvent();
    toast("Pronto! Agora você gerencia este evento neste aparelho.");
  },
  async "f-create"(fd) {
    const start = fd.get("start"), end = fd.get("end");
    const weekdays = fd.getAll("wd").map(Number);
    if (!start || !end || end < start) return toast("A data final precisa ser depois da inicial.");
    if ((fromISO(end) - fromISO(start)) / 86400000 > MAX_DAYS) return toast(`O período pode ter no máximo ${MAX_DAYS} dias.`);
    if (!weekdays.length) return toast("Escolha pelo menos um dia da semana.");
    const ev = {
      name: String(fd.get("name")).trim(),
      desc: String(fd.get("desc") || "").trim(),
      start, end, weekdays,
      showResults: fd.get("public") === "on",
      closed: false,
      finalDate: null,
      adminUid: user.uid,
      adminName: profile.name,
      createdAt: Date.now(),
    };
    if (!canCreate()) return toast("Só o organizador pode criar eventos.");
    if (!candidateDates(ev).length) return toast("Nenhum dia do período cai nos dias da semana escolhidos.");
    let id;
    try { id = await api.createEvent(ev, newAdminCode()); }
    catch (e) {
      if (e?.code === "permission-denied") return toast("Não foi possível criar o evento. Cada pessoa pode criar no máximo 30 eventos.", 6000);
      throw e;
    }
    homeCreateOpen = false;
    go(id);
    page.tab = "admin";
    renderEvent();
    toast("Evento criado! Agora envie o link para o grupo.");
  },
};

app.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const h = forms[f.id];
  if (!h) return;
  const btn = f.querySelector("button[type=submit]");
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = "Aguarde…"; }
  try { await h(new FormData(f)); }
  catch (err) { showError(err); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
});

const actions = {
  home(el, e) { e.preventDefault(); go(null); },
  open(el, e) { e.preventDefault(); go(el.dataset.id); },
  account(el, e) { e.preventDefault(); renderAccount(); },
  async logout() { closeEvent(); login = { step: "phone", phone: "", phoneRaw: "" }; await api.signOut(); },
  "change-phone"() { login.step = "phone"; renderLogin(currentEventId()); },
  tab(el) { page.tab = el.dataset.tab; renderEvent(); window.scrollTo({ top: 0 }); },
  mode(el) {
    const mode = el.dataset.mode;
    if (mode === page.draft.mode) return;
    const valid = new Set(candidateDates(page.ev));
    if ([...page.draft.dates].some((x) => valid.has(x))) return toast("Para trocar, toque em \"limpar\" primeiro.");
    page.draft = { mode, dates: new Set() };
    page.dirty = true;
    renderEvent();
  },
  toggle(el) {
    const d = el.dataset.date;
    const s = page.draft.dates;
    s.has(d) ? s.delete(d) : s.add(d);
    page.dirty = true;
    const y = window.scrollY;
    renderEvent();
    window.scrollTo({ top: y });
  },
  clear() { page.draft.dates.clear(); page.dirty = true; renderEvent(); },
  "import-old"(el) {
    const old = page.responses.find((r) => r.uid === el.dataset.uid);
    if (!old) return;
    page.draft = { mode: old.mode, dates: new Set(old.dates || []) };
    page.importedFrom = old.uid;
    page.dirty = true;
    renderEvent();
    toast("Datas carregadas. Toque em Salvar para confirmar.");
  },
  async save() {
    const ev = page.ev;
    const data = {
      name: profile.name,
      mode: page.draft.mode,
      dates: [...page.draft.dates].filter((x) => candidateDates(ev).includes(x)).sort(),
    };
    page.dirty = false;
    try {
      await api.saveResponse(ev.id, user.uid, data, { name: profile.name, phone: profile.phone || user.phone || null });
      if (page.importedFrom && isEventAdmin(ev)) {
        await api.deleteResponse(ev.id, page.importedFrom).catch((e) => console.error(e));
        page.importedFrom = null;
      }
      toast("Datas salvas. Obrigado!");
      if (ev.showResults || isEventAdmin(ev)) { page.tab = "resultado"; renderEvent(); window.scrollTo({ top: 0 }); }
    } catch (e) { page.dirty = true; renderEvent(); throw e; }
  },
  theme() {
    const t = currentTheme() === "dark" ? "light" : "dark";
    applyTheme(t);
    try { localStorage.setItem("bm-theme", t); } catch {}
    app.querySelectorAll('[data-act="theme"]').forEach((b) => { b.outerHTML = themeBtn(); });
  },
  "new-event"() { homeCreateOpen = true; renderHome(); },
  "claim-open"() { page.claimOpen = true; renderEvent(); app.querySelector("#f-claim input")?.focus(); },
  "show-all"() { page.showAll = !page.showAll; renderEvent(); },
  async copy(el) {
    try { await navigator.clipboard.writeText(el.dataset.text); toast("Link copiado!"); }
    catch { const i = app.querySelector(".linkbox"); i?.select(); toast("Selecione e copie o link."); }
  },
  "toggle-closed"() { return api.updateEvent(page.ev.id, { closed: !page.ev.closed }); },
  "toggle-public"(el) { return api.updateEvent(page.ev.id, { showResults: el.checked }); },
  async "set-final"() {
    const v = app.querySelector("#final-sel")?.value;
    if (!v) return;
    await api.updateEvent(page.ev.id, { finalDate: v, closed: true });
    toast("Data definida! Avise o grupo pelo WhatsApp.");
  },
  async "save-wd"() {
    const weekdays = [...app.querySelectorAll("#wd-edit input:checked")].map((i) => Number(i.value));
    if (!weekdays.length) return toast("Escolha pelo menos um dia da semana.");
    if (!candidateDates({ ...page.ev, weekdays }).length) return toast("Nenhum dia do período cai nesses dias da semana.");
    await api.updateEvent(page.ev.id, { weekdays });
    toast("Dias atualizados. As respostas foram mantidas.");
  },
  "share-final"() { return shareFinal(page.ev); },
  "clear-final"() { return api.updateEvent(page.ev.id, { finalDate: null }); },
  async "del-event"(el) {
    if (el.dataset.confirm !== "1") { el.dataset.confirm = "1"; el.textContent = "Toque de novo para apagar de vez"; return; }
    const id = page.ev.id;
    closeEvent();
    await api.deleteEvent(id);
    toast("Evento apagado.");
    go(null);
  },
  async "del-resp"(el) {
    if (el.dataset.confirm !== "1") { el.dataset.confirm = "1"; el.textContent = "confirmar remoção?"; return; }
    await api.deleteResponse(page.ev.id, el.dataset.uid);
    toast(`Resposta de ${el.dataset.name} removida.`);
  },
  async fake() { await api.addFakeResponses(page.ev.id, candidateDates(page.ev)); toast("Participantes fictícios adicionados."); },
};

app.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || !app.contains(el)) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  try { await fn(el, e); } catch (err) { showError(err); }
});

// ---------- imagem da data final ----------
let finalImg = { key: "", blob: null, promise: null };
function finalImageData(ev) {
  const set = (r) => new Set(r.dates || []);
  const yes = [], no = [];
  for (const r of page.responses) {
    const ok = r.mode === "can" ? set(r).has(ev.finalDate) : !set(r).has(ev.finalDate);
    (ok ? yes : no).push(r.name);
  }
  const byName = (a, b) => a.localeCompare(b, "pt-BR");
  return { eventName: ev.name, desc: ev.desc || "", dateLabel: fmtLong(ev.finalDate), yes: yes.sort(byName), no: no.sort(byName), total: page.responses.length, link: shareLink(ev.id) };
}
// Gera (ou reaproveita) a imagem. Fica pronta antes do toque para o compartilhamento abrir na hora.
function finalImage(ev) {
  const d = finalImageData(ev);
  const key = JSON.stringify(d);
  if (finalImg.key === key && (finalImg.blob || finalImg.promise)) return finalImg.blob ? Promise.resolve(finalImg.blob) : finalImg.promise;
  finalImg = { key, blob: null, promise: null };
  const mine = finalImg;
  mine.promise = makeFinalImage(d).then((b) => { mine.blob = b; return b; });
  return mine.promise;
}
async function shareFinal(ev) {
  const text = `*${ev.name}*\nData definida: *${fmtLong(ev.finalDate)}*\n${shareLink(ev.id)}`;
  const blob = await finalImage(ev);
  const file = new File([blob], "bora-marcar-data.png", { type: "image/png" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
      if (err && err.name === "NotAllowedError") { toast("Imagem pronta. Toque de novo para enviar."); return; }
      throw err;
    }
  }
  // Sem compartilhamento de arquivos (ex.: computador): baixa a imagem.
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast("Imagem baixada. Envie no grupo pelo WhatsApp.", 4500);
}

// ---------- início ----------
async function boot() {
  try {
    if (CONFIG.firebase) {
      const m = await import("./firebase-backend.js");
      api = await m.createFirebaseBackend(CONFIG.firebase, CONFIG.authMode, CONFIG.appCheckSiteKey);
    } else {
      const m = await import("./demo-backend.js");
      api = m.createDemoBackend(CONFIG.authMode);
    }
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="card"><h2>Não foi possível carregar</h2><p>Verifique sua conexão e recarregue a página.</p></div>`;
    return;
  }
  api.onAuth(async (u) => {
    user = u;
    profile = null;
    if (u) {
      try {
        if (pendingProfile) {
          await api.saveProfile(u.uid, pendingProfile);
          profile = pendingProfile;
          pendingProfile = null;
        } else {
          profile = await api.getProfile(u.uid);
        }
      } catch (e) { showError(e); }
    }
    try { await refreshOrganizer(); } catch (e) { console.error(e); organizer = !(CONFIG.adminPhones || []).length; }
    route();
  });
}
boot();
