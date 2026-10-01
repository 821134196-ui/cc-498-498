/* 花艺婚礼执行台 —— 原生 JS，无依赖 */
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const state = { zones: [], flowers: [], selectedZone: null };

/* ---------------- 基础工具 ---------------- */
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function money(v) {
  const n = Number(v || 0);
  return (n < 0 ? "-¥" : "¥") + Math.abs(n).toFixed(2);
}
function toast(msg, ok = true) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show " + (ok ? "ok" : "err");
  setTimeout(() => t.className = "toast", 2600);
}
async function api(path, body) {
  const opt = body ? {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : {};
  const res = await fetch(path, opt);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error.message || "请求失败");
  return data;
}
const STATUS_BADGE = {
  draft: ["gray", "草稿"], confirmed: ["leaf", "客户已确认"], superseded: ["gray", "已被新版本取代"],
  pending: ["amber", "待客户确认"], rejected: ["red", "已驳回"],
  accepted: ["leaf", "合格"], wilt: ["red", "萎蔫"], bloom: ["amber", "提前开花"], damage: ["amber", "运输折损"],
};
function badge(code) {
  const [cls, txt] = STATUS_BADGE[code] || ["gray", code];
  return `<span class="badge ${cls}">${txt}</span>`;
}
const INC_LABEL = { wilt: "萎蔫", bloom: "提前开花", damage: "运输折损", addition: "现场追加", recycle: "撤场回收", duplicate: "重复领料预警" };
const REASON_LABEL = { quota: "清单配额", substitution: "替换授权", adhoc: "临时追加" };

function fillSelect(sel, rows, { blank = "", value = "id", text = "name" } = {}) {
  sel.innerHTML = (blank ? `<option value="">${blank}</option>` : "") +
    rows.map(r => `<option value="${r[value]}">${esc(r[text])}</option>`).join("");
}

/* ---------------- 标签页 ---------------- $$("#tabs button").forEach(b => b.addEventListener("click", () => {
  $$("#tabs button").forEach(x => x.classList.remove("active"));
  $$(".page").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  $("#page-" + b.dataset.page).classList.add("active");
  renderPage(b.dataset.page);
}));

async function refreshBase() {
  const d = await api("/api/zones");
  state.zones = d.zones;
  state.flowers = d.stock;
  const f = await api("/api/flowers");
  state.flowers = f.flowers;
}

/* ================= 花材配额页 ================= */
function renderFloorplan() {
  const fp = $("#floorplan");
  fp.querySelectorAll(".zone-box").forEach(n => n.remove());
  state.zones.forEach(z => {
    const div = document.createElement("div");
    div.className = "zone-box" + (z.is_hero ? " hero" : "") +
      (state.selectedZone === z.id ? " selected" : "");
    div.style.left = z.floor_x + "%";
    div.style.top = z.floor_y + "%";
    div.style.width = z.floor_w + "%";
    div.style.height = z.floor_h + "%";
    div.innerHTML = `
      <div class="zname">${z.is_hero ? "★ " : ""}${esc(z.name)}</div>
      <div class="zmeta">${z.latest_version ? "v" + z.latest_version : "无清单"} ${badge(z.manifest_status || "draft")}</div>
      ${z.verified_at ? '<span class="check badge leaf">已核对</span>' : ""}`;
    div.onclick = () => { state.selectedZone = z.id; renderFloorplan(); renderQuotaDetail(); };
    fp.appendChild(div);
  });
}

function renderStockTable() {
  const demandMap = {}; // flower -> 已确认配额总需求（信息列）
  const rows = state.flowers.map(s => {
    const pct = s.supply ? Math.min(100, Math.round(s.available / s.supply * 100)) : 0;
    const low = s.available <= 0 ? ' class="low"' : "";
    return `<tr>
      <td>${esc(s.name)}</td>
      <td class="num">${money(s.unit_price)}/枝</td>
      <td class="num">${s.supply}</td>
      <td class="num">${s.picked}</td>
      <td class="num"><b class="${s.available <= 0 ? "price-up" : ""}">${s.available}</b></td>
      <td><div class="stockbar${low}"><i style="width:${pct}%"></i></div></td>
    </tr>`;
  }).join("");
  $("#stock-tbl").innerHTML = `<thead><tr>
    <th>花材</th><th class="num">单价</th><th class="num">质检入库</th>
    <th class="num">已领（占用）</th><th class="num">可用</th><th style="min-width:90px">余量</th>
  </tr></thead><tbody>${rows}</tbody>`;
}

