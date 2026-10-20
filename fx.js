// RECAST AI+ v0.4 — scene look: colour grades, vignette, letterbox, power effects, poster titles.

export const GRADES = {
  none: { name: 'None' },
  blockbuster: { name: 'Blockbuster (teal & orange)', contrast: 1.12, sat: 1.1, shadow: [-10, 8, 18], high: [20, 8, -12] },
  noir: { name: 'Noir', contrast: 1.35, sat: 0 },
  romance: { name: 'Warm romance', contrast: 0.95, sat: 0.95, lift: 10, shadow: [10, 4, -2], high: [16, 8, -8] },
  night: { name: 'Night city', contrast: 1.08, sat: 0.9, gain: 0.85, shadow: [-8, 0, 22], high: [-4, 4, 14] },
  comic: { name: 'Comic punch', contrast: 1.25, sat: 1.45 },
  vintage: { name: 'Vintage', contrast: 0.9, sat: 0.6, lift: 18, shadow: [12, 6, -6], high: [18, 10, -10] },
};

/** Apply a grade in place to RGBA pixel data (pure, unit-tested). amount 0..1 blends with the original. */
export function applyGrade(d, key, amount = 1) {
  const g = GRADES[key]; if (!g || key === 'none' || amount <= 0) return d;
  const c = g.contrast ?? 1, sat = g.sat ?? 1, lift = g.lift || 0, gain = g.gain ?? 1, sh = g.shadow || [0, 0, 0], hi = g.high || [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) {
    const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];
    const l = (0.299 * r0 + 0.587 * g0 + 0.114 * b0) / 255;
    let rgb = [r0, g0, b0];
    rgb = rgb.map(v => v + (0.299 * r0 + 0.587 * g0 + 0.114 * b0 - v) * (1 - sat));
    rgb = rgb.map((v, k) => ((v - 128) * c + 128) * gain + lift * (1 - l) + sh[k] * (1 - l) + hi[k] * l);
    for (let k = 0; k < 3; k++) { const v = d[i + k] + (rgb[k] - d[i + k]) * amount; d[i + k] = v < 0 ? 0 : v > 255 ? 255 : v; }
  }
  return d;
}

export function gradeCanvas(ctx, W, H, key, amount) {
  if (!key || key === 'none' || amount <= 0) return;
  const img = ctx.getImageData(0, 0, W, H); applyGrade(img.data, key, amount); ctx.putImageData(img, 0, 0);
}

export function vignette(ctx, W, H, k) {
  if (!k) return;
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${0.75 * k})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}
export function letterbox(ctx, W, H, on) {
  if (!on) return;
  const target = W / 2.39, bar = Math.max(0, (H - target) / 2);
  if (bar < 2 || H > W) { const b = H * 0.08; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, b); ctx.fillRect(0, H - b, W, b); return; }
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, bar); ctx.fillRect(0, H - bar, W, bar);
}

const rgba = (hex, a) => { const n = parseInt((hex || '#ffffff').slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
function seeded(seed) { let s = seed | 0 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

/** Draw one power effect. anchor = {p:[x,y], dir:[dx,dy]}; T = torso length in px; t = time (s) for animation. */
export function drawEffect(ctx, fx, anchor, T, W, H, t = 0) {
  const [x, y] = anchor.p, [dx, dy] = anchor.dir, col = fx.color || '#9fd8ff', k = fx.size ?? 1, pulse = 1 + 0.08 * Math.sin(t * 9);
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  const glow = (gx, gy, r, a = 1) => { const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r); g.addColorStop(0, rgba('#ffffff', 0.95 * a)); g.addColorStop(0.18, rgba(col, 0.85 * a)); g.addColorStop(1, rgba(col, 0)); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(gx, gy, r, 0, 7); ctx.fill(); };
  if (fx.type === 'glow') glow(x, y, T * 0.45 * k * pulse);
  if (fx.type === 'beam') {
    const len = Math.hypot(W, H), w = T * 0.16 * k * pulse, ex = x + dx * len, ey = y + dy * len, nx = -dy, ny = dx;
    for (const [mult, a] of [[2.6, 0.25], [1.4, 0.5], [0.45, 0.95]]) {
      const g = ctx.createLinearGradient(x + nx * w * mult, y + ny * w * mult, x - nx * w * mult, y - ny * w * mult);
      g.addColorStop(0, rgba(col, 0)); g.addColorStop(0.5, mult < 1 ? rgba('#ffffff', a) : rgba(col, a)); g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x + nx * w * mult * 0.4, y + ny * w * mult * 0.4); ctx.lineTo(ex + nx * w * mult, ey + ny * w * mult); ctx.lineTo(ex - nx * w * mult, ey - ny * w * mult); ctx.lineTo(x - nx * w * mult * 0.4, y - ny * w * mult * 0.4); ctx.closePath(); ctx.fill();
    }
    glow(x, y, T * 0.5 * k * pulse);
  }
  if (fx.type === 'lightning') {
    const rnd = seeded(Math.floor(t * 12) + 3);
    for (let b = 0; b < 3; b++) {
      ctx.strokeStyle = rgba(col, 0.9); ctx.lineWidth = Math.max(1.5, T * 0.025 * k); ctx.shadowColor = col; ctx.shadowBlur = T * 0.2;
      ctx.beginPath(); let px = x, py = y; ctx.moveTo(px, py);
      const tx = x + (rnd() - 0.5) * W * 0.5, ty = -10, steps = 12;
      for (let i = 1; i <= steps; i++) { px = x + (tx - x) * i / steps + (rnd() - 0.5) * T * 0.35; py = y + (ty - y) * i / steps; ctx.lineTo(px, py); }
      ctx.stroke();
    }
    ctx.shadowBlur = 0; glow(x, y, T * 0.5 * k * pulse);
  }
  if (fx.type === 'shock') {
    for (let i = 0; i < 3; i++) { const ph = ((t * 0.8 + i / 3) % 1), r = T * (0.4 + ph * 2.2) * k; ctx.strokeStyle = rgba(col, 0.6 * (1 - ph)); ctx.lineWidth = T * 0.05 * (1 - ph) + 1; ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.18, 0, 0, 7); ctx.stroke(); }
    const rnd = seeded(5); ctx.fillStyle = rgba(col, 0.5);
    for (let i = 0; i < 26; i++) { const a = rnd() * Math.PI, r = T * (0.3 + rnd() * 1.6) * k; ctx.beginPath(); ctx.arc(x + Math.cos(a) * r * (rnd() > 0.5 ? 1 : -1), y - Math.sin(a) * r * 0.35, T * 0.02 * (1 + rnd() * 2), 0, 7); ctx.fill(); }
  }
  if (fx.type === 'trail') {
    const g = ctx.createLinearGradient(x, y, x, Math.min(H, y + T * 3)); g.addColorStop(0, rgba(col, 0.85)); g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g; const w = T * 0.35 * k * pulse; ctx.beginPath(); ctx.moveTo(x - w, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w * 0.15, Math.min(H, y + T * 3)); ctx.lineTo(x - w * 0.15, Math.min(H, y + T * 3)); ctx.closePath(); ctx.fill();
    glow(x, y, T * 0.4 * k);
  }
  ctx.restore();
}

