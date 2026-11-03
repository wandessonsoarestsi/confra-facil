import { CONFIG } from "./config.js";

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
  return { eventId: id, ev: null, responses: [], unsub: [], tab: "minhas", draft: null, dirty: false, loaded: false, showAll: false };
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
  page.unsub.push(api.watchResponses(id, (rs) => {
    if (page.eventId !== id) return;
    page.responses = rs;
    if (!page.dirty) page.draft = null;
    renderEvent();
  }, showError));
}

// ---------- telas ----------
function header() {
  return `<header class="top">
    <a href="${location.pathname}" class="brand" data-act="home">🎉 Confra Fácil</a>
    ${user && profile?.name ? `<div class="who"><span>${esc(profile.name)}</span><button class="link" data-act="logout">Sair</button></div>` : ""}
  </header>`;
}

function renderShell(inner) {
  app.innerHTML = `${header()}<main>${inner}</main>${api?.isDemo ? `<p class="demo-banner">Modo demonstração: os dados ficam só neste navegador. Código de login: <b>123456</b>.</p>` : ""}`;
}

function renderLogin(eventId) {
  const intro = eventId
    ? "Você foi convidado para escolher a data da confra. Entre com seu telefone para marcar suas datas."
    : "Cada pessoa marca as datas em que pode (ou não pode) ir, e o sistema encontra o dia em que mais gente consegue participar.";
  let form;
  if (api.authMode === "simples") {
    form = `<form id="f-simple" class="card stack">
      <label>Seu nome<input name="name" required maxlength="40" autocomplete="name" placeholder="Como o grupo te conhece"></label>
      <label>Seu telefone (WhatsApp)<input name="phone" type="tel" inputmode="tel" required placeholder="(11) 98765-4321" autocomplete="tel"></label>
      <button class="btn primary" type="submit">Entrar</button>
    </form>`;
  } else if (login.step === "phone") {
    form = `<form id="f-phone" class="card stack">
      <label>Seu telefone<input name="phone" type="tel" inputmode="tel" required placeholder="(11) 98765-4321" autocomplete="tel" value="${esc(login.phoneRaw)}"></label>
      <p class="hint">Você vai receber um código por SMS para entrar.</p>
      <button class="btn primary" type="submit">Receber código</button>
    </form>`;
  } else {
    form = `<form id="f-code" class="card stack">
      <p>Enviamos um código por SMS para <b>${esc(fmtPhone(login.phone))}</b>.</p>
      <label>Código de 6 dígitos<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required pattern="[0-9]{6}" class="code-input"></label>
      <button class="btn primary" type="submit">Entrar</button>
      <button type="button" class="link" data-act="change-phone">Trocar número ou reenviar</button>
    </form>`;
  }
  renderShell(`<section class="hero"><h1>Qual o melhor dia pra confra?</h1><p class="lead">${intro}</p></section>${form}`);
  app.querySelector("input")?.focus();
}

function renderProfile() {
  renderShell(`<form id="f-profile" class="card stack">
    <h2>Como você quer ser chamado?</h2>
    <p class="hint">Seu nome aparece para o organizador junto com as suas datas.</p>
    <label>Seu nome<input name="name" required maxlength="40" autocomplete="name" value="${esc(profile?.name || "")}"></label>
    <button class="btn primary" type="submit">Continuar</button>
  </form>`);
  app.querySelector("input")?.focus();
}

async function renderHome() {
  renderShell(`<div class="loading">Carregando…</div>`);
  let events = [];
  try { events = await api.listMyEvents(user.uid); } catch (e) { showError(e); }
  if (currentEventId() || !user) return;
  events.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const list = events.length
    ? `<ul class="ev-list">${events.map((ev) => `<li><a href="?e=${esc(ev.id)}" data-act="open" data-id="${esc(ev.id)}">
        <b>${esc(ev.name)}</b>
        <span>${fmtShort(ev.start)} a ${fmtShort(ev.end)}${ev.finalDate ? ` · data: ${fmtShort(ev.finalDate)}` : ev.closed ? " · encerrado" : ""}</span>
      </a></li>`).join("")}</ul>`
    : `<p class="muted">Você ainda não criou nenhum evento. Se recebeu um link no grupo, é só abrir o link.</p>`;
  if (!canCreate()) {
    const mine = events.length ? `<section class="stack"><h2>Meus eventos</h2>${list}</section>` : "";
    return renderShell(`${mine}<div class="card stack"><h2>Abra o link do grupo</h2><p>Para marcar suas datas, toque no link do evento que o organizador mandou no grupo do WhatsApp.</p></div>`);
  }
  renderShell(`<section class="stack"><h2>Meus eventos</h2>${list}</section>${createForm()}`);
}

