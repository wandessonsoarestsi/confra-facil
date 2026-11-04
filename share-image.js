// Gera a imagem (PNG) com a data definida, quantos vão e quem não pode.
const W = 1080;
const PAD = 72;
const FONT = '"Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const C = {
  bg: "#f3f6fc", card: "#ffffff", text: "#0f172a", muted: "#64748b", line: "#e2e8f0",
  can: "#16a34a", canSoft: "#dcfce7", cannot: "#dc2626", cannotSoft: "#fee2e2",
};

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
const font = (w, s) => `${w} ${s}px ${FONT}`;

// Quebra um texto em linhas que cabem na largura.
function wrap(ctx, text, max) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (ctx.measureText(t).width > max && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}
function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}

// Posições das "pílulas" de nomes, em linhas.
function layoutChips(ctx, names, max) {
  ctx.font = font(600, 30);
  const H = 60, GAP = 14, PADX = 26;
  let x = 0, y = 0;
  const chips = names.map((n) => {
    const label = fit(ctx, n, max - PADX * 2);
    const w = ctx.measureText(label).width + PADX * 2;
    if (x > 0 && x + w > max) { x = 0; y += H + GAP; }
    const c = { label, x, y, w };
    x += w + GAP;
    return c;
  });
  return { chips, height: names.length ? y + H : 0, H, PADX };
}

function drawCheck(ctx, cx, cy, s, color) {
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = s * 0.16; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath(); ctx.moveTo(cx - s * 0.3, cy); ctx.lineTo(cx - s * 0.08, cy + s * 0.22); ctx.lineTo(cx + s * 0.32, cy - s * 0.2); ctx.stroke(); ctx.restore();
}
function drawX(ctx, cx, cy, s, color) {
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = s * 0.16; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(cx - s * 0.24, cy - s * 0.24); ctx.lineTo(cx + s * 0.24, cy + s * 0.24);
  ctx.moveTo(cx + s * 0.24, cy - s * 0.24); ctx.lineTo(cx - s * 0.24, cy + s * 0.24); ctx.stroke(); ctx.restore();
}
function drawLogo(ctx, x, y, s) {
  const k = s / 40;
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, "#ffffff"); g.addColorStop(1, "#dbe7ff");
  ctx.fillStyle = g; rr(ctx, x + 3 * k, y + 6 * k, 34 * k, 31 * k, 10 * k); ctx.fill();
  ctx.fillStyle = "#cfe0ff";
  rr(ctx, x + 11 * k, y + 2.5 * k, 4 * k, 8 * k, 2 * k); ctx.fill();
  rr(ctx, x + 25 * k, y + 2.5 * k, 4 * k, 8 * k, 2 * k); ctx.fill();
  ctx.save(); ctx.strokeStyle = "#0d4fd1"; ctx.lineWidth = 3.6 * k; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath(); ctx.moveTo(x + 13 * k, y + 22.5 * k); ctx.lineTo(x + 18 * k, y + 27.5 * k); ctx.lineTo(x + 27.5 * k, y + 17.5 * k); ctx.stroke(); ctx.restore();
}

// Desenha uma seção (vão / não vão) e devolve a altura usada.
function section(ctx, y, draw, { title, count, names, color, soft, mark, empty }) {
  const inner = W - PAD * 2 - 80;
  const lay = layoutChips(ctx, names, inner);
  const head = 64;
  const body = names.length ? lay.height : 44;
  const h = 40 + head + 24 + body + 40;
  if (!draw) return h;
  ctx.fillStyle = C.card; rr(ctx, PAD, y, W - PAD * 2, h, 36); ctx.fill();
  ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.stroke();
  const x0 = PAD + 40;
  let yy = y + 40;
  ctx.fillStyle = soft; rr(ctx, x0, yy, head, head, 18); ctx.fill();
  mark(ctx, x0 + head / 2, yy + head / 2, 40, color);
  ctx.fillStyle = C.text; ctx.font = font(800, 38); ctx.textBaseline = "middle";
  ctx.fillText(title, x0 + head + 22, yy + head / 2);
  ctx.font = font(800, 40); ctx.fillStyle = color; ctx.textAlign = "right";
  ctx.fillText(String(count), W - PAD - 40, yy + head / 2); ctx.textAlign = "left";
  yy += head + 24;
  if (!names.length) {
    ctx.font = font(500, 30); ctx.fillStyle = C.muted; ctx.fillText(empty, x0, yy + 22);
  } else {
    for (const c of lay.chips) {
      ctx.fillStyle = soft; rr(ctx, x0 + c.x, yy + c.y, c.w, lay.H, lay.H / 2); ctx.fill();
      ctx.fillStyle = color; ctx.font = font(600, 30);
      ctx.fillText(c.label, x0 + c.x + lay.PADX, yy + c.y + lay.H / 2 + 1);
    }
  }
  return h;
}