async function renderQuotaDetail() {
  const zid = state.selectedZone;
  const body = $("#quota-zone-body");
  if (!zid) { body.innerHTML = '<p class="muted">请在左侧平面图选择一个区域。</p>'; return; }
  const d = await api("/api/zone?id=" + zid);
  const z = d.zone;
  const latest = d.manifests[0];
  const latestQuota = latest ? d.versions.find(v => v.manifest.id === latest.id).quota : [];
  const flowerOpts = state.flowers.map(f =>
    `<option value="${f.id}">${esc(f.name)}（${money(f.unit_price)}/枝，可用 ${f.available}）</option>`).join("");

  const editorRows = latestQuota.map(q => `
    <tr>
      <td>${esc(q.flower_name)}</td>
      <td class="num">${money(q.unit_price)}</td>
      <td><input type="number" min="0" value="${q.stems}" data-fid="${q.flower_id}" class="qty" style="width:80px"></td>
    </tr>`).join("");

  body.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <b style="font-size:16px">${z.is_hero ? "★ " : ""}${esc(z.name)}</b>
      ${z.is_hero ? '<span class="badge coral">主视觉区域</span>' : ""}
      ${z.verified_at ? '<span class="badge leaf">已现场核对</span>' : '<span class="badge gray">未核对</span>'}
    </div>
    <p class="small muted" style="margin:6px 0">最新版本：${latest ? "v" + latest.version + " " + badge(latest.status) : "尚无清单"}；客户确认始终关联具体版本号。</p>

    <details ${latest ? "" : "open"}>
      <summary class="small" style="cursor:pointer;font-weight:700;color:var(--leaf-dark)">调整配额并生成新版本</summary>
      <div class="tbl-wrap" style="margin:8px 0"><table class="tbl"><thead><tr>
        <th>花材</th><th class="num">单价</th><th>枝数</th></tr></thead>
        <tbody>${editorRows}
        <tr><td colspan="2"><select id="nv-flower">${flowerOpts}</select></td>
        <td><div style="display:flex;gap:6px"><input type="number" id="nv-stems" min="0" value="0" style="width:70px">
        <button class="btn ghost sm" id="nv-addrow">加入</button></div></td></tr>
      </tbody></table></div>
      <button class="btn coral sm" id="nv-save">另存为新版本</button>
      <span class="small muted">保存后为草稿，需客户确认；旧版本自动变为「已取代」。</span>
    </details>

    <h4 style="margin:14px 0 6px">版本与确认记录</h4>
    <div class="tbl-wrap"><table class="tbl"><thead><tr>
      <th>版本</th><th>状态</th><th>创建时间</th><th>确认时间</th><th class="num">品种数</th><th>操作</th>
    </tr></thead><tbody>
    ${d.manifests.map((m, i) => {
      const n = d.versions[i].quota.length;
      return `<tr>
        <td>v${m.version}</td><td>${badge(m.status)}</td>
        <td class="small">${esc(m.created_at)}</td>
        <td class="small">${esc(m.confirmed_at || "—")}</td>
        <td class="num">${n}</td>
        <td>${m.status === "draft" ? `<button class="btn primary sm" data-confirm="${m.version}">客户确认此版本</button>` : ""}</td>
      </tr>`;
    }).join("")}</tbody></table></div>

    <h4 style="margin:14px 0 6px">最新版花材清单与领料</h4>
    <div class="tbl-wrap"><table class="tbl"><thead><tr>
      <th>花材</th><th class="num">单价</th><th class="num">计划枝数</th><th class="num">该区域已领</th><th class="num">占用校验</th>
    </tr></thead><tbody>
    ${latestQuota.map(q => {
      const picked = d.picks_all.filter(p => p.flower_id === q.flower_id)
        .reduce((a, p) => a + p.stems, 0);
      const over = picked > q.stems;
      return `<tr><td>${esc(q.flower_name)}</td><td class="num">${money(q.unit_price)}</td>
        <td class="num">${q.stems}</td><td class="num">${picked}</td>
        <td>${over ? '<span class="badge red">超出配额</span>' : '<span class="badge leaf">正常</span>'}</td></tr>`;
    }).join("") || '<tr><td colspan="5" class="muted">暂无配额</td></tr>'}</tbody></table></div>

    <h4 style="margin:14px 0 6px">效果图</h4>
    ${d.photos.filter(p => p.kind === "reference").map(p =>
      `<img src="/${p.path}" class="thumb" style="width:200px;height:auto" title="${esc(p.label)}">`).join("") || '<span class="muted small">暂无效果图</span>'}
  `;

  // 新版本编辑器
  const extraRows = [];
  body.querySelector("#nv-addrow").onclick = () => {
    const fid = Number($("#nv-flower").value);
    const stems = Number($("#nv-stems").value);
    if (stems > 0 && !extraRows.find(r => r[0] === fid) &&
        !latestQuota.find(q => q.flower_id === fid)) {
      extraRows.push([fid, stems]);
      toast("已加入新版本清单，点击「另存为新版本」");
    }
  };
  body.querySelector("#nv-save").onclick = async () => {
    const items = $$(".qty", body).map(i => [Number(i.dataset.fid), Number(i.value) || 0])
      .filter(x => x[1] > 0);
    extraRows.forEach(r => { if (!items.find(i => i[0] === r[0])) items.push(r); });
    if (!items.length) return toast("请至少保留一个花材枝数", false);
    try {
      const r = await api("/api/manifest/create", { zone_id: zid, items, note: "页面调整生成" });
      toast("已生成 v" + r.version + "（草稿），等待客户确认");
      renderQuotaDetail();
    } catch (e) { toast(e.message, false); }
  };
  $$("[data-confirm]", body).forEach(btn => btn.onclick = async () => {
    try {
      await api("/api/manifest/confirm", { zone_id: zid, version: Number(btn.dataset.confirm) });
      toast("客户已确认 v" + btn.dataset.confirm);
      await refreshBase(); renderFloorplan(); renderQuotaDetail();
    } catch (e) { toast(e.message, false); }
  });
}

/* ================= 到货质检页 ================= */
async function renderArrivals() {
  fillSelect($("#ar-flower"), state.flowers);
  $("#ar-date").value = "2026-09-30";
  const d = await api("/api/arrivals");
  $("#arrival-tbl").innerHTML = `<thead><tr>
    <th>批次</th><th>花材</th><th class="num">到货</th><th>到货日</th><th>冷藏位</th>
    <th>质检状态</th><th class="num">可用枝数</th><th>备注/质检照</th><th>验收操作</th>
  </tr></thead><tbody>
  ${d.arrivals.map(a => {
    const qcp = d.qc_photos[a.id];
    const action = a.qc_status === "pending" ? `
      <div style="display:flex;gap:5px;flex-wrap:wrap">
        <select class="qc-status" style="width:96px">
          <option value="accepted">合格</option><option value="wilt">萎蔫</option>
          <option value="bloom">提前开花</option><option value="damage">运输折损</option>
        </select>
        <input type="number" class="qc-usable" min="0" max="${a.stems}" value="${a.stems}" style="width:64px" title="可用枝数">
        <button class="btn primary sm qc-go" data-id="${a.id}">验收</button>
      </div>` : "—";
    return `<tr>
      <td>#${a.id}</td><td>${esc(a.flower_name)}</td><td class="num">${a.stems}</td>
      <td>${esc(a.arrival_date)}</td><td>${esc(a.cold_location || "—")}</td>
      <td>${badge(a.qc_status)}</td>
      <td class="num"><b>${a.usable_stems}</b>${a.usable_stems < a.stems ? ` <span class="badge red">损${a.stems - a.usable_stems}</span>` : ""}</td>
      <td class="small">${esc(a.qc_note || "")}${qcp ? `<br><img src="/${qcp.path}" class="thumb">` : ""}</td>
      <td>${action}</td>
    </tr>`;
  }).join("")}</tbody>`;
  $$(".qc-go").forEach(btn => btn.onclick = async () => {
    const tr = btn.closest("tr");
    const status = $(".qc-status", tr).value;
    const usable = Number($(".qc-usable", tr).value);
    const note = { wilt: "到货萎蔫剔除", bloom: "部分提前开花", damage: "运输折损剔除", accepted: "质检合格" }[status];
    try {
      await api("/api/arrival/qc", { arrival_id: Number(btn.dataset.id), status, usable_stems: usable, note });
      const label = { accepted: "合格", wilt: "到货萎蔫", bloom: "提前开花", damage: "运输折损" }[status];
      toast("批次 #" + btn.dataset.id + " 验收完成：" + label);
      await refreshBase(); renderPage("arrivals");
    } catch (e) { toast(e.message, false); }
  });
}

/* ================= 区域领料页 ================= */
async function renderPicks() {
  fillSelect($("#pk-zone"), state.zones);
  fillSelect($("#pk-flower"), state.flowers);
  await syncPickRefs();
  const d = await api("/api/picks");
  const dupCrews = {};
  d.picks.forEach(p => {
    const k = p.zone_id + "-" + p.flower_id;
    (dupCrews[k] = dupCrews[k] || new Set()).add(p.crew);
  });
  $("#pick-tbl").innerHTML = `<thead><tr>
    <th>#</th><th>时间</th><th>区域</th><th>花材</th><th class="num">枝数</th><th>小组</th><th>依据</th><th>标记</th>
  </tr></thead><tbody>
  ${d.picks.map(p => {
    const k = p.zone_id + "-" + p.flower_id;
    const dup = dupCrews[k].size > 1 ? '<span class="badge amber">多组领料留痕</span>' : "";
    return `<tr><td>${p.id}</td><td class="small">${esc(p.created_at)}</td>
      <td>${esc(p.zone_name)}${state.zones.find(z => z.id === p.zone_id)?.is_hero ? ' <span class="badge coral">主视觉</span>' : ""}</td>
      <td>${esc(p.flower_name)}</td><td class="num">${p.stems}</td>
      <td>${esc(p.crew)}</td><td>${REASON_LABEL[p.reason]}</td><td>${dup}</td></tr>`;
  }).join("")}</tbody>`;
}
async function syncPickRefs() {
  const reason = $("#pk-reason").value;
  const zid = Number($("#pk-zone").value);
  const wrap = $("#pk-ref-wrap");
  if (reason === "quota") { wrap.style.display = "none"; return; }
  wrap.style.display = "";
  const sel = $("#pk-ref");
  if (reason === "substitution") {
    const d = await api("/api/substitutions");
    const rows = d.substitutions.filter(s => s.zone_id === zid && s.status === "confirmed");
    sel.innerHTML = rows.map(s => `<option value="${s.id}" data-fid="${s.substitute_id}">
      #${s.id} ${esc(s.original_name)}→${esc(s.substitute_name)} ${s.substitute_stems}枝（v${s.decided_version}）</option>`).join("")
      || '<option value="">（无已确认替换）</option>';
  } else {
    const d = await api("/api/adhocs");
    const rows = d.adhocs.filter(a => a.zone_id === zid);
    sel.innerHTML = rows.map(a => `<option value="${a.id}" data-fid="${a.flower_id}">
      #${a.id} ${esc(a.flower_name)} ${a.stems}枝（${esc(a.reason)}）</option>`).join("")
      || '<option value="">（无追加单）</option>';
  }
}