function createForm() {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  const end = new Date(t.getFullYear(), 11, 31);
  return `<form id="f-create" class="card stack">
    <h2>Criar novo evento</h2>
    <label>Nome do evento<input name="name" required maxlength="60" placeholder="Confra de fim de ano ${t.getFullYear()}"></label>
    <label>Descrição (opcional)<textarea name="desc" rows="2" maxlength="300" placeholder="Local, ideias, valor…"></textarea></label>
    <div class="row">
      <label>De<input type="date" name="start" required value="${toISO(t)}"></label>
      <label>Até<input type="date" name="end" required value="${toISO(end)}"></label>
    </div>
    <fieldset>
      <legend>Dias da semana possíveis</legend>
      <div class="chips">${WD_NAMES.map((n, i) => `<label class="chip"><input type="checkbox" name="wd" value="${i}" ${i === 0 || i === 6 ? "checked" : ""}><span>${n}</span></label>`).join("")}</div>
    </fieldset>
    <label class="check"><input type="checkbox" name="public" checked> Participantes podem ver o resultado parcial</label>
    <button class="btn primary" type="submit">Criar evento</button>
  </form>`;
}

function renderEvent() {
  if (!page.loaded) return;
  const ev = page.ev;
  if (!ev) {
    return renderShell(`<div class="card stack"><h2>Evento não encontrado</h2><p>${api.isDemo
      ? "O site ainda está em modo demonstração, então os eventos ficam salvos só no aparelho de quem criou. O organizador precisa configurar o Firebase para o link funcionar para todos."
      : "Confira se o link está completo ou peça o link de novo ao organizador. Se o evento foi apagado, peça o link novo."}</p>
      ${canCreate() ? `<button class="btn primary" data-act="home">Ir para meus eventos</button>` : ""}</div>`);
  }
  const isAdmin = ev.adminUid === user.uid;
  const mine = page.responses.find((r) => r.uid === user.uid);
  if (!page.draft) page.draft = { mode: mine?.mode || "can", dates: new Set(mine?.dates || []) };
  const canSee = isAdmin || ev.showResults || ev.closed;
  const tabs = [["minhas", "Minhas datas"]];
  if (canSee) tabs.push(["resultado", "Resultado"]);
  if (isAdmin) tabs.push(["admin", "Gerenciar"]);
  if (!tabs.some((t) => t[0] === page.tab)) page.tab = "minhas";

  const body = page.tab === "resultado" ? tabResults(ev) : page.tab === "admin" ? tabAdmin(ev) : tabMine(ev, mine);
  renderShell(`
    ${isAdmin ? `<a href="${location.pathname}" class="back" data-act="home">← Meus eventos</a>` : ""}
    <section class="ev-head">
      <h1>${esc(ev.name)}</h1>
      ${ev.desc ? `<p>${esc(ev.desc)}</p>` : ""}
      <p class="muted">Período: ${fmtShort(ev.start)} a ${fmtShort(ev.end)} · ${plural(page.responses.length, "resposta", "respostas")}${ev.closed ? " · votação encerrada" : ""}</p>
    </section>
    ${ev.finalDate ? `<div class="final"><span>Data definida 🎉</span><strong>${fmtLong(ev.finalDate)}</strong></div>` : ""}
    ${tabs.length > 1 ? `<nav class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${page.tab === k}" class="${page.tab === k ? "on" : ""}" data-act="tab" data-tab="${k}">${l}</button>`).join("")}</nav>` : ""}
    ${body}
  `);
}

function tabMine(ev, mine) {
  const d = page.draft;
  if (ev.closed) {
    return `<section class="stack">
      <div class="card"><p>A votação foi encerrada pelo organizador.${mine ? " Estas foram as suas respostas:" : ""}</p></div>
      ${mine ? `${mySummary(ev, mine)}${calendar(ev, "readonly")}` : ""}
    </section>`;
  }
  const valid = new Set(candidateDates(ev));
  const n = [...d.dates].filter((x) => valid.has(x)).length;
  const summary = d.mode === "can"
    ? (n ? `Você pode em ${plural(n, "dia", "dias")}` : "Nenhum dia marcado")
    : (n ? `Você não pode em ${plural(n, "dia", "dias")}` : "Nenhum dia marcado: você pode em todos");
  return `<section class="stack">
    <div class="mode">
      <button class="mode-btn ${d.mode === "can" ? "on can" : ""}" data-act="mode" data-mode="can" aria-pressed="${d.mode === "can"}">✅ Marcar os dias que <b>posso</b></button>
      <button class="mode-btn ${d.mode === "cannot" ? "on cannot" : ""}" data-act="mode" data-mode="cannot" aria-pressed="${d.mode === "cannot"}">🚫 Marcar os dias que <b>não posso</b></button>
    </div>
    <p class="hint">${d.mode === "can" ? "Toque nos dias em que você <b>pode</b> ir." : "Toque nos dias em que você <b>não pode</b> ir. Os outros dias contam como livres."} Dias em cinza não estão em votação.</p>
    ${calendar(ev, "pick")}
    <div class="savebar">
      <span>${summary}${n ? ` · <button class="link" data-act="clear">limpar</button>` : ""}</span>
      <button class="btn primary" data-act="save" ${!page.dirty && mine ? "disabled" : ""}>${mine ? (page.dirty ? "Salvar alterações" : "Salvo ✓") : "Salvar minhas datas"}</button>
    </div>
    ${mine && !page.dirty ? `<p class="ok">Suas datas estão salvas. Você pode alterar até o organizador encerrar a votação.</p>${mySummary(ev, mine)}` : ""}
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
    html += `<div class="month"><h3>${cap(first.toLocaleDateString("pt-BR", { month: "long", year: "numeric" }))}</h3><div class="grid">`;
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
  if (!rs.length) return `<div class="card"><p>Ninguém respondeu ainda. Compartilhe o link no grupo!</p></div>`;
  const rank = computeRanking(ev, rs);
  if (!rank.length) return `<div class="card"><p>Não há datas em votação neste período.</p></div>`;
  const total = rs.length;
  const max = rank[0].yes.length;
  const best = rank.filter((r) => r.yes.length === max);
  const heat = new Map(rank.map((r) => [r.date, { yes: r.yes.length, total, best: max > 0 && r.yes.length === max }]));

  let headline;
  if (max === 0) headline = `<p>Nenhuma data funciona para ninguém ainda. Peça para o grupo revisar as datas.</p>`;
  else if (best.length === 1) headline = `<p class="kicker">Melhor data até agora</p><p class="big">${fmtLong(best[0].date)}</p><p>${max === total ? "Todo mundo pode! 🎉" : `${max} de ${total} pessoas podem`}</p>`;
  else headline = `<p class="kicker">Empate entre ${best.length} datas</p><p class="big-list">${best.slice(0, 6).map((b) => fmtLong(b.date)).join("<br>")}${best.length > 6 ? `<br>e mais ${best.length - 6}…` : ""}</p><p>${max === total ? "Todo mundo pode em qualquer uma delas! 🎉" : `${max} de ${total} pessoas podem em cada uma`}</p>`;

  const shown = page.showAll ? rank : rank.slice(0, 8);
  const items = shown.map((r, i) => {
    const pct = Math.round((r.yes.length / total) * 100);
    return `<li class="${r.yes.length === max && max > 0 ? "top" : ""}">
      <div class="rk-top"><span class="pos">${i + 1}º</span><b>${fmtLong(r.date)}</b><span class="cnt">${r.yes.length}/${total}</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      ${r.no.length ? `<details><summary>Não podem (${r.no.length})</summary><p>${r.no.map(esc).join(", ")}</p></details>` : `<p class="all">Todos podem</p>`}
    </li>`;
  }).join("");

  return `<section class="stack">
    <div class="card highlight">${headline}</div>
    <h2>Ranking das datas</h2>
    <ol class="rank">${items}</ol>
    ${rank.length > 8 ? `<button class="link" data-act="show-all">${page.showAll ? "Mostrar menos" : `Ver todas as ${rank.length} datas`}</button>` : ""}
    <h2>Calendário</h2>
    <p class="hint">Quanto mais escuro, mais gente pode. O número é quantas pessoas podem no dia.</p>
    ${calendar(ev, "heat", heat)}
    <h2>Quem já respondeu (${total})</h2>
    <ul class="people">${rs.slice().sort((a, b) => a.name.localeCompare(b.name)).map((r) => `<li>${esc(r.name)}</li>`).join("")}</ul>
  </section>`;
}

// Resumo para o participante conferir o que marcou.
function mySummary(ev, mine) {
  const { can, cannot } = availability(ev, mine);
  return `<div class="card stack mine-summary">
    <h3>O que você marcou</h3>
    <p><span class="tag y">Pode</span> ${can.length ? can.map(fmtShort).join(", ") : "nenhum dia"}</p>
    <p><span class="tag n">Não pode</span> ${cannot.length ? cannot.map(fmtShort).join(", ") : "nenhum dia"}</p>
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
      return `<tr><th>${esc(r.name)}</th>${dates.map((d) => c.has(d) ? `<td class="y" title="Pode">✓</td>` : `<td class="n" title="Não pode">✗</td>`).join("")}</tr>`;
    }).join("")}</tbody>
    <tfoot><tr><th>Podem</th>${dates.map((d) => `<td>${people.filter((p) => p.can.includes(d)).length}</td>`).join("")}</tr></tfoot>
  </table></div>`;
  const list = `<ul class="admin-people">${people.map(({ r, can, cannot }) => `<li>
    <details>
      <summary><b>${esc(r.name)}</b><span class="muted">${r.phone ? esc(fmtPhone(r.phone)) + " · " : ""}marcou os dias que ${r.mode === "can" ? "pode" : "não pode"}</span></summary>
      <p><span class="tag y">Pode</span> ${can.length ? can.map(fmtShort).join(", ") : "nenhum dia"}</p>
      <p><span class="tag n">Não pode</span> ${cannot.length ? cannot.map(fmtShort).join(", ") : "nenhum dia"}</p>
      <button class="link danger" data-act="del-resp" data-uid="${esc(r.uid)}" data-name="${esc(r.name)}">remover resposta</button>
    </details>
  </li>`).join("")}</ul>`;
  return `<p class="hint">✓ pode · ✗ não pode. Arraste a tabela para o lado para ver todas as datas.</p>${table}<p class="hint">Toque no nome para ver as datas de cada pessoa.</p>${list}`;
}

function shareLink(id) { return `${location.origin}${location.pathname}?e=${encodeURIComponent(id)}`; }

function tabAdmin(ev) {
  const link = shareLink(ev.id);
  const invite = `🎉 *${ev.name}*\n\nMarque as datas em que você pode (ou não pode) ir à confra. O sistema escolhe o dia em que mais gente consegue ir:\n${link}`;
  const rank = page.responses.length ? computeRanking(ev, page.responses) : [];
  const total = page.responses.length;
  const options = (rank.length ? rank.slice(0, 15).map((r) => ({ date: r.date, label: `${fmtLong(r.date)} (${r.yes.length}/${total})` })) : candidateDates(ev).map((d) => ({ date: d, label: fmtLong(d) })));
  const finalMsg = ev.finalDate ? `🎉 *${ev.name}*\n\nData definida: *${fmtLong(ev.finalDate)}*!\n${link}` : "";
  return `<section class="stack">
    ${api.isDemo ? `<div class="card stack warn"><h3>O link ainda não funciona para o grupo</h3><p>O site está em modo demonstração: este evento existe só neste aparelho. Configure o Firebase (veja o LEIA-ME) antes de mandar o link.</p></div>` : ""}
    <div class="card stack">
      <h3>Convidar o grupo</h3>
      <p class="hint">Envie este link no grupo do WhatsApp. Cada pessoa entra com o telefone e marca as datas.</p>
      <input readonly value="${esc(link)}" class="linkbox" aria-label="Link do evento">
      <div class="row">
        <button class="btn" data-act="copy" data-text="${esc(link)}">Copiar link</button>
        <a class="btn wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(invite)}">Enviar no WhatsApp</a>
      </div>
    </div>
    <div class="card stack">
      <h3>Votação ${ev.closed ? "encerrada" : "aberta"}</h3>
      <p class="hint">${ev.closed ? "Ninguém pode alterar as datas agora." : "As pessoas podem marcar e alterar as datas."}</p>
      <button class="btn" data-act="toggle-closed">${ev.closed ? "Reabrir votação" : "Encerrar votação"}</button>
      <label class="check"><input type="checkbox" data-act="toggle-public" ${ev.showResults ? "checked" : ""}> Participantes veem o resultado parcial</label>
    </div>
    <div class="card stack">
      <h3>Dias da semana em votação</h3>
      <p class="hint">Mudar os dias não apaga nenhuma resposta. O ranking passa a considerar só os dias marcados aqui.</p>
      <div class="chips" id="wd-edit">${WD_NAMES.map((n, i) => `<label class="chip"><input type="checkbox" value="${i}" ${(ev.weekdays ?? [0, 1, 2, 3, 4, 5, 6]).includes(i) ? "checked" : ""}><span>${n}</span></label>`).join("")}</div>
      <button class="btn" data-act="save-wd">Salvar dias</button>
    </div>
    <div class="card stack">
      <h3>Definir a data final</h3>
      <p class="hint">Ao confirmar, a votação é encerrada e todos veem a data escolhida.</p>
      <select id="final-sel">${options.map((o) => `<option value="${o.date}" ${o.date === ev.finalDate ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>
      <button class="btn primary" data-act="set-final">Confirmar data</button>
      ${ev.finalDate ? `<a class="btn wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(finalMsg)}">Avisar o grupo no WhatsApp</a>
      <button class="link" data-act="clear-final">Remover data definida</button>` : ""}
    </div>
    <div class="card stack">
      <h3>Respostas (${total})</h3>
      ${total ? adminResponses(ev) : `<p class="muted">Nenhuma resposta ainda.</p>`}
    </div>
    <div class="card stack">
      <h3>Apagar evento</h3>
      <p class="hint">Apaga o evento e todas as respostas. O link deixa de funcionar.</p>
      <button class="btn danger" data-act="del-event">Apagar este evento</button>
    </div>
    ${api.isDemo ? `<div class="card stack"><h3>Testar o cálculo</h3><p class="hint">Só no modo demonstração: adiciona respostas fictícias.</p><button class="btn" data-act="fake">Adicionar 8 participantes fictícios</button></div>` : ""}
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
    const id = await api.createEvent(ev);
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
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Aguarde…"; }
  try { await h(new FormData(f)); }
  catch (err) { showError(err); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; } }
});