/** Aura: draw the character's own silhouette blurred in a colour behind it. layerCanvas holds just that character. */
export function drawAura(ctx, layerCanvas, fx, T, t = 0) {
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  ctx.shadowColor = fx.color || '#8dc6ff'; ctx.shadowBlur = T * 0.35 * (fx.size ?? 1) * (1 + 0.1 * Math.sin(t * 6));
  ctx.globalAlpha = 0.9; for (let i = 0; i < 2; i++) ctx.drawImage(layerCanvas, 0, 0);
  ctx.restore();
}

/** Movie-poster typography. text: {title, tagline, credits, date, pos:'top'|'bottom', color, font} */
export const TITLE_FONTS = { anton: '"Anton", Impact, "Arial Narrow", sans-serif', oswald: '"Oswald", "Arial Narrow", sans-serif', archivo: '"Archivo", "Helvetica Neue", Arial, sans-serif' };
export function drawPoster(ctx, W, H, text) {
  if (!text || !(text.title || text.tagline || text.credits || text.date)) return;
  const col = text.color || '#ffffff', fam = TITLE_FONTS[text.font] || TITLE_FONTS.anton, top = text.pos === 'top';
  ctx.save(); ctx.textAlign = 'center'; ctx.fillStyle = col; ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = H * 0.012;
  const fit = (s, font, maxW, size) => { let fs = size; ctx.font = font(fs); while (ctx.measureText(s).width > maxW && fs > 8) { fs *= 0.94; ctx.font = font(fs); } return fs; };
  let y = top ? H * 0.06 : H * 0.97;
  const lines = [];
  if (text.tagline) lines.push({ s: text.tagline.toUpperCase(), f: fs => `500 ${fs}px "Oswald", "Arial Narrow", sans-serif`, size: H * 0.024, ls: 0.18 });
  if (text.title) lines.push({ s: text.title.toUpperCase(), f: fs => `${text.font === 'archivo' ? '800 ' : ''}${fs}px ${fam}`, size: H * 0.11, ls: 0.02 });
  if (text.date) lines.push({ s: text.date.toUpperCase(), f: fs => `600 ${fs}px "Oswald", "Arial Narrow", sans-serif`, size: H * 0.03, ls: 0.25 });
  if (text.credits) lines.push({ s: text.credits.toUpperCase(), f: fs => `300 ${fs}px "Oswald", "Arial Narrow", sans-serif`, size: H * 0.014, ls: 0.06, credits: true });
  const ordered = top ? lines : lines.slice().reverse();
  for (const L of ordered) {
    const fs = fit(L.s, L.f, W * (L.credits ? 0.86 : 0.9), L.size);
    try { ctx.letterSpacing = `${(fs * L.ls).toFixed(1)}px`; } catch {}
    ctx.textBaseline = top ? 'top' : 'bottom';
    if (L.credits) { ctx.globalAlpha = 0.85; ctx.shadowBlur = 0; }
    ctx.fillText(L.s, W / 2, y); ctx.globalAlpha = 1; ctx.shadowBlur = H * 0.012;
    y += (top ? 1 : -1) * fs * (L.credits ? 1.4 : 1.12);
  }
  ctx.restore();
}