function paint(ctx, d, draw) {
  ctx.textBaseline = "alphabetic";
  // Cabeçalho azul
  ctx.font = font(800, 64);
  const nameLines = wrap(ctx, d.eventName, W - PAD * 2 - 80).slice(0, 3);
  ctx.font = font(500, 32);
  const descLines = d.desc ? wrap(ctx, d.desc, W - PAD * 2 - 80).slice(0, 3) : [];
  const heroH = 64 + 64 + 40 + nameLines.length * 76 + (descLines.length ? 16 + descLines.length * 44 : 0) + 48 + 46 + 12 + 84 + 64;
  let y = 0;
  if (draw) {
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, ctx.canvas.height);
    const g = ctx.createLinearGradient(0, 0, W * 0.6, heroH);
    g.addColorStop(0, "#3a8dff"); g.addColorStop(0.55, "#0d4fd1"); g.addColorStop(1, "#072a7a");
    ctx.fillStyle = g; rr(ctx, 0, -60, W, heroH + 60, 60); ctx.fill();
    // brilho suave
    const rg = ctx.createRadialGradient(W * 0.85, 40, 10, W * 0.85, 40, 520);
    rg.addColorStop(0, "rgba(255,255,255,.22)"); rg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, heroH);
    // logo + marca
    drawLogo(ctx, PAD, 64, 64);
    ctx.fillStyle = "#fff"; ctx.font = font(800, 38); ctx.textBaseline = "middle";
    ctx.fillText("Bora Marcar", PAD + 84, 64 + 34);
    ctx.textBaseline = "alphabetic";
  }
  y = 64 + 64 + 40;
  if (draw) { ctx.fillStyle = "#fff"; ctx.font = font(800, 64); }
  for (const l of nameLines) { y += 64; if (draw) ctx.fillText(l, PAD, y); y += 12; }
  if (descLines.length) {
    y += 16;
    if (draw) { ctx.fillStyle = "rgba(255,255,255,.82)"; ctx.font = font(500, 32); }
    for (const l of descLines) { y += 36; if (draw) ctx.fillText(l, PAD, y); y += 8; }
  }
  y += 48;
  if (draw) {
    ctx.fillStyle = "rgba(255,255,255,.75)"; ctx.font = font(700, 28);
    ctx.fillText("DATA DEFINIDA", PAD, y + 28);
  }
  y += 46 + 12;
  if (draw) {
    ctx.fillStyle = "#fff"; ctx.font = font(800, 70);
    ctx.fillText(fit(ctx, d.dateLabel, W - PAD * 2), PAD, y + 66);
  }
  y = heroH + 40;

  // Destaque: quantos vão
  const statH = 150;
  if (draw) {
    ctx.fillStyle = C.card; rr(ctx, PAD, y, W - PAD * 2, statH, 36); ctx.fill();
    ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.stroke();
    ctx.textBaseline = "middle";
    ctx.fillStyle = C.can; ctx.font = font(800, 96);
    const big = String(d.yes.length);
    ctx.fillText(big, PAD + 44, y + statH / 2 + 4);
    const bw = ctx.measureText(big).width;
    ctx.fillStyle = C.text; ctx.font = font(800, 38);
    ctx.fillText(d.yes.length === 1 ? "pessoa pode ir" : "pessoas podem ir", PAD + 44 + bw + 28, y + statH / 2 - 20);
    ctx.fillStyle = C.muted; ctx.font = font(500, 30);
    ctx.fillText(`de ${d.total} ${d.total === 1 ? "resposta" : "respostas"}`, PAD + 44 + bw + 28, y + statH / 2 + 24);
    ctx.textBaseline = "alphabetic";
  }
  y += statH + 28;

  y += section(ctx, y, draw, { title: "Não podem", count: d.no.length, names: d.no, color: C.cannot, soft: C.cannotSoft, mark: drawX, empty: "Todo mundo pode nessa data!" }) + 28;
  y += section(ctx, y, draw, { title: "Podem ir", count: d.yes.length, names: d.yes, color: C.can, soft: C.canSoft, mark: drawCheck, empty: "Ninguém ainda." }) + 28;

  // Rodapé
  y += 12;
  if (draw) {
    ctx.fillStyle = C.muted; ctx.font = font(600, 28); ctx.textAlign = "center";
    ctx.fillText(fit(ctx, d.link.replace(/^https?:\/\//, ""), W - PAD * 2), W / 2, y + 28);
    ctx.textAlign = "left";
  }
  return y + 28 + 64;
}

export async function makeFinalImage(d) {
  try { await Promise.all([document.fonts.load(font(800, 64)), document.fonts.load(font(600, 30)), document.fonts.load(font(500, 30))]); } catch {}
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = 10;
  const h = paint(canvas.getContext("2d"), d, false);
  canvas.height = Math.ceil(h);
  paint(canvas.getContext("2d"), d, true);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Não foi possível gerar a imagem."))), "image/png"));
}