const actions = {
  home(el, e) { e.preventDefault(); go(null); },
  open(el, e) { e.preventDefault(); go(el.dataset.id); },
  async logout() { closeEvent(); login = { step: "phone", phone: "", phoneRaw: "" }; await api.signOut(); },
  "change-phone"() { login.step = "phone"; renderLogin(currentEventId()); },
  tab(el) { page.tab = el.dataset.tab; renderEvent(); window.scrollTo({ top: 0 }); },
  mode(el) {
    const mode = el.dataset.mode;
    if (mode === page.draft.mode) return;
    if (page.draft.dates.size) toast("Seleção limpa: agora marque os dias de novo.");
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
  async save() {
    const ev = page.ev;
    const data = {
      name: profile.name,
      phone: profile.phone || user.phone || null,
      mode: page.draft.mode,
      dates: [...page.draft.dates].sort(),
    };
    page.dirty = false;
    try {
      await api.saveResponse(ev.id, user.uid, data);
      toast("Datas salvas! Obrigado 🎉");
      if (ev.showResults || ev.adminUid === user.uid) { page.tab = "resultado"; renderEvent(); window.scrollTo({ top: 0 }); }
    } catch (e) { page.dirty = true; renderEvent(); throw e; }
  },
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
  "clear-final"() { return api.updateEvent(page.ev.id, { finalDate: null }); },
  async "del-event"(el) {
    if (el.dataset.confirm !== "1") { el.dataset.confirm = "1"; el.textContent = "Toque de novo para apagar de vez"; return; }
    const id = page.ev.id;
    for (const r of page.responses) await api.deleteResponse(id, r.uid);
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

// ---------- início ----------
async function boot() {
  try {
    if (CONFIG.firebase) {
      const m = await import("./firebase-backend.js");
      api = await m.createFirebaseBackend(CONFIG.firebase, CONFIG.authMode);
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