/* ================= 替换确认页 ================= */
async function renderSubstitutions() {
  fillSelect($("#sb-zone"), state.zones);
  fillSelect($("#sb-original"), state.flowers);
  fillSelect($("#sb-sub"), state.flowers);
  previewSubPrice();
  const d = await api("/api/substitutions");
  const zones = state.zones;
  $("#sub-list").innerHTML = d.substitutions.map(s => {
    const zone = zones.find(z => z.id === s.zone_id);
    const stale = s.status === "pending" && zone.latest_version != null && s.version !== zone.latest_version;
    const before = (s.photos || []).find(p => p.kind === "before");
    const after = (s.photos || []).find(p => p.kind === "after");
    return `<div class="card">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <b>提案 #${s.id} · ${esc(s.zone_name)}</b>
        ${zone.is_hero ? '<span class="badge coral">★ 主视觉 · 未确认锁定</span>' : ""}
        ${badge(s.status)}
        <span class="badge blue">基于 v${s.version}</span>
        ${s.decided_version ? `<span class="badge leaf">确认于 v${s.decided_version}</span>` : ""}
        ${stale ? '<span class="badge red">版本已过期，需重新提案</span>' : ""}
      </div>
      <div class="grid grid-2" style="gap:14px">
        <div>
          <table class="tbl"><thead><tr><th></th><th>花材</th><th class="num">枝数</th><th class="num">单价</th><th class="num">小计</th></tr></thead><tbody>
            <tr><td>原方案</td><td>${esc(s.original_name)}</td><td class="num">${s.original_stems}</td>
              <td class="num">${money(s.original_price)}</td><td class="num">${money(s.original_price * s.original_stems)}</td></tr>
            <tr><td>替代</td><td>${esc(s.substitute_name)}</td><td class="num"><span class="stems-tag">${s.substitute_stems} 枝</span></td>
              <td class="num">${money(s.substitute_price)}</td><td class="num">${money(s.substitute_price * s.substitute_stems)}</td></tr>
          </tbody></table>
          <p style="margin:8px 0">价差：<span class="price-tag ${s.price_diff > 0 ? "price-up" : "price-down"}">${money(s.price_diff)}</span>
             ｜已领替代枝数：${s.picked_stems}/${s.substitute_stems}</p>
          <div class="alert warn" style="margin:4px 0"><b>视觉差异：</b>${esc(s.visual_diff)}</div>
          ${s.decided_note ? `<p class="small muted">客户意见：${esc(s.decided_note)}</p>` : ""}
          <div style="margin-top:8px">
            ${s.status === "pending" ? `
              <button class="btn coral sm sb-decide" data-id="${s.id}" data-dec="confirmed" ${stale ? "disabled" : ""}>✔ 客户确认替换</button>
              <button class="btn ghost sm sb-decide" data-id="${s.id}" data-dec="rejected">✘ 驳回（维持原花材）</button>
              ${stale ? '<span class="small price-up">清单已更新到 v' + zone.latest_version + '，不能确认旧提案</span>' : ""}
              ${zone.is_hero ? '<span class="small muted">主视觉区域：确认前布置端无法领取替代花材。</span>' : ""}
            ` : ""}
          </div>
        </div>
        <div class="photo-pair">
          <div class="photo-side before"><img src="/${before?.path || ""}" onerror="this.style.opacity=.2">
            <div class="cap"><b>替换前</b>${esc(s.original_name)} · <span class="stems-tag">${s.original_stems}枝</span><br>
            小计 ${money(s.original_price * s.original_stems)}</div></div>
          <div class="photo-arrow">➜</div>
          <div class="photo-side after"><img src="/${after?.path || ""}" onerror="this.style.opacity=.2">
            <div class="cap"><b>替换后</b>${esc(s.substitute_name)} · <span class="stems-tag">${s.substitute_stems}枝</span><br>
            小计 ${money(s.substitute_price * s.substitute_stems)} · <span class="price-tag ${s.price_diff > 0 ? "price-up" : "price-down"}">价差 ${money(s.price_diff)}</span></div></div>
        </div>
      </div>
    </div>`;
  }).join("") || '<p class="muted">暂无替换提案。</p>';
  $$(".sb-decide").forEach(btn => btn.onclick = async () => {
    const note = prompt("客户确认 / 驳回意见（将随通知留档）：", btn.dataset.dec === "confirmed" ? "客户确认" : "") ?? "";
    try {
      await api("/api/substitution/decide", { sub_id: Number(btn.dataset.id), decision: btn.dataset.dec, note });
      toast("提案 #" + btn.dataset.id + " 已" + (btn.dataset.dec === "confirmed" ? "确认" : "驳回"));
      renderPage("substitutions");
    } catch (e) { toast(e.message, false); }
  });
}
function previewSubPrice() {
  const o = state.flowers.find(f => f.id === Number($("#sb-original").value));
  const s = state.flowers.find(f => f.id === Number($("#sb-sub").value));
  const p = $("#sb-price-preview");
  if (!o || !s || o.id === s.id) { p.textContent = ""; return; }
  const diff = s.unit_price * Number($("#sb-sstems").value || 0) - o.unit_price * Number($("#sb-ostems").value || 0);
  p.innerHTML = `预计价差 <b class="${diff > 0 ? "price-up" : "price-down"}">${money(diff)}</b>　（提交后生成待确认提案并模拟通知客户）`;
}

