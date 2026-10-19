// RECAST AI+ — tiny DOM toolkit.
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (['value', 'checked', 'disabled', 'selected', 'hidden', 'muted', 'controls', 'playsInline', 'min', 'max', 'step'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const $ = (sel, root = document) => root.querySelector(sel);

export function toast(msg, bad = false, ms = 3400) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, msg);
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/** In-page confirm (native confirm() is unreliable inside embedded views). */
export function confirmBox(title, body, okLabel = 'Delete', danger = true) {
  return new Promise(res => {
    const close = v => { m.remove(); res(v); };
    const m = h('div', { class: 'modal', onclick: e => e.target === m && close(false) },
      h('div', { class: 'box', role: 'dialog', 'aria-modal': 'true' },
        h('h2', null, title), body ? h('p', { class: 'muted' }, body) : null,
        h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
          h('button', { class: 'btn ghost', onclick: () => close(false) }, 'Cancel'),
          h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => close(true) }, okLabel))));
    document.body.appendChild(m);
  });
}

export function slider(label, value, { min = 0, max = 1, step = 0.01, fmt = v => (+v).toFixed(2), oninput, id } = {}) {
  const out = h('output', null, fmt(value));
  const inp = h('input', { type: 'range', min, max, step, value, id, 'aria-label': label, oninput: e => { out.textContent = fmt(e.target.value); oninput?.(+e.target.value); } });
  return h('div', { class: 'slider' }, h('span', null, label), inp, out);
}
export function check(label, checked, onchange, id) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, id, onchange: e => onchange(e.target.checked) }), h('span', null, label));
}
export function seg(options, value, onchange) {
  const wrap = h('div', { class: 'seg', role: 'group' });
  const draw = v => { wrap.replaceChildren(...options.map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(k === v), onclick: () => { draw(k); onchange(k); } }, l))); };
  draw(value);
  return wrap;
}
export function chip(text, kind = '') { return h('span', { class: 'chip ' + kind }, text); }
export function progressBar() {
  const fill = h('i'), bar = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, fill);
  bar.set = (p) => { const v = Math.max(0, Math.min(1, p)); fill.style.width = (v * 100).toFixed(1) + '%'; bar.setAttribute('aria-valuenow', Math.round(v * 100)); };
  return bar;
}
export function fileButton(label, accept, onfile, { multiple = false, cls = 'btn', capture } = {}) {
  return h('span', { class: cls + ' filebtn' }, label, h('input', { type: 'file', accept, multiple, capture, onchange: e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) onfile(multiple ? f : f[0]); } }));
}
export function timecode(frame, fps) {
  const f = Math.max(0, frame | 0), s = Math.floor(f / fps), ff = Math.round(f - s * fps);
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob), a = h('a', { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export async function shareFile(blob, name, type) {
  const file = new File([blob], name, { type });
  if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return true; }
  return false;
}
export const ICONS = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  cast: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  shirt: '<path d="M8 3l-5 3 2 5 3-1v11h8V10l3 1 2-5-5-3c-1 2-2.5 3-4 3s-3-1-4-3z"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  queue: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  pose: '<circle cx="12" cy="4" r="2"/><path d="M12 6v7M12 9l-5-3M12 9l5 3M12 13l-4 8M12 13l4 8"/>',
};
export function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = ICONS[name] || ''; s.setAttribute('aria-hidden', 'true');
  return s;
}
