'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const yuan = n => '¥' + (Math.round(n * 100) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let DATA = null;
let selArea = 'arch';

function toast(msg, type = 'info') {
  const box = $('#toast');
  const d = document.createElement('div');
  d.className = type; d.textContent = msg;
  box.appendChild(d);
  setTimeout(() => d.remove(), 4200);
}
async function api(path, body) {
  const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.detail || j.error || `请求失败 ${r.status}`;
    const e = new Error(msg); e.payload = j; throw e;
  }
  return j;
}
async function refresh() {
  DATA = await api('/api/summary');
  $('#verTag').textContent = `当前清单：${DATA.version.label}`;
  renderQuota(); renderPickup();
}

// ---------- 标签页 ----------
$$('nav button').forEach(b => b.onclick = () => {
  $$('nav button').forEach(x => x.classList.toggle('active', x === b));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + b.dataset.page));
  const f = { qc: renderQc, sub: renderSub, onsite: renderOnsite, bill: renderBill }[b.dataset.page];
  if (f) f();
});

function statusTag(s) {
  const m = {
    '合格': 'tag-ok', '部分合格': 'tag-wait', '不合格': 'tag-bad', '待检': 'tag-off',
    '已确认': 'tag-ok', '待客户确认': 'tag-wait', '已拒绝': 'tag-bad', '版本过期': 'tag-off',
  };
  return `<span class="tag ${m[s] || 'tag-off'}">${esc(s)}</span>`;
}

// ---------- 1. 配额 + 平面图 ----------
function renderFloor() {
  const svg = $('#floor');
  svg.innerHTML = DATA.areas.map(a => {
    const picked = a.items.reduce((s, i) => s + i.picked, 0);
    const quota = a.items.reduce((s, i) => s + i.quota, 0);
    const pct = quota ? Math.round(picked / quota * 100) : 0;
    return `
    <g class="zone ${a.is_hero ? 'hero' : 'normal'} ${selArea === a.id ? 'sel' : ''}" data-area="${a.id}">
      <rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" rx="14"/>
      <text x="${a.x + 16}" y="${a.y + 34}" font-size="21" font-weight="700" fill="#24352a">
        ${a.is_hero ? '★ ' : ''}${esc(a.name)}</text>
      <text x="${a.x + 16}" y="${a.y + 60}" font-size="14" fill="#5a6b5d">
        配额 ${quota} 枝 · 已领 ${picked} 枝（${pct}%）${a.is_hero ? ' · 主视觉' : ''}</text>
      <rect x="${a.x + 16}" y="${a.y + a.h - 26}" width="${a.w - 32}" height="10" rx="5" fill="#dce7de"/>
      <rect x="${a.x + 16}" y="${a.y + a.h - 26}" width="${(a.w - 32) * Math.min(pct, 100) / 100}" height="10" rx="5"
        fill="${pct >= 100 ? '#e8705c' : '#5a8f5e'}"/>
    </g>`;
  }).join('');
  $$('.zone', svg).forEach(g => g.onclick = () => { selArea = g.dataset.area; renderFloor(); renderAreaList(); });
  const a = DATA.areas.find(x => x.id === selArea);
  $('#floorHint').textContent = a ? `已选中：${a.name}${a.is_hero ? '（主视觉区域，替换需客户确认）' : ''}。${a.note || ''}` : '';
}
function renderAreaList() {
  const a = DATA.areas.find(x => x.id === selArea);
  $('#areaTitle').innerHTML = `${a.is_hero ? '<span class="tag tag-hero">★ 主视觉</span> ' : ''}${esc(a.name)} · 花材清单`;
  if (!a.items.length) { $('#areaList').innerHTML = '<p class="muted">当前版本该区域暂无清单。</p>'; return; }
  $('#areaList').innerHTML = `<table><thead><tr>
    <th>效果图</th><th>品种</th><th>颜色</th><th class="num">计划</th><th class="num">追加</th>
    <th class="num">替代</th><th class="num">配额</th><th class="num">已领</th><th>进度</th><th>缺货/替代</th>
  </tr></thead><tbody>${a.items.map(i => {
    const q = i.quota, pct = q ? Math.round(i.picked / q * 100) : 0;
    const subCell = i.sub
      ? `${i.sub.subName} ×${i.sub.shortfall} <br>${statusTag(i.sub.status)}`
      : '<span class="muted">—</span>';
    return `<tr>
      <td>${i.ref_photo ? `<img class="thumb" src="${i.ref_photo}">` : ''}</td>
      <td><b>${esc(i.flower_name)}</b></td><td>${esc(i.color)}</td>
      <td class="num">${i.stems}</td><td class="num">${i.additions || ''}</td>
      <td class="num">${i.substituteIn ? '+' + i.sub.shortfall : (i.sub && i.sub.status === '已确认' ? -i.sub.shortfall : 0)}</td>
      <td class="num"><b>${q}</b></td><td class="num">${i.picked}</td>
      <td><div class="bar"><i class="${pct >= 100 ? 'over' : pct > 70 ? 'warn' : ''}" style="width:${pct}%"></i></div><span class="muted">${pct}%</span></td>
      <td style="font-size:12px">${subCell}</td></tr>`;
  }).join('')}</tbody></table>`;
}
function renderFlowers() {
  $('#flowerTbody').innerHTML = DATA.flowers.map(f => {
    const s = f.stock;
    const need = s.planned + s.additions;
    const pct = need ? Math.min(s.accepted / need * 100, 100) : 0;
    const short = s.accepted < need;
    return `<tr>
      <td><b>${esc(f.name)}</b></td><td>${esc(f.color)}</td><td class="num">${yuan(f.unit_price)}</td>
      <td class="num">${s.planned}</td><td class="num">${s.additions || ''}</td>
      <td class="num">${s.accepted}</td><td class="num">${s.picked}</td>
      <td class="num" style="color:${s.available < 0 ? 'var(--bad)' : 'inherit'};font-weight:700">${s.available}</td>
      <td><div class="bar"><i class="${short ? 'over' : ''}" style="width:${pct}%"></i></div>
      <span class="muted">${short ? `缺口 ${need - s.accepted} 枝` : '库存满足计划'}</span></td></tr>`;
  }).join('');
}
function renderQuota() { renderFloor(); renderAreaList(); renderFlowers(); }

