/*
 * ระบบบันทึกพัสดุยาเสพติด — หน้าจอและการทำงานหลัก
 * จัดทำโดย ด่านตรวจยานพาหนะชุมพร
 *
 * ข้อมูลเก็บในเบราว์เซอร์ของเครื่องนี้ผ่าน ParcelDB (db.js)
 * แปลงข้อความผลค้นหาพัสดุอยู่ใน parser.js · เครือข่ายและกราฟอยู่ใน network.js
 */
'use strict';

(() => {
  const {
    $, $$, esc, icon, uid, debounce, rafThrottle, num, store,
    clean, lower, cleanCode, codeKey, digits, formatPhone, phoneWarning, telHref, nameKey, guessCourier,
    idCardKey, formatIdCard, idCardValid,
    parseTerms, highlight, date, time, dateTime, dayLong, dateRange, startOfDay, addDays,
    toLocalInput, fromLocalInput, fileStamp, formatBytes, download, blobToDataURL, dataURLToBlob,
  } = U;

  // ───────── ค่าตั้งต้น ─────────
  const THUMB_MAX = 400; // รูปย่อสำหรับแสดงผล (ไฟล์ต้นฉบับเก็บไว้ตามเดิม)
  const PAGE_SIZE = 60; // จำนวนแถวที่วาดต่อครั้ง
  const BACKUP_REMIND_DAYS = 7;
  const CHUNK = 6 * 1024 * 1024; // ขนาดชิ้นข้อมูลไฟล์แนบในไฟล์สำรอง
  const UNIT = 'ด่านตรวจยานพาหนะชุมพร';

  // ชนิดข้อมูลของแต่ละช่อง ใช้กำหนดวิธีเทียบคำค้น
  const FIELDS = {
    tracking: 'code',
    sender: 'text',
    receiver: 'text',
    senderPhone: 'phone',
    receiverPhone: 'phone',
    customer: 'text',
    customerPhone: 'phone',
    idCard: 'phone', // เลขบัตรประชาชนผู้ฝากส่ง (เทียบเฉพาะตัวเลข)
    senderAddress: 'text',
    receiverAddress: 'text',
    drug: 'text',
    amount: 'text',
    courier: 'text',
    status: 'text',
    productType: 'text',
    weight: 'text',
    size: 'text',
    fee: 'text',
    note: 'text',
    extraText: 'text', // ข้อมูลเพิ่มเติมจากต้นทาง (สาขาปลายทาง ยอด COD ฯลฯ)
  };
  const ALL_FIELDS = Object.keys(FIELDS);
  const TEXT_KEYS = ['tracking', 'courier', 'status', 'sender', 'senderPhone', 'senderAddress', 'receiver',
    'receiverPhone', 'receiverAddress', 'customer', 'customerPhone', 'idCard', 'productType', 'weight', 'size', 'fee',
    'drug', 'amount', 'note', 'geo', 'origin'];
  // ปุ่มเลือกช่องค้นหา → ช่องข้อมูลที่ค้น
  const CHIP_FIELDS = {
    tracking: ['tracking'],
    sender: ['sender'],
    receiver: ['receiver'],
    senderPhone: ['senderPhone'],
    receiverPhone: ['receiverPhone'],
    customer: ['customer', 'customerPhone', 'idCard'],
  };
  const CHIP_LABEL = {
    all: 'ทั้งหมด', tracking: 'เลขพัสดุ', sender: 'ผู้ส่ง', receiver: 'ผู้รับ',
    senderPhone: 'เบอร์ผู้ส่ง', receiverPhone: 'เบอร์ผู้รับ', customer: 'ลูกค้า',
  };
  const PLACEHOLDER = {
    all: 'ค้นหาเลขพัสดุ ชื่อ เบอร์โทร ที่อยู่ ลูกค้า หรือของกลาง',
    tracking: 'ค้นหาจากเลขพัสดุ',
    sender: 'ค้นหาจากชื่อผู้ส่ง',
    receiver: 'ค้นหาจากชื่อผู้รับ',
    senderPhone: 'ค้นหาจากเบอร์ผู้ส่ง',
    receiverPhone: 'ค้นหาจากเบอร์ผู้รับ',
    customer: 'ค้นหาจากชื่อ เบอร์ หรือเลขบัตรประชาชนผู้ฝากส่ง',
  };
  const ROLE_LABEL = { send: 'ผู้ส่ง', recv: 'ผู้รับ', both: 'ทั้งส่งและรับ', cust: 'ลูกค้าผู้ฝากส่ง' };
  const DRUGS = ['ยาบ้า', 'ไอซ์', 'เฮโรอีน', 'เคตามีน', 'ยาอี', 'โคเคน', 'ฝิ่น', 'กัญชา', 'อีริมิน 5'];
  const COURIERS = [
    'ไปรษณีย์ไทย', 'Flash Express', 'J&T Express', 'KEX Express', 'SPX Express', 'Lazada Express',
    'Best Express', 'Ninja Van', 'DHL eCommerce', 'Nim Express', 'Inter Express',
  ];
  const NO_TERMS = [];

  const state = {
    parcels: [], // เรียงจากวันที่ล่าสุด
    results: [],
    terms: [],
    q: '',
    field: 'all',
    range: 'all',
    from: '',
    to: '',
    drug: '',
    courier: '',
    group: null, // { index|null, label, ids: Set } เมื่อกรองตามเครือข่าย/ชุดที่นำเข้า
    sort: store.get('sort', 'new'),
    rendered: 0,
    lastDay: null,
    dayCounts: new Map(),
    nameToPhone: new Map(),
    phoneToName: new Map(),
    linkNames: store.get('linkNames', true),
    netNames: [], // ชื่อเครือข่ายที่ผู้ใช้ตั้ง
    net: null,
    netVersion: 0,
    view: 'list',
    detailId: null,
    graphShow: 'networks',
    renderedDay: startOfDay(),
  };

  // ═════════ ข้อมูลพัสดุ ═════════
  function prepare(p) {
    for (const key of TEXT_KEYS) if (typeof p[key] !== 'string') p[key] = '';
    if (!Array.isArray(p.photoIds)) p.photoIds = [];
    if (typeof p.coverId !== 'string') p.coverId = p.photoIds[0] || '';
    if (!Array.isArray(p.links)) p.links = [];
    if (!Array.isArray(p.extras)) p.extras = [];
    if (!Number.isFinite(p.createdAt)) p.createdAt = Date.now();
    if (!Number.isFinite(p.updatedAt)) p.updatedAt = p.createdAt;
    if (!Number.isFinite(p.date)) p.date = p.createdAt;
    if (!Number.isFinite(p.deliveredAt)) p.deliveredAt = null;
    const k = {};
    for (const key of ALL_FIELDS) {
      const kind = FIELDS[key];
      k[key] = kind === 'code' ? codeKey(p[key]) : kind === 'phone' ? digits(p[key]) : lower(p[key]);
    }
    k.extraText = lower(p.extras.map((e) => `${e.label} ${e.value}`).join(' '));
    // ไม่นับเป็นข้อมูลที่บันทึก (enumerable: false)
    Object.defineProperty(p, '_k', { value: k, configurable: true, writable: true, enumerable: false });
    return p;
  }

  const byDate = (a, b) => b.date - a.date || b.createdAt - a.createdAt;

  // สีป้ายสถานะ: เขียว = ส่งถึงแล้ว · เหลือง = อยู่ระหว่างดำเนินการ/ตรวจยึด · แดง = ตีกลับ/ยกเลิก
  function statusClass(status) {
    const s = String(status || '');
    if (/เซ็นรับ|ส่งมอบแล้ว|ส่งสำเร็จ|นำจ่ายสำเร็จ|delivered/i.test(s)) return 'ok';
    if (/ตีกลับ|ยกเลิก|สูญหาย|เสียหาย|return|cancel/i.test(s)) return 'danger';
    if (s) return 'warn';
    return '';
  }
  const findParcel = (id) => state.parcels.find((p) => p.id === id);

  function findDuplicate(tracking, exceptId) {
    const key = codeKey(tracking);
    if (!key) return null;
    return state.parcels.find((p) => p.id !== exceptId && p._k.tracking === key) || null;
  }

  function mergeLinks(a = [], b = []) {
    const seen = new Set();
    const out = [];
    for (const l of [...a, ...b]) {
      if (!l || !l.url || seen.has(l.url)) continue;
      seen.add(l.url);
      out.push({ label: l.label || '', url: l.url });
    }
    return out;
  }

  // ═════════ ค้นหาและกรอง ═════════
  function termHits(p, key, t) {
    const hay = p._k[key];
    if (!hay) return false;
    const kind = FIELDS[key];
    if (kind === 'phone') return t.phones.some((d) => hay.includes(d));
    if (kind === 'code') return !!t.code && hay.includes(t.code);
    return hay.includes(t.text);
  }

  const fieldsOf = (field) => (field === 'all' ? ALL_FIELDS : CHIP_FIELDS[field] || [field]);

  function matches(p, terms, field = 'all') {
    if (!terms.length) return true;
    const keys = fieldsOf(field);
    return terms.every((t) => keys.some((key) => termHits(p, key, t)));
  }

  function mergeExtras(a = [], b = []) {
    const out = a.map((e) => ({ ...e }));
    for (const e of b) {
      if (!e || !e.label || !e.value) continue;
      const ex = out.find((x) => x.label === e.label);
      if (ex) ex.value = e.value;
      else out.push({ label: e.label, value: e.value });
    }
    return out;
  }

  function rangeBounds() {
    const today = startOfDay();
    switch (state.range) {
      case 'today': return [today, addDays(today, 1)];
      case 'yesterday': return [addDays(today, -1), today];
      case '7d': return [addDays(today, -6), addDays(today, 1)];
      case '30d': return [addDays(today, -29), addDays(today, 1)];
      case '90d': return [addDays(today, -89), addDays(today, 1)];
      case 'custom': {
        let a = state.from ? fromLocalInput(state.from) : -Infinity;
        let b = state.to ? addDays(fromLocalInput(state.to), 1) : Infinity;
        if (a > b) [a, b] = [addDays(b, -1), addDays(a, 1)];
        return [a, b];
      }
      default: return [-Infinity, Infinity];
    }
  }

  function applyFilters({ keep = false } = {}) {
    state.terms = parseTerms(state.q);
    const [from, to] = rangeBounds();
    const { drug, courier, group, field, terms } = state;
    const out = state.parcels.filter((p) => p.date >= from && p.date < to
      && (!drug || clean(p.drug) === drug)
      && (!courier || clean(p.courier) === courier)
      && (!group || group.ids.has(p.id))
      && matches(p, terms, field));
    if (state.sort === 'old') out.reverse();
    state.results = out;
    state.dayCounts = new Map();
    for (const p of out) {
      const d = startOfDay(p.date);
      state.dayCounts.set(d, (state.dayCounts.get(d) || 0) + 1);
    }
    state.renderedDay = startOfDay();
    renderMeta();
    renderGroupFilter();
    renderList(keep ? Math.max(PAGE_SIZE, state.rendered) : PAGE_SIZE);
  }

  function setField(field, apply = true) {
    state.field = field;
    $$('#chips .chip').forEach((c) => {
      const on = c.dataset.field === field;
      c.setAttribute('aria-checked', String(on));
      c.tabIndex = on ? 0 : -1;
    });
    const q = $('#q');
    q.placeholder = PLACEHOLDER[field];
    q.inputMode = field === 'senderPhone' || field === 'receiverPhone' ? 'tel' : 'search';
    q.setAttribute('aria-label', field === 'all' ? 'ค้นหาพัสดุ' : `ค้นหาจาก${CHIP_LABEL[field]}`);
    if (apply) applyFilters();
  }

  function resetFilters() {
    state.q = '';
    state.range = 'all';
    state.from = '';
    state.to = '';
    state.drug = '';
    state.courier = '';
    state.group = null;
    $('#q').value = '';
    $('#qClear').hidden = true;
    $('#range').value = 'all';
    $('#from').value = '';
    $('#to').value = '';
    $('#customRange').hidden = true;
    $('#drugFilter').value = '';
    $('#courierFilter').value = '';
    setField('all');
  }

  function searchList(text) {
    state.q = text;
    $('#q').value = text;
    $('#qClear').hidden = !text;
    state.group = null;
    setField('all', false);
    go('#/list');
    applyFilters();
  }

  function setGroupFilter(index) {
    const g = state.net && state.net.networks.find((x) => x.index === index);
    if (!g) return;
    state.group = { index, label: g.label, ids: new Set(g.parcels.map((p) => p.id)) };
    applyFilters();
  }

  // หลังคำนวณเครือข่ายใหม่ หมายเลขเครือข่ายอาจเปลี่ยน → หาเครือข่ายเดิมจากพัสดุที่เคยอยู่
  function resolveGroupFilter() {
    if (!state.group || !state.group.index) return;
    const id = [...state.group.ids].find((x) => state.net.parcelGroup.has(x));
    const g = id && state.net.parcelGroup.get(id);
    state.group = g && g.isNetwork ? { index: g.index, label: g.label, ids: new Set(g.parcels.map((p) => p.id)) } : null;
  }

  // ═════════ รายการพัสดุ ═════════
  function renderMeta() {
    const total = state.parcels.length;
    $('#countList').textContent = total ? num(total) : '';
    const meta = $('#meta');
    if (!total) {
      meta.innerHTML = '';
      return;
    }
    const filtered = state.terms.length || state.range !== 'all' || state.drug || state.courier || state.group;
    meta.innerHTML = filtered
      ? `พบ <b>${num(state.results.length)}</b> รายการ จากทั้งหมด ${num(total)} <button type="button" class="link-btn" data-action="reset">ล้างตัวกรอง</button>`
      : `ทั้งหมด <b>${num(total)}</b> รายการ`;
  }

  function renderGroupFilter() {
    const box = $('#groupFilter');
    const g = state.group;
    box.hidden = !g;
    if (!g) return;
    box.innerHTML = `${icon(g.index ? 'link' : 'paste')}<span>แสดงเฉพาะ <b>${esc(g.label)}</b> · ${num(g.ids.size)} พัสดุ</span>
      ${g.index ? '<button type="button" class="link-btn" data-action="group-graph">ดูกราฟเครือข่ายนี้</button>' : ''}
      <button type="button" class="icon-btn sm" data-action="group-clear" title="ยกเลิกตัวกรอง" aria-label="ยกเลิกตัวกรอง">${icon('x')}</button>`;
  }

  function renderList(count = PAGE_SIZE) {
    $('#list').textContent = '';
    state.rendered = 0;
    state.lastDay = null;
    $('#thead').hidden = !state.results.length;
    renderEmpty();
    renderMore(count);
  }

  function renderMore(count = PAGE_SIZE) {
    const slice = state.results.slice(state.rendered, state.rendered + count);
    if (!slice.length) return;
    const frag = document.createDocumentFragment();
    const imgs = [];
    for (const p of slice) {
      const day = startOfDay(p.date);
      if (day !== state.lastDay) {
        frag.append(dayHeader(day));
        state.lastDay = day;
      }
      const row = document.createElement('article');
      row.className = 'row';
      row.tabIndex = 0;
      row.dataset.id = p.id;
      row.setAttribute('aria-label', `พัสดุ ${p.tracking}`);
      row.innerHTML = rowHTML(p);
      const img = row.querySelector('img[data-photo]');
      if (img) imgs.push(img);
      frag.append(row);
    }
    $('#list').append(frag);
    state.rendered += slice.length;
    imgs.forEach(observeThumb);
    requestAnimationFrame(checkSentinel);
  }

  function checkSentinel() {
    if (state.view !== 'list' || state.rendered >= state.results.length) return;
    if ($('#sentinel').getBoundingClientRect().top < innerHeight + 900) renderMore();
  }

  function dayHeader(day) {
    const today = startOfDay();
    const rel = day === today ? 'วันนี้' : day === addDays(today, -1) ? 'เมื่อวาน' : '';
    const h = document.createElement('h2');
    h.className = 'day';
    h.innerHTML = `${rel ? `<b>${rel}</b>` : ''}<span>${esc(dayLong(day))}</span><small>${num(state.dayCounts.get(day) || 0)} รายการ</small>`;
    return h;
  }

  function rowHTML(p) {
    const { terms, field } = state;
    const active = fieldsOf(field);
    const on = (key) => (active.includes(key) ? terms : NO_TERMS);
    const any = field === 'all' ? terms : NO_TERMS;
    const count = p.photoIds.length;
    const g = state.net && state.net.parcelGroup.get(p.id);
    const badge = g && g.isNetwork
      ? `<button type="button" class="net-badge" data-group="${g.index}" title="แสดงเฉพาะพัสดุใน${esc(g.label)}">${icon('link')}<span>${esc(g.label)}</span></button>`
      : '';
    const party = (role, label, name, phone, tName, tPhone) => `
      <div class="c-party c-${role}">
        <span class="lbl"><span class="dot ${role}"></span>${label}</span>
        ${name ? `<span class="name">${highlight(name, tName)}</span>` : phone ? '' : '<span class="name nil">ไม่ระบุ</span>'}
        ${phone ? `<span class="phone${name ? '' : ' solo'}">${highlight(phone, tPhone, 'phone')}</span>` : ''}
      </div>`;
    const evidence = p.drug || p.amount
      ? `${p.drug ? `<span class="drug">${highlight(p.drug, any)}</span>` : ''}${p.amount ? `<span class="amount">${highlight(p.amount, any)}</span>` : ''}`
      : '<span class="nil">—</span>';
    const thumb = p.coverId ? `<img alt="" data-photo="${esc(p.coverId)}">` : icon(count ? 'clip' : 'box');
    const sub = [];
    if (p.courier) sub.push(`<span class="courier">${highlight(p.courier, any)}</span>`);
    if (p.productType) sub.push(`<span class="ptype">${highlight(p.productType, any)}</span>`);
    if (p.deliveredAt) sub.push(`<span class="delivered" title="วันส่งมอบ ${esc(dateTime(p.deliveredAt))}">${icon('check')}ส่งมอบ ${esc(date(p.deliveredAt))}</span>`);
    else if (p.status) sub.push(`<span class="pill ${statusClass(p.status)}">${highlight(p.status, any)}</span>`);
    if (p.customer || p.customerPhone) {
      const who = [
        p.customer ? highlight(p.customer, on('customer')) : '',
        p.customerPhone ? `<span class="tel">${highlight(p.customerPhone, on('customerPhone'), 'phone')}</span>` : '',
      ].filter(Boolean).join(' ');
      sub.push(`<span class="cust-tag" title="ลูกค้าผู้ฝากส่ง"><span class="dot cust"></span><span>ลูกค้า ${who}</span></span>`);
    }
    // เลขบัตรประชาชนแสดงเฉพาะเมื่อตรงกับคำค้น (บอกว่าพบรายการนี้เพราะอะไร)
    if (p.idCard && terms.length) {
      const id = highlight(formatIdCard(p.idCard), on('idCard'), 'phone');
      if (id.includes('<mark>')) sub.push(`<span class="cust-tag" title="เลขบัตรประชาชนผู้ฝากส่ง">${icon('idcard')}<span>บัตร <span class="tel">${id}</span></span></span>`);
    }
    return `
      <div class="thumb">${thumb}${count > 1 || (count && !p.coverId) ? `<span class="badge">${count}</span>` : ''}</div>
      <div class="c-track">
        <div class="track">
          <span class="code">${highlight(p.tracking, on('tracking'), 'code')}</span>
          <button type="button" class="copy" data-copy="${esc(p.tracking)}" title="คัดลอกเลขพัสดุ" aria-label="คัดลอกเลขพัสดุ">${icon('copy')}</button>
        </div>
        ${sub.length || badge ? `<div class="sub">${sub.join('')}${badge}</div>` : ''}
      </div>
      ${party('send', 'ผู้ส่ง', p.sender, p.senderPhone, on('sender'), on('senderPhone'))}
      ${party('recv', 'ผู้รับ', p.receiver, p.receiverPhone, on('receiver'), on('receiverPhone'))}
      <div class="c-drug"><span class="lbl">${icon('pill')}</span>${evidence}</div>
      <time class="c-time" datetime="${new Date(p.date).toISOString()}">${time(p.date)}</time>`;
  }

  function renderEmpty() {
    const box = $('#empty');
    if (state.results.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    if (!state.parcels.length) {
      box.innerHTML = `
        <div class="empty-art">${icon('box')}</div>
        <h2>ยังไม่มีรายการพัสดุ</h2>
        <p>บันทึกพัสดุยาเสพติดที่ตรวจพบ หรือนำเข้าหลายรายการจากข้อความผลค้นหาพัสดุ / ไฟล์ Excel<br>ระบบจะเชื่อมโยงหมายเลขและเลขบัตรประชาชนที่ซ้ำกันเป็นกลุ่มเครือข่ายให้อัตโนมัติ</p>
        <div class="empty-actions">
          <button type="button" class="btn primary" data-action="add">${icon('plus')}<span>บันทึกพัสดุรายการแรก</span></button>
          <button type="button" class="btn" data-action="import">${icon('paste')}<span>นำเข้าข้อความ / Excel</span></button>
        </div>`;
      return;
    }
    const where = state.field !== 'all' ? ` ในช่อง${CHIP_LABEL[state.field]}` : '';
    box.innerHTML = `
      <div class="empty-art">${icon('search')}</div>
      <h2>ไม่พบรายการที่ค้นหา</h2>
      <p>${state.q ? `ไม่มีรายการที่ตรงกับ “${esc(state.q)}”${where}` : 'ไม่มีรายการตามตัวกรองที่เลือก'}</p>
      <button type="button" class="btn" data-action="reset">ล้างการค้นหาและตัวกรอง</button>`;
  }

  // ── ตัวเลือกกรอง/รายการแนะนำ ที่สร้างจากข้อมูลจริง ──
  function countValues(values) {
    const m = new Map();
    for (const v of values) if (v) m.set(v, (m.get(v) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'th'));
  }

  function fillSelect(sel, allLabel, entries, value) {
    sel.innerHTML = `<option value="">${esc(allLabel)}</option>${entries
      .map(([v, n]) => `<option value="${esc(v)}">${esc(v)} (${num(n)})</option>`).join('')}`;
    sel.value = entries.some(([v]) => v === value) ? value : '';
  }

  function rebuildOptions() {
    const drugs = countValues(state.parcels.map((p) => clean(p.drug)));
    const couriers = countValues(state.parcels.map((p) => clean(p.courier)));
    $('#productList').innerHTML = countValues(state.parcels.map((p) => clean(p.productType)))
      .map(([v]) => `<option value="${esc(v)}"></option>`).join('');
    if (state.drug && !drugs.some(([v]) => v === state.drug)) state.drug = '';
    if (state.courier && !couriers.some(([v]) => v === state.courier)) state.courier = '';
    fillSelect($('#drugFilter'), 'ของกลางทุกชนิด', drugs, state.drug);
    fillSelect($('#courierFilter'), 'ขนส่งทุกบริษัท', couriers, state.courier);
    $('#drugFilterWrap').hidden = !drugs.length;
    $('#courierFilterWrap').hidden = !couriers.length;
    const options = (entries, base) => [...new Set([...entries.map(([v]) => v), ...base])]
      .map((v) => `<option value="${esc(v)}"></option>`).join('');
    $('#drugList').innerHTML = options(drugs, DRUGS);
    $('#courierList').innerHTML = options(couriers, COURIERS);
  }

  // ชื่อ ↔ เบอร์ ที่เคยบันทึก (ข้อมูลล่าสุดทับข้อมูลเก่า) สำหรับเติมอัตโนมัติ
  function rebuildPeople() {
    const n2p = new Map();
    const p2n = new Map();
    for (let i = state.parcels.length - 1; i >= 0; i--) {
      const p = state.parcels[i];
      for (const [name, phone] of [[p.sender, p.senderPhone], [p.receiver, p.receiverPhone], [p.customer, p.customerPhone]]) {
        if (name) n2p.set(name, phone || n2p.get(name) || '');
        if (name && phone) p2n.set(digits(phone), name);
      }
    }
    state.nameToPhone = n2p;
    state.phoneToName = p2n;
    $('#peopleList').innerHTML = [...n2p.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'th'))
      .map(([name, phone]) => `<option value="${esc(name)}"${phone ? ` label="${esc(phone)}"` : ''}></option>`)
      .join('');
  }

  // ═════════ ไฟล์แนบ: ข้อมูลย่อและรูปย่อ ═════════
  const metaCache = new Map(); // attachmentId → Promise<{ thumbURL, name, type, size } | null>

  function attachmentMeta(id) {
    if (!metaCache.has(id)) {
      metaCache.set(id, ParcelDB.getPhoto(id)
        .then((a) => (a ? {
          thumbURL: a.thumb ? URL.createObjectURL(a.thumb) : '',
          name: a.name || '',
          type: a.type || (a.full && a.full.type) || '',
          size: a.full ? a.full.size : 0,
        } : null))
        .catch(() => null));
    }
    return metaCache.get(id);
  }

  const thumbURL = (id) => attachmentMeta(id).then((m) => (m && m.thumbURL) || '');

  function dropThumb(id) {
    const p = metaCache.get(id);
    if (p) p.then((m) => m && m.thumbURL && URL.revokeObjectURL(m.thumbURL));
    metaCache.delete(id);
  }

  function extOf(m) {
    const n = (m && m.name) || '';
    const dot = n.lastIndexOf('.');
    const e = dot > 0 ? n.slice(dot + 1) : m && m.type ? m.type.split('/').pop() : '';
    return (e || 'ไฟล์').slice(0, 5).toUpperCase();
  }

  async function loadThumb(img) {
    const url = await thumbURL(img.dataset.photo);
    if (url) img.src = url;
    else img.closest('.thumb')?.classList.add('broken');
  }

  const thumbIO = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        thumbIO.unobserve(e.target);
        loadThumb(e.target);
      }
    }, { rootMargin: '300px' })
    : null;

  const observeThumb = (img) => (thumbIO ? thumbIO.observe(img) : loadThumb(img));

  // ═════════ ฟอร์มบันทึก/แก้ไข ═════════
  const form = {
    editing: null,
    photos: [], // ไฟล์แนบ { id, isNew, full?, thumb?, name?, type?, size?, width?, height?, url? }
    removed: [],
    pending: 0,
    session: 0,
    saving: false,
    initial: '',
    extra: {}, // ข้อมูลที่ได้จากข้อความที่วาง แต่ไม่มีช่องในฟอร์ม (พิกัด ลิงก์ภาพ ที่มา)
  };
  const FORM_IDS = ['fTracking', 'fCourier', 'fDate', 'fDelivered', 'fStatus', 'fSender', 'fSenderPhone', 'fSenderAddress',
    'fReceiver', 'fReceiverPhone', 'fReceiverAddress', 'fCustomer', 'fCustomerPhone', 'fIdCard', 'fProductType', 'fWeight', 'fSize',
    'fFee', 'fDrug', 'fAmount', 'fNote'];
  const snapshot = () => JSON.stringify([
    FORM_IDS.map((id) => $(`#${id}`).value.trim()),
    form.photos.map((p) => p.id),
    form.pending,
    form.extra,
  ]);
  const isDirty = () => snapshot() !== form.initial;

  function setMsg(id, text = '', type = '') {
    const el = $(`#${id}`);
    el.textContent = text;
    el.className = `msg${type ? ` ${type}` : ''}`;
    el.closest('.field').classList.toggle('invalid', type === 'error' && !!text);
  }

  const PHONE_FIELDS = [['fSenderPhone', 'senderPhoneMsg'], ['fReceiverPhone', 'receiverPhoneMsg'], ['fCustomerPhone', 'customerPhoneMsg']];

  // เบอร์ผิดรูปแบบ → เตือน · เบอร์ที่มีในข้อมูลเดิม → บอกทันทีว่าจะจับคู่กับพัสดุ/เครือข่ายไหน
  function phoneHint(msgId, phone) {
    const warn = phoneWarning(phone);
    if (warn) {
      setMsg(msgId, warn, 'warn');
      return;
    }
    const key = Network.partyKey('', phone);
    const node = key && state.net ? state.net.nodeByKey.get(key) : null;
    const own = form.editing && form.editing.id;
    const count = node ? new Set(node.items.map((it) => it.parcel.id).filter((id) => id !== own)).size : 0;
    if (!count) {
      setMsg(msgId);
      return;
    }
    const g = node.group;
    setMsg(msgId, `จับคู่กับข้อมูลเดิม: เบอร์นี้อยู่ใน ${num(count)} พัสดุ${g && g.isNetwork ? ` · ${g.label}` : ''}`, 'match');
  }

  function refreshPhoneHints() {
    for (const [id, msg] of PHONE_FIELDS) phoneHint(msg, $(`#${id}`).value);
    idCardHint();
  }

  // เลขบัตรประชาชน: จัดรูปแบบ ตรวจหลักสุดท้าย และบอกถ้าเคยพบในข้อมูลเดิม
  function idCardHint() {
    const el = $('#fIdCard');
    const raw = clean(el.value);
    if (!raw) {
      setMsg('idCardMsg');
      return;
    }
    const key = idCardKey(raw);
    if (!key) {
      setMsg('idCardMsg', /^\d[\d\s-]*$/.test(raw) ? 'เลขบัตรประชาชนต้องมี 13 หลัก' : '', 'warn');
      return;
    }
    el.value = formatIdCard(key);
    if (!idCardValid(key)) {
      setMsg('idCardMsg', 'เลขบัตรไม่ผ่านการตรวจหลักสุดท้าย — ตรวจว่าพิมพ์ถูกหรือไม่', 'warn');
      return;
    }
    const own = form.editing && form.editing.id;
    const count = state.parcels.filter((p) => p.id !== own && idCardKey(p.idCard) === key).length;
    const nodes = (state.net && state.net.nodesByIdCard.get(key)) || [];
    const g = nodes.map((n) => n.group).find((x) => x && x.isNetwork);
    setMsg('idCardMsg', count ? `จับคู่กับข้อมูลเดิม: บัตรนี้อยู่ใน ${num(count)} พัสดุ${g ? ` · ${g.label}` : ''}` : '', 'match');
  }

  function setSaving(on) {
    form.saving = on;
    const btn = $('#btnSave');
    btn.disabled = on || form.pending > 0;
    $('span', btn).textContent = on ? 'กำลังบันทึก…' : form.pending ? 'กำลังเตรียมไฟล์…' : 'บันทึก';
  }

  function openForm(parcel = null, carry = null) {
    discardNewPhotos();
    form.session += 1;
    form.editing = parcel;
    form.removed = [];
    form.pending = 0;
    form.extra = {};
    form.photos = parcel ? parcel.photoIds.map((id) => ({ id, isNew: false })) : [];
    $('#parcelForm').reset();
    $('#formTitle').textContent = parcel ? 'แก้ไขรายการพัสดุ' : 'บันทึกพัสดุใหม่';
    $('#formTip').hidden = !!parcel;
    $('#keepOpenWrap').hidden = !!parcel;
    $('#keepOpen').checked = !!store.get('keepOpen', false);
    const v = parcel || {};
    const set = (id, value) => { $(`#${id}`).value = value || ''; };
    set('fTracking', v.tracking);
    set('fCourier', v.courier || (carry && carry.courier));
    $('#fDate').value = toLocalInput(parcel ? parcel.date : (carry && carry.date) || Date.now());
    $('#fDelivered').value = parcel && parcel.deliveredAt ? toLocalInput(parcel.deliveredAt) : '';
    set('fStatus', v.status);
    set('fSender', v.sender);
    set('fSenderPhone', v.senderPhone);
    set('fSenderAddress', v.senderAddress);
    set('fReceiver', v.receiver);
    set('fReceiverPhone', v.receiverPhone);
    set('fReceiverAddress', v.receiverAddress);
    set('fCustomer', v.customer);
    set('fCustomerPhone', v.customerPhone);
    set('fIdCard', v.idCard ? formatIdCard(v.idCard) : '');
    set('fProductType', v.productType);
    set('fWeight', v.weight);
    set('fSize', v.size);
    set('fFee', v.fee);
    set('fDrug', v.drug);
    set('fAmount', v.amount);
    set('fNote', v.note);
    setMsg('trackingMsg');
    setMsg('dateMsg', parcel && parcel.dateAuto ? 'ข้อความต้นทางไม่มีวันที่ส่ง — ระบบใส่ให้ก่อน แก้ได้' : '', 'warn');
    refreshPhoneHints();
    ['fSenderPhone', 'fReceiverPhone', 'fCustomerPhone', 'fCourier'].forEach((id) => { delete $(`#${id}`).dataset.auto; });
    setSaving(false);
    renderFormPhotos();
    renderFormExtra();
    form.initial = snapshot();
    const dlg = $('#formDialog');
    $('.sheet-body', dlg).scrollTop = 0;
    openModal(dlg);
    $('#fTracking').focus();
  }

  function renderFormExtra() {
    const src = { ...(form.editing || {}), ...form.extra };
    const bits = [];
    if (src.geo) bits.push('พิกัดจุดส่งมอบ');
    if (src.links && src.links.length) bits.push(`ลิงก์ภาพรับพัสดุ ${src.links.length} ลิงก์`);
    if (src.extras && src.extras.length) bits.push(`ข้อมูลเพิ่มเติม ${src.extras.length} รายการ (${src.extras.slice(0, 3).map((e) => e.label).join(', ')}${src.extras.length > 3 ? ' …' : ''})`);
    if (src.origin) bits.push(`ที่มา: ${src.origin}`);
    const box = $('#formExtra');
    box.hidden = !bits.length;
    box.innerHTML = bits.length ? `${icon('info')}<span>เก็บข้อมูลเพิ่มเติมไว้กับรายการนี้ด้วย: ${esc(bits.join(' · '))}</span>` : '';
  }

  async function requestCloseForm() {
    if (form.saving) return;
    if (isDirty()) {
      const ok = await confirmBox({
        title: 'ยกเลิกการบันทึก?',
        body: 'ข้อมูลที่กรอกไว้ในฟอร์มนี้จะหายไป',
        ok: 'ทิ้งข้อมูล',
        cancel: 'กลับไปกรอกต่อ',
        danger: true,
      });
      if (!ok) return;
    }
    $('#formDialog').close();
  }

  function discardNewPhotos() {
    form.photos.filter((p) => p.isNew && p.url).forEach((p) => URL.revokeObjectURL(p.url));
    form.photos = [];
  }

  function checkTracking() {
    const value = $('#fTracking').value.trim();
    const dup = value ? findDuplicate(value, form.editing && form.editing.id) : null;
    if (dup) {
      setMsg('trackingMsg', `เลขนี้บันทึกไว้แล้วเมื่อ ${dateTime(dup.date)}${dup.receiver ? ` · ผู้รับ ${dup.receiver}` : ''}`, 'warn');
    } else {
      setMsg('trackingMsg');
    }
    const courier = $('#fCourier');
    const guess = guessCourier(value);
    if (guess && (!courier.value.trim() || courier.dataset.auto)) {
      courier.value = guess;
      courier.dataset.auto = '1';
    }
  }

  // เติมเบอร์จากชื่อที่เคยบันทึก และเติมชื่อจากเบอร์ (เฉพาะช่องที่ยังว่าง)
  function wireParty(nameEl, phoneEl, msgId) {
    nameEl.addEventListener('input', () => {
      if (phoneEl.value && !phoneEl.dataset.auto) return;
      const phone = state.nameToPhone.get(clean(nameEl.value));
      if (phone) {
        phoneEl.value = phone;
        phoneEl.dataset.auto = '1';
        flash(phoneEl);
        phoneHint(msgId, phone);
      } else if (phoneEl.dataset.auto) {
        phoneEl.value = '';
        delete phoneEl.dataset.auto;
      }
    });
    phoneEl.addEventListener('input', () => {
      delete phoneEl.dataset.auto;
      if ($(`#${msgId}`).textContent) setMsg(msgId);
    });
    phoneEl.addEventListener('change', () => {
      phoneEl.value = formatPhone(phoneEl.value);
      if (!nameEl.value.trim()) {
        const name = state.phoneToName.get(digits(phoneEl.value));
        if (name) {
          nameEl.value = name;
          flash(nameEl);
        }
      }
      phoneHint(msgId, phoneEl.value);
    });
  }

  function flash(el) {
    el.classList.remove('autofilled');
    void el.offsetWidth;
    el.classList.add('autofilled');
  }

  function onFormKeydown(e) {
    if (e.key !== 'Enter' || e.isComposing) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      $('#btnSave').click();
      return;
    }
    const t = e.target;
    if (t.tagName !== 'INPUT' || t.type === 'checkbox' || t.type === 'file') return;
    // Enter = ไปช่องถัดไป (รองรับเครื่องสแกนบาร์โค้ดที่ส่ง Enter ต่อท้าย)
    e.preventDefault();
    const order = ['fTracking', 'fCourier', 'fDate', 'fDelivered', 'fStatus', 'fSender', 'fSenderPhone', 'fReceiver', 'fReceiverPhone',
      'fCustomer', 'fCustomerPhone', 'fProductType', 'fWeight', 'fSize', 'fFee', 'fDrug', 'fAmount']
      .map((id) => $(`#${id}`));
    const next = order[order.indexOf(t) + 1];
    (next || $('#btnSave')).focus();
  }

  // วางข้อความผลค้นหาพัสดุในฟอร์ม: 1 รายการ → เติมช่องให้ · หลายรายการ → เปิดหน้านำเข้า
  function fillFormFromText(text) {
    const res = ParcelParser.parse(text);
    const recs = dedupeRecords(res.records);
    if (recs.length > 1) {
      if (!isDirty()) $('#formDialog').close();
      openImport(text);
      return;
    }
    const r = recs[0];
    if (!r) return;
    const put = (id, value) => { if (value) $(`#${id}`).value = value; };
    put('fTracking', r.tracking);
    put('fCourier', r.courier);
    put('fStatus', r.status);
    put('fSender', r.sender);
    put('fSenderPhone', r.senderPhone);
    put('fSenderAddress', r.senderAddress);
    put('fReceiver', r.receiver);
    put('fReceiverPhone', r.receiverPhone);
    put('fReceiverAddress', r.receiverAddress);
    put('fCustomer', r.customer);
    put('fCustomerPhone', r.customerPhone);
    put('fIdCard', r.idCard ? formatIdCard(r.idCard) : '');
    put('fProductType', r.productType);
    put('fWeight', r.weight);
    put('fSize', r.size);
    put('fFee', r.fee);
    put('fDrug', r.drug);
    put('fAmount', r.amount);
    if (r.date) {
      $('#fDate').value = toLocalInput(r.date);
      setMsg('dateMsg');
    }
    if (r.deliveredAt) $('#fDelivered').value = toLocalInput(r.deliveredAt);
    const notes = [r.note, r.extraPhones.length ? `เบอร์อื่นในข้อความ: ${r.extraPhones.join(', ')}` : ''].filter(Boolean);
    if (notes.length) {
      const n = $('#fNote');
      n.value = [n.value.trim(), ...notes].filter(Boolean).join('\n');
    }
    const prev = form.editing || {};
    if (r.geo) form.extra.geo = r.geo;
    if (r.links.length) form.extra.links = mergeLinks(prev.links, r.links);
    if (r.extras.length) form.extra.extras = mergeExtras(prev.extras, r.extras);
    if (!prev.origin) form.extra.origin = res.query && res.query.role ? `ผลค้นหาเบอร์${res.query.role} ${res.query.phone}` : 'นำเข้าจากข้อความ';
    ['fSenderPhone', 'fReceiverPhone', 'fCustomerPhone', 'fCourier'].forEach((id) => { delete $(`#${id}`).dataset.auto; });
    renderFormExtra();
    checkTracking();
    refreshPhoneHints();
    toast('เติมข้อมูลจากข้อความแล้ว — ตรวจสอบก่อนกดบันทึก', 'ok');
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (form.pending || form.saving) return;
    const tracking = cleanCode($('#fTracking').value);
    if (!tracking) {
      setMsg('trackingMsg', 'กรุณากรอกเลขพัสดุ', 'error');
      $('#fTracking').focus();
      return;
    }
    const prev = form.editing;
    const dup = findDuplicate(tracking, prev && prev.id);
    if (dup) {
      const ok = await confirmBox({
        title: 'เลขพัสดุซ้ำ',
        body: `เลขพัสดุ ${tracking} บันทึกไว้แล้วเมื่อ ${dateTime(dup.date)} ต้องการบันทึกซ้ำอีกรายการหรือไม่?`,
        ok: 'บันทึกซ้ำ',
      });
      if (!ok) {
        $('#fTracking').focus();
        return;
      }
    }
    setSaving(true);
    const now = Date.now();
    const when = fromLocalInput($('#fDate').value);
    const delivered = fromLocalInput($('#fDelivered').value);
    // ไม่ได้แก้วันที่ → คงค่าเดิม (รวมถึงสถานะ "ระบบใส่ให้")
    const sameDate = !!prev && $('#fDate').value === toLocalInput(prev.date);
    // รูปแรกของรายการใช้เป็นรูปหน้าปกในรายการ
    const metas = await Promise.all(form.photos.map((p) => (p.isNew ? { thumbURL: p.url } : attachmentMeta(p.id))));
    const coverIndex = metas.findIndex((m) => m && m.thumbURL);
    const parcel = Object.assign(prev ? { ...prev } : {}, form.extra, {
      id: prev ? prev.id : uid(),
      tracking,
      courier: clean($('#fCourier').value),
      date: sameDate ? prev.date : Number.isFinite(when) ? when : prev ? prev.date : now,
      dateAuto: sameDate && !!prev.dateAuto,
      deliveredAt: Number.isFinite(delivered) ? delivered : null,
      status: clean($('#fStatus').value),
      sender: clean($('#fSender').value),
      senderPhone: formatPhone($('#fSenderPhone').value),
      senderAddress: clean($('#fSenderAddress').value),
      receiver: clean($('#fReceiver').value),
      receiverPhone: formatPhone($('#fReceiverPhone').value),
      receiverAddress: clean($('#fReceiverAddress').value),
      customer: clean($('#fCustomer').value),
      customerPhone: formatPhone($('#fCustomerPhone').value),
      idCard: idCardKey($('#fIdCard').value) || clean($('#fIdCard').value),
      productType: clean($('#fProductType').value),
      weight: clean($('#fWeight').value),
      size: clean($('#fSize').value),
      fee: clean($('#fFee').value),
      drug: clean($('#fDrug').value),
      amount: clean($('#fAmount').value),
      note: $('#fNote').value.trim(),
      photoIds: form.photos.map((p) => p.id),
      coverId: coverIndex >= 0 ? form.photos[coverIndex].id : '',
      createdAt: prev ? prev.createdAt : now,
      updatedAt: now,
    });
    const added = form.photos.filter((p) => p.isNew).map((p) => ({
      id: p.id, parcelId: parcel.id, full: p.full, thumb: p.thumb, name: p.name, type: p.type, size: p.size,
      width: p.width, height: p.height, createdAt: now,
    }));
    try {
      await ParcelDB.saveParcel(parcel, added, form.removed);
    } catch (err) {
      console.error(err);
      setSaving(false);
      toast(err && err.name === 'QuotaExceededError'
        ? 'พื้นที่ดิสก์ของเครื่องไม่พอ — ลบไฟล์ที่ไม่ใช้ในเครื่อง หรือสำรองข้อมูลแล้วย้ายไฟล์ใหญ่ออก'
        : 'บันทึกไม่สำเร็จ กรุณาลองอีกครั้ง', 'error', 6000);
      return;
    }
    // ไฟล์ที่เพิ่งบันทึกใช้รูปย่อเดิมต่อได้เลย
    form.photos.filter((p) => p.isNew).forEach((p) => {
      metaCache.set(p.id, Promise.resolve({ thumbURL: p.url || '', name: p.name, type: p.type, size: p.size }));
    });
    form.removed.forEach(dropThumb);
    form.photos = [];
    form.removed = [];
    form.saving = false;
    prepare(parcel);
    const i = state.parcels.findIndex((x) => x.id === parcel.id);
    if (i >= 0) state.parcels[i] = parcel;
    else state.parcels.push(parcel);
    dataChanged();
    broadcast();
    requestPersist();
    const g = state.net.parcelGroup.get(parcel.id);
    const matched = g && g.isNetwork ? ` · จับคู่อยู่ใน ${g.label}` : '';
    if (!prev && $('#keepOpen').checked) {
      openForm(null, { courier: parcel.courier, date: parcel.date });
      toast(`บันทึก ${parcel.tracking} แล้ว${matched} — กรอกรายการถัดไปได้เลย`, 'ok');
    } else {
      $('#formDialog').close();
      toast(`${prev ? 'บันทึกการแก้ไขแล้ว' : 'บันทึกพัสดุแล้ว'}${matched}`, 'ok');
      if (prev) openDetail(parcel.id);
    }
  }

  // ── ไฟล์แนบในฟอร์ม (ไม่จำกัดจำนวนและชนิด เก็บไฟล์ต้นฉบับ) ──
  function renderFormPhotos() {
    const grid = $('#photoGrid');
    grid.textContent = '';
    form.photos.forEach((ph, i) => grid.append(attachmentTile(ph, i)));
    for (let i = 0; i < form.pending; i++) {
      const tile = document.createElement('div');
      tile.className = 'ph loading';
      tile.innerHTML = '<span class="spinner" aria-label="กำลังเตรียมไฟล์"></span>';
      grid.append(tile);
    }
    $('#btnCamera').hidden = !!$('#btnCamera').dataset.unavailable;
    const n = form.photos.length;
    $('#photoCount').textContent = n ? `${num(n)} ไฟล์ · ไม่จำกัดจำนวน` : 'ไม่จำกัดจำนวน';
    if (!form.saving) setSaving(false);
  }

  function attachmentTile(ph, i) {
    const tile = document.createElement('div');
    tile.className = 'ph';
    const fill = (m) => {
      if (m && m.thumbURL) {
        const img = document.createElement('img');
        img.alt = m.name || `ไฟล์ที่ ${i + 1}`;
        img.src = m.thumbURL;
        tile.prepend(img);
      } else {
        tile.classList.add('file');
        const face = document.createElement('div');
        face.className = 'file-face';
        face.innerHTML = `${icon('file')}<span class="ext">${esc(extOf(m))}</span>`;
        const nm = document.createElement('span');
        nm.className = 'fname';
        nm.textContent = (m && m.name) || '';
        face.append(nm);
        tile.prepend(face);
      }
      if (m) tile.title = `${m.name || ''}${m.size ? ` · ${formatBytes(m.size)}` : ''}`;
    };
    if (ph.isNew) fill({ thumbURL: ph.url, name: ph.name, type: ph.type, size: ph.size });
    else attachmentMeta(ph.id).then(fill);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'ph-remove';
    rm.title = 'เอาไฟล์นี้ออก';
    rm.setAttribute('aria-label', `เอาไฟล์ที่ ${i + 1} ออก`);
    rm.innerHTML = icon('x');
    rm.addEventListener('click', () => removeFormPhoto(i));
    tile.append(rm);
    return tile;
  }

  function removeFormPhoto(i) {
    const [ph] = form.photos.splice(i, 1);
    if (!ph) return;
    if (ph.isNew) {
      if (ph.url) URL.revokeObjectURL(ph.url);
    } else {
      form.removed.push(ph.id);
    }
    renderFormPhotos();
  }

  async function addFiles(fileList) {
    const files = [...fileList].filter(Boolean);
    if (!files.length) return;
    const session = form.session;
    form.pending += files.length;
    renderFormPhotos();
    for (const file of files) {
      let att = null;
      try {
        att = await prepareAttachment(file);
      } catch (err) {
        console.error(err);
        toast(`อ่านไฟล์ “${file.name}” ไม่ได้`, 'error');
      }
      if (session !== form.session) return; // ฟอร์มถูกปิดระหว่างเตรียมไฟล์
      form.pending -= 1;
      if (att) form.photos.push({ id: uid(), isNew: true, ...att, url: att.thumb ? URL.createObjectURL(att.thumb) : '' });
      renderFormPhotos();
    }
  }

  const isImageFile = (f) => (f.type || '').startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$/i.test(f.name || '');

  // เก็บไฟล์ต้นฉบับไว้ครบถ้วน · ถ้าเป็นรูปจะทำรูปย่อไว้แสดงผล (หมุนตาม EXIF ให้อัตโนมัติ)
  async function prepareAttachment(file) {
    const att = { full: file, name: file.name || 'ไฟล์แนบ', type: file.type || '', size: file.size, thumb: null, width: 0, height: 0 };
    if (!isImageFile(file)) return att;
    try {
      const { source, width, height, release } = await decodeImage(file);
      try {
        att.thumb = await toJpeg(drawScaled(source, width, height, THUMB_MAX), 0.78);
        att.width = width;
        att.height = height;
      } finally {
        release();
      }
    } catch {
      /* รูปที่เบราว์เซอร์เปิดไม่ได้ (เช่น HEIC) เก็บเป็นไฟล์ธรรมดา */
    }
    return att;
  }

  async function decodeImage(file) {
    if ('createImageBitmap' in window) {
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
      } catch {
        /* ลองอีกวิธีด้านล่าง */
      }
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  }

  function drawScaled(source, w, h, max) {
    const k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return c;
  }

  const toJpeg = (canvas, quality) => new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('แปลงรูปไม่สำเร็จ'))), 'image/jpeg', quality);
  });

  // ── กล้อง ──
  let camStream = null;
  let camShots = 0;
  const isTouch = () => window.matchMedia && matchMedia('(pointer: coarse)').matches;

  async function detectCamera() {
    const btn = $('#btnCamera');
    if (isTouch()) return; // มือถือ: เปิดกล้องผ่านช่องเลือกไฟล์
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!devices.some((d) => d.kind === 'videoinput')) btn.dataset.unavailable = '1';
    } catch {
      btn.dataset.unavailable = '1';
    }
  }

  async function openCamera() {
    if (isTouch() || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('#cameraInput').click();
      return;
    }
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
    } catch (err) {
      console.error(err);
      toast(err && err.name === 'NotAllowedError'
        ? 'ไม่ได้รับอนุญาตให้ใช้กล้อง — อนุญาตได้ที่ไอคอนกล้องบนแถบที่อยู่'
        : 'ไม่พบกล้องบนเครื่องนี้ — ใช้ปุ่ม “เลือกไฟล์” แทน', 'error', 5000);
      return;
    }
    camShots = 0;
    $('#camCount').textContent = '';
    const video = $('#camVideo');
    video.srcObject = camStream;
    openModal($('#cameraDialog'));
    video.play().catch(() => {});
  }

  function stopCamera() {
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
    $('#camVideo').srcObject = null;
  }

  async function snap() {
    const video = $('#camVideo');
    if (!video.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    const fl = $('#camFlash');
    fl.classList.remove('on');
    void fl.offsetWidth;
    fl.classList.add('on');
    const blob = await toJpeg(c, 0.92);
    camShots += 1;
    $('#camCount').textContent = `ถ่ายแล้ว ${camShots} รูป`;
    await addFiles([new File([blob], `ภาพถ่าย-${fileStamp()}-${camShots}.jpg`, { type: 'image/jpeg' })]);
  }

  // ═════════ รายละเอียดพัสดุ ═════════
  const detailState = { images: [], fileURLs: [], token: 0 };

  function openDetail(id) {
    const p = findParcel(id);
    if (!p) return;
    state.detailId = id;
    $('#dTracking').textContent = p.tracking;
    const sub = [];
    if (p.courier) sub.push(`${icon('truck')}<span>${esc(p.courier)}</span>`);
    if (p.status) sub.push(`<span class="pill ${statusClass(p.status)}">${esc(p.status)}</span>`);
    $('#dSub').innerHTML = sub.map((s) => `<span class="d-sub-item">${s}</span>`).join('');
    // ไทม์ไลน์แบบแอพติดตามพัสดุ: วันที่ (ตรวจพบ/ส่ง) → ส่งมอบ
    const delivered = !!p.deliveredAt;
    const dated = !p.dateAuto;
    $('#dTimeline').innerHTML = `
      <li class="${dated ? 'done' : 'pending'}${delivered ? '' : ' next-pending'}">
        <span class="tl-dot" aria-hidden="true">${dated ? icon('check') : ''}</span>
        <div><b>วันที่ (ตรวจพบ/ส่ง)</b><small>${dated ? esc(dateTime(p.date)) : 'ไม่มีในข้อความต้นทาง'}</small></div>
      </li>
      <li class="${delivered ? 'done' : 'pending'}">
        <span class="tl-dot" aria-hidden="true">${delivered ? icon('check') : ''}</span>
        <div><b>ส่งมอบ</b><small>${delivered ? esc(dateTime(p.deliveredAt)) : 'ยังไม่มีข้อมูลการส่งมอบ'}</small></div>
      </li>`;
    fillParty($('#dSender'), p.sender, p.senderPhone, p.senderAddress);
    fillParty($('#dReceiver'), p.receiver, p.receiverPhone, p.receiverAddress);
    const hasCustomer = !!(p.customer || p.customerPhone);
    $('#dCustomer').hidden = !hasCustomer;
    if (hasCustomer) fillParty($('#dCustomer'), p.customer, p.customerPhone, '');
    // เลขบัตรประชาชนผู้ฝากส่ง: แสดงในการ์ดลูกค้า (ถ้ามี) ไม่เช่นนั้นในการ์ดผู้ส่ง
    const idHost = hasCustomer ? $('#dCustomer') : $('#dSender');
    for (const box of [$('#dSender'), $('#dCustomer')]) {
      const row = $('.id-row', box);
      row.hidden = !(p.idCard && box === idHost);
      if (row.hidden) continue;
      const shown = formatIdCard(p.idCard);
      $('.id-num', row).textContent = shown;
      $('[data-copy-id]', row).dataset.copyId = shown;
    }
    renderSpecs($('#dProduct'), $('#dProductBody'), [
      ['ประเภทสินค้า', p.productType], ['น้ำหนัก', p.weight], ['ขนาดกล่อง', p.size], ['ค่าขนส่ง', p.fee],
    ]);
    renderSpecs($('#dExtras'), $('#dExtrasBody'), p.extras.map((e) => [e.label, e.value]));
    renderDelivery(p);
    $('#dEvidence').hidden = !(p.drug || p.amount);
    $('#dDrug').textContent = p.drug;
    $('#dAmount').textContent = p.amount;
    $('#dNoteWrap').hidden = !p.note;
    $('#dNote').textContent = p.note;
    renderAttachments(p);
    renderDetailNetwork(p);
    const edited = p.updatedAt - p.createdAt > 60000;
    $('#dMeta').textContent = `บันทึกเข้าระบบ ${dateTime(p.createdAt)}${edited ? ` · แก้ไขล่าสุด ${dateTime(p.updatedAt)}` : ''}`;
    const dlg = $('#detailDialog');
    $('.sheet-body', dlg).scrollTop = 0;
    openModal(dlg);
  }

  function fillParty(box, name, phone, address) {
    const nameEl = $('.name', box);
    nameEl.textContent = name || 'ไม่ระบุชื่อ';
    nameEl.classList.toggle('nil', !name);
    const row = $('.phone-row', box);
    row.hidden = !phone;
    if (phone) {
      const link = $('.phone-link', box);
      link.href = telHref(phone);
      $('span', link).textContent = phone;
      $('[data-copy-phone]', box).dataset.copyPhone = phone;
    }
    const addr = $('.addr', box);
    addr.textContent = address || '';
    addr.hidden = !address;
  }

  // ตารางคู่ "หัวข้อ — ค่า" (แสดงเฉพาะที่มีค่า) · ข้อมูลมาจากผู้ใช้/ต้นทาง จึงใส่ด้วย textContent
  function renderSpecs(section, dl, pairs) {
    dl.textContent = '';
    const rows = pairs.filter(([, v]) => v);
    section.hidden = !rows.length;
    for (const [k, v] of rows) {
      const div = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = v;
      div.append(dt, dd);
      dl.append(div);
    }
  }

  function renderDelivery(p) {
    const parts = [];
    if (p.geo) {
      parts.push(`<a class="ext-link" href="https://www.google.com/maps?q=${encodeURIComponent(p.geo)}" target="_blank" rel="noopener noreferrer" title="เปิด Google Maps (ต้องต่ออินเทอร์เน็ต)">${icon('pin')}<span>พิกัดจุดส่งมอบ ${esc(p.geo)}</span>${icon('external', 'sm')}</a>`);
    }
    p.links.forEach((l, i) => {
      parts.push(`<a class="ext-link" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="เปิดลิงก์ภายนอก (ต้องต่ออินเทอร์เน็ต)">${icon('image')}<span>${esc(l.label || `ลิงก์ ${i + 1}`)}</span>${icon('external', 'sm')}</a>`);
    });
    if (p.origin) parts.push(`<p class="muted small origin">ที่มา: ${esc(p.origin)}</p>`);
    $('#dDelivery').hidden = !parts.length;
    $('#dDeliveryBody').innerHTML = parts.join('');
  }

  function releaseDetailFiles() {
    detailState.fileURLs.forEach((u) => URL.revokeObjectURL(u));
    detailState.fileURLs = [];
  }

  async function renderAttachments(p) {
    const token = ++detailState.token;
    releaseDetailFiles();
    const gallery = $('#dGallery');
    const list = $('#dFiles');
    gallery.textContent = '';
    list.textContent = '';
    detailState.images = [];
    $('#dPhotosWrap').hidden = !p.photoIds.length;
    $('#dPhotoCount').textContent = p.photoIds.length ? `(${num(p.photoIds.length)})` : '';
    if (!p.photoIds.length) return;
    const recs = await Promise.all(p.photoIds.map((id) => ParcelDB.getPhoto(id).catch(() => null)));
    if (token !== detailState.token) return;
    for (const a of recs) {
      if (!a) continue;
      if (a.thumb) {
        const i = detailState.images.length;
        detailState.images.push(a.id);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'g-item';
        b.dataset.i = String(i);
        b.setAttribute('aria-label', `ดูรูปที่ ${i + 1}`);
        b.title = a.name || '';
        const img = document.createElement('img');
        img.alt = '';
        thumbURL(a.id).then((u) => { if (u) img.src = u; });
        b.append(img);
        gallery.append(b);
      } else {
        const url = URL.createObjectURL(a.full);
        detailState.fileURLs.push(url);
        const name = a.name || 'ไฟล์แนบ';
        const li = document.createElement('li');
        li.innerHTML = `${icon('file')}<span class="f-main"><b></b><small>${esc(extOf(a))} · ${esc(formatBytes(a.full.size))}</small></span>
          <a class="btn small" target="_blank" rel="noopener">${icon('external')}<span>เปิด</span></a>
          <a class="btn small">${icon('download')}<span>บันทึก</span></a>`;
        $('b', li).textContent = name;
        const [openLink, saveLink] = li.querySelectorAll('a');
        openLink.href = url;
        saveLink.href = url;
        saveLink.download = name;
        list.append(li);
      }
    }
    gallery.hidden = !detailState.images.length;
    list.hidden = !list.children.length;
  }

  // พัสดุอื่นที่ใช้หมายเลข (หรือชื่อ เมื่อไม่มีเบอร์) เดียวกับรายการนี้
  function relatedParcels(p) {
    const out = new Map();
    for (const [name, phone] of [[p.sender, p.senderPhone], [p.receiver, p.receiverPhone], [p.customer, p.customerPhone]]) {
      const key = Network.partyKey(name, phone);
      const node = key && state.net.nodeByKey.get(key);
      if (!node) continue;
      for (const it of node.items) {
        if (it.parcel.id === p.id) continue;
        const r = out.get(it.parcel.id) || { parcel: it.parcel, via: new Set() };
        r.via.add(node.label);
        out.set(it.parcel.id, r);
      }
    }
    // บัตรประชาชนผู้ฝากส่งใบเดียวกัน (แม้ชื่อ/เบอร์บนใบพัสดุจะต่างกัน)
    const id = idCardKey(p.idCard);
    if (id) {
      for (const x of state.parcels) {
        if (x.id === p.id || idCardKey(x.idCard) !== id) continue;
        const r = out.get(x.id) || { parcel: x, via: new Set() };
        r.via.add(`บัตร ${formatIdCard(id)}`);
        out.set(x.id, r);
      }
    }
    return [...out.values()].sort((a, b) => b.parcel.date - a.parcel.date);
  }

  function renderDetailNetwork(p) {
    const g = state.net.parcelGroup.get(p.id);
    const related = relatedParcels(p);
    let html = `<h3 class="eyebrow">${icon('link')}การเชื่อมโยง</h3>`;
    if (g && g.isNetwork) {
      html += `
        <div class="net-box">
          <div class="net-line"><b>${esc(g.label)}</b>${g.customName ? ` <small class="muted">(${esc(g.autoLabel)})</small>` : ''}<span class="muted"> · ${num(g.parcelCount)} พัสดุ · ${num(g.phoneCount)} หมายเลข · ${esc(dateRange(g.first, g.last))}</span></div>
          ${g.mergedNames && g.mergedNames.length ? `<p class="gc-merged">${icon('alert')}<span>เชื่อมรวมกับเครือข่ายที่ตั้งชื่อไว้: ${esc(g.mergedNames.join(', '))}</span></p>` : ''}
          <div class="net-actions">
            <button type="button" class="btn small" data-d-graph="${g.index}">${icon('graph')}<span>ดูกราฟเครือข่าย</span></button>
            <button type="button" class="btn small" data-d-list="${g.index}">${icon('list')}<span>ดูพัสดุในเครือข่าย</span></button>
            <button type="button" class="btn small" data-d-rename="${g.index}">${icon('pencil')}<span>${g.customName ? 'เปลี่ยนชื่อ' : 'ตั้งชื่อเครือข่าย'}</span></button>
          </div>
        </div>`;
    } else {
      html += '<p class="muted">ยังไม่พบหมายเลข ชื่อ ที่อยู่ หรือเลขบัตรประชาชนที่ซ้ำกับพัสดุรายการอื่น</p>';
    }
    if (related.length) {
      html += `<h4 class="sub-title">พัสดุที่ใช้หมายเลข/ชื่อ/บัตรเดียวกัน (${num(related.length)})</h4>
        <ul class="mini-list">${related.slice(0, 30).map(({ parcel: r, via }) => `
          <li><button type="button" data-open="${esc(r.id)}">
            <span class="code">${esc(r.tracking)}</span>
            <span class="mini-meta">${esc(date(r.date))}${r.drug ? ` · ${esc(r.drug)}` : ''}</span>
            <span class="mini-via">ใช้ ${esc([...via].join(', '))}</span>
          </button></li>`).join('')}</ul>`;
      if (related.length > 30) html += `<p class="muted small">และอีก ${num(related.length - 30)} รายการ</p>`;
    }
    $('#dNet').innerHTML = html;
  }

  async function removeParcel(p) {
    const ok = await confirmBox({
      title: 'ลบรายการนี้?',
      body: `พัสดุเลข ${p.tracking} และไฟล์แนบทั้งหมดของรายการนี้จะถูกลบถาวร`,
      ok: 'ลบรายการ',
      danger: true,
    });
    if (!ok) return;
    try {
      await ParcelDB.deleteParcel(p.id);
    } catch (err) {
      console.error(err);
      toast('ลบไม่สำเร็จ กรุณาลองอีกครั้ง', 'error');
      return;
    }
    p.photoIds.forEach(dropThumb);
    state.parcels = state.parcels.filter((x) => x.id !== p.id);
    $('#detailDialog').close();
    dataChanged();
    broadcast();
    toast('ลบรายการแล้ว', 'ok');
  }

  // ── ดูรูปขนาดใหญ่ ──
  const lb = { ids: [], i: 0, urls: new Map(), names: new Map(), name: '' };

  async function openLightbox(ids, i, name) {
    lb.ids = ids;
    lb.i = i;
    lb.name = String(name || 'parcel').replace(/[^\w-]/g, '') || 'parcel';
    openModal($('#lightbox'));
    await showLightbox();
  }

  async function showLightbox() {
    const id = lb.ids[lb.i];
    const img = $('#lbImg');
    const many = lb.ids.length > 1;
    $('#lbCount').textContent = many ? `${lb.i + 1} / ${lb.ids.length}` : '';
    $('#lbPrev').hidden = !many;
    $('#lbNext').hidden = !many;
    $('#lbPrev').disabled = lb.i === 0;
    $('#lbNext').disabled = lb.i >= lb.ids.length - 1;
    let url = lb.urls.get(id);
    if (!url) {
      img.src = (await thumbURL(id)) || '';
      const ph = await ParcelDB.getPhoto(id);
      if (!ph) return;
      url = URL.createObjectURL(ph.full);
      lb.urls.set(id, url);
      lb.names.set(id, ph.name || '');
    }
    if (lb.ids[lb.i] !== id) return; // เปลี่ยนรูปไปแล้วระหว่างโหลด
    img.src = url;
    const save = $('#lbSave');
    save.href = url;
    save.download = lb.names.get(id) || `${lb.name}-${lb.i + 1}.jpg`;
  }

  function stepLightbox(d) {
    const i = lb.i + d;
    if (i < 0 || i >= lb.ids.length) return;
    lb.i = i;
    showLightbox();
  }

  function releaseLightbox() {
    lb.urls.forEach((u) => URL.revokeObjectURL(u));
    lb.urls.clear();
    lb.names.clear();
    $('#lbImg').removeAttribute('src');
  }

  // ═════════ นำเข้าข้อมูล: ข้อความผลค้นหาพัสดุ · ไฟล์ Excel/CSV · ช่วงเซลล์ที่คัดลอกจาก Excel ═════════
  const PREVIEW_MAX = 300; // จำนวนแถวที่แสดงให้ตรวจ (นำเข้าได้ทุกแถว)
  const imp = {
    result: null,
    records: [],
    checked: [],
    done: null,
    file: null, // ไฟล์ตาราง { name, size, sheets, infos, sheet }
    table: null, // ตารางที่วางในช่องข้อความ { rows, info }
    columns: null, // การจับคู่คอลัมน์ของตารางที่กำลังแสดง
    overrides: {}, // เลขคอลัมน์ → ช่องข้อมูล ที่ผู้ใช้เลือกเอง
    error: '',
    token: 0,
  };

  // เลขพัสดุซ้ำในข้อความเดียวกัน → รวมเป็นรายการเดียว
  function dedupeRecords(records) {
    const byKey = new Map();
    const out = [];
    for (const r of records) {
      const k = codeKey(r.tracking);
      const ex = k && byKey.get(k);
      if (!ex) {
        if (k) byKey.set(k, r);
        out.push(r);
        continue;
      }
      for (const [key, value] of Object.entries(r)) {
        if (value && !ex[key] && typeof value !== 'object') ex[key] = value;
      }
      ex.links = mergeLinks(ex.links, r.links);
      ex.extras = mergeExtras(ex.extras, r.extras);
      ex.extraPhones = [...new Set([...ex.extraPhones, ...r.extraPhones])];
    }
    return out;
  }

  function importOptions() {
    const res = imp.result;
    const f = imp.file;
    let origin = 'นำเข้าจากข้อความ';
    if (f) origin = `นำเข้าจากไฟล์ ${f.name}${f.sheets.length > 1 ? ` (แผ่นงาน ${f.sheets[f.sheet].name})` : ''}`;
    else if (imp.table) origin = 'นำเข้าจากตารางที่คัดลอกมาวาง';
    else if (res && res.query && res.query.role) origin = `ผลค้นหาเบอร์${res.query.role} ${res.query.phone}`;
    return {
      courier: clean($('#impCourier').value),
      note: clean($('#impNote').value),
      origin,
      fromFile: !!(f || imp.table),
    };
  }

  // รายการที่มีอยู่แล้ว: เติมเฉพาะช่องที่ยังว่าง อัปเดตข้อมูลการจัดส่ง และบันทึกข้อมูลที่ขัดกันไว้ในหมายเหตุ
  function mergeParcel(ex, r, opts, now) {
    const next = { ...ex };
    let changed = false;
    const fill = (key, value) => {
      if (value && !next[key]) {
        next[key] = value;
        changed = true;
      }
    };
    const set = (key, value) => {
      if (value && next[key] !== value) {
        next[key] = value;
        changed = true;
      }
    };
    fill('sender', r.sender);
    fill('senderPhone', r.senderPhone);
    fill('senderAddress', r.senderAddress);
    fill('receiver', r.receiver);
    fill('receiverPhone', r.receiverPhone);
    fill('receiverAddress', r.receiverAddress);
    fill('customer', r.customer);
    fill('customerPhone', r.customerPhone);
    fill('idCard', r.idCard);
    fill('productType', r.productType);
    fill('weight', r.weight);
    fill('size', r.size);
    fill('fee', r.fee);
    fill('courier', opts.courier || r.courier);
    fill('drug', r.drug);
    fill('amount', r.amount);
    fill('origin', opts.origin);
    set('status', r.status);
    set('geo', r.geo);
    set('deliveredAt', r.deliveredAt);
    // วันที่เดิมระบบใส่ให้ (ข้อความครั้งก่อนไม่มีวันที่ส่ง) → ใช้วันที่จริงจากข้อความนี้แทน
    if (r.date != null && next.dateAuto) {
      next.date = r.date;
      next.dateAuto = false;
      changed = true;
    }
    const links = mergeLinks(next.links, r.links);
    if (links.length !== next.links.length) {
      next.links = links;
      changed = true;
    }
    const extras = mergeExtras(next.extras, r.extras);
    if (JSON.stringify(extras) !== JSON.stringify(next.extras)) {
      next.extras = extras;
      changed = true;
    }
    const conflicts = [];
    const phoneDiffers = (a, b) => a && b && digits(a) !== digits(b);
    const nameDiffers = (a, b) => a && b && nameKey(a) !== nameKey(b);
    if (phoneDiffers(ex.senderPhone, r.senderPhone)) conflicts.push(`เบอร์ผู้ส่ง ${r.senderPhone}`);
    if (phoneDiffers(ex.receiverPhone, r.receiverPhone)) conflicts.push(`เบอร์ผู้รับ ${r.receiverPhone}`);
    if (nameDiffers(ex.sender, r.sender)) conflicts.push(`ชื่อผู้ส่ง ${r.sender}`);
    if (nameDiffers(ex.receiver, r.receiver)) conflicts.push(`ชื่อผู้รับ ${r.receiver}`);
    if (idCardKey(ex.idCard) && idCardKey(r.idCard) && idCardKey(ex.idCard) !== idCardKey(r.idCard)) conflicts.push(`เลขบัตรประชาชน ${formatIdCard(r.idCard)}`);
    const lines = [];
    if (conflicts.length) lines.push(`ข้อมูลนำเข้าที่ต่างจากเดิม: ${conflicts.join(', ')}`);
    if (opts.note) lines.push(opts.note);
    for (const line of lines) {
      if (!next.note.includes(line)) {
        next.note = next.note ? `${next.note}\n${line}` : line;
        changed = true;
      }
    }
    if (!changed) return null;
    next.updatedAt = now;
    return next;
  }

  function parcelFromImport(r, opts, now) {
    const notes = [r.note, opts.note, r.extraPhones.length ? `เบอร์อื่นใน${opts.fromFile ? 'ไฟล์' : 'ข้อความ'}: ${r.extraPhones.join(', ')}` : ''].filter(Boolean);
    return {
      id: uid(),
      tracking: r.tracking,
      courier: opts.courier || r.courier || guessCourier(r.tracking),
      // ข้อความบางแบบไม่มีวันที่ส่ง → ใช้วันส่งมอบ (หรือเวลานำเข้า) ไปก่อน และจำไว้ว่าเป็นค่าที่ระบบใส่ให้
      date: r.date ?? r.deliveredAt ?? now,
      dateAuto: r.date == null,
      deliveredAt: r.deliveredAt ?? null,
      status: r.status,
      sender: r.sender,
      senderPhone: r.senderPhone,
      senderAddress: r.senderAddress,
      receiver: r.receiver,
      receiverPhone: r.receiverPhone,
      receiverAddress: r.receiverAddress,
      customer: r.customer,
      customerPhone: r.customerPhone,
      idCard: r.idCard || '',
      productType: r.productType,
      weight: r.weight,
      size: r.size,
      fee: r.fee,
      drug: r.drug,
      amount: r.amount,
      note: notes.join('\n'),
      geo: r.geo,
      links: r.links,
      extras: r.extras,
      origin: opts.origin,
      photoIds: [],
      coverId: '',
      createdAt: now,
      updatedAt: now,
    };
  }

  // เลขพัสดุ → รายการเดิม (ตรวจไฟล์หลายร้อยแถวได้เร็ว ไม่ต้องไล่หาทีละรายการ)
  function trackingIndex() {
    const m = new Map();
    for (const p of state.parcels) if (p._k.tracking && !m.has(p._k.tracking)) m.set(p._k.tracking, p);
    return m;
  }

  function importKind(r, opts, index) {
    if (!r.tracking) return { kind: 'skip', label: 'ไม่มีเลขพัสดุ — ข้าม' };
    const ex = index.get(codeKey(r.tracking));
    if (!ex) return { kind: 'new', label: 'ใหม่' };
    return mergeParcel(ex, r, opts, Date.now())
      ? { kind: 'update', label: 'มีแล้ว · เติมข้อมูล' }
      : { kind: 'same', label: 'มีแล้ว' };
  }

  function resetImport(text = '') {
    imp.token += 1;
    imp.done = null;
    imp.file = null;
    imp.error = '';
    imp.overrides = {};
    $('#impText').value = text;
    $('#impCourier').value = '';
    $('#impNote').value = '';
  }

  function showImportDialog() {
    const dlg = $('#importDialog');
    $('.sheet-body', dlg).scrollTop = 0;
    openModal(dlg);
  }

  function openImport(text = '') {
    resetImport(text);
    analyzeImport();
    showImportDialog();
    (text && imp.records.length ? $('#impGo') : $('#impText')).focus();
  }

  // ไฟล์ Excel/CSV/ข้อความ → อ่านในเครื่อง แล้วแสดงให้ตรวจก่อนนำเข้า
  async function importFromFile(file) {
    if (!$('#importDialog').open) {
      resetImport();
      showImportDialog();
    }
    const token = ++imp.token;
    imp.done = null;
    imp.error = '';
    imp.overrides = {};
    $('#impSummary').hidden = false;
    $('#impSummary').innerHTML = `<p class="imp-hint">${icon('file')}<span>กำลังอ่านไฟล์ ${esc(file.name)} …</span></p>`;
    $('#impList').innerHTML = '';
    $('#impGo').disabled = true;
    let data;
    try {
      data = await SheetImport.readFile(file);
    } catch (err) {
      if (token !== imp.token) return;
      if (!err || !err.code) console.error(err); // ข้อผิดพลาดที่รู้จัก (ไฟล์ .xls รุ่นเก่า ฯลฯ) แจ้งผู้ใช้บนหน้าจอแล้ว
      imp.file = null;
      imp.error = `${file.name}: ${SheetImport.messageOf(err)}`;
      analyzeImport();
      return;
    }
    if (token !== imp.token) return;
    if (data.kind === 'text') {
      imp.file = null;
      $('#impText').value = data.text;
    } else {
      const sheets = data.sheets.filter((s) => s.rows.length);
      const infos = sheets.map((s) => SheetImport.analyze(s.rows));
      let sheet = infos.findIndex((info, i) => info.hasTracking && !sheets[i].hidden);
      if (sheet < 0) sheet = Math.max(0, infos.findIndex((info) => info.hasTracking));
      imp.file = { name: file.name, size: file.size, sheets, infos, sheet };
      $('#impText').value = '';
    }
    analyzeImport();
    $('.sheet-body', $('#importDialog')).scrollTop = 0;
    if (imp.records.length) $('#impGo').focus();
  }

  function analyzeImport() {
    let res;
    imp.table = null;
    imp.columns = null;
    const f = imp.file;
    const table = f ? null : (() => {
      const text = $('#impText').value;
      return ParcelParser.looksLike(text) ? null : SheetImport.tableFromText(text);
    })();
    if (f || table) {
      const src = f ? { rows: f.sheets[f.sheet].rows, info: f.infos[f.sheet] } : table;
      const out = SheetImport.toRecords(src.rows, src.info, imp.overrides);
      imp.table = table;
      imp.columns = out.columns;
      res = { records: out.records, query: null, total: null };
    } else {
      res = ParcelParser.parse($('#impText').value);
    }
    imp.result = res;
    imp.records = dedupeRecords(res.records);
    imp.checked = imp.records.map((r) => !!r.tracking);
    imp.done = null;
    renderImport();
  }

  // ตัวอย่างค่าในคอลัมน์ (ค่าแรกที่ไม่ว่าง) ให้ผู้ใช้ดูประกอบการจับคู่
  function columnSample(rows, info, index) {
    for (let i = info.headerRow + 1; i < Math.min(rows.length, info.headerRow + 60); i++) {
      const v = clean(rows[i][index]);
      if (v) return v.length > 40 ? `${v.slice(0, 40)}…` : v;
    }
    return '';
  }

  function renderImportFile() {
    const f = imp.file;
    const info = f.infos[f.sheet];
    $('#impFileName').textContent = f.name;
    const bits = [formatBytes(f.size), `${num(info.dataRows)} แถวข้อมูล`];
    if (info.courier) bits.push(`รูปแบบข้อมูล ${info.courier}`);
    $('#impFileMeta').textContent = bits.join(' · ');
    const many = f.sheets.length > 1;
    $('#impSheetWrap').hidden = !many;
    if (many) {
      $('#impSheet').innerHTML = f.sheets.map((s, i) => `<option value="${i}">${esc(s.name)}${s.hidden ? ' (ซ่อน)' : ''} · ${num(f.infos[i].dataRows)} แถว</option>`).join('');
      $('#impSheet').value = String(f.sheet);
    }
  }

  function renderImportMap() {
    const src = imp.file ? { rows: imp.file.sheets[imp.file.sheet].rows, info: imp.file.infos[imp.file.sheet] } : imp.table;
    const L = SheetImport.FIELD_LABEL;
    const cols = imp.columns.filter((c) => c.filled || imp.overrides[c.index]);
    const mapped = cols.filter((c) => c.field !== 'extra' && c.field !== 'skip').length;
    const extra = cols.filter((c) => c.field === 'extra').length;
    const skipped = cols.filter((c) => c.field === 'skip').length;
    $('#impMapSummary').textContent = `การจับคู่คอลัมน์ — ใช้ ${num(mapped)} คอลัมน์ · เก็บเป็นข้อมูลเพิ่มเติม ${num(extra)} · ไม่นำเข้า ${num(skipped)}`;
    $('#impMapBody').innerHTML = cols.map((c) => {
      const choices = SheetImport.CHOICES.includes(c.auto) ? SheetImport.CHOICES : [c.auto, ...SheetImport.CHOICES];
      const options = choices.map((k) => `<option value="${k}"${k === c.field ? ' selected' : ''}>${esc(L[k])}${k === c.auto ? ' · อัตโนมัติ' : ''}</option>`).join('');
      const sample = columnSample(src.rows, src.info, c.index);
      return `
        <tr class="${c.field === 'skip' ? 'is-skip' : c.field === 'extra' ? 'is-extra' : 'is-used'}">
          <th scope="row"><span class="col-name">${esc(c.header)}</span>${sample ? `<small>${esc(sample)}</small>` : ''}</th>
          <td><select data-col="${c.index}" aria-label="ช่องข้อมูลสำหรับคอลัมน์ ${esc(c.header)}">${options}</select></td>
        </tr>`;
    }).join('');
  }

  // สรุปการจับคู่ก่อนนำเข้า: ในไฟล์มีกี่หมายเลข/บัตร และตรงกับข้อมูลเดิมเท่าไร
  function importMatchHTML(records) {
    const net = state.net;
    const phones = new Set();
    const ids = new Set();
    const knownPhones = new Set();
    const knownIds = new Set();
    const groups = new Set();
    for (const r of records) {
      for (const phone of [r.senderPhone, r.receiverPhone, r.customerPhone]) {
        const key = phone && Network.partyKey('', phone);
        if (!key) continue;
        phones.add(key);
        const node = net.nodeByKey.get(key);
        if (!node) continue;
        knownPhones.add(key);
        if (node.group && node.group.isNetwork) groups.add(node.group);
      }
      const id = idCardKey(r.idCard);
      if (!id) continue;
      ids.add(id);
      const nodes = net.nodesByIdCard.get(id);
      if (!nodes) continue;
      knownIds.add(id);
      for (const n of nodes) if (n.group && n.group.isNetwork) groups.add(n.group);
    }
    let html = `<p class="imp-hint">${icon('link')}<span>ในชุดนี้มี ${num(phones.size)} หมายเลข${ids.size ? ` · ${num(ids.size)} เลขบัตรประชาชนผู้ฝากส่ง` : ''} — ระบบจะจับคู่เป็นเครือข่ายจากเบอร์โทร${ids.size ? ' เลขบัตรประชาชน' : ''} ชื่อ และที่อยู่ให้อัตโนมัติ</span></p>`;
    if (knownPhones.size || knownIds.size) {
      const list = [...groups].sort((a, b) => b.parcelCount - a.parcelCount);
      const where = list.length ? ` — จะเชื่อมเข้ากับ ${list.slice(0, 3).map((g) => `<b>${esc(g.label)}</b>`).join(', ')}${list.length > 3 ? ` และอีก ${num(list.length - 3)} เครือข่าย` : ''}` : '';
      const bits = [knownPhones.size ? `${num(knownPhones.size)} หมายเลข` : '', knownIds.size ? `${num(knownIds.size)} เลขบัตรประชาชน` : ''].filter(Boolean).join(' · ');
      html += `<p class="imp-match">${icon('network')}<span>ตรงกับข้อมูลที่มีอยู่แล้ว ${bits}${where}</span></p>`;
    }
    return html;
  }

  function renderImport() {
    const done = !!imp.done;
    const f = imp.file;
    const isTable = !!(f || imp.table);
    $('#impDone').hidden = !done;
    $('#impList').hidden = done;
    $('#impSummary').hidden = done;
    $('#impGo').hidden = done;
    $('#impInput').hidden = done;
    $('#impTextField').hidden = !!f;
    $('#impFileCard').hidden = !f;
    $('#impMap').hidden = done || !imp.columns;
    $('#impCancel').textContent = done ? 'ปิด' : 'ยกเลิก';
    if (done) {
      $('#impDone').innerHTML = importDoneHTML();
      return;
    }
    if (f) renderImportFile();
    if (imp.columns) renderImportMap();
    const text = $('#impText').value.trim();
    const { records, checked, result: res } = imp;
    const opts = importOptions();
    const index = trackingIndex();
    const kinds = records.map((r) => importKind(r, opts, index));
    const count = (k) => kinds.filter((x) => x.kind === k).length;
    let html = imp.error ? `<p class="imp-warn">${icon('alert')}<span>${esc(imp.error)}</span></p>` : '';
    const noTracking = isTable && !records.some((r) => r.tracking);
    if (!text && !f) {
      if (!imp.error) html += `<p class="imp-hint">${icon('info')}<span>วางข้อความผลค้นหาพัสดุ หรือช่วงเซลล์ที่คัดลอกจาก Excel ในช่องด้านบน — หรือกด “เลือกไฟล์” / ลากไฟล์ Excel (.xlsx) CSV หรือ .txt มาวางที่หน้านี้</span></p>`;
    } else if (noTracking) {
      html += `<p class="imp-warn">${icon('alert')}<span>ไม่พบคอลัมน์เลขพัสดุในตารางนี้ — เปิด “การจับคู่คอลัมน์” แล้วเลือกคอลัมน์ที่เป็นเลขพัสดุเอง</span></p>`;
    } else if (!records.length) {
      html += `<p class="imp-warn">${icon('alert')}<span>ไม่พบข้อมูลพัสดุในข้อความนี้ — ต้องมีบรรทัดแบบ “เลขพัสดุ : …”, “ผู้ส่ง : ชื่อ เบอร์”, “ผู้รับ : ชื่อ เบอร์” หรือเป็นตารางที่มีคอลัมน์เลขพัสดุ</span></p>`;
    } else {
      const bits = [`พบ <b>${num(records.length)}</b> รายการ`];
      if (count('new')) bits.push(`ใหม่ ${num(count('new'))}`);
      if (count('update')) bits.push(`มีแล้ว เติมข้อมูลเพิ่ม ${num(count('update'))}`);
      if (count('same')) bits.push(`มีแล้วครบถ้วน ${num(count('same'))}`);
      if (count('skip')) bits.push(`ไม่มีเลขพัสดุ ${num(count('skip'))}`);
      html += `<p class="imp-count">${bits.join(' · ')}</p>`;
      if (res.query) {
        html += `<p class="imp-hint">${icon('search')}<span>ผลค้นหาจากเบอร์${esc(res.query.role)} <b class="code">${esc(res.query.phone)}</b> — จะเชื่อมโยงเป็นเครือข่ายเดียวกันจากเบอร์โทรให้อัตโนมัติ</span></p>`;
      }
      if (res.total && res.total > res.records.length) {
        html += `<p class="imp-warn">${icon('alert')}<span>ข้อความระบุว่ามีทั้งหมด ${num(res.total)} รายการ แต่ที่วางมามี ${num(res.records.length)} รายการ — รายการที่เหลืออยู่ในลิงก์ “ดูเพิ่มเติม” ของผลค้นหา (ดาวน์โหลดไฟล์ .txt แล้วกด “เลือกไฟล์”)</span></p>`;
      }
      html += importMatchHTML(records);
    }
    $('#impSummary').innerHTML = html;
    const party = (role, name, phone) => `<span class="imp-party"><span class="dot ${role}"></span><span>${esc(name || '—')}${phone ? ` · <span class="tel">${esc(phone)}</span>` : ''}</span></span>`;
    $('#impList').innerHTML = records.slice(0, PREVIEW_MAX).map((r, i) => {
      const k = kinds[i];
      const meta = [r.date ? dateTime(r.date) : '', r.status, r.deliveredAt ? `ส่งมอบ ${dateTime(r.deliveredAt)}` : '',
        r.productType, r.weight, r.size, r.fee ? `ค่าขนส่ง ${r.fee}` : '']
        .filter(Boolean).map(esc).join(' · ');
      return `
        <li class="imp-row ${k.kind}">
          <label>
            <input type="checkbox" data-i="${i}"${checked[i] ? ' checked' : ''}${r.tracking ? '' : ' disabled'}>
            <span class="imp-main">
              <span class="imp-top"><b class="code">${esc(r.tracking || '—')}</b><span class="imp-badge ${k.kind}">${k.label}</span></span>
              ${meta ? `<span class="imp-meta">${meta}</span>` : ''}
              ${party('send', r.sender, r.senderPhone)}
              ${party('recv', r.receiver, r.receiverPhone)}
              ${r.customer || r.customerPhone ? party('cust', r.customer ? `ลูกค้า ${r.customer}` : 'ลูกค้า', r.customerPhone) : ''}
              ${r.idCard ? `<span class="imp-party">${icon('idcard')}<span>บัตรประชาชนผู้ฝากส่ง <span class="tel">${esc(formatIdCard(r.idCard))}</span></span></span>` : ''}
            </span>
          </label>
        </li>`;
    }).join('') + (records.length > PREVIEW_MAX
      ? `<li class="imp-more">แสดง ${num(PREVIEW_MAX)} รายการแรกให้ตรวจ — อีก ${num(records.length - PREVIEW_MAX)} รายการจะนำเข้าด้วย</li>`
      : '');
    updateImportButton();
  }

  function updateImportButton() {
    const selected = imp.records.filter((r, i) => imp.checked[i] && r.tracking).length;
    const go = $('#impGo');
    go.disabled = !selected;
    $('span', go).textContent = selected ? `นำเข้า ${num(selected)} รายการ` : 'นำเข้า';
  }

  async function runImport() {
    if (!imp.records.length) return;
    const opts = importOptions();
    const now = Date.now();
    const index = trackingIndex();
    const toSave = [];
    const ids = [];
    const counts = { created: 0, updated: 0, same: 0 };
    imp.records.forEach((r, i) => {
      if (!imp.checked[i] || !r.tracking) return;
      const ex = index.get(codeKey(r.tracking));
      if (ex) {
        ids.push(ex.id);
        const merged = mergeParcel(ex, r, opts, now);
        if (merged) {
          toSave.push(merged);
          counts.updated += 1;
        } else {
          counts.same += 1;
        }
      } else {
        const p = parcelFromImport(r, opts, now);
        toSave.push(p);
        ids.push(p.id);
        counts.created += 1;
      }
    });
    const go = $('#impGo');
    go.disabled = true;
    try {
      if (toSave.length) await ParcelDB.putParcels(toSave);
      await reload();
    } catch (err) {
      console.error(err);
      toast('นำเข้าไม่สำเร็จ กรุณาลองอีกครั้ง', 'error');
      go.disabled = false;
      return;
    }
    broadcast();
    requestPersist();
    const q = imp.result.query;
    imp.done = { ...counts, ids, queryKey: q ? `p:${digits(q.phone)}` : null };
    renderImport();
  }

  // เครือข่ายที่พัสดุชุดที่นำเข้าอยู่ (เครือข่ายของเบอร์ที่ค้นหาขึ้นก่อน แล้วเรียงตามจำนวนพัสดุ)
  function importGroups() {
    const d = imp.done;
    const net = state.net;
    const node = d.queryKey && net.nodeByKey.get(d.queryKey);
    const first = node && node.group;
    const groups = [...new Set(d.ids.map((id) => net.parcelGroup.get(id)).filter((g) => g && g.isNetwork))];
    return groups.sort((a, b) => (b === first) - (a === first) || b.parcelCount - a.parcelCount || a.index - b.index);
  }

  function importDoneHTML() {
    const d = imp.done;
    const bits = [];
    if (d.created) bits.push(`เพิ่มใหม่ ${num(d.created)}`);
    if (d.updated) bits.push(`เติมข้อมูล ${num(d.updated)}`);
    if (d.same) bits.push(`ไม่มีข้อมูลใหม่ ${num(d.same)}`);
    const groups = importGroups();
    let matched = '';
    if (groups.length === 1) {
      const g = groups[0];
      matched = `<p class="muted">จับคู่อยู่ใน <b>${esc(g.label)}</b> · ${num(g.parcelCount)} พัสดุ · ${num(g.phoneCount)} หมายเลข</p>`;
    } else if (groups.length > 1) {
      matched = `<p class="muted">จับคู่ได้ <b>${num(groups.length)} เครือข่าย</b>: ${groups.slice(0, 4).map((g) => `${esc(g.label)} (${num(g.parcelCount)} พัสดุ · ${num(g.phoneCount)} หมายเลข)`).join(' · ')}${groups.length > 4 ? ' …' : ''}</p>`;
    }
    return `
      <div class="imp-done-icon">${icon('check')}</div>
      <h3>นำเข้าเรียบร้อย</h3>
      <p>${bits.join(' · ') || 'ไม่มีรายการที่เปลี่ยนแปลง'}</p>
      ${matched}
      <div class="net-actions">
        <button type="button" class="btn primary" data-imp="graph">${icon('graph')}<span>ดูกราฟเครือข่าย</span></button>
        <button type="button" class="btn" data-imp="list">${icon('list')}<span>ดูรายการที่นำเข้า</span></button>
        <button type="button" class="btn" data-imp="more">${icon('paste')}<span>นำเข้าเพิ่ม</span></button>
      </div>`;
  }

  function onImportDone(action) {
    const d = imp.done;
    if (!d) return;
    if (action === 'more') {
      openImport('');
      return;
    }
    $('#importDialog').close();
    if (action === 'list') {
      state.group = { index: null, label: 'รายการที่นำเข้าล่าสุด', ids: new Set(d.ids) };
      go('#/list');
      applyFilters();
      window.scrollTo(0, 0);
      return;
    }
    const groups = importGroups();
    const key = d.queryKey || null;
    if (groups.length === 1) {
      showGroupGraph(groups[0].index, key);
    } else {
      state.graphShow = groups.length ? 'networks' : 'all';
      graph.pendingKey = key;
      go('#/graph');
    }
  }

  // ═════════ กล่องยืนยัน · แจ้งเตือน · หน้าต่าง ═════════
  let toastsNeedRaise = false;

  function openModal(dlg) {
    if (!dlg.open) dlg.showModal();
    toastsNeedRaise = true;
  }

  function confirmBox({ title, body = '', ok = 'ตกลง', cancel = 'ยกเลิก', danger = false }) {
    const dlg = $('#confirmDialog');
    $('#cfTitle').textContent = title;
    $('#cfBody').textContent = body;
    const okBtn = $('#cfOk');
    okBtn.textContent = ok;
    okBtn.className = `btn ${danger ? 'danger' : 'primary'}`;
    $('#cfCancel').textContent = cancel;
    dlg.returnValue = '';
    openModal(dlg);
    (danger ? $('#cfCancel') : okBtn).focus();
    return new Promise((resolve) => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    });
  }

  function toast(message, type = 'info', ms = 3200) {
    const host = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = `${icon(type === 'error' ? 'alert' : type === 'ok' ? 'check' : 'info')}<span></span>`;
    $('span', el).textContent = message;
    host.append(el);
    // ให้แจ้งเตือนอยู่เหนือหน้าต่างที่เปิดอยู่ (popover อยู่ใน top layer)
    if (host.showPopover) {
      try {
        if (!host.matches(':popover-open')) host.showPopover();
        else if (toastsNeedRaise) {
          host.hidePopover();
          host.showPopover();
        }
        toastsNeedRaise = false;
      } catch {
        /* เบราว์เซอร์เก่า: แสดงแบบปกติ */
      }
    }
    if (ms) setTimeout(() => dismissToast(el), ms);
    return el;
  }

  function dismissToast(el) {
    if (!el || !el.isConnected) return;
    el.classList.add('leaving');
    setTimeout(() => {
      el.remove();
      const host = $('#toasts');
      if (!host.children.length && host.hidePopover) {
        try { host.hidePopover(); } catch { /* ไม่เป็นไร */ }
      }
    }, 220);
  }

  async function copyText(text, message, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      (document.querySelector('dialog[open]') || document.body).append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (btn) {
      btn.classList.add('done');
      setTimeout(() => btn.classList.remove('done'), 1200);
    }
    toast(message, 'ok', 1800);
  }

  // ═════════ เครือข่าย ═════════
  function refreshNetwork() {
    state.net = Network.build(state.parcels, { linkNames: state.linkNames, names: state.netNames });
    state.netVersion += 1;
    resolveGroupFilter();
    $('#countGroups').textContent = state.net.networks.length ? num(state.net.networks.length) : '';
  }

  function dataChanged() {
    state.parcels.sort(byDate);
    refreshNetwork();
    rebuildPeople();
    rebuildOptions();
    applyFilters({ keep: true });
    refreshAnalysisViews();
    renderBanner();
  }

  function refreshAnalysisViews() {
    if (state.view === 'graph') renderGraph();
    else if (state.view === 'groups') renderGroups();
    const dlg = $('#detailDialog');
    if (dlg.open && state.detailId) {
      if (findParcel(state.detailId)) openDetail(state.detailId);
      else dlg.close();
    }
  }

  // ไอคอนกล่องพัสดุตามบทบาท — ตรงกับกล่องในกราฟ
  const roleDot = (n) => Network.boxIcon(n);
  const nodeLabel = (n) => `<b class="${n.type === 'phone' ? 'code' : ''}">${esc(n.label)}</b>`;

  // ── กราฟเชื่อมโยง ──
  const graph = { view: null, version: -1, show: '', edge: null, pendingKey: null };

  function renderGraph() {
    if (!graph.view) {
      graph.view = new Network.GraphView($('#graphStage'), {
        onSelect: () => {
          graph.edge = null;
          renderGraphPanel();
        },
        onEdge: (edge) => {
          graph.edge = edge;
          graph.view.select(null, { silent: true });
          renderGraphPanel();
        },
      });
    }
    const view = graph.view;
    const net = state.net;
    if (state.graphShow.startsWith('g') && !net.networks.some((g) => `g${g.index}` === state.graphShow)) {
      state.graphShow = 'networks';
    }
    fillShowSelect();
    $('#gRename').hidden = !state.graphShow.startsWith('g');
    if (graph.version !== state.netVersion || graph.show !== state.graphShow) {
      const prevKey = graph.pendingKey || (view.selected && view.selected.key);
      const show = state.graphShow.startsWith('g') ? Number(state.graphShow.slice(1)) : state.graphShow;
      // จัดตำแหน่งตามขนาดกรอบกราฟ ให้แผนผังเต็มกรอบ (จัดใหม่เองเมื่อขนาดหน้าต่างเปลี่ยน)
      view.setScene((area) => Network.scene(net, show, area));
      graph.version = state.netVersion;
      graph.show = state.graphShow;
      graph.edge = null;
      const again = prevKey ? view.nodes.find((n) => n.key === prevKey) : null;
      if (again && graph.pendingKey) view.select(again, { center: true, silent: true });
      else view.select(again || null, { silent: true });
      applyGraphSearch();
    } else if (graph.pendingKey) {
      const n = view.nodes.find((x) => x.key === graph.pendingKey);
      if (n) view.select(n, { center: true, silent: true });
    }
    graph.pendingKey = null;
    $('#graphEmpty').hidden = view.nodes.length > 0;
    renderGraphPanel();
  }

  function fillShowSelect() {
    const net = state.net;
    const opts = [
      `<option value="networks">ทุกเครือข่าย (${num(net.networks.length)})</option>`,
      '<option value="all">ทั้งหมด รวมพัสดุเดี่ยว</option>',
    ];
    if (net.networks.length) {
      opts.push(`<optgroup label="เลือกเครือข่าย">${net.networks.map((g) => `<option value="g${g.index}">${esc(g.label)}${g.customName ? ` (${esc(g.autoLabel)})` : ''} — ${num(g.parcelCount)} พัสดุ · ${num(g.phoneCount)} หมายเลข</option>`).join('')}</optgroup>`);
    }
    const sel = $('#gShow');
    sel.innerHTML = opts.join('');
    sel.value = state.graphShow;
  }

  function applyGraphSearch() {
    const view = graph.view;
    if (!view) return [];
    const terms = parseTerms($('#gSearch').value);
    const found = [];
    if (terms.length) {
      for (const n of view.nodes) {
        const ok = terms.every((t) => (t.phones.length && n.digits && t.phones.some((d) => n.digits.includes(d)))
          || (t.text && n.search.includes(t.text)));
        if (ok) found.push(n);
      }
    }
    found.sort((a, b) => b.degree - a.degree || b.count - a.count);
    view.setMatches(new Set(found));
    $('#gFound').textContent = terms.length ? (found.length ? `พบ ${num(found.length)}` : 'ไม่พบ') : '';
    return found;
  }

  function renderGraphPanel() {
    const panel = $('#graphPanel');
    const n = graph.view && graph.view.selected;
    if (n) panel.innerHTML = nodePanelHTML(n);
    else if (graph.edge) panel.innerHTML = edgePanelHTML(graph.edge);
    else panel.innerHTML = overviewPanelHTML();
  }

  function overviewPanelHTML() {
    const net = state.net;
    const nodes = graph.view ? graph.view.nodes : [];
    const top = [...nodes].sort((a, b) => b.degree - a.degree || b.count - a.count).slice(0, 20);
    return `
      <h2 class="panel-title">ภาพรวม</h2>
      <div class="mini-stats">
        <div><b>${num(net.networks.length)}</b><span>เครือข่าย</span></div>
        <div><b>${num(net.nodes.filter((x) => x.type === 'phone').length)}</b><span>หมายเลข</span></div>
        <div><b>${num(state.parcels.length)}</b><span>พัสดุ</span></div>
      </div>
      <p class="panel-hint">${icon('info')}<span>คลิกจุดเพื่อดูรายละเอียดหมายเลข · ลากพื้นหลังเพื่อเลื่อน · หมุนล้อเมาส์เพื่อซูม · ดับเบิลคลิกจุดเพื่อขยายเฉพาะหมายเลขที่เชื่อมกัน</span></p>
      ${top.length ? `
        <h3 class="panel-sub">หมายเลขที่เชื่อมโยงมากที่สุด</h3>
        <ol class="rank-list">${top.map((x) => `
          <li><button type="button" data-node="${esc(x.key)}">
            ${roleDot(x)}
            <span class="rk-main">${nodeLabel(x)}${x.topName ? `<small>${esc(x.topName)}</small>` : ''}</span>
            <span class="rk-num"><b>${num(x.degree)}</b> เชื่อม · ${num(x.count)} ชิ้น</span>
          </button></li>`).join('')}</ol>` : ''}`;
  }

  function linkText(L) {
    const parts = [];
    if (L.out) parts.push(`ส่งไป ${num(L.out)}`);
    if (L.in) parts.push(`รับจาก ${num(L.in)}`);
    if (L.custOut) parts.push(`ฝากส่งให้ ${num(L.custOut)}`);
    if (L.custIn) parts.push(`ลูกค้าฝากส่ง ${num(L.custIn)}`);
    if (L.reason) parts.push(L.reason);
    return parts.join(' · ');
  }

  function nodePanelHTML(n) {
    const links = new Map();
    for (const e of n.group.edges) {
      if (e.source !== n && e.target !== n) continue;
      const other = e.source === n ? e.target : e.source;
      const L = links.get(other) || { node: other, out: 0, in: 0, custOut: 0, custIn: 0, reason: '' };
      if (e.type === 'name') L.reason = e.reason || 'ชื่อเดียวกัน';
      else if (e.type === 'cust') {
        if (e.source === n) L.custOut += e.parcels.length;
        else L.custIn += e.parcels.length;
      } else if (e.source === n) L.out += e.parcels.length;
      else L.in += e.parcels.length;
      links.set(other, L);
    }
    const weight = (L) => L.out + L.in + L.custOut + L.custIn;
    const linkList = [...links.values()].sort((a, b) => weight(b) - weight(a));
    const items = [...n.items].sort((a, b) => b.parcel.date - a.parcel.date);
    const g = n.group;
    const names = n.type === 'phone' && n.nameList.length
      ? `<div class="kv"><span>ชื่อที่ใช้</span><span class="tags">${n.nameList.map((nm) => `<span class="tag">${esc(nm)}${n.names.get(nm) > 1 ? ` <small>×${n.names.get(nm)}</small>` : ''}</span>`).join('')}</span></div>`
      : '';
    const addresses = n.addressList.length
      ? `<div class="kv"><span>ที่อยู่ที่ใช้</span><span class="addr-list">${n.addressList.slice(0, 5).map((a) => `<span>${esc(a)}${n.addresses.get(a) > 1 ? ` <small>×${n.addresses.get(a)}</small>` : ''}</span>`).join('')}</span></div>`
      : '';
    const idCards = n.idCardList.length
      ? `<div class="kv"><span>บัตรประชาชนผู้ฝากส่ง</span><span class="tags">${n.idCardList.map((id) => `<span class="tag tel">${esc(id)}${n.idCards.get(id) > 1 ? ` <small>×${n.idCards.get(id)}</small>` : ''}</span>`).join('')}</span></div>`
      : '';
    return `
      <button type="button" class="back-btn" data-panel="back">${icon('arrow-left')}<span>ภาพรวม</span></button>
      <div class="node-card">
        <div class="node-role">${roleDot(n)}<span>${ROLE_LABEL[n.role]}${n.type === 'name' ? ' · ไม่มีเบอร์โทร' : ''}</span></div>
        <div class="node-title${n.type === 'phone' ? ' code' : ''}">${esc(n.label)}</div>
        <div class="node-actions">
          <button type="button" class="btn small" data-copy-text="${esc(n.label)}">${icon('copy')}<span>คัดลอก</span></button>
          <button type="button" class="btn small" data-find="${esc(n.label)}">${icon('search')}<span>ค้นหาในรายการพัสดุ</span></button>
        </div>
        <div class="mini-stats">
          <div><b>${num(n.sent)}</b><span>ส่ง</span></div>
          <div><b>${num(n.received)}</b><span>รับ</span></div>
          ${n.booked ? `<div><b>${num(n.booked)}</b><span>ฝากส่ง (ลูกค้า)</span></div>` : ''}
          <div><b>${num(n.degree)}</b><span>เชื่อมกับ</span></div>
        </div>
        ${names}
        ${idCards}
        ${addresses}
        ${g.isNetwork ? `<div class="kv"><span>อยู่ใน</span><span class="kv-net"><button type="button" class="link-btn" data-focus-group="${g.index}">${esc(g.label)}</button> <small class="muted">${num(g.parcelCount)} พัสดุ</small><button type="button" class="icon-btn sm" data-rename="${g.index}" title="ตั้งชื่อเครือข่าย" aria-label="ตั้งชื่อเครือข่าย">${icon('pencil')}</button></span></div>` : ''}
      </div>
      ${linkList.length ? `
        <h3 class="panel-sub">หมายเลขที่เชื่อมโยง (${num(linkList.length)})</h3>
        <ul class="rank-list">${linkList.map((L) => `
          <li><button type="button" data-node="${esc(L.node.key)}">
            ${roleDot(L.node)}
            <span class="rk-main">${nodeLabel(L.node)}${L.node.topName ? `<small>${esc(L.node.topName)}</small>` : ''}</span>
            <span class="rk-num">${linkText(L)}</span>
          </button></li>`).join('')}</ul>` : ''}
      <h3 class="panel-sub">พัสดุที่เกี่ยวข้อง (${num(items.length)})</h3>
      <ul class="mini-list">${items.slice(0, 50).map(({ parcel: p, role }) => `
        <li><button type="button" data-open="${esc(p.id)}">
          <span class="code">${esc(p.tracking)}</span>
          <span class="mini-meta">${esc(date(p.date))} · ${role === 'send' ? 'เป็นผู้ส่ง' : role === 'recv' ? 'เป็นผู้รับ' : 'เป็นลูกค้าผู้ฝากส่ง'}${p.drug ? ` · ${esc(p.drug)}` : ''}</span>
        </button></li>`).join('')}</ul>`;
  }

  function edgePanelHTML(e) {
    const isName = e.type === 'name';
    const isCust = e.type === 'cust';
    const title = isName ? `ใช้${esc(e.reason || 'ชื่อเดียวกัน')}` : isCust ? `ลูกค้าฝากส่ง ${num(e.parcels.length)} ชิ้น` : `ส่งพัสดุ ${num(e.parcels.length)} ชิ้น`;
    return `
      <button type="button" class="back-btn" data-panel="back">${icon('arrow-left')}<span>ภาพรวม</span></button>
      <div class="node-card">
        <div class="node-role"><span>${title}</span></div>
        <div class="edge-ends">
          <button type="button" data-node="${esc(e.source.key)}">${roleDot(e.source)}${nodeLabel(e.source)}</button>
          <span class="edge-arrow" aria-hidden="true">${isName ? '↔' : isCust ? '⇢' : '→'}</span>
          <button type="button" data-node="${esc(e.target.key)}">${roleDot(e.target)}${nodeLabel(e.target)}</button>
        </div>
        ${isName ? `<div class="kv"><span>${{ 'ที่อยู่เดียวกัน': 'ที่อยู่', 'เลขบัตรประชาชนเดียวกัน': 'เลขบัตรประชาชน' }[e.reason] || 'ชื่อ'}</span><span>${esc(e.name)}</span></div>` : ''}
      </div>
      ${e.parcels.length ? `
        <h3 class="panel-sub">พัสดุ</h3>
        <ul class="mini-list">${e.parcels.map((p) => `
          <li><button type="button" data-open="${esc(p.id)}">
            <span class="code">${esc(p.tracking)}</span>
            <span class="mini-meta">${esc(date(p.date))}${p.drug ? ` · ${esc(p.drug)}` : ''}${p.amount ? ` ${esc(p.amount)}` : ''}</span>
          </button></li>`).join('')}</ul>` : ''}`;
  }

  async function exportGraphImage() {
    const view = graph.view;
    if (!view || !view.nodes.length) {
      toast('ยังไม่มีกราฟให้บันทึก', 'error');
      return;
    }
    const opt = $('#gShow').selectedOptions[0];
    const blob = await view.exportPNG({
      title: 'กราฟเชื่อมโยงหมายเลข — ระบบบันทึกพัสดุยาเสพติด',
      subtitle: `${UNIT} · แสดง: ${opt ? opt.textContent : ''} · ส่งออกเมื่อ ${dateTime(Date.now())}`,
    });
    if (!blob) {
      toast('บันทึกภาพไม่สำเร็จ', 'error');
      return;
    }
    download(blob, `กราฟเชื่อมโยง-${fileStamp()}.png`);
    toast('บันทึกภาพกราฟแล้ว', 'ok');
  }

  // ── กลุ่มเครือข่าย ──
  function renderGroups() {
    const net = state.net;
    const total = state.parcels.length;
    const inNet = net.networks.reduce((s, g) => s + g.parcelCount, 0);
    const phones = net.networks.reduce((s, g) => s + g.phoneCount, 0);
    $('#groupStats').innerHTML = `
      <div class="stat"><span class="stat-label">เครือข่าย</span><b>${num(net.networks.length)}</b></div>
      <div class="stat"><span class="stat-label">หมายเลขในเครือข่าย</span><b>${num(phones)}</b></div>
      <div class="stat"><span class="stat-label">พัสดุที่เชื่อมโยงกัน</span><b>${num(inNet)}</b><small>จาก ${num(total)} รายการ</small></div>
      <div class="stat"><span class="stat-label">พัสดุเดี่ยว</span><b>${num(total - inNet)}</b><small>ยังไม่พบการเชื่อมโยง</small></div>`;

    const q = $('#groupSearch').value;
    const terms = parseTerms(q);
    const nameHit = (g) => !!g.customName && terms.every((t) => lower(g.customName).includes(t.text));
    let list = net.networks.filter((g) => !terms.length || nameHit(g) || g.parcels.some((p) => matches(p, terms)));
    if ($('#groupSort').value === 'recent') list = [...list].sort((a, b) => b.last - a.last);
    const grid = $('#groupGrid');
    grid.innerHTML = list.map(groupCardHTML).join('');

    const empty = $('#groupsEmpty');
    empty.hidden = list.length > 0;
    if (!list.length) {
      empty.innerHTML = !net.networks.length
        ? `<div class="empty-art">${icon('network')}</div><h2>ยังไม่พบเครือข่าย</h2><p>เมื่อพัสดุตั้งแต่ 2 รายการใช้เบอร์โทร เลขบัตรประชาชน ชื่อ หรือที่อยู่เดียวกัน ระบบจะจัดเป็นกลุ่มเครือข่ายให้อัตโนมัติ</p>`
        : `<div class="empty-art">${icon('search')}</div><h2>ไม่พบเครือข่ายที่ค้นหา</h2><p>ไม่มีเครือข่ายที่มี “${esc(q)}”</p>`;
    }
    requestAnimationFrame(() => {
      $$('canvas.gc-mini', grid).forEach((c) => {
        const g = net.networks.find((x) => x.index === Number(c.dataset.group));
        if (g) Network.drawMini(c, g);
      });
    });
  }

  function groupCardHTML(g) {
    const facts = [['ช่วงเวลา', dateRange(g.first, g.last)]];
    if (g.drugs.length) facts.push(['ของกลาง', g.drugs.slice(0, 3).map(([d, n]) => `${d} ${num(n)}`).join(' · ')]);
    if (g.couriers.length) facts.push(['ขนส่ง', g.couriers.slice(0, 3).map(([d, n]) => `${d} ${num(n)}`).join(' · ')]);
    return `
      <article class="group-card">
        <header class="gc-head">
          <div class="gc-title">
            <h3>${esc(g.label)}</h3>
            ${g.customName ? `<small>${esc(g.autoLabel)}</small>` : ''}
          </div>
          <button type="button" class="icon-btn sm" data-rename="${g.index}" title="${g.customName ? 'เปลี่ยนชื่อเครือข่าย' : 'ตั้งชื่อเครือข่าย'}" aria-label="ตั้งชื่อ${esc(g.label)}">${icon('pencil')}</button>
          <span class="pill">${num(g.parcelCount)} พัสดุ</span>
          <span class="pill">${num(g.phoneCount)} หมายเลข</span>
        </header>
        ${g.mergedNames && g.mergedNames.length ? `<p class="gc-merged">${icon('alert')}<span>เชื่อมรวมกับเครือข่ายที่ตั้งชื่อไว้: ${esc(g.mergedNames.join(', '))}</span></p>` : ''}
        <button type="button" class="gc-mini-wrap" data-graph="${g.index}" aria-label="ดูกราฟ${esc(g.label)}">
          <canvas class="gc-mini" data-group="${g.index}"></canvas>
        </button>
        <dl class="gc-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        <div class="gc-hubs">
          <h4>หมายเลขสำคัญ</h4>
          <ul class="rank-list">${g.hubs.map((n) => `
            <li><button type="button" data-hub="${g.index}" data-key="${esc(n.key)}">
              ${roleDot(n)}
              <span class="rk-main">${nodeLabel(n)}${n.topName ? `<small>${esc(n.topName)}</small>` : ''}</span>
              <span class="rk-num">ส่ง ${num(n.sent)} · รับ ${num(n.received)} · เชื่อม ${num(n.degree)}</span>
            </button></li>`).join('')}</ul>
        </div>
        <footer class="gc-actions">
          <button type="button" class="btn small" data-graph="${g.index}">${icon('graph')}<span>ดูกราฟ</span></button>
          <button type="button" class="btn small" data-list="${g.index}">${icon('list')}<span>ดูรายการพัสดุ</span></button>
        </footer>
      </article>`;
  }

  function showGroupGraph(index, key = null) {
    state.graphShow = `g${index}`;
    graph.pendingKey = key;
    go('#/graph');
  }

  function showGroupList(index) {
    setGroupFilter(index);
    go('#/list');
    window.scrollTo(0, 0);
  }

  // ── ตั้งชื่อเครือข่าย ──
  // ชื่อผูกกับหมายเลขในเครือข่ายขณะตั้งชื่อ จึงตามเครือข่ายไปแม้เลขลำดับจะเปลี่ยน
  let naming = null;

  const networkByIndex = (index) => state.net && state.net.networks.find((g) => g.index === Number(index));

  function openNameDialog(index) {
    const g = networkByIndex(index);
    if (!g) return;
    naming = { keys: g.nodes.map((n) => n.key), nameId: g.nameId || null };
    $('#nmTitle').textContent = g.customName ? 'เปลี่ยนชื่อเครือข่าย' : `ตั้งชื่อ${g.autoLabel}`;
    const hubs = g.hubs.filter((n) => n.type === 'phone').slice(0, 2).map((n) => n.label);
    $('#nmSub').textContent = `${g.autoLabel} · ${num(g.parcelCount)} พัสดุ · ${num(g.phoneCount)} หมายเลข${hubs.length ? ` · หมายเลขหลัก ${hubs.join(', ')}` : ''}`;
    $('#nmInput').value = g.customName || '';
    $('#nmClear').hidden = !g.nameId;
    openModal($('#nameDialog'));
    const input = $('#nmInput');
    input.focus();
    input.select();
  }

  async function saveNetworkName(clear = false) {
    if (!naming) return;
    const name = clean($('#nmInput').value).slice(0, 80);
    const removing = clear || !name;
    const now = Date.now();
    try {
      if (removing) {
        if (naming.nameId) await ParcelDB.deleteNetworkName(naming.nameId);
      } else {
        const ex = naming.nameId && state.netNames.find((r) => r.id === naming.nameId);
        await ParcelDB.putNetworkName(ex
          ? { ...ex, name, keys: naming.keys, updatedAt: now }
          : { id: uid(), name, keys: naming.keys, createdAt: now, updatedAt: now });
      }
      state.netNames = await ParcelDB.getNetworkNames();
    } catch (err) {
      console.error(err);
      toast('บันทึกชื่อเครือข่ายไม่สำเร็จ', 'error');
      return;
    }
    const hadName = !!naming.nameId;
    naming = null;
    $('#nameDialog').close();
    refreshNetwork();
    applyFilters({ keep: true });
    refreshAnalysisViews();
    broadcast();
    if (!removing) toast(`ตั้งชื่อเครือข่าย “${name}” แล้ว`, 'ok');
    else if (hadName) toast('ล้างชื่อเครือข่ายแล้ว — กลับไปใช้เลขลำดับ', 'ok');
  }

  // ═════════ ส่งออก · สำรอง · กู้คืน ═════════
  // ค่าที่เป็นตัวเลขล้วน (เบอร์โทร/เลขพัสดุ) ห่อเป็นข้อความ ให้ Excel ไม่ตัดเลข 0 / ไม่แปลงเป็นเลขยกกำลัง
  function csvCell(v) {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s) || (/^[\d\s\-+()]+$/.test(s) && s.replace(/\D/g, '').length >= 6)) {
      s = `="${s.replace(/"/g, '""')}"`;
    }
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function downloadCSV(rows, filename) {
    const csv = `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}`;
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename);
  }

  function exportCSV() {
    const rows = state.results;
    if (!rows.length) {
      toast('ไม่มีรายการให้ส่งออก', 'error');
      return;
    }
    const head = ['วันที่', 'เลขพัสดุ', 'บริษัทขนส่ง', 'สถานะ', 'วันส่งมอบ', 'ผู้ส่ง', 'เบอร์ผู้ส่ง', 'ที่อยู่ผู้ส่ง',
      'ผู้รับ', 'เบอร์ผู้รับ', 'ที่อยู่ผู้รับ', 'ลูกค้า (ผู้ฝากส่ง)', 'เบอร์ลูกค้า', 'เลขบัตรประชาชนผู้ฝากส่ง', 'ประเภทสินค้า', 'น้ำหนัก', 'ขนาดกล่อง',
      'ค่าขนส่ง', 'ชนิดยาเสพติด', 'จำนวน/น้ำหนักของกลาง', 'เครือข่าย', 'พิกัดส่งมอบ', 'ลิงก์ภาพรับพัสดุ',
      'ข้อมูลเพิ่มเติม', 'หมายเหตุ', 'จำนวนไฟล์แนบ', 'ที่มา', 'บันทึกเข้าระบบ'];
    const body = rows.map((p) => {
      const g = state.net.parcelGroup.get(p.id);
      return [p.dateAuto ? '' : dateTime(p.date), p.tracking, p.courier, p.status, p.deliveredAt ? dateTime(p.deliveredAt) : '',
        p.sender, p.senderPhone, p.senderAddress, p.receiver, p.receiverPhone, p.receiverAddress,
        p.customer, p.customerPhone, p.idCard ? formatIdCard(p.idCard) : '', p.productType, p.weight, p.size, p.fee,
        p.drug, p.amount, g && g.isNetwork ? g.label : '', p.geo, p.links.map((l) => l.url).join(' '),
        p.extras.map((e) => `${e.label}: ${e.value}`).join(' | '),
        p.note, p.photoIds.length, p.origin, dateTime(p.createdAt)];
    });
    downloadCSV([head, ...body], `รายการพัสดุยาเสพติด-${fileStamp()}.csv`);
    toast(`ส่งออก ${num(rows.length)} รายการแล้ว`, 'ok');
  }

  function exportNumbers() {
    const nodes = state.net.nodes.filter((n) => n.type === 'phone');
    if (!nodes.length) {
      toast('ยังไม่มีหมายเลขให้ส่งออก', 'error');
      return;
    }
    nodes.sort((a, b) => (a.group.index || 1e9) - (b.group.index || 1e9) || b.degree - a.degree || b.count - a.count);
    const head = ['เครือข่าย', 'หมายเลข', 'บทบาท', 'ชื่อที่ใช้', 'เลขบัตรประชาชน (ผู้ฝากส่ง)', 'ที่อยู่ที่ใช้', 'จำนวนที่ส่ง', 'จำนวนที่รับ',
      'จำนวนที่ฝากส่ง (ลูกค้า)', 'เชื่อมกับ (หมายเลข)', 'หมายเลข/ชื่อที่เชื่อมโยง', 'เลขพัสดุที่เกี่ยวข้อง'];
    const body = nodes.map((n) => [
      n.group.isNetwork ? n.group.label : 'พัสดุเดี่ยว',
      n.phone,
      ROLE_LABEL[n.role],
      n.nameList.join(', '),
      n.idCardList.join(', '),
      n.addressList.join(' | '),
      n.sent,
      n.received,
      n.booked,
      n.degree,
      [...n.neighbors].map((m) => m.label).join(', '),
      [...new Set(n.items.map((it) => it.parcel.tracking))].join(', '),
    ]);
    downloadCSV([head, ...body], `หมายเลขและเครือข่าย-${fileStamp()}.csv`);
    toast(`ส่งออก ${num(nodes.length)} หมายเลขแล้ว`, 'ok');
  }

  const blobToBase64 = async (blob) => {
    const url = await blobToDataURL(blob);
    return url.slice(url.indexOf(',') + 1);
  };

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // ไฟล์สำรอง (.jsonl): บรรทัดแรกเป็นหัวไฟล์ ตามด้วยพัสดุทีละบรรทัด
  // ไฟล์แนบเขียนเป็นข้อมูลย่อ 1 บรรทัด + เนื้อไฟล์แบ่งเป็นชิ้น ๆ (รองรับไฟล์ขนาดใหญ่ไม่จำกัด)
  async function backup() {
    if (!state.parcels.length) {
      toast('ยังไม่มีข้อมูลให้สำรอง', 'error');
      return;
    }
    const note = toast('กำลังสำรองข้อมูล…', 'info', 0);
    try {
      const parts = [`${JSON.stringify({ app: 'parcel-log', format: 2, unit: UNIT, exportedAt: Date.now(), count: state.parcels.length })}\n`];
      let files = 0;
      for (const p of state.parcels) {
        parts.push(new Blob([`${JSON.stringify({ parcel: { ...p } })}\n`]));
        for (const id of p.photoIds) {
          const a = await ParcelDB.getPhoto(id);
          if (!a || !a.full) continue;
          files += 1;
          const meta = {
            id: a.id, parcelId: p.id, name: a.name || '', type: a.type || a.full.type || '', size: a.full.size,
            width: a.width || 0, height: a.height || 0, createdAt: a.createdAt || 0,
            thumb: a.thumb ? await blobToDataURL(a.thumb) : null,
          };
          parts.push(new Blob([`${JSON.stringify({ attachment: meta })}\n`]));
          for (let off = 0, i = 0; off < a.full.size; off += CHUNK, i++) {
            const data = await blobToBase64(a.full.slice(off, off + CHUNK));
            parts.push(new Blob([`{"chunk":{"id":${JSON.stringify(a.id)},"i":${i},"data":"${data}"}}\n`]));
          }
        }
      }
      for (const rec of state.netNames) parts.push(new Blob([`${JSON.stringify({ network: rec })}\n`]));
      download(new Blob(parts, { type: 'application/x-ndjson' }), `สำรองข้อมูลพัสดุ-${fileStamp()}.jsonl`);
      store.set('lastBackup', Date.now());
      renderBanner();
      toast(`สำรองข้อมูล ${num(state.parcels.length)} รายการ · ไฟล์แนบ ${num(files)} ไฟล์ — เก็บไฟล์ไว้ในที่ปลอดภัย`, 'ok', 5000);
    } catch (err) {
      console.error(err);
      toast('สำรองข้อมูลไม่สำเร็จ', 'error');
    } finally {
      dismissToast(note);
    }
  }

  async function readLines(file, onLine) {
    if (file.stream && 'TextDecoderStream' in window) {
      const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let start = 0;
        let nl;
        while ((nl = buf.indexOf('\n', start)) !== -1) {
          await onLine(buf.slice(start, nl));
          start = nl + 1;
        }
        buf = buf.slice(start);
      }
      if (buf) await onLine(buf);
      return;
    }
    for (const line of (await file.text()).split('\n')) await onLine(line);
  }

  const cut = (v, max) => String(v ?? '').slice(0, max);
  const finite = (v) => (Number.isFinite(v) ? v : null);

  function sanitizeParcel(src) {
    const createdAt = finite(src.createdAt) ?? Date.now();
    const links = (Array.isArray(src.links) ? src.links : [])
      .filter((l) => l && typeof l.url === 'string' && /^https?:\/\//i.test(l.url))
      .slice(0, 30)
      .map((l) => ({ label: cut(l.label, 80), url: cut(l.url, 1000) }));
    return {
      id: cut(src.id, 100) || uid(),
      tracking: cleanCode(cut(src.tracking, 100)),
      courier: cut(src.courier, 100),
      date: finite(src.date) ?? createdAt,
      dateAuto: src.dateAuto === true,
      deliveredAt: finite(src.deliveredAt),
      status: cut(src.status, 100),
      sender: cut(src.sender, 200),
      senderPhone: cut(src.senderPhone, 50),
      senderAddress: cut(src.senderAddress, 500),
      receiver: cut(src.receiver, 200),
      receiverPhone: cut(src.receiverPhone, 50),
      receiverAddress: cut(src.receiverAddress, 500),
      customer: cut(src.customer, 200),
      customerPhone: cut(src.customerPhone, 50),
      idCard: cut(src.idCard, 30),
      productType: cut(src.productType, 100),
      weight: cut(src.weight, 50),
      size: cut(src.size, 60),
      fee: cut(src.fee, 50),
      extras: (Array.isArray(src.extras) ? src.extras : [])
        .filter((e) => e && e.label && e.value)
        .slice(0, 60)
        .map((e) => ({ label: cut(e.label, 80), value: cut(e.value, 500) })),
      drug: cut(src.drug, 100),
      amount: cut(src.amount, 100),
      note: cut(src.note, 5000),
      geo: /^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$/.test(src.geo || '') ? src.geo : '',
      links,
      origin: cut(src.origin, 200),
      photoIds: (Array.isArray(src.photoIds) ? src.photoIds : []).map((x) => cut(x, 100)).filter(Boolean),
      coverId: cut(src.coverId, 100),
      createdAt,
      updatedAt: finite(src.updatedAt) ?? createdAt,
    };
  }

  function sanitizeNetworkName(rec) {
    const name = clean(cut(rec && rec.name, 80));
    const keys = (Array.isArray(rec && rec.keys) ? rec.keys : [])
      .map((k) => cut(k, 200))
      .filter((k) => /^[pn]:/.test(k))
      .slice(0, 5000);
    if (!name || !keys.length) return null;
    const now = Date.now();
    return {
      id: cut(rec.id, 100) || uid(),
      name,
      keys,
      createdAt: finite(rec.createdAt) ?? now,
      updatedAt: finite(rec.updatedAt) ?? now,
    };
  }

  // ไฟล์สำรองรูปแบบเดิม (format 1): { parcel, photos: [{ full, thumb (data URL) }] }
  function sanitizeLegacyItem(obj) {
    const parcel = sanitizeParcel(obj.parcel);
    const photos = [];
    for (const ph of obj.photos) {
      if (!ph || typeof ph.full !== 'string' || !ph.full.startsWith('data:')) continue;
      try {
        const full = dataURLToBlob(ph.full);
        const thumb = typeof ph.thumb === 'string' && ph.thumb.startsWith('data:image/') ? dataURLToBlob(ph.thumb) : null;
        photos.push({
          id: cut(ph.id, 100) || uid(), parcelId: parcel.id, full, thumb, name: cut(ph.name, 200), type: full.type,
          size: full.size, width: Number(ph.width) || 0, height: Number(ph.height) || 0, createdAt: Number(ph.createdAt) || Date.now(),
        });
      } catch {
        /* รูปเสีย ข้ามไป */
      }
    }
    parcel.photoIds = photos.map((ph) => ph.id);
    if (!parcel.photoIds.includes(parcel.coverId)) parcel.coverId = (photos.find((ph) => ph.thumb) || {}).id || '';
    return { parcel, photos };
  }

  async function restore(file) {
    const note = toast('กำลังกู้คืนข้อมูล…', 'info', 0);
    let header = null;
    let count = 0;
    let files = 0;
    let legacy = [];
    let current = null; // ไฟล์แนบที่กำลังประกอบชิ้นข้อมูล
    let lastParcelId = null;
    const flushLegacy = async () => {
      if (!legacy.length) return;
      await ParcelDB.importItems(legacy);
      count += legacy.length;
      legacy = [];
    };
    const finishAttachment = async () => {
      if (!current) return;
      const { meta, parts } = current;
      current = null;
      const full = new Blob(parts, { type: meta.type || 'application/octet-stream' });
      await ParcelDB.putAttachment({ ...meta, full, size: full.size });
      files += 1;
    };
    try {
      await readLines(file, async (raw) => {
        const line = raw.replace(/^﻿/, '').trim();
        if (!line) return;
        const obj = JSON.parse(line);
        if (!header) {
          if (!obj || obj.app !== 'parcel-log') throw new Error('not-backup');
          header = obj;
          return;
        }
        if (obj.chunk) {
          if (current && obj.chunk.id === current.meta.id && typeof obj.chunk.data === 'string') {
            current.parts.push(base64ToBytes(obj.chunk.data));
          }
          return;
        }
        await finishAttachment();
        if (obj.network) {
          const rec = sanitizeNetworkName(obj.network);
          if (rec) await ParcelDB.putNetworkName(rec);
          return;
        }
        if (obj.attachment) {
          const a = obj.attachment;
          if (!lastParcelId) return;
          let thumb = null;
          if (typeof a.thumb === 'string' && a.thumb.startsWith('data:image/')) {
            try { thumb = dataURLToBlob(a.thumb); } catch { thumb = null; }
          }
          current = {
            meta: {
              id: cut(a.id, 100) || uid(), parcelId: lastParcelId, name: cut(a.name, 200), type: cut(a.type, 100),
              width: Number(a.width) || 0, height: Number(a.height) || 0, createdAt: Number(a.createdAt) || Date.now(), thumb,
            },
            parts: [],
          };
          return;
        }
        if (obj.parcel && typeof obj.parcel === 'object') {
          if (Array.isArray(obj.photos)) {
            legacy.push(sanitizeLegacyItem(obj));
            if (legacy.length >= 20) await flushLegacy();
            return;
          }
          const parcel = sanitizeParcel(obj.parcel);
          await ParcelDB.replaceParcel(parcel);
          lastParcelId = parcel.id;
          count += 1;
        }
      });
      await finishAttachment();
      await flushLegacy();
      if (!header) throw new Error('not-backup');
      metaCache.clear();
      await reload();
      broadcast();
      toast(`กู้คืนข้อมูลแล้ว ${num(count)} รายการ${files ? ` · ไฟล์แนบ ${num(files)} ไฟล์` : ''}`, 'ok', 5000);
    } catch (err) {
      console.error(err);
      toast(err && (err.message === 'not-backup' || err instanceof SyntaxError)
        ? 'ไฟล์นี้ไม่ใช่ไฟล์สำรองของระบบบันทึกพัสดุ'
        : 'กู้คืนข้อมูลไม่สำเร็จ', 'error', 5000);
      if (count) await reload().catch(() => {});
    } finally {
      dismissToast(note);
    }
  }

  async function reload() {
    const [all, names] = await Promise.all([ParcelDB.getAllParcels(), ParcelDB.getNetworkNames()]);
    state.parcels = all.map(prepare);
    state.netNames = names;
    dataChanged();
  }

  // ── เมนู ──
  function toggleMenu(open) {
    const menu = $('#menu');
    const show = open ?? menu.hidden;
    menu.hidden = !show;
    $('#btnMenu').setAttribute('aria-expanded', String(show));
    if (!show) return;
    const n = state.results.length;
    $('#csvHint').textContent = n === state.parcels.length ? `ทุกรายการ (${num(n)})` : `เฉพาะผลการค้นหา ${num(n)} รายการ`;
    updateMenuFoot();
    $('[role="menuitem"]', menu).focus();
  }

  async function updateMenuFoot() {
    const last = store.get('lastBackup', 0);
    let usage = '';
    try {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      if (est && est.usage != null) {
        usage = ` · ใช้พื้นที่ ${formatBytes(est.usage)}`;
        if (est.quota) usage += ` จากที่ใช้ได้ ${formatBytes(est.quota)}`;
      }
    } catch {
      /* ไม่ทราบขนาด */
    }
    const lines = [
      `ข้อมูลเก็บในเบราว์เซอร์เครื่องนี้${usage}`,
      `สำรองล่าสุด: ${last ? dateTime(last) : 'ยังไม่เคยสำรอง'}`,
    ];
    if (document.documentElement.classList.contains('no-logo')) lines.push('โลโก้: วางไฟล์ logo.png ไว้ในโฟลเดอร์ของแอพ');
    $('#menuFoot').textContent = lines.join('\n');
  }

  // ── แถบแจ้งเตือนด้านบน ──
  function renderBanner() {
    const el = $('#banner');
    if (!store.get('introSeen', false)) {
      el.className = 'banner';
      el.innerHTML = `${icon('info')}<p><b>ข้อมูลทั้งหมดเก็บอยู่ในเบราว์เซอร์ของเครื่องนี้เท่านั้น</b> ไม่มีการส่งขึ้นอินเทอร์เน็ต หากล้างข้อมูลเบราว์เซอร์หรือเปลี่ยนเครื่อง ข้อมูลจะไม่ติดไปด้วย — ควร “สำรองข้อมูล” จากเมนู ⋮ เป็นประจำ</p>
        <div class="banner-actions"><button type="button" class="btn small" data-action="intro-ok">รับทราบ</button></div>`;
      el.hidden = false;
      return;
    }
    const last = store.get('lastBackup', 0);
    const due = state.parcels.length >= 10
      && Date.now() - last > BACKUP_REMIND_DAYS * 864e5
      && Date.now() > store.get('backupSnooze', 0)
      && state.parcels.some((p) => p.updatedAt > last);
    if (due) {
      el.className = 'banner warn';
      el.innerHTML = `${icon('alert')}<p>${last ? `สำรองข้อมูลครั้งล่าสุดเมื่อ ${esc(date(last))}` : 'ยังไม่เคยสำรองข้อมูล'} — มีรายการที่ยังไม่ได้สำรอง</p>
        <div class="banner-actions">
          <button type="button" class="btn small primary" data-action="backup">สำรองตอนนี้</button>
          <button type="button" class="btn small" data-action="snooze">ไว้ทีหลัง</button>
        </div>`;
      el.hidden = false;
      return;
    }
    el.hidden = true;
  }

  // ═════════ ระบบ ═════════
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('parcel-log') : null;
  function broadcast() {
    try {
      if (channel) channel.postMessage('changed');
    } catch {
      /* ไม่เป็นไร */
    }
  }

  let persistAsked = false;
  function requestPersist() {
    if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
    persistAsked = true;
    navigator.storage.persisted().then((ok) => ok || navigator.storage.persist()).catch(() => {});
  }

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function route() {
    const m = /^#\/(list|graph|groups)\b/.exec(location.hash);
    const view = m ? m[1] : 'list';
    const prev = state.view;
    state.view = view;
    document.body.dataset.view = view;
    $$('.view').forEach((s) => { s.hidden = s.dataset.view !== view; });
    $$('.nav-link').forEach((a) => {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    toggleMenu(false);
    if (view === 'graph') renderGraph();
    else if (view === 'groups') renderGroups();
    else requestAnimationFrame(checkSentinel);
    if (prev !== view && view !== 'list') window.scrollTo(0, 0);
  }

  function fatal(err) {
    console.error(err);
    $('main').innerHTML = `
      <div class="container"><div class="empty">
        <div class="empty-art">${icon('alert')}</div>
        <h2>เปิดฐานข้อมูลไม่ได้</h2>
        <p>เบราว์เซอร์นี้ไม่อนุญาตให้บันทึกข้อมูล (อาจเป็นโหมดไม่ระบุตัวตน หรือปิดการเก็บข้อมูลไว้)<br>กรุณาเปิดไฟล์ index.html ด้วย Google Chrome หรือ Microsoft Edge แบบปกติ</p>
        <p class="muted small">${esc(err && err.message ? err.message : err)}</p>
      </div></div>`;
    $('#btnAdd').disabled = true;
    $('#btnImport').disabled = true;
  }

  function wire() {
    // ── ค้นหารายการ ──
    const q = $('#q');
    const runSearch = debounce(() => applyFilters(), 120);
    q.addEventListener('input', () => {
      state.q = q.value;
      $('#qClear').hidden = !q.value;
      runSearch();
    });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (q.value) {
          e.preventDefault();
          q.value = '';
          state.q = '';
          $('#qClear').hidden = true;
          applyFilters();
        } else {
          q.blur();
        }
      } else if (e.key === 'Enter') {
        // สแกนเลขพัสดุเข้าช่องค้นหาแล้วกด Enter → เปิดรายการทันทีถ้าพบรายการเดียว
        e.preventDefault();
        state.q = q.value;
        applyFilters();
        if (state.results.length === 1) openDetail(state.results[0].id);
        else if (state.results.length) $('#list .row')?.focus();
      }
    });
    $('#qClear').addEventListener('click', () => {
      q.value = '';
      state.q = '';
      $('#qClear').hidden = true;
      applyFilters();
      q.focus();
    });

    const chips = $('#chips');
    chips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      setField(chip.dataset.field);
      if (window.matchMedia && matchMedia('(pointer: fine)').matches) q.focus();
    });
    chips.addEventListener('keydown', (e) => {
      const list = $$('.chip', chips);
      const i = list.indexOf(document.activeElement);
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (i < 0 || !d) return;
      e.preventDefault();
      const next = list[(i + d + list.length) % list.length];
      next.focus();
      setField(next.dataset.field);
    });

    $('#range').addEventListener('change', (e) => {
      state.range = e.target.value;
      $('#customRange').hidden = state.range !== 'custom';
      applyFilters();
    });
    $('#from').addEventListener('change', (e) => { state.from = e.target.value; applyFilters(); });
    $('#to').addEventListener('change', (e) => { state.to = e.target.value; applyFilters(); });
    $('#drugFilter').addEventListener('change', (e) => { state.drug = e.target.value; applyFilters(); });
    $('#courierFilter').addEventListener('change', (e) => { state.courier = e.target.value; applyFilters(); });
    $('#sort').addEventListener('change', (e) => {
      state.sort = e.target.value;
      store.set('sort', state.sort);
      applyFilters();
    });

    // ── รายการ ──
    const list = $('#list');
    list.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('[data-copy]');
      if (copyBtn) {
        copyText(copyBtn.dataset.copy, 'คัดลอกเลขพัสดุแล้ว', copyBtn);
        return;
      }
      const badge = e.target.closest('[data-group]');
      if (badge) {
        setGroupFilter(Number(badge.dataset.group));
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      const row = e.target.closest('.row');
      if (row && !String(window.getSelection() || '')) openDetail(row.dataset.id);
    });
    list.addEventListener('keydown', (e) => {
      const row = e.target.closest('.row');
      if (!row || e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDetail(row.dataset.id);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        let n = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
        while (n && !n.classList.contains('row')) n = e.key === 'ArrowDown' ? n.nextElementSibling : n.previousElementSibling;
        if (n) {
          e.preventDefault();
          n.focus();
        }
      }
    });
    const onScroll = rafThrottle(checkSentinel);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    // ── ปุ่มทั่วไป ──
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-action]');
      if (!a) return;
      switch (a.dataset.action) {
        case 'add': openForm(); break;
        case 'import': openImport(); break;
        case 'reset': resetFilters(); break;
        case 'group-clear': state.group = null; applyFilters(); break;
        case 'group-graph': if (state.group && state.group.index) showGroupGraph(state.group.index); break;
        case 'intro-ok': store.set('introSeen', true); renderBanner(); break;
        case 'backup': backup(); break;
        case 'snooze': store.set('backupSnooze', Date.now() + 3 * 864e5); renderBanner(); break;
        default: break;
      }
    });
    $('#btnAdd').addEventListener('click', () => openForm());
    $('#btnImport').addEventListener('click', () => openImport());

    // ── เมนู ──
    $('#btnMenu').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu();
    });
    $('#menu').addEventListener('click', (e) => {
      const item = e.target.closest('[data-menu]');
      if (!item) return;
      toggleMenu(false);
      const act = item.dataset.menu;
      if (act === 'import') openImport();
      else if (act === 'csv') exportCSV();
      else if (act === 'numbers') exportNumbers();
      else if (act === 'backup') backup();
      else if (act === 'restore') $('#importInput').click();
    });
    $('#menu').addEventListener('keydown', (e) => {
      const items = $$('[role="menuitem"]', $('#menu'));
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        toggleMenu(false);
        $('#btnMenu').focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      } else if (e.key === 'Tab') {
        toggleMenu(false);
      }
    });
    document.addEventListener('click', (e) => {
      if (!$('#menu').hidden && !e.target.closest('.menu-wrap')) toggleMenu(false);
    });
    $('#importInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) restore(file);
    });

    // ── ฟอร์ม ──
    const f = $('#parcelForm');
    f.addEventListener('submit', onSubmit);
    f.addEventListener('keydown', onFormKeydown);
    $('#fTracking').addEventListener('input', debounce(checkTracking, 180));
    $('#fDate').addEventListener('input', () => setMsg('dateMsg'));
    $('#fTracking').addEventListener('blur', () => {
      const el = $('#fTracking');
      el.value = cleanCode(el.value);
      checkTracking();
    });
    $('#fCourier').addEventListener('input', (e) => { delete e.target.dataset.auto; });
    wireParty($('#fSender'), $('#fSenderPhone'), 'senderPhoneMsg');
    wireParty($('#fReceiver'), $('#fReceiverPhone'), 'receiverPhoneMsg');
    wireParty($('#fCustomer'), $('#fCustomerPhone'), 'customerPhoneMsg');
    $('#fIdCard').addEventListener('change', idCardHint);
    $('#fIdCard').addEventListener('input', () => { if ($('#idCardMsg').textContent) setMsg('idCardMsg'); });
    $('#btnPick').addEventListener('click', () => $('#fileInput').click());
    $('#btnCamera').addEventListener('click', openCamera);
    for (const id of ['fileInput', 'cameraInput']) {
      $(`#${id}`).addEventListener('change', (e) => {
        const files = [...e.target.files];
        e.target.value = '';
        if (files.length) addFiles(files);
      });
    }
    $('#keepOpen').addEventListener('change', (e) => store.set('keepOpen', e.target.checked));
    $('#formDialog').addEventListener('cancel', (e) => {
      e.preventDefault();
      requestCloseForm();
    });
    // ปิดด้วยวิธีใดก็ตาม: คืนหน่วยความจำของไฟล์ที่ยังไม่ได้บันทึก และยกเลิกงานเตรียมไฟล์ที่ค้างอยู่
    $('#formDialog').addEventListener('close', () => {
      discardNewPhotos();
      form.session += 1;
    });

    const dz = $('#dropzone');
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dz.classList.add('over');
    }));
    dz.addEventListener('dragleave', (e) => {
      if (!dz.contains(e.relatedTarget)) dz.classList.remove('over');
    });
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.remove('over');
      addFiles(e.dataTransfer.files);
    });
    // ลากไฟล์มาวางที่ใดก็ได้ (และกันเบราว์เซอร์เปิดไฟล์ทับแอพ):
    //   ไฟล์ Excel/CSV → หน้านำเข้า · ไฟล์อื่น → ฟอร์มบันทึกพร้อมไฟล์แนบ
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = [...e.dataTransfer.files];
      const table = files.find((file) => SheetImport.isTableFile(file));
      if ($('#importDialog').open) {
        const file = table || files.find((f) => /\.txt$/i.test(f.name) || f.type === 'text/plain');
        if (file) importFromFile(file);
      } else if ($('#formDialog').open) {
        addFiles(files);
      } else if (!document.querySelector('dialog[open]')) {
        if (table && files.length === 1) {
          importFromFile(table);
          return;
        }
        openForm();
        addFiles(files);
      }
    });

    // ── วาง (Ctrl+V): รูปในฟอร์ม · ข้อความผลค้นหาพัสดุ → เติมฟอร์ม/เปิดหน้านำเข้าอัตโนมัติ ──
    document.addEventListener('paste', (e) => {
      const cd = e.clipboardData;
      if (!cd) return;
      const target = e.target instanceof Element ? e.target : null;
      const formOpen = $('#formDialog').open;
      if (formOpen) {
        const files = [...cd.files];
        const intoText = target && target.matches('input, textarea') && cd.types.includes('text/plain');
        if (files.length && !intoText) {
          e.preventDefault();
          addFiles(files);
          return;
        }
      }
      if ($('#importDialog').open) return; // วางลงช่องข้อความของหน้านำเข้าตามปกติ
      const text = cd.getData('text/plain');
      const isText = ParcelParser.looksLike(text);
      // ช่วงเซลล์ที่คัดลอกจาก Excel (มีคอลัมน์เลขพัสดุ) → หน้านำเข้า
      const isTable = !isText && !!SheetImport.tableFromText(text);
      if (!isText && !isTable) return;
      if (formOpen) {
        if (isTable) {
          if (isDirty()) return; // กำลังกรอกฟอร์มอยู่ → วางลงช่องตามปกติ
          e.preventDefault();
          $('#formDialog').close();
          openImport(text);
          return;
        }
        e.preventDefault();
        fillFormFromText(text);
        return;
      }
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      openImport(text);
    });

    // ── นำเข้าข้อความ / ไฟล์ ──
    const reanalyze = debounce(analyzeImport, 200);
    $('#impText').addEventListener('input', () => {
      imp.error = '';
      imp.overrides = {}; // ข้อความเปลี่ยน → จับคู่คอลัมน์ใหม่
      reanalyze();
    });
    $('#impSheet').addEventListener('change', (e) => {
      if (!imp.file) return;
      imp.file.sheet = Number(e.target.value);
      imp.overrides = {};
      analyzeImport();
    });
    $('#impFileClear').addEventListener('click', () => {
      imp.token += 1;
      imp.file = null;
      imp.overrides = {};
      analyzeImport();
      $('#impText').focus();
    });
    $('#impMapBody').addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-col]');
      if (!sel) return;
      imp.overrides[Number(sel.dataset.col)] = sel.value;
      analyzeImport();
    });
    $('#impCourier').addEventListener('input', debounce(renderImport, 200));
    $('#impNote').addEventListener('input', debounce(renderImport, 200));
    $('#impList').addEventListener('change', (e) => {
      const cb = e.target.closest('input[type="checkbox"][data-i]');
      if (!cb) return;
      imp.checked[Number(cb.dataset.i)] = cb.checked;
      updateImportButton();
    });
    $('#impGo').addEventListener('click', runImport);
    $('#impFileBtn').addEventListener('click', () => $('#impFile').click());
    $('#impFileChange').addEventListener('click', () => $('#impFile').click());
    $('#impFile').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) importFromFile(file);
    });
    $('#impDone').addEventListener('click', (e) => {
      const b = e.target.closest('[data-imp]');
      if (b) onImportDone(b.dataset.imp);
    });

    // ── กล้อง ──
    $('#btnShutter').addEventListener('click', snap);
    $('#cameraDialog').addEventListener('close', stopCamera);

    // ── รายละเอียด ──
    const detail = $('#detailDialog');
    $('#dCopy').addEventListener('click', (e) => copyText($('#dTracking').textContent, 'คัดลอกเลขพัสดุแล้ว', e.currentTarget));
    $('#dEdit').addEventListener('click', () => {
      const p = findParcel(state.detailId);
      if (!p) return;
      detail.close();
      openForm(p);
    });
    $('#dDelete').addEventListener('click', () => {
      const p = findParcel(state.detailId);
      if (p) removeParcel(p);
    });
    detail.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      const p = findParcel(state.detailId);
      if (t.dataset.copyPhone) copyText(t.dataset.copyPhone, 'คัดลอกเบอร์โทรแล้ว', t);
      else if (t.dataset.copyId) copyText(t.dataset.copyId, 'คัดลอกเลขบัตรประชาชนแล้ว', t);
      else if (t.dataset.open) openDetail(t.dataset.open);
      else if (t.dataset.dGraph) {
        detail.close();
        showGroupGraph(Number(t.dataset.dGraph), p ? Network.partyKey(p.sender, p.senderPhone) : null);
      } else if (t.dataset.dList) {
        detail.close();
        showGroupList(Number(t.dataset.dList));
      } else if (t.dataset.dRename) {
        openNameDialog(t.dataset.dRename);
      } else if (t.classList.contains('g-item') && p) {
        openLightbox(detailState.images, Number(t.dataset.i), p.tracking);
      }
    });
    detail.addEventListener('close', () => {
      state.detailId = null;
      detailState.token += 1;
      releaseDetailFiles();
    });

    // ── ดูรูป ──
    $('#lbPrev').addEventListener('click', () => stepLightbox(-1));
    $('#lbNext').addEventListener('click', () => stepLightbox(1));
    const lightbox = $('#lightbox');
    lightbox.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') stepLightbox(-1);
      else if (e.key === 'ArrowRight') stepLightbox(1);
    });
    let touchX = null;
    lightbox.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
    lightbox.addEventListener('touchend', (e) => {
      if (touchX === null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(dx) > 50) stepLightbox(dx < 0 ? 1 : -1);
    });
    lightbox.addEventListener('close', releaseLightbox);

    // ── ปิดหน้าต่าง: ปุ่มปิด และคลิกพื้นหลัง ──
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-close]');
      if (!btn) return;
      const dlg = btn.closest('dialog');
      if (!dlg) return;
      if (dlg.id === 'formDialog') requestCloseForm();
      else dlg.close();
    });
    $$('dialog').forEach((dlg) => {
      let armed = false;
      dlg.addEventListener('pointerdown', (e) => { armed = e.target === dlg; });
      dlg.addEventListener('click', (e) => {
        if (!armed || e.target !== dlg) return;
        armed = false;
        if (dlg.id === 'formDialog') requestCloseForm();
        else dlg.close();
      });
    });

    // ── กราฟ ──
    $('#gShow').addEventListener('change', (e) => {
      state.graphShow = e.target.value;
      renderGraph();
    });
    const gSearch = $('#gSearch');
    gSearch.addEventListener('input', debounce(applyGraphSearch, 150));
    gSearch.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const found = applyGraphSearch();
      if (found.length) graph.view.select(found[0], { center: true });
      else if (gSearch.value.trim()) toast('ไม่พบหมายเลขหรือชื่อนี้ในกราฟที่แสดงอยู่', 'error');
    });
    $('#gRename').addEventListener('click', () => {
      if (state.graphShow.startsWith('g')) openNameDialog(Number(state.graphShow.slice(1)));
    });
    $('#nameForm').addEventListener('submit', (e) => {
      e.preventDefault();
      saveNetworkName(false);
    });
    $('#nmClear').addEventListener('click', () => saveNetworkName(true));
    $('#gZoomIn').addEventListener('click', () => graph.view && graph.view.zoomBy(1.35));
    $('#gZoomOut').addEventListener('click', () => graph.view && graph.view.zoomBy(1 / 1.35));
    $('#gFit').addEventListener('click', () => graph.view && graph.view.refit());
    $('#gExport').addEventListener('click', exportGraphImage);
    $('#graphPanel').addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t || !graph.view) return;
      if (t.dataset.node) {
        const n = graph.view.nodes.find((x) => x.key === t.dataset.node);
        if (n) graph.view.select(n, { center: true });
      } else if (t.dataset.open) {
        openDetail(t.dataset.open);
      } else if (t.dataset.panel === 'back') {
        graph.edge = null;
        graph.view.select(null);
      } else if (t.dataset.rename) {
        openNameDialog(t.dataset.rename);
      } else if (t.dataset.focusGroup) {
        state.graphShow = `g${t.dataset.focusGroup}`;
        renderGraph();
      } else if (t.dataset.find) {
        searchList(t.dataset.find);
      } else if (t.dataset.copyText) {
        copyText(t.dataset.copyText, 'คัดลอกแล้ว', t);
      }
    });

    // ── ตัวเลือกเชื่อมชื่อ/ที่อยู่ซ้ำ (ใช้ร่วมกันทั้งกราฟและกลุ่ม) ──
    $$('[data-link-names]').forEach((cb) => {
      cb.checked = state.linkNames;
      cb.addEventListener('change', () => {
        state.linkNames = cb.checked;
        store.set('linkNames', state.linkNames);
        $$('[data-link-names]').forEach((x) => { x.checked = state.linkNames; });
        refreshNetwork();
        applyFilters({ keep: true });
        refreshAnalysisViews();
      });
    });

    // ── กลุ่มเครือข่าย ──
    $('#groupSearch').addEventListener('input', debounce(renderGroups, 150));
    $('#groupSort').addEventListener('change', renderGroups);
    $('#groupGrid').addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.rename) openNameDialog(t.dataset.rename);
      else if (t.dataset.hub) showGroupGraph(Number(t.dataset.hub), t.dataset.key);
      else if (t.dataset.graph) showGroupGraph(Number(t.dataset.graph));
      else if (t.dataset.list) showGroupList(Number(t.dataset.list));
    });

    // ── แป้นพิมพ์ลัด ──
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.isComposing || document.querySelector('dialog[open]')) return;
      const typing = e.target instanceof Element && !!e.target.closest('input, textarea, select, [contenteditable="true"]');
      const mod = e.ctrlKey || e.metaKey;
      // ใช้ e.code เพื่อให้ทำงานได้แม้แป้นพิมพ์อยู่ในโหมดภาษาไทย
      if ((mod && e.code === 'KeyK') || (!typing && !mod && !e.altKey && (e.code === 'Slash' || e.key === '/'))) {
        e.preventDefault();
        const input = state.view === 'graph' ? $('#gSearch') : state.view === 'groups' ? $('#groupSearch') : $('#q');
        input.focus();
        input.select();
      } else if (!typing && !mod && !e.altKey && e.code === 'KeyN') {
        e.preventDefault();
        openForm();
      }
    });

    window.addEventListener('hashchange', route);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && startOfDay() !== state.renderedDay) applyFilters({ keep: true });
    });
    if (channel) channel.onmessage = () => { reload().catch(() => {}); };
    new ResizeObserver(() => {
      document.documentElement.style.setProperty('--appbar-h', `${$('#appbar').offsetHeight}px`);
    }).observe($('#appbar'));
  }

  // ความสูงจริงของแถบด้านบน (เปลี่ยนตามขนาดจอ/การตัดบรรทัดเมนู) → พื้นที่กราฟสูงพอดีหน้าจอ ไม่ล้นลงล่าง
  function trackAppbarHeight() {
    const bar = $('#appbar');
    const set = () => {
      const h = Math.round(bar.getBoundingClientRect().height);
      if (h) document.documentElement.style.setProperty('--appbar-h', `${h}px`);
    };
    set();
    if ('ResizeObserver' in window) new ResizeObserver(set).observe(bar);
  }

  async function init() {
    trackAppbarHeight();
    wire();
    setField('all', false);
    $('#sort').value = state.sort;
    try {
      await ParcelDB.open();
      state.parcels = (await ParcelDB.getAllParcels()).map(prepare).sort(byDate);
      state.netNames = await ParcelDB.getNetworkNames();
    } catch (err) {
      fatal(err);
      return;
    }
    refreshNetwork();
    rebuildPeople();
    rebuildOptions();
    applyFilters();
    renderBanner();
    route();
    detectCamera();
  }

  init();
})();