/* ================= 现场核对页 ================= */
async function renderVerify() {
  fillSelect($("#ph-zone"), state.zones);
  fillSelect($("#rc-zone"), state.zones);
  fillSelect($("#rc-flower"), state.flowers);
  const inz = $("#in-zone"), inf = $("#in-flower");
  inz.innerHTML = '<option value="">—</option>' + state.zones.map(z => `<option value="${z.id}">${esc(z.name)}</option>`).join("");
  inf.innerHTML = '<option value="">—</option>' + state.flowers.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join("");

  $("#verify-zones").innerHTML = state.zones.map(z => `
    <div style="display:flex;gap:10px;align-items:center;border-bottom:1px dashed var(--line);padding:9px 2px">
      <div style="flex:1"><b>${z.is_hero ? "★ " : ""}${esc(z.name)}</b>
        <span class="small muted">${z.verified_at ? `已核对 · ${esc(z.verified_at)} · ${esc(z.verifier)}` : "尚未核对"}</span></div>
      ${z.verified_at ? '<span class="badge leaf">已核对</span>' :
        `<button class="btn primary sm vf-go" data-id="${z.id}">标记核对完成</button>`}
    </div>`).join("");
  $$(".vf-go").forEach(b => b.onclick = async () => {
    const v = prompt("核对人：", "现场督导") || "现场督导";
    try { await api("/api/verify", { zone_id: Number(b.dataset.id), verifier: v }); toast("已标记核对完成"); renderPage("verify"); }
    catch (e) { toast(e.message, false); }
  });

  const ph = await api("/api/photos?kind=completion");
  $("#verify-photos").innerHTML = ph.photos.slice(0, 8).map(p => {
    const z = state.zones.find(x => x.id === p.zone_id);
    return `<div style="display:inline-block;margin:0 8px 8px 0;text-align:center">
      <img src="/${p.path}" style="width:150px;border:1px solid var(--line);border-radius:8px">
      <div class="small muted">${esc(z?.name || "")} ${esc(p.label || "")}</div></div>`;
  }).join("") || '<p class="muted small">暂无完工照片。</p>';

  const inc = await api("/api/incidents");
  $("#incident-tbl").innerHTML = `<thead><tr><th>类型</th><th>区域</th><th>花材</th><th class="num">枝数</th><th>说明</th><th>时间</th></tr></thead><tbody>` +
    inc.incidents.slice(0, 30).map(i => `<tr>
      <td>${i.kind === "duplicate" ? '<span class="badge amber">' : '<span class="badge gray">'}${INC_LABEL[i.kind] || i.kind}</span></td>
      <td>${esc(i.zone_name || "—")}</td><td>${esc(i.flower_name || "—")}</td>
      <td class="num">${i.stems}</td><td class="small">${esc(i.note)}</td><td class="small">${esc(i.created_at)}</td></tr>`).join("") +
    "</tbody>";

  const rc = await api("/api/recycles");
  $("#recycle-tbl").innerHTML = `<thead><tr><th>区域</th><th>花材</th><th class="num">回收枝数</th><th>备注</th><th>时间</th></tr></thead><tbody>` +
    rc.recycles.map(r => `<tr><td>${esc(r.zone_name)}</td><td>${esc(r.flower_name)}</td>
      <td class="num">${r.stems}</td><td class="small">${esc(r.note)}</td><td class="small">${esc(r.created_at)}</td></tr>`).join("") +
    "</tbody>";
}