// ---------- 2. 质检 ----------
async function renderQc() {
  const rows = await api('/api/batches');
  $('#batchTbody').innerHTML = rows.map(b => {
    const done = b.qc_status !== '待检';
    return `<tr data-bid="${b.id}">
      <td>#${b.id}</td><td><b>${esc(b.flower_name)}</b><br><span class="muted">${esc(b.color)}</span></td>
      <td>${b.arrive_date}</td><td class="num">${b.stems}</td><td>${esc(b.cold_location || '')}</td>
      <td>${statusTag(b.qc_status)}</td>
      <td class="num">${done ? b.accepted_stems : '<input class="i-acc" type="number" min="0" value="' + b.stems + '" style="width:64px">'}</td>
      <td class="num">${done ? b.rejected_stems : '<input class="i-rej" type="number" min="0" value="0" style="width:64px">'}</td>
      <td>${done ? esc(b.reject_reason || '—') : '<select class="i-reason"><option>到货萎蔫</option><option>提前开花</option><option>运输折损</option></select>'}</td>
      <td>${done ? `<span class="muted">${b.inspected_at ? '已验收' : ''}</span>`
        : '<button class="act qc-go">提交验收</button>'}</td></tr>`;
  }).join('');
  $$('#batchTbody .qc-go').forEach(btn => btn.onclick = async () => {
    const tr = btn.closest('tr');
    const body = {
      batchId: tr.dataset.bid,
      accepted: Number(tr.querySelector('.i-acc').value),
      rejected: Number(tr.querySelector('.i-rej').value),
      reason: tr.querySelector('.i-reason').value,
    };
    try {
      const b = await api('/api/inspect', body);
      toast(`批次#${b.id} 验收完成：${b.qc_status}`, 'ok');
      renderQc();
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ---------- 3. 领料 ----------
function fillSelect(sel, items) { sel.innerHTML = items.map(o => `<option value="${o[0]}">${esc(o[1])}</option>`).join(''); }
function renderPickup() {
  fillSelect($('#pkArea'), DATA.areas.map(a => [a.id, a.name + (a.is_hero ? ' ★主视觉' : '')]));
  const fnames = Object.fromEntries(DATA.flowers.map(f => [f.id, `${f.name}（${f.color}）`]));
  fillSelect($('#pkFlower'), DATA.flowers.map(f => [f.id, fnames[f.id]]));
  $('#pkTable').innerHTML = DATA.areas.map(a => {
    if (!a.items.length) return '';
    return `<h2 style="font-size:14px;margin:12px 0 6px">${a.is_hero ? '★ ' : ''}${esc(a.name)}</h2>
    <table><thead><tr><th>花材</th><th class="num">配额</th><th class="num">已领</th><th class="num">剩余可领</th><th class="num">全场可用</th></tr></thead>
    <tbody>${a.items.map(i => `<tr ${i.picked >= i.quota ? 'style="opacity:.65"' : ''}>
      <td>${esc(i.flower_name)} ${i.sub && i.sub.status === '已确认' ? `<span class="pill">替代+${i.sub.shortfall}</span>` : ''}</td>
      <td class="num">${i.quota}</td><td class="num">${i.picked}</td>
      <td class="num"><b style="color:${i.quota - i.picked <= 0 ? 'var(--bad)' : 'var(--ok)'}">${i.quota - i.picked}</b></td>
      <td class="num">${i.available}</td></tr>`).join('')}</tbody></table>`;
  }).join('');
  renderAttempts(DATA.attempts);
}
function renderAttempts(rows) {
  $('#attemptLog').innerHTML = rows.map(r =>
    `<div class="r"><b class="kind-${esc(r.result)}">${esc(r.result)}</b>
     <span class="muted">${r.created_at.slice(11, 19)}</span>
     ${esc(r.crew)}｜${esc(r.detail || '')}</div>`).join('') || '<p class="muted">暂无记录</p>';
}
$('#pkGo').onclick = async () => {
  const body = { areaId: $('#pkArea').value, flowerId: $('#pkFlower').value,
    stems: Number($('#pkStems').value), crew: $('#pkCrew').value.trim() || '未填组' };
  try { await api('/api/pickup', body); toast('领料成功', 'ok'); }
  catch (e) { toast(`领料被拒：${e.message}`, 'err'); }
  await refresh();
};

// ---------- 4. 替换确认 ----------
async function renderSub() {
  const rows = await api('/api/substitutions');
  $('#subList').innerHTML = rows.map(s => {
    const stale = !s.is_current || s.status === '版本过期';
    const delta = s.price_delta;
    const deltaTxt = (delta > 0 ? '+' : '') + yuan(delta) + '/枝';
    const totalDelta = delta * s.shortfall_stems;
    return `<div class="card" style="margin:0 0 14px;${stale ? 'opacity:.7' : ''}">
      <div class="rowline" style="justify-content:space-between">
        <div class="rowline">
          <b>替代单 #${s.id}</b>
          ${s.is_hero ? '<span class="tag tag-hero">★ 主视觉区域</span>' : '<span class="tag tag-ok">普通区域</span>'}
          ${statusTag(s.status)}
          <span class="pill">关联版本：${esc(s.version_label)}${s.is_current ? '' : '（已被新版替换）'}</span>
        </div>
        <div><b>${esc(s.area_name)}</b> · ${esc(s.original_name)} 缺 ${s.shortfall_stems} 枝</div>
      </div>
      <div class="compare" style="margin:10px 0">
        <div class="col">${s.before_photo ? `<img src="${s.before_photo}">` : ''}
          <div class="cap"><b>替换前</b>：${esc(s.original_name)}（${esc(s.original_color)}）<br>${s.shortfall_stems} 枝 × ${yuan(s.orig_price)}</div></div>
        <div class="arrow">→</div>
        <div class="col">${s.after_photo ? `<img src="${s.after_photo}">` : ''}
          <div class="cap"><b>替换后</b>：${esc(s.substitute_name)}（${esc(s.substitute_color)}）<br>
          ${s.shortfall_stems} 枝 × ${yuan(s.sub_price)}
          枝数：<b>${s.shortfall_stems}</b>
          每枝价差：<span class="${delta < 0 ? 'diff-pos' : 'diff-neg'}">${deltaTxt}</span>
          合计 <span class="${totalDelta < 0 ? 'diff-pos' : 'diff-neg'}">${totalDelta > 0 ? '+' : ''}${yuan(totalDelta)}</span></div></div>
      </div>
      <p class="muted" style="margin:6px 0"><b>视觉差异：</b>${esc(s.visual_diff)}</p>
      ${s.status === '待客户确认' ? `<div class="rowline">
          ${stale ? '<b style="color:var(--bad)">该单基于旧版本，确认将判定为"版本过期"，需按当前版本重提。</b>' :
          '<span>客户确认（模拟通知将留痕）：</span>'}
          <button class="act coral sub-go" data-id="${s.id}" data-d="confirm" ${stale ? '' : ''}>客户确认替换</button>
          <button class="act gray sub-go" data-id="${s.id}" data-d="reject">客户拒绝</button>
        </div>` : `<p class="muted">${s.confirmer ? '确认人：' + esc(s.confirmer) : ''} ${s.decided_at ? '· ' + s.decided_at.replace('T', ' ').slice(0, 16) : ''}</p>`}
    </div>`;
  }).join('');
  $$('.sub-go').forEach(btn => btn.onclick = async () => {
    try {
      const r = await api('/api/substitution/decide',
        { id: Number(btn.dataset.id), decision: btn.dataset.d, confirmer: '客户（林小姐）' });
      toast(r.detail, r.ok ? 'ok' : 'err');
    } catch (e) { toast(e.message, 'err'); }
    renderSub(); refresh();
  });
}

// ---------- 5. 现场核对 ----------
async function renderOnsite() {
  const o = await api('/api/onsite');
  fillSelect($('#adArea'), DATA.areas.map(a => [a.id, a.name]));
  fillSelect($('#adFlower'), DATA.flowers.map(f => [f.id, f.name]));
  fillSelect($('#tdArea'), DATA.areas.map(a => [a.id, a.name]));
  fillSelect($('#tdFlower'), DATA.flowers.map(f => [f.id, f.name]));
  fillSelect($('#phArea'), DATA.areas.map(a => [a.id, a.name]));
  $('#addTbody').innerHTML = o.additions.map(x =>
    `<tr><td>${esc(x.area_name)}</td><td>${esc(x.flower_name)}</td><td class="num">${x.stems}</td><td>${esc(x.reason || '')}</td></tr>`).join('');
  $('#tdTbody').innerHTML = o.teardowns.map(x =>
    `<tr><td>${esc(x.area_name)}</td><td>${esc(x.flower_name)}</td><td class="num">${x.stems_recovered}</td><td>${esc(x.condition)}</td></tr>`).join('');
  $('#photoList').innerHTML = o.photos.map(p =>
    `<div class="rowline" style="margin-bottom:6px"><img class="thumb" src="${p.path}">
     <span class="tag ${p.kind === '完工' ? 'tag-ok' : 'tag-wait'}">${esc(p.kind)}</span>
     <b>${esc(p.area_name)}</b><span class="muted">${p.uploaded_at.replace('T', ' ').slice(0, 16)}</span></div>`).join('')
    || '<p class="muted">暂无照片</p>';
  $('#onsiteTable').innerHTML = o.areas.map(a =>
    `<h2 style="font-size:14px;margin:10px 0 6px">${a.is_hero ? '★ ' : ''}${esc(a.name)}</h2>
    <table><thead><tr><th>花材</th><th class="num">配额</th><th class="num">已领</th><th class="num">差额</th></tr></thead>
    <tbody>${a.items.map(i => {
      const diff = i.quota - i.picked;
      return `<tr><td>${esc(i.flower_name)}</td><td class="num">${i.quota}</td><td class="num">${i.picked}</td>
      <td class="num" style="color:${diff === 0 ? 'var(--ok)' : diff > 0 ? 'var(--warn)' : 'var(--bad)'};font-weight:700">
      ${diff === 0 ? '齐' : (diff > 0 ? '少领 ' + diff : '超领 ' + -diff)}</td></tr>`;
    }).join('')}</tbody></table>`).join('');
}
$('#adGo').onclick = async () => {
  try {
    await api('/api/addition', { areaId: $('#adArea').value, flowerId: $('#adFlower').value,
      stems: Number($('#adStems').value), reason: $('#adReason').value, crew: '现场组' });
    toast('追加已登记，配额与结算已更新', 'ok'); $('#adReason').value = '';
  } catch (e) { toast(e.message, 'err'); }
  await refresh(); renderOnsite();
};
$('#tdGo').onclick = async () => {
  try {
    await api('/api/teardown', { areaId: $('#tdArea').value, flowerId: $('#tdFlower').value,
      stems: Number($('#tdStems').value), condition: $('#tdCond').value });
    toast('撤场回收已登记', 'ok');
  } catch (e) { toast(e.message, 'err'); }
  renderOnsite();
};
$('#phGo').onclick = async () => {
  const file = $('#phFile').files[0];
  if (!file) return toast('请先选择照片文件', 'err');
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const isSvg = file.name.endsWith('.svg');
  try {
    await api('/api/photo', { areaId: $('#phArea').value, kind: $('#phKind').value,
      ...(isSvg ? { svg: new TextDecoder().decode(bytes) } : { imageBase64: btoa(bin), name: file.name }) });
    toast('照片已保存到本地 data/photos', 'ok');
  } catch (e) { toast(e.message, 'err'); }
  renderOnsite();
};

// ---------- 6. 结算 ----------
async function renderBill() {
  const b = await api('/api/settlement');
  $('#billStat').innerHTML = `
    <div class="s"><b>${yuan(b.plannedTotal)}</b><span>原计划金额</span></div>
    <div class="s"><b>${yuan(b.actualTotal)}</b><span>实际（计划净枝+替代+追加）</span></div>
    <div class="s"><b style="color:var(--coral)">${yuan(b.actualTotal - b.plannedTotal)}</b><span>替代+追加差额</span></div>
    <div class="s"><b style="color:var(--ok)">-${yuan(b.recoveredWorth)}</b><span>完好回收抵扣</span></div>`;
  $('#billTbody').innerHTML = b.rows.map(r => {
    const note = r.kind === '替代'
      ? `替代「${esc(r.original)}」；每枝 ${r.priceDelta > 0 ? '+' : ''}${yuan(r.priceDelta)}；${esc(r.visualDiff)}`
      : r.kind === '追加' ? '现场临时追加' : (r.replacedStems ? `其中 ${r.replacedStems} 枝走已确认替代` : '');
    return `<tr>
      <td>${r.isHero ? '★ ' : ''}${esc(r.area)}</td>
      <td><span class="tag ${r.kind === '替代' ? 'tag-wait' : r.kind === '追加' ? 'tag-hero' : 'tag-ok'}">${r.kind}</span></td>
      <td>${esc(r.flower)}</td><td>${esc(r.color)}</td>
      <td class="num">${r.stems}</td><td class="num">${yuan(r.unitPrice)}</td>
      <td class="num">${r.priceDelta ? `<span class="${r.priceDelta < 0 ? 'diff-pos' : 'diff-neg'}">${r.priceDelta > 0 ? '+' : ''}${yuan(r.priceDelta)}</span>` : '—'}</td>
      <td class="num">${yuan(r.amount)}</td><td style="font-size:12px">${note}</td></tr>`;
  }).join('');
  $('#billNet').textContent = yuan(b.netPayable);
  $('#billVer').textContent = `基于 ${b.version}`;
}

refresh().catch(e => toast('加载失败：' + e.message, 'err'));