/* ================= 结算页 ================= */
async function renderSettlement() {
  const d = await api("/api/settlement");
  const g = d.grand;
  $("#settle-cards").innerHTML = [
    ["清单合计", money(g.planned), ""],
    ["替换价差合计", money(g.subs_diff), g.subs_diff > 0 ? "coral" : ""],
    ["现场追加", money(g.adhoc), g.adhoc ? "coral" : ""],
    ["应收总额", money(g.total), "coral"],
    ["质检损耗/回收", g.qc_loss + " 枝 / " + g.recycled + " 枝", ""],
  ].map(([k, v, c]) => `<div class="money-card ${c}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");

  $("#settle-zones").innerHTML = d.zones.map(z => `
    <details class="zone-settle" ${z.zone.is_hero ? "open" : ""}>
      <summary>${z.zone.is_hero ? "★ " : ""}${esc(z.zone.name)}
        ${z.zone.is_hero ? '<span class="badge coral">主视觉</span>' : ""}
        ${z.version ? `<span class="badge blue">v${z.version}</span>${badge(z.manifest_status)}` : '<span class="badge gray">无清单</span>'}
        ${z.zone.verified_at ? '<span class="badge leaf">已核对</span>' : '<span class="badge gray">未核对</span>'}
        <span style="flex:1"></span><span class="price-tag">${money(z.total)}</span></summary>
      <div class="body">
        <div class="grid grid-3" style="gap:10px;margin-bottom:10px">
          <div class="money-card"><div class="k">清单金额（v${z.version ?? "—"}）</div><div class="v" style="font-size:18px">${money(z.planned)}</div></div>
          <div class="money-card ${z.subs_diff ? "coral" : ""}"><div class="k">已确认替换价差</div><div class="v" style="font-size:18px">${money(z.subs_diff)}</div></div>
          <div class="money-card ${z.adhoc_amt ? "coral" : ""}"><div class="k">现场追加</div><div class="v" style="font-size:18px">${money(z.adhoc_amt)}</div></div>
        </div>
        <div class="tbl-wrap" style="margin-bottom:10px"><table class="tbl"><thead><tr>
          <th>花材</th><th class="num">单价</th><th class="num">计划枝数</th><th class="num">金额</th></tr></thead><tbody>
          ${z.planned_rows.map(q => `<tr><td>${esc(q.flower_name)}</td><td class="num">${money(q.unit_price)}</td>
            <td class="num">${q.stems}</td><td class="num">${money(q.amount)}</td></tr>`).join("") ||
            '<tr><td colspan="4" class="muted">无</td></tr>'}</tbody></table></div>
        ${z.substitutions.length ? `<p class="small"><b>替换：</b>${z.substitutions.map(s =>
          `${esc(s.original_name)}→${esc(s.substitute_name)}（${s.substitute_stems}枝，${money(s.price_diff)}，确认于 v${s.decided_version}）`).join("；")}</p>` : ""}
        ${z.adhoc.length ? `<p class="small"><b>追加：</b>${z.adhoc.map(a =>
          `${esc(a.flower_name)} ${a.stems}枝（${esc(a.reason)}）`).join("；")}</p>` : ""}
        <p class="small muted">实际领料成本 ${money(z.picked_amt)}｜撤场回收 ${z.recycled} 枝｜本区域现场损耗 ${z.loss} 枝</p>
      </div>
    </details>`).join("");
}

/* ================= 通知（模拟适配器） ================= */
async function loadNotifications() {
  const d = await api("/api/notifications");
  $("#notif-dot").textContent = d.notifications.length;
  $("#notif-panel").innerHTML = d.notifications.map(n => `
    <div class="notif-item">
      <div class="t">${esc(n.subject)} <span class="badge ${n.to_role === "client" ? "coral" : "leaf"}">${n.to_role === "client" ? "客户" : "团队"}</span></div>
      <div class="b">${esc(n.body)}</div>
      <div class="m">${esc(n.sent_at)} · 模拟适配器（仅落库，未真实发送）</div>
    </div>`).join("") || '<p class="muted small" style="padding:8px">暂无通知</p>';
}
$("#bell").onclick = e => { e.stopPropagation(); $("#notif-panel").classList.toggle("open"); };
document.addEventListener("click", e => {
  if (!e.target.closest("#notif-panel") && !e.target.closest("#bell")) $("#notif-panel").classList.remove("open");
});

/* ---------------- 页面分发 ---------------- */
function renderPage(page) {
  ({
    quota: async () => { renderFloorplan(); renderStockTable(); if (state.selectedZone) renderQuotaDetail(); },
    arrivals: renderArrivals,
    picks: renderPicks,
    substitutions: renderSubstitutions,
    verify: renderVerify,
    settlement: renderSettlement,
  })[page]();
}

/* ---------------- 事件绑定 ---------------- */
$("#ar-receive").onclick = async () => {
  try {
    const r = await api("/api/arrival/receive", {
      flower_id: Number($("#ar-flower").value), stems: Number($("#ar-stems").value),
      arrival_date: $("#ar-date").value, cold_location: $("#ar-cold").value,
    });
    toast("已登记到货批次 #" + r.arrival_id + "，待验收");
    renderPage("arrivals");
  } catch (e) { toast(e.message, false); }
};

$("#pk-go").onclick = async () => {
  const reason = $("#pk-reason").value;
  const body = {
    zone_id: Number($("#pk-zone").value), flower_id: Number($("#pk-flower").value),
    stems: Number($("#pk-stems").value), crew: $("#pk-crew").value || "未署名小组", reason,
  };
  if (reason !== "quota") body.ref_id = Number($("#pk-ref").value);
  try {
    const r = await api("/api/pick", body);
    if (r.duplicate_warning) toast(r.duplicate_warning, false);
    else toast("领料成功");
    await refreshBase(); renderPage("picks");
  } catch (e) { toast(e.message, false); }
};
$("#pk-reason").onchange = syncPickRefs;
$("#pk-zone").onchange = syncPickRefs;
$("#pk-ref").onchange = () => {
  const opt = $("#pk-ref option:checked");
  if (opt && opt.dataset.fid) $("#pk-flower").value = opt.dataset.fid;
};

["sb-original", "sb-sub", "sb-ostems", "sb-sstems"].forEach(id =>
  $("#" + id).addEventListener("input", previewSubPrice));
$("#sb-propose").onclick = async () => {
  try {
    const r = await api("/api/substitution/propose", {
      zone_id: Number($("#sb-zone").value),
      original_id: Number($("#sb-original").value), original_stems: Number($("#sb-ostems").value),
      substitute_id: Number($("#sb-sub").value), substitute_stems: Number($("#sb-sstems").value),
      visual_diff: $("#sb-visual").value,
    });
    toast("已生成提案 #" + r.substitution_id + "，价差 " + money(r.price_diff) + "，已模拟通知客户");
    renderPage("substitutions");
  } catch (e) { toast(e.message, false); }
};

$("#ph-upload").onclick = async () => {
  const f = $("#ph-file").files[0];
  if (!f) return toast("请选择照片", false);
  const fd = new FormData();
  fd.append("kind", "completion");
  fd.append("zone_id", $("#ph-zone").value);
  fd.append("label", $("#ph-label").value);
  fd.append("file", f);
  const res = await fetch("/api/photo", { method: "POST", body: fd });
  const data = await res.json();
  if (!data.ok) return toast(data.error.message, false);
  toast("完工照片已保存到本地");
  renderPage("verify");
};

$("#in-add").onclick = async () => {
  try {
    await api("/api/incident", {
      kind: $("#in-kind").value,
      zone_id: $("#in-zone").value ? Number($("#in-zone").value) : null,
      flower_id: $("#in-flower").value ? Number($("#in-flower").value) : null,
      stems: Number($("#in-stems").value), note: $("#in-note").value,
    });
    toast("异常已记录"); renderPage("verify");
  } catch (e) { toast(e.message, false); }
};
$("#rc-add").onclick = async () => {
  try {
    await api("/api/recycle", {
      zone_id: Number($("#rc-zone").value), flower_id: Number($("#rc-flower").value),
      stems: Number($("#rc-stems").value), note: $("#rc-note").value,
    });
    toast("回收已登记"); renderPage("verify");
  } catch (e) { toast(e.message, false); }
};

/* ---------------- 启动 ---------------- */
(async function init() {
  await refreshBase();
  state.selectedZone = state.zones[0]?.id ?? null;
  renderPage("quota");
  loadNotifications();
  setInterval(loadNotifications, 15000);
})();
