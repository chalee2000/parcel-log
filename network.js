/*
 * วิเคราะห์เครือข่ายพัสดุ
 *  build()    สร้างโหนด (หมายเลขโทรศัพท์ หรือชื่อเมื่อไม่มีเบอร์) และเส้นเชื่อม (พัสดุ: ผู้ส่ง → ผู้รับ)
 *             แล้วแบ่งกลุ่มเครือข่ายด้วย connected components
 *  scene()    จัดตำแหน่งแต่ละเครือข่ายด้วย force layout แล้ววางกล่องเครือข่ายเรียงเป็นแถว
 *  GraphView  วาดกราฟบน canvas — ซูม เลื่อน ลากจุด ชี้ดูรายละเอียด คลิกเลือก บันทึกภาพ
 */
'use strict';

const Network = (() => {
  const { clean, lower, digits, formatPhone, nameKey, addressKey, idCardKey, formatIdCard, clamp, num } = U;

  const TAU = Math.PI * 2;
  const FONT = '"Leelawadee UI", "Noto Sans Thai", "Segoe UI", Tahoma, system-ui, sans-serif';
  const MIN_K = 0.05;
  const MAX_K = 4;

  // สีบทบาท = ช่องที่ 1–2 ของชุดสีมาตรฐานสำหรับกราฟ (ตรวจการแยกสีสำหรับผู้บกพร่องการเห็นสีแล้ว)
  // "ทั้งส่งและรับ" ใช้วงกลมครึ่งสี แทนการเพิ่มสีที่สาม · "ไม่มีเบอร์" ใช้วงกลมกลวง
  const PALETTE = {
    light: {
      send: '#2a78d6', recv: '#eb6834', cust: '#1baf7a', surface: '#ffffff', box: '#f8f8f6', boxLine: '#e6e6e2',
      edge: '#8d8d92', edgeName: '#b0b0b4', ink: '#141414', label: '#2e2e30', muted: '#6b6b70', match: '#ffd400',
      tape: '#e4e9ef', tapeShade: '#c9d1db', bothTop: '#f1e3d4',
    },
    dark: {
      send: '#3987e5', recv: '#d95926', cust: '#199e70', surface: '#1a1a1b', box: '#202022', boxLine: '#2f2f32',
      edge: '#85858b', edgeName: '#5a5a60', ink: '#f4f4f2', label: '#dededa', muted: '#96968f', match: '#ffd400',
      tape: '#d3d9e0', tapeShade: '#aab3be', bothTop: '#e2d0bd',
    },
  };
  const darkQuery = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  const scheme = () => (darkQuery && darkQuery.matches ? 'dark' : 'light');

  // คีย์ของโหนด: เบอร์โทร (ตัวเลขล้วน) หรือชื่อเมื่อไม่มีเบอร์
  function partyKey(name, phone) {
    const d = digits(phone);
    if (d) return `p:${d}`;
    const k = nameKey(name);
    return k ? `n:${k}` : null;
  }

  function countBy(list, fn) {
    const m = new Map();
    for (const x of list) {
      const k = fn(x);
      if (k) m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  // ═════════ สร้างเครือข่าย ═════════
  function build(parcels, { linkNames = true, names = [] } = {}) {
    const nodes = new Map();
    const edges = new Map();

    const touch = (name, phone, address) => {
      const key = partyKey(name, phone);
      if (!key) return null;
      let n = nodes.get(key);
      if (!n) {
        const isPhone = key.startsWith('p:');
        n = {
          key,
          type: isPhone ? 'phone' : 'name',
          phone: isPhone ? formatPhone(phone) : '',
          names: new Map(),
          addresses: new Map(),
          idCards: new Map(),
          items: [],
          sent: 0,
          received: 0,
          booked: 0,
          neighbors: new Set(),
          group: null,
          x: 0, y: 0, lx: 0, ly: 0, r: 8,
        };
        nodes.set(key, n);
      }
      const nm = clean(name);
      if (nm) n.names.set(nm, (n.names.get(nm) || 0) + 1);
      const addr = clean(address);
      if (addr) n.addresses.set(addr, (n.addresses.get(addr) || 0) + 1);
      return n;
    };

    for (const p of parcels) {
      const s = touch(p.sender, p.senderPhone, p.senderAddress);
      const r = touch(p.receiver, p.receiverPhone, p.receiverAddress);
      if (s) {
        s.sent += 1;
        s.items.push({ parcel: p, role: 'send' });
      }
      if (r) {
        r.received += 1;
        r.items.push({ parcel: p, role: 'recv' });
      }
      if (s && r && s !== r) {
        const key = `${s.key}>${r.key}`;
        let e = edges.get(key);
        if (!e) {
          e = { key, type: 'parcel', source: s, target: r, parcels: [], curved: false };
          edges.set(key, e);
        }
        e.parcels.push(p);
        s.neighbors.add(r);
        r.neighbors.add(s);
      }
      // ลูกค้า (บัญชีผู้ฝากส่ง) → เชื่อมเข้ากับผู้ส่ง (หรือผู้รับ ถ้าไม่มีข้อมูลผู้ส่ง)
      const c = touch(p.customer, p.customerPhone, '');
      if (c) {
        c.booked += 1;
        c.items.push({ parcel: p, role: 'cust' });
        const to = s || r;
        if (to && to !== c) {
          const key = `${c.key}»${to.key}`;
          let e = edges.get(key);
          if (!e) {
            e = { key, type: 'cust', source: c, target: to, parcels: [], curved: false };
            edges.set(key, e);
          }
          e.parcels.push(p);
          c.neighbors.add(to);
          to.neighbors.add(c);
        }
      }
      // เลขบัตรประชาชนผู้ฝากส่ง: ติดกับลูกค้า (ถ้ามี) ไม่เช่นนั้นติดกับผู้ส่ง
      const idc = idCardKey(p.idCard);
      const holder = c || s || r;
      if (idc && holder) {
        const shown = formatIdCard(idc);
        holder.idCards.set(shown, (holder.idCards.get(shown) || 0) + 1);
      }
    }

    // ส่งหากันทั้งสองทาง → วาดเป็นเส้นโค้งคู่ ไม่ให้ทับกัน
    for (const e of edges.values()) {
      if (edges.has(`${e.target.key}>${e.source.key}`)) e.curved = true;
    }

    // เบอร์ต่างกันแต่ใช้ชื่อเดียวกัน (หลังตัดคำนำหน้าชื่อ) หรือที่อยู่เดียวกัน → เชื่อมด้วยเส้นประ
    const linkAlike = (source, keyOf, reason) => {
      const byKey = new Map();
      for (const n of nodes.values()) {
        for (const value of n[source].keys()) {
          const k = keyOf(value);
          if (!k) continue;
          if (!byKey.has(k)) byKey.set(k, { value, list: new Set() });
          byKey.get(k).list.add(n);
        }
      }
      for (const { value, list } of byKey.values()) {
        if (list.size < 2) continue;
        const [hub, ...rest] = list;
        for (const other of rest) {
          if (hub.neighbors.has(other)) continue; // เชื่อมกันอยู่แล้ว
          const key = `~${hub.key}~${other.key}`;
          edges.set(key, { key, type: 'name', reason, source: hub, target: other, name: value, parcels: [], curved: false });
          hub.neighbors.add(other);
          other.neighbors.add(hub);
        }
      }
    };
    // เลขบัตรประชาชนเดียวกัน = คนเดียวกันแน่นอน → เชื่อมเสมอ (ทำก่อน เพื่อให้เส้นแสดงเหตุผลที่หนักแน่นที่สุด)
    linkAlike('idCards', idCardKey, 'เลขบัตรประชาชนเดียวกัน');
    if (linkNames) {
      linkAlike('names', nameKey, 'ชื่อเดียวกัน');
      linkAlike('addresses', addressKey, 'ที่อยู่เดียวกัน');
    }

    const all = [...nodes.values()];
    for (const n of all) {
      n.nameList = [...n.names.entries()].sort((a, b) => b[1] - a[1]).map(([nm]) => nm);
      n.addressList = [...n.addresses.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
      n.idCardList = [...n.idCards.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      n.label = n.type === 'phone' ? n.phone : n.nameList[0] || '';
      n.topName = n.type === 'phone' ? n.nameList[0] || '' : '';
      n.count = new Set(n.items.map((it) => it.parcel.id)).size;
      n.degree = n.neighbors.size;
      n.role = n.sent && n.received ? 'both' : n.sent ? 'send' : n.received ? 'recv' : 'cust';
      n.r = Math.min(22, 7 + 2.2 * Math.sqrt(n.count));
      n.digits = n.type === 'phone' ? n.key.slice(2) : '';
      n.search = lower([...n.nameList, ...n.idCardList.map(digits)].join(' '));
    }

    // แบ่งกลุ่ม: หมายเลขที่เชื่อมถึงกันได้อยู่กลุ่มเดียวกัน
    const groups = [];
    const seen = new Set();
    for (const start of all) {
      if (seen.has(start)) continue;
      const members = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const n = stack.pop();
        members.push(n);
        for (const m of n.neighbors) {
          if (!seen.has(m)) {
            seen.add(m);
            stack.push(m);
          }
        }
      }
      const g = { nodes: members, edges: [], parcels: [], layout: null };
      members.forEach((n) => { n.group = g; });
      groups.push(g);
    }
    for (const e of edges.values()) e.source.group.edges.push(e);
    groups.forEach(summarize);
    groups.sort((a, b) => (b.isNetwork - a.isNetwork) || (b.parcelCount - a.parcelCount)
      || (b.nodes.length - a.nodes.length) || (b.last - a.last));

    let index = 0;
    for (const g of groups) {
      if (g.isNetwork) {
        index += 1;
        g.index = index;
        g.autoLabel = `เครือข่าย ${index}`;
      } else {
        g.index = 0;
        g.autoLabel = 'พัสดุเดี่ยว';
      }
    }
    applyNames(groups.filter((g) => g.isNetwork), names);
    for (const g of groups) g.label = g.customName || g.autoLabel;

    const parcelGroup = new Map();
    for (const g of groups) for (const p of g.parcels) parcelGroup.set(p.id, g);
    // เลขบัตรประชาชน (13 หลัก) → โหนดที่ใช้บัตรนั้น
    const nodesByIdCard = new Map();
    for (const n of all) {
      for (const id of n.idCardList) {
        const k = idCardKey(id);
        if (!nodesByIdCard.has(k)) nodesByIdCard.set(k, []);
        nodesByIdCard.get(k).push(n);
      }
    }

    return {
      nodes: all,
      edges: [...edges.values()],
      groups,
      networks: groups.filter((g) => g.isNetwork),
      singles: groups.filter((g) => !g.isNetwork),
      unlinked: parcels.filter((p) => !parcelGroup.has(p.id)),
      nodeByKey: nodes,
      nodesByIdCard,
      parcelGroup,
      linkNames,
    };
  }

  // ชื่อที่ผู้ใช้ตั้ง ผูกกับหมายเลข/ชื่อในเครือข่ายตอนตั้งชื่อ → เครือข่ายที่มีหมายเลขเหล่านั้นมากที่สุดได้ชื่อนั้น
  // (เลขลำดับเครือข่ายเปลี่ยนได้เมื่อข้อมูลเปลี่ยน แต่ชื่อจะตามกลุ่มหมายเลขไปเสมอ)
  function applyNames(networks, saved) {
    const groupOfKey = new Map();
    for (const g of networks) for (const n of g.nodes) groupOfKey.set(n.key, g);
    const hits = new Map();
    for (const rec of saved) {
      if (!rec || !rec.name || !Array.isArray(rec.keys)) continue;
      const counts = new Map();
      for (const k of rec.keys) {
        const g = groupOfKey.get(k);
        if (g) counts.set(g, (counts.get(g) || 0) + 1);
      }
      let best = null;
      let bestN = 0;
      for (const [g, c] of counts) {
        if (c > bestN) {
          best = g;
          bestN = c;
        }
      }
      if (!best) continue;
      if (!hits.has(best)) hits.set(best, []);
      hits.get(best).push({ rec, overlap: bestN });
    }
    for (const [g, list] of hits) {
      list.sort((a, b) => b.overlap - a.overlap || (a.rec.createdAt || 0) - (b.rec.createdAt || 0));
      g.customName = list[0].rec.name;
      g.nameId = list[0].rec.id;
      g.mergedNames = list.slice(1).map((x) => x.rec.name);
    }
  }

  function summarize(g) {
    const byId = new Map();
    for (const n of g.nodes) for (const it of n.items) byId.set(it.parcel.id, it.parcel);
    g.parcels = [...byId.values()].sort((a, b) => b.date - a.date);
    g.parcelCount = g.parcels.length;
    g.isNetwork = g.parcelCount >= 2;
    g.phoneCount = g.nodes.filter((n) => n.type === 'phone').length;
    const names = new Set();
    g.nodes.forEach((n) => n.nameList.forEach((nm) => names.add(nm)));
    g.nameCount = names.size;
    g.first = g.parcels.reduce((m, p) => Math.min(m, p.date), Infinity);
    g.last = g.parcels.reduce((m, p) => Math.max(m, p.date), -Infinity);
    g.drugs = countBy(g.parcels, (p) => clean(p.drug));
    g.couriers = countBy(g.parcels, (p) => clean(p.courier));
    g.hubs = [...g.nodes].sort((a, b) => b.degree - a.degree || b.count - a.count).slice(0, 3);
  }

  // ═════════ จัดตำแหน่ง ═════════
  // force layout แบบเดียวกับ d3-force (แรงผลัก + สปริงตามเส้น + แรงดึงเข้ากลาง) ทำครั้งเดียวต่อเครือข่าย
  // คำนวณในอาร์เรย์ของตัวเอง (ไม่แตะตำแหน่งที่กราฟกำลังแสดง) แล้วคืน Map จุด → [x, y]
  function simulate(nodes, edges) {
    const n = nodes.length;
    const order = [...nodes].sort((a, b) => b.degree - a.degree || b.count - a.count || (a.key < b.key ? -1 : 1));
    const at = new Map(order.map((d, i) => [d, i]));
    const X = new Float64Array(n);
    const Y = new Float64Array(n);
    const VX = new Float64Array(n);
    const VY = new Float64Array(n);
    order.forEach((d, i) => {
      const radius = 16 * Math.sqrt(i + 0.5);
      const angle = i * 2.399963;
      X[i] = radius * Math.cos(angle);
      Y[i] = radius * Math.sin(angle);
    });
    const result = () => new Map(order.map((d, i) => [d, [X[i], Y[i]]]));
    if (n < 2) return result();

    const links = edges.map((e) => ({ s: at.get(e.source), t: at.get(e.target), len: e.type === 'name' ? 60 : e.type === 'cust' ? 72 : 95 }));
    const deg = new Float64Array(n);
    for (const l of links) {
      deg[l.s] += 1;
      deg[l.t] += 1;
    }
    const iterations = clamp(Math.round(3e6 / (n * n)), 60, 300);
    const decay = 1 - Math.pow(0.001, 1 / iterations);
    const charge = -420;
    let alpha = 1;

    for (let it = 0; it < iterations; it++) {
      for (const { s, t, len } of links) {
        let dx = X[t] + VX[t] - X[s] - VX[s];
        let dy = Y[t] + VY[t] - Y[s] - VY[s];
        const d = Math.hypot(dx, dy) || 1e-3;
        const f = ((d - len) / d) * alpha / Math.min(deg[s], deg[t]);
        dx *= f;
        dy *= f;
        const bias = deg[s] / (deg[s] + deg[t]);
        VX[t] -= dx * bias;
        VY[t] -= dy * bias;
        VX[s] += dx * (1 - bias);
        VY[s] += dy * (1 - bias);
      }
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let dx = X[j] - X[i];
          let dy = Y[j] - Y[i];
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) {
            dx = 0.7 + (j - i) * 0.01;
            dy = 0.7;
            d2 = dx * dx + dy * dy;
          }
          const w = (charge * alpha) / d2;
          VX[i] += dx * w;
          VY[i] += dy * w;
          VX[j] -= dx * w;
          VY[j] -= dy * w;
        }
      }
      for (let i = 0; i < n; i++) {
        VX[i] -= X[i] * 0.05 * alpha;
        VY[i] -= Y[i] * 0.05 * alpha;
        VX[i] *= 0.6;
        VY[i] *= 0.6;
        X[i] += VX[i];
        Y[i] += VY[i];
      }
      alpha -= alpha * decay;
    }

    // ดันจุดที่ชิดกันเกินไปออก ให้มีที่สำหรับป้ายเบอร์ใต้จุด
    for (let pass = 0; pass < 30; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const min = order[i].r + order[j].r + 26;
          let dx = X[j] - X[i];
          let dy = Y[j] - Y[i];
          let d = Math.hypot(dx, dy);
          if (d >= min) continue;
          if (d < 1e-3) {
            dx = 1;
            dy = 0;
            d = 1;
          }
          const push = (min - d) / 2;
          const ux = dx / d;
          const uy = dy / d;
          X[i] -= ux * push;
          Y[i] -= uy * push;
          X[j] += ux * push;
          Y[j] += uy * push;
          moved = true;
        }
      }
      if (!moved) break;
    }
    return result();
  }

  // ตำแหน่งจุดของกลุ่ม (n.lx, n.ly) พร้อมขอบเขตที่เผื่อป้ายเบอร์ไว้แล้ว — จัดตำแหน่งครั้งเดียวต่อเครือข่าย
  function layoutGroup(g) {
    if (!g.layoutPos) {
      g.layoutPos = g.isNetwork
        ? simulate(g.nodes, g.edges)
        : new Map(g.nodes.map((n) => [n, [n.sent || g.nodes.length === 1 ? 0 : 120, 0]])); // พัสดุเดี่ยว: ผู้ส่งซ้าย → ผู้รับขวา
    }
    const pos = g.layoutPos;
    const L = {
      minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
      nx0: Infinity, ny0: Infinity, nx1: -Infinity, ny1: -Infinity,
      cx0: Infinity, cy0: Infinity, cx1: -Infinity, cy1: -Infinity,
    };
    for (const n of g.nodes) {
      [n.lx, n.ly] = pos.get(n);
      const half = Math.max(n.r + 4, LABEL_HALF);
      L.minX = Math.min(L.minX, n.lx - half);
      L.maxX = Math.max(L.maxX, n.lx + half);
      L.minY = Math.min(L.minY, n.ly - n.r - 6);
      L.maxY = Math.max(L.maxY, n.ly + n.r + LABEL_BELOW);
      L.nx0 = Math.min(L.nx0, n.lx - n.r);
      L.nx1 = Math.max(L.nx1, n.lx + n.r);
      L.ny0 = Math.min(L.ny0, n.ly - n.r);
      L.ny1 = Math.max(L.ny1, n.ly + n.r);
      L.cx0 = Math.min(L.cx0, n.lx);
      L.cx1 = Math.max(L.cx1, n.lx);
      L.cy0 = Math.min(L.cy0, n.ly);
      L.cy1 = Math.max(L.cy1, n.ly);
    }
    g.layout = L;
    return L;
  }

  // วางเครือข่ายเป็นกล่องเรียงแถว (ใหญ่ก่อน) พัสดุเดี่ยวรวมอยู่ในกล่องสุดท้าย
  const PAD = 20;
  const HEAD = 34;
  const GAP = 30;
  const LABEL_HALF = 52; // เผื่อความกว้างป้ายเบอร์โทร (ครึ่งหนึ่ง)
  const LABEL_BELOW = 36; // เผื่อป้ายใต้จุด
  const FIT_MAX_K = 1.6; // ซูมพอดีจอได้ไม่เกินนี้ (กล่องพัสดุไม่ใหญ่เกินไป)
  const MAX_STRETCH = 3; // ยืดตามแกนได้ไม่เกิน 3 เท่า (ไม่ให้รูปเครือข่ายบิดเกินไป)
  const MIN_SQUASH = 0.7; // บีบแกนที่เหลือได้ถึง 70% (ซูมได้มากขึ้น กล่องพัสดุใหญ่ขึ้น)

  // ปรับสัดส่วนเครือข่ายเดียวให้เต็มกรอบที่แสดง (area = ขนาดพื้นที่วาดเป็นพิกเซล)
  //   1) กรอบกว้างกว่าเครือข่าย: บีบแนวตั้งเล็กน้อยแล้วยืดแนวนอนให้สัดส่วนเท่ากรอบ (กรอบสูงกว่า: กลับกัน)
  //      การบีบทำให้ซูมได้มากขึ้น กล่องพัสดุและป้ายจึงใหญ่ขึ้นตามกรอบ ไม่ใช่แค่ห่างกันขึ้น
  //   2) เครือข่ายเล็ก: ขยายระยะห่างให้เต็มกรอบที่ซูมสูงสุด (ไม่ขยายกล่องพัสดุจนใหญ่เกินไป)
  //   (ภาพรวมหลายเครือข่าย: ปรับแต่ละกล่องเข้าหาสัดส่วนกรอบแบบพอประมาณ ไม่ขยายระยะ — grow = false)
  function fillScale(L, area, { grow = true, maxStretch = MAX_STRETCH, minSquash = MIN_SQUASH } = {}) {
    const spanX = L.cx1 - L.cx0;
    const spanY = L.cy1 - L.cy0;
    const mx = L.maxX - L.minX - spanX + PAD * 2;
    const my = L.maxY - L.minY - spanY + PAD * 2 + HEAD;
    const target = area.width / area.height;
    const aspect = (spanX + mx) / (spanY + my);
    let sx = 1;
    let sy = 1;
    if (aspect < target && spanX > 1) {
      if (spanY > 1) sy = Math.max(minSquash, Math.sqrt(aspect / target));
      sx = clamp((target * (spanY * sy + my) - mx) / spanX, 1, maxStretch);
    } else if (aspect > target && spanY > 1) {
      if (spanX > 1) sx = Math.max(minSquash, Math.sqrt(target / aspect));
      sy = clamp(((spanX * sx + mx) / target - my) / spanY, 1, maxStretch);
    }
    if (!grow) return { sx, sy };
    const fx = spanX > 1 ? (area.width / FIT_MAX_K - mx) / (spanX * sx) : Infinity;
    const fy = spanY > 1 ? (area.height / FIT_MAX_K - my) / (spanY * sy) : Infinity;
    const spread = clamp(Math.min(fx, fy), 1, 2.5);
    return { sx: sx * spread, sy: sy * spread };
  }

  // ตำแหน่งจุดในกล่อง (หลังปรับสัดส่วน) และขนาดกล่องที่เผื่อป้ายเบอร์ + หัวกล่อง
  function placeGroup(g, L, sx = 1, sy = 1) {
    const list = g.nodes.map((n) => ({ n, x: (n.lx - L.cx0) * sx, y: (n.ly - L.cy0) * sy }));
    // หลังบีบแกน จุดที่ใกล้กันเกินไปถูกดันออก (เว้นที่ให้ป้ายเบอร์เหมือนตอนจัดตำแหน่ง)
    if (sx < 1 || sy < 1) {
      for (let pass = 0; pass < 20; pass++) {
        let moved = false;
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i];
            const b = list[j];
            const min = a.n.r + b.n.r + 26;
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let d = Math.hypot(dx, dy);
            if (d >= min) continue;
            if (d < 1e-3) {
              dx = 1;
              dy = 0;
              d = 1;
            }
            const push = (min - d) / 2;
            a.x -= (dx / d) * push;
            a.y -= (dy / d) * push;
            b.x += (dx / d) * push;
            b.y += (dy / d) * push;
            moved = true;
          }
        }
        if (!moved) break;
      }
    }
    const at = new Map();
    const B = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const { n, x, y } of list) {
      at.set(n, [x, y]);
      const half = Math.max(n.r + 4, LABEL_HALF);
      B.minX = Math.min(B.minX, x - half);
      B.maxX = Math.max(B.maxX, x + half);
      B.minY = Math.min(B.minY, y - n.r - 6);
      B.maxY = Math.max(B.maxY, y + n.r + LABEL_BELOW);
    }
    return { at, B, w: B.maxX - B.minX + PAD * 2, h: B.maxY - B.minY + PAD * 2 + HEAD };
  }

  // วางกล่องเป็นชั้น (เรียงจากสูงไปต่ำ): กล่องแรกของชั้นกำหนดความสูงชั้น
  // กล่องถัดไปซ้อนเป็นคอลัมน์ทางขวาภายในความสูงของชั้น ไม่ให้เหลือที่ว่างใต้กล่องเล็ก
  function pack(blocks, rowW) {
    const at = [];
    let shelfY = 0;
    let shelfH = 0;
    let colX = 0;
    let colW = 0;
    let colY = 0;
    let W = 0;
    for (const b of blocks) {
      if (!at.length) {
        at.push([0, 0]);
        shelfH = b.h;
        colX = b.w + GAP;
        W = b.w;
      } else if (colW && colY + b.h <= shelfH && colX + Math.max(colW, b.w) <= rowW) {
        at.push([colX, shelfY + colY]); // ใต้กล่องก่อนหน้าในคอลัมน์เดียวกัน
        colY += b.h + GAP;
        colW = Math.max(colW, b.w);
        W = Math.max(W, colX + colW);
      } else if ((colW ? colX + colW + GAP : colX) + b.w <= rowW) {
        colX = colW ? colX + colW + GAP : colX; // คอลัมน์ใหม่ในชั้นเดิม
        colW = b.w;
        colY = b.h + GAP;
        at.push([colX, shelfY]);
        W = Math.max(W, colX + b.w);
      } else {
        shelfY += shelfH + GAP; // ชั้นใหม่
        shelfH = b.h;
        at.push([0, shelfY]);
        colX = b.w + GAP;
        colW = 0;
        colY = 0;
        W = Math.max(W, b.w);
      }
    }
    return { at, W, H: shelfY + shelfH };
  }

  // area = ขนาดพื้นที่วาด (พิกเซล) — ถ้ามี จะจัดให้เต็มกรอบ: เครือข่ายเดียวยืดตามสัดส่วนจอ หลายเครือข่ายเรียงให้ซูมได้ใหญ่ที่สุด
  function scene(net, show = 'networks', area = null) {
    const groups = show === 'all' ? net.groups
      : show === 'networks' ? net.networks
        : net.groups.filter((g) => g.index === show);
    const target = area && area.width > 0 && area.height > 0 ? area.width / area.height : 1.6;
    const single = typeof show === 'number' && !!area;
    const blocks = [];
    for (const g of groups) {
      if (!g.isNetwork) continue;
      const L = layoutGroup(g);
      const { sx, sy } = !area ? { sx: 1, sy: 1 }
        : single ? fillScale(L, area)
          : fillScale(L, area, { grow: false, maxStretch: 2, minSquash: 0.85 });
      const P = placeGroup(g, L, sx, sy);
      blocks.push({
        group: g,
        P,
        w: P.w,
        h: P.h,
        label: g.label,
        sub: `${g.customName ? `${g.autoLabel} · ` : ''}${num(g.parcelCount)} พัสดุ · ${num(g.phoneCount)} หมายเลข`,
      });
    }
    const singles = groups.filter((g) => !g.isNetwork);
    if (singles.length) {
      const cellW = 250;
      const cellH = 92;
      // จำนวนคอลัมน์ให้กล่องพัสดุเดี่ยวมีสัดส่วนใกล้เคียงกรอบที่แสดง
      const cols = Math.max(1, Math.min(singles.length, Math.ceil(Math.sqrt((singles.length * target * cellH) / cellW))));
      const rows = Math.ceil(singles.length / cols);
      singles.forEach((g, i) => {
        layoutGroup(g);
        g.cell = { x: (i % cols) * cellW, y: Math.floor(i / cols) * cellH };
      });
      blocks.push({
        singles,
        w: cols * cellW + PAD * 2,
        h: rows * cellH + PAD * 2 + HEAD,
        label: 'พัสดุเดี่ยว',
        sub: `${num(singles.length)} รายการ · ยังไม่เชื่อมโยงกับรายการอื่น`,
      });
    }
    if (!blocks.length) return { nodes: [], edges: [], boxes: [], bounds: null };

    // จัดวางกล่อง: ลองหลายความกว้างแถว เลือกแบบที่ซูมพอดีกรอบได้ใหญ่ที่สุด (ไม่มีกรอบ: สัดส่วนใกล้ 1.6)
    const sorted = [...blocks].sort((a, b) => b.h - a.h || b.w - a.w);
    const maxW = Math.max(...sorted.map((b) => b.w));
    const sumW = sorted.reduce((s, b) => s + b.w + GAP, 0);
    let best = null;
    for (let i = 0; i <= 16; i++) {
      const packed = pack(sorted, maxW + ((sumW - maxW) * i) / 16);
      const score = area ? Math.min(area.width / packed.W, area.height / packed.H)
        : -Math.abs(Math.log(packed.W / packed.H / target));
      if (!best || score > best.score) best = { ...packed, score };
    }
    const boxes = [];
    sorted.forEach((b, i) => {
      const [x, y] = best.at[i];
      if (b.group) {
        const { at, B } = b.P;
        const dx = x + PAD - B.minX;
        const dy = y + HEAD + PAD - B.minY;
        for (const n of b.group.nodes) {
          const [px, py] = at.get(n);
          n.x = px + dx;
          n.y = py + dy;
        }
      } else {
        for (const g of b.singles) {
          for (const n of g.nodes) {
            n.x = x + PAD + g.cell.x + 60 + n.lx;
            n.y = y + HEAD + PAD + g.cell.y + 22 + n.ly;
          }
        }
      }
      boxes.push({ x, y, w: b.w, h: b.h, label: b.label, sub: b.sub, group: b.group || null });
    });
    const bounds = {
      minX: 0,
      minY: 0,
      maxX: Math.max(...boxes.map((b) => b.x + b.w)),
      maxY: Math.max(...boxes.map((b) => b.y + b.h)),
    };
    return { nodes: groups.flatMap((g) => g.nodes), edges: groups.flatMap((g) => g.edges), boxes, bounds };
  }

  // ═════════ วาด ═════════
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fitText(ctx, text, max) {
    if (max <= 0) return '';
    if (ctx.measureText(text).width <= max) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
      else hi = mid - 1;
    }
    return lo ? `${text.slice(0, lo)}…` : '';
  }

  function fitTextFont(ctx, text, max, font) {
    ctx.font = font;
    return fitText(ctx, text, max);
  }

  function haloText(ctx, text, x, y, fill, halo) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = halo;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  const toward = (p, tx, ty, dist) => {
    const dx = tx - p.x;
    const dy = ty - p.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * dist, y: p.y + (dy / len) * dist };
  };

  function segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const l2 = dx * dx + dy * dy || 1;
    const t = clamp(((px - x1) * dx + (py - y1) * dy) / l2, 0, 1);
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  // ── รูปกล่องพัสดุ (มุมมองสามมิติ) ──
  // พิกัดหน่วยในกล่องกว้าง 18 สูง 19 (ศูนย์กลางที่ 0,0) — ตรงกับไอคอน i-pbox ใน index.html
  const BOX = {
    outline: [[0, -9.5], [9, -5], [9, 5], [0, 9.5], [-9, 5], [-9, -5]],
    top: [[0, -9.5], [9, -5], [0, -0.5], [-9, -5]],
    left: [[-9, -5], [0, -0.5], [0, 9.5], [-9, 5]],
    right: [[0, -0.5], [9, -5], [9, 5], [0, 9.5]],
    tapeTop: [[-3.42, -7.79], [5.58, -3.29], [3.42, -2.21], [-5.58, -6.71]],
    tapeRight: [[3.42, -2.21], [5.58, -3.29], [5.58, 6.71], [3.42, 7.79]],
  };
  const BOX_REACH = 1.07; // ระยะจากกลางถึงมุมไกลสุดของกล่อง เทียบกับ r

  function boxPath(ctx, pts, x, y, s) {
    ctx.beginPath();
    pts.forEach(([px, py], i) => {
      if (i) ctx.lineTo(x + px * s, y + py * s);
      else ctx.moveTo(x + px * s, y + py * s);
    });
    ctx.closePath();
  }

  // ผสมสี hex กับสีเป้าหมาย (ทำเฉดด้านสว่าง/ด้านเงาของกล่องจากสีบทบาทเดียวกัน)
  function mix(hex, target, t) {
    const a = parseInt(hex.slice(1), 16);
    const b = parseInt(target.slice(1), 16);
    const ch = (sh) => {
      const va = (a >> sh) & 255;
      const vb = (b >> sh) & 255;
      return Math.round(va + (vb - va) * t);
    };
    return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
  }

  const shadeCache = new Map();
  function boxShades(pal, role) {
    const key = `${pal.send}|${pal.recv}|${pal.cust}|${pal.bothTop}|${role}`;
    if (!shadeCache.has(key)) {
      const base = role === 'recv' ? pal.recv : role === 'cust' ? pal.cust : pal.send;
      shadeCache.set(key, role === 'both'
        ? { top: pal.bothTop, left: mix(pal.send, '#000000', 0.12), right: pal.recv, line: mix(pal.recv, '#000000', 0.5), hollow: pal.label }
        : { top: mix(base, '#ffffff', 0.42), left: mix(base, '#000000', 0.28), right: base, line: mix(base, '#000000', 0.5), hollow: base });
    }
    return shadeCache.get(key);
  }

  // จุดหนึ่งจุด = กล่องพัสดุ: ผู้ส่งกล่องสีฟ้า · ผู้รับกล่องสีส้ม · ทั้งส่งและรับ ด้านซ้ายฟ้า/ด้านขวาส้ม
  // ไม่มีเบอร์ = กล่องโปร่ง (เส้นขอบ) · มีขอบสีพื้น 2px แยกกล่องออกจากเส้นที่ลากผ่าน
  // u = ขนาด 1px ของหน้าจอในหน่วยที่กำลังวาด
  function paintNode(ctx, x, y, r, n, pal, u) {
    const s = r / 9;
    const sh = boxShades(pal, n.role);
    ctx.lineJoin = 'round';
    boxPath(ctx, BOX.outline, x, y, s);
    ctx.lineWidth = 4 * u;
    ctx.strokeStyle = pal.surface;
    ctx.stroke();
    ctx.fillStyle = pal.surface;
    ctx.fill();
    if (n.type === 'name') {
      ctx.lineWidth = Math.min(1.6 * u, r * 0.3);
      ctx.strokeStyle = sh.hollow;
      for (const face of ['top', 'left', 'right', 'tapeTop', 'tapeRight']) {
        boxPath(ctx, BOX[face], x, y, s);
        ctx.stroke();
      }
      return;
    }
    for (const face of ['top', 'left', 'right']) {
      boxPath(ctx, BOX[face], x, y, s);
      ctx.fillStyle = sh[face];
      ctx.fill();
    }
    boxPath(ctx, BOX.tapeTop, x, y, s);
    ctx.fillStyle = pal.tape;
    ctx.fill();
    boxPath(ctx, BOX.tapeRight, x, y, s);
    ctx.fillStyle = pal.tapeShade;
    ctx.fill();
    // สันกล่อง + ขอบนอก
    ctx.beginPath();
    ctx.moveTo(x - 9 * s, y - 5 * s);
    ctx.lineTo(x, y - 0.5 * s);
    ctx.lineTo(x + 9 * s, y - 5 * s);
    ctx.moveTo(x, y - 0.5 * s);
    ctx.lineTo(x, y + 9.5 * s);
    ctx.lineWidth = 0.8 * u;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.stroke();
    boxPath(ctx, BOX.outline, x, y, s);
    ctx.lineWidth = u;
    ctx.strokeStyle = sh.line;
    ctx.stroke();
  }

  // คำอธิบายสัญลักษณ์บนภาพที่ส่งออก — ขึ้นบรรทัดใหม่เมื่อยาวเกินความกว้าง · dry = วัดความสูงอย่างเดียว
  const LEGEND_ROW = 24;
  function drawLegend(ctx, x, y, pal, maxW, dry = false) {
    ctx.font = `400 12.5px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const items = [
      ['node', 'ผู้ส่ง', { role: 'send', type: 'phone' }, pal],
      ['node', 'ผู้รับ', { role: 'recv', type: 'phone' }, pal],
      ['node', 'ทั้งส่งและรับ', { role: 'both', type: 'phone' }, pal],
      ['node', 'ลูกค้าผู้ฝากส่ง', { role: 'cust', type: 'phone' }, pal],
      ['node', 'ไม่มีเบอร์ (ใช้ชื่อ)', { role: 'send', type: 'name' }, { ...pal, send: pal.muted }],
      ['arrow', 'ส่งพัสดุ (เส้นหนา = หลายชิ้น)'],
      ['dash', 'ชื่อ/ที่อยู่/บัตรประชาชนเดียวกัน'],
      ['dot', 'ลูกค้าฝากส่ง'],
    ];
    const glyphW = { node: 20, arrow: 34, dash: 32, dot: 32 };
    let cx = x;
    let cy = y;
    for (const [kind, text, n, p] of items) {
      const w = glyphW[kind] + ctx.measureText(text).width + 20;
      if (cx > x && cx + w > x + maxW) {
        cx = x;
        cy += LEGEND_ROW;
      }
      if (!dry) {
        ctx.strokeStyle = kind === 'dash' ? pal.edgeName : pal.edge;
        ctx.fillStyle = pal.edge;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        if (kind === 'node') {
          paintNode(ctx, cx + 7, cy, 6.5, n, p, 1);
        } else {
          ctx.setLineDash(kind === 'dash' ? [5, 4] : kind === 'dot' ? [0.1, 4.5] : []);
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + (kind === 'arrow' ? 20 : 24), cy);
          ctx.stroke();
          ctx.setLineDash([]);
          if (kind === 'arrow') {
            ctx.beginPath();
            ctx.moveTo(cx + 27, cy);
            ctx.lineTo(cx + 19, cy - 4.5);
            ctx.lineTo(cx + 19, cy + 4.5);
            ctx.closePath();
            ctx.fill();
          }
        }
        ctx.fillStyle = pal.label;
        ctx.fillText(text, cx + glyphW[kind], cy);
      }
      cx += w;
    }
    return cy - y + LEGEND_ROW;
  }

  // ภาพย่อของเครือข่ายในการ์ดกลุ่ม
  function drawMini(canvas, g) {
    layoutGroup(g);
    const pal = PALETTE[scheme()];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 150;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const L = g.layout;
    const pad = 16;
    const bw = Math.max(1, L.nx1 - L.nx0);
    const bh = Math.max(1, L.ny1 - L.ny0);
    const k = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh, 1);
    const ox = (w - bw * k) / 2 - L.nx0 * k;
    const oy = (h - bh * k) / 2 - L.ny0 * k;
    ctx.lineCap = 'round';
    for (const e of g.edges) {
      const isName = e.type === 'name';
      const isCust = e.type === 'cust';
      ctx.strokeStyle = isName ? pal.edgeName : pal.edge;
      ctx.lineWidth = isName ? 1 : isCust ? 1.4 : 1.2 + Math.min(2, Math.log2(e.parcels.length));
      ctx.setLineDash(isName ? [3, 3] : isCust ? [0.1, 3.2] : []);
      ctx.beginPath();
      ctx.moveTo(e.source.lx * k + ox, e.source.ly * k + oy);
      ctx.lineTo(e.target.lx * k + ox, e.target.ly * k + oy);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const n of g.nodes) {
      paintNode(ctx, n.lx * k + ox, n.ly * k + oy, clamp(n.r * k, 3.5, 9), n, pal, 1);
    }
  }

  // ไอคอนกล่องพัสดุขนาดเล็ก (SVG) สำหรับรายการ/tooltip — สีตามบทบาทเดียวกับในกราฟ
  const ROLE_TITLE = { send: 'ผู้ส่ง', recv: 'ผู้รับ', both: 'ทั้งส่งและรับ', cust: 'ลูกค้าผู้ฝากส่ง' };
  function boxIcon(n) {
    const cls = `pbox ${n.role}${n.type === 'name' ? ' hollow' : ''}`;
    const title = `${ROLE_TITLE[n.role] || ''}${n.type === 'name' ? ' (ไม่มีเบอร์)' : ''}`;
    return `<svg class="${cls}" viewBox="0 0 24 24" role="img" aria-label="${title}"><title>${title}</title><use href="#i-pbox"></use></svg>`;
  }

  // ═════════ มุมมองกราฟแบบโต้ตอบ ═════════
  class GraphView {
    constructor(host, { onSelect, onEdge } = {}) {
      this.host = host;
      this.onSelect = onSelect || (() => {});
      this.onEdge = onEdge || (() => {});
      this.canvas = document.createElement('canvas');
      this.canvas.setAttribute('role', 'img');
      this.canvas.setAttribute('aria-label', 'กราฟเชื่อมโยงหมายเลขโทรศัพท์ของผู้ส่งและผู้รับพัสดุ รายละเอียดแสดงในแผงด้านข้าง');
      this.ctx = this.canvas.getContext('2d');
      this.tip = document.createElement('div');
      this.tip.className = 'graph-tip';
      this.tip.hidden = true;
      host.prepend(this.canvas);
      host.append(this.tip);

      this.k = 1;
      this.tx = 0;
      this.ty = 0;
      this.cw = 0;
      this.ch = 0;
      this.dpr = 1;
      this.nodes = [];
      this.edges = [];
      this.boxes = [];
      this.bounds = null;
      this.selected = null;
      this.hover = null;
      this.hoverEdge = null;
      this.matches = new Set();
      this.pointers = new Map();
      this.drag = null;
      this.pinch = null;
      this.anim = 0;
      this.pendingFit = true;
      this.userMoved = false;
      this.build = null; // ตัวสร้างฉากตามขนาดพื้นที่วาด
      this.sceneArea = null; // ขนาดพื้นที่วาดตอนจัดตำแหน่งครั้งล่าสุด
      this.dragged = false; // ผู้ใช้ลากจุดจัดเองแล้ว
      this.requestDraw = U.rafThrottle(() => this.draw());

      this.bind();
      new ResizeObserver(() => this.resize()).observe(host);
      if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', () => this.requestDraw());
    }

    // ── ข้อมูลและมุมมอง ──
    // scene = ฉากสำเร็จรูป หรือฟังก์ชัน (area) => ฉาก ที่จัดตำแหน่งให้เต็มพื้นที่วาด
    // (แบบฟังก์ชันจะจัดใหม่เองเมื่อขนาด/สัดส่วนพื้นที่วาดเปลี่ยน เช่น ขยายหน้าต่าง หมุนจอ)
    setScene(scene) {
      this.build = typeof scene === 'function' ? scene : () => scene;
      this.dragged = false;
      this.layoutScene();
      this.selected = null;
      this.hover = null;
      this.hoverEdge = null;
      this.matches = new Set();
      this.hideTip();
      if (this.cw) this.fit(false);
      else this.pendingFit = true;
      this.requestDraw();
    }

    // ขอบว่างรอบกราฟเมื่อจัดพอดีจอ (บาง ๆ ให้กราฟเต็มกรอบ)
    fitPad() {
      return clamp(Math.round(Math.min(this.cw, this.ch) * 0.03), 10, 24);
    }

    // ขอบล่าง: เว้นที่ให้คำอธิบายสัญลักษณ์ที่ลอยอยู่มุมล่าง ไม่ให้บังกราฟ
    fitBottom() {
      const legend = this.host.querySelector('.graph-legend');
      const reserve = legend && legend.offsetParent !== null ? legend.offsetHeight + 18 : 0;
      return Math.max(this.fitPad(), Math.min(reserve, this.ch * 0.3));
    }

    // พื้นที่ที่ใช้จัดกราฟให้พอดี (พิกเซล)
    fitArea() {
      if (!this.cw || !this.ch) return null;
      const pad = this.fitPad();
      return { width: Math.max(1, this.cw - pad * 2), height: Math.max(1, this.ch - pad - this.fitBottom()) };
    }

    // จัดตำแหน่งจุดตามขนาดพื้นที่วาดปัจจุบัน (จุดเดิม ตำแหน่งใหม่ — ค่าที่เลือก/ค้นหาไว้ยังอยู่)
    layoutScene() {
      if (!this.build) return;
      const area = this.fitArea();
      const { nodes, edges, boxes, bounds } = this.build(area);
      this.nodes = nodes;
      this.edges = edges;
      this.boxes = boxes;
      this.bounds = bounds;
      this.sceneArea = area;
    }

    // ขนาดพื้นที่วาดต่างจากตอนจัดตำแหน่งครั้งก่อนมากพอ (สัดส่วนหรือขนาดต่าง >10%) หรือยังไม่เคยรู้ขนาด
    areaChanged() {
      const a = this.fitArea();
      const b = this.sceneArea;
      if (!a) return false;
      if (!b) return true;
      return Math.abs(Math.log(a.width / b.width)) > 0.1 || Math.abs(Math.log(a.height / b.height)) > 0.1;
    }

    resize() {
      const rect = this.host.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (!w || !h) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      if (w === this.cw && h === this.ch && dpr === this.dpr) return;
      // ถ้าผู้ใช้ยังไม่ได้ซูม/เลื่อนเอง ให้จัดพอดีจอใหม่ทุกครั้งที่ขนาดเปลี่ยน (เช่น ขยายหน้าต่าง)
      const refit = this.pendingFit || !this.userMoved;
      if (this.cw && !refit) {
        this.tx += (w - this.cw) / 2;
        this.ty += (h - this.ch) / 2;
      }
      this.cw = w;
      this.ch = h;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      if (refit) {
        this.pendingFit = false;
        // จัดตำแหน่งใหม่ให้เต็มกรอบใหม่ (ยกเว้นผู้ใช้ลากจุดจัดเองไว้แล้ว)
        if (!this.dragged && this.areaChanged()) this.layoutScene();
        this.fit(false);
      }
      this.draw();
    }

    fit(animate = true, b = this.bounds) {
      if (!b || !this.cw) return;
      const pad = this.fitPad();
      const { width, height } = this.fitArea();
      const bw = Math.max(1, b.maxX - b.minX);
      const bh = Math.max(1, b.maxY - b.minY);
      const k = clamp(Math.min(width / bw, height / bh), MIN_K, FIT_MAX_K);
      this.moveTo(k, (this.cw - bw * k) / 2 - b.minX * k, pad + (height - bh * k) / 2 - b.minY * k, animate);
      this.userMoved = b !== this.bounds; // ขยายเฉพาะกลุ่มถือเป็นการเลือกมุมมองเอง
    }

    moveTo(k, tx, ty, animate = true) {
      cancelAnimationFrame(this.anim);
      const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!animate || reduce) {
        this.k = k;
        this.tx = tx;
        this.ty = ty;
        this.requestDraw();
        return;
      }
      const from = { k: this.k, tx: this.tx, ty: this.ty };
      const start = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / 320);
        const e = 1 - (1 - t) ** 3;
        this.k = from.k + (k - from.k) * e;
        this.tx = from.tx + (tx - from.tx) * e;
        this.ty = from.ty + (ty - from.ty) * e;
        this.draw();
        if (t < 1) this.anim = requestAnimationFrame(step);
      };
      this.anim = requestAnimationFrame(step);
    }

    zoomAt(sx, sy, factor) {
      cancelAnimationFrame(this.anim);
      this.userMoved = true;
      const k = clamp(this.k * factor, MIN_K, MAX_K);
      const wx = (sx - this.tx) / this.k;
      const wy = (sy - this.ty) / this.k;
      this.k = k;
      this.tx = sx - wx * k;
      this.ty = sy - wy * k;
      this.hideTip();
      this.requestDraw();
    }

    zoomBy(factor) {
      this.zoomAt(this.cw / 2, this.ch / 2, factor);
    }

    centerOn(n) {
      this.userMoved = true;
      const k = Math.max(this.k, 1);
      this.moveTo(k, this.cw / 2 - n.x * k, this.ch / 2 - n.y * k);
    }

    // ปุ่ม "พอดีจอ": ถ้าขนาดจอเปลี่ยนไปตั้งแต่จัดตำแหน่ง ให้จัดใหม่ให้เต็มกรอบก่อน
    refit() {
      if (!this.dragged && this.areaChanged()) this.layoutScene();
      this.fit();
    }

    focusNeighborhood(n) {
      const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const p of [n, ...n.neighbors]) {
        b.minX = Math.min(b.minX, p.x - p.r - 60);
        b.maxX = Math.max(b.maxX, p.x + p.r + 60);
        b.minY = Math.min(b.minY, p.y - p.r - 30);
        b.maxY = Math.max(b.maxY, p.y + p.r + 50);
      }
      this.select(n);
      this.fit(true, b);
    }

    select(n, { center = false, silent = false } = {}) {
      this.selected = n || null;
      if (n && center) this.centerOn(n);
      this.requestDraw();
      if (!silent) this.onSelect(this.selected);
    }

    setMatches(set) {
      this.matches = set;
      this.requestDraw();
    }

    // ── การชี้และลาก ──
    bind() {
      const c = this.canvas;
      c.addEventListener('pointerdown', (e) => this.down(e));
      c.addEventListener('pointermove', (e) => this.move(e));
      c.addEventListener('pointerup', (e) => this.up(e, false));
      c.addEventListener('pointercancel', (e) => this.up(e, true));
      c.addEventListener('pointerleave', () => {
        if (!this.drag) this.setHover(null, null);
      });
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const scale = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0018;
        this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * scale));
      }, { passive: false });
      c.addEventListener('dblclick', (e) => {
        const n = this.hitNode(e.offsetX, e.offsetY);
        if (n) this.focusNeighborhood(n);
        else this.zoomAt(e.offsetX, e.offsetY, 1.6);
      });
    }

    down(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (this.canvas.setPointerCapture) this.canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      cancelAnimationFrame(this.anim);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = {
          d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          k: this.k, tx: this.tx, ty: this.ty,
          mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
        };
        this.drag = null;
        return;
      }
      const node = this.hitNode(e.offsetX, e.offsetY);
      this.drag = {
        id: e.pointerId, node, sx: e.offsetX, sy: e.offsetY, tx: this.tx, ty: this.ty,
        nx: node ? node.x : 0, ny: node ? node.y : 0, moved: false,
      };
    }

    move(e) {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const p = this.pinch;
        this.userMoved = true;
        const k = clamp(p.k * ((Math.hypot(a.x - b.x, a.y - b.y) || 1) / p.d), MIN_K, MAX_K);
        const wx = (p.mx - p.tx) / p.k;
        const wy = (p.my - p.ty) / p.k;
        this.k = k;
        this.tx = (a.x + b.x) / 2 - wx * k;
        this.ty = (a.y + b.y) / 2 - wy * k;
        this.requestDraw();
        return;
      }
      const d = this.drag;
      if (d && d.id === e.pointerId) {
        const dx = e.offsetX - d.sx;
        const dy = e.offsetY - d.sy;
        if (!d.moved && Math.hypot(dx, dy) > 4) {
          d.moved = true;
          this.canvas.classList.add('dragging');
          this.hideTip();
        }
        if (d.moved) {
          this.userMoved = true;
          if (d.node) {
            this.dragged = true; // ผู้ใช้จัดตำแหน่งเอง → ไม่จัดใหม่อัตโนมัติเมื่อขนาดจอเปลี่ยน
            d.node.x = d.nx + dx / this.k;
            d.node.y = d.ny + dy / this.k;
          } else {
            this.tx = d.tx + dx;
            this.ty = d.ty + dy;
          }
          this.requestDraw();
        }
        return;
      }
      if (e.pointerType === 'touch') return;
      const node = this.hitNode(e.offsetX, e.offsetY);
      this.setHover(node, node ? null : this.hitEdge(e.offsetX, e.offsetY), e.offsetX, e.offsetY);
    }

    up(e, cancelled) {
      this.pointers.delete(e.pointerId);
      this.canvas.classList.remove('dragging');
      if (this.pinch) {
        if (this.pointers.size < 2) this.pinch = null;
        this.drag = null;
        return;
      }
      const d = this.drag;
      this.drag = null;
      if (!d || d.id !== e.pointerId || cancelled || d.moved) return;
      if (d.node) {
        this.select(d.node);
        return;
      }
      const edge = this.hitEdge(e.offsetX, e.offsetY);
      if (edge) this.onEdge(edge);
      else this.select(null);
    }

    hitNode(sx, sy) {
      const wx = (sx - this.tx) / this.k;
      const wy = (sy - this.ty) / this.k;
      let best = null;
      let bestD = Infinity;
      for (const n of this.nodes) {
        const d = Math.hypot(n.x - wx, n.y - wy) * this.k;
        const reach = Math.max(n.r * this.k + 5, 12); // เป้าคลิกอย่างน้อย 24px
        if (d <= reach && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    }

    geom(e) {
      const a = e.source;
      const b = e.target;
      let cx = (a.x + b.x) / 2;
      let cy = (a.y + b.y) / 2;
      if (e.curved) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const off = Math.min(28, len * 0.18);
        cx += (-dy / len) * off;
        cy += (dx / len) * off;
      }
      return { cx, cy };
    }

    hitEdge(sx, sy) {
      const u = 1 / this.k;
      const wx = (sx - this.tx) * u;
      const wy = (sy - this.ty) * u;
      let best = null;
      let bestD = 6 * u;
      for (const e of this.edges) {
        const a = e.source;
        const b = e.target;
        let d;
        if (e.curved) {
          const { cx, cy } = this.geom(e);
          d = Infinity;
          let px = a.x;
          let py = a.y;
          for (let i = 1; i <= 10; i++) {
            const t = i / 10;
            const mt = 1 - t;
            const qx = mt * mt * a.x + 2 * mt * t * cx + t * t * b.x;
            const qy = mt * mt * a.y + 2 * mt * t * cy + t * t * b.y;
            d = Math.min(d, segDist(wx, wy, px, py, qx, qy));
            px = qx;
            py = qy;
          }
        } else {
          d = segDist(wx, wy, a.x, a.y, b.x, b.y);
        }
        if (d < bestD) {
          best = e;
          bestD = d;
        }
      }
      return best;
    }

    setHover(node, edge, sx, sy) {
      const changed = node !== this.hover || edge !== this.hoverEdge;
      this.hover = node;
      this.hoverEdge = edge;
      this.canvas.classList.toggle('pointer', !!(node || edge));
      if (node || edge) this.showTip(node, edge, sx, sy);
      else this.hideTip();
      if (changed) this.requestDraw();
    }

    // ข้อความใน tooltip มาจากข้อมูลที่ผู้ใช้กรอก จึงใส่ด้วย textContent เท่านั้น
    showTip(node, edge, sx, sy) {
      const tip = this.tip;
      tip.textContent = '';
      const add = (tag, text, cls) => {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        el.textContent = text;
        tip.append(el);
        return el;
      };
      if (node) {
        const head = document.createElement('div');
        head.className = 'tip-head';
        head.innerHTML = boxIcon(node); // มาร์กอัปคงที่ ไม่มีข้อมูลจากผู้ใช้
        const strong = document.createElement('strong');
        strong.textContent = node.label;
        head.append(strong);
        tip.append(head);
        if (node.type === 'phone') {
          if (node.nameList.length) {
            const more = node.nameList.length > 3 ? ` และอีก ${node.nameList.length - 3} ชื่อ` : '';
            add('div', `ชื่อที่ใช้: ${node.nameList.slice(0, 3).join(', ')}${more}`);
          }
        } else {
          add('div', 'ไม่มีเบอร์โทร (อ้างอิงจากชื่อ)', 'muted');
        }
        if (node.idCardList.length) {
          add('div', `เลขบัตรประชาชน: ${node.idCardList.slice(0, 2).join(', ')}${node.idCardList.length > 2 ? ' …' : ''}`);
        }
        add('div', `ส่ง ${num(node.sent)} · รับ ${num(node.received)}${node.booked ? ` · ลูกค้าฝากส่ง ${num(node.booked)}` : ''} · เชื่อมกับ ${num(node.degree)} หมายเลข`);
        if (node.group && node.group.isNetwork) add('div', node.group.label, 'muted');
      } else if (edge.type === 'parcel' || edge.type === 'cust') {
        add('strong', edge.type === 'cust' ? `ลูกค้าฝากส่ง ${num(edge.parcels.length)} พัสดุ` : `${num(edge.parcels.length)} พัสดุ`);
        add('div', `${edge.source.label} → ${edge.target.label}`);
        const list = edge.parcels.slice(0, 4).map((p) => p.tracking).join(', ');
        add('div', list + (edge.parcels.length > 4 ? ' …' : ''), 'muted code');
      } else {
        add('strong', `ใช้${edge.reason || 'ชื่อเดียวกัน'}`);
        add('div', edge.name);
        add('div', `${edge.source.label} ↔ ${edge.target.label}`, 'muted');
      }
      tip.hidden = false;
      const pad = 14;
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let x = sx + pad;
      let y = sy + pad;
      if (x + tw > this.cw - 8) x = sx - tw - pad;
      if (y + th > this.ch - 8) y = sy - th - pad;
      tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
    }

    hideTip() {
      this.tip.hidden = true;
    }

    // ── วาดทั้งหมด (ใช้ทั้งบนจอ และตอนบันทึกเป็นภาพ) ──
    draw(target) {
      const out = target || {};
      const ctx = out.ctx || this.ctx;
      const W = out.width ?? this.cw;
      const H = out.height ?? this.ch;
      if (!W || !H) return;
      const dpr = out.dpr ?? this.dpr;
      const oy = out.offsetY ?? 0;
      const pal = PALETTE[out.scheme || scheme()];
      const { k, tx, ty } = this;
      const u = 1 / k;
      const hover = out.ctx ? null : this.hover;
      const hoverEdge = out.ctx ? null : this.hoverEdge;
      const sel = this.selected;
      const near = sel ? new Set([sel, ...sel.neighbors]) : null;
      const base = () => ctx.setTransform(dpr, 0, 0, dpr, 0, oy * dpr);

      ctx.save();
      try {
        this.paint(ctx, { W, H, pal, k, tx, ty, u, hover, hoverEdge, sel, near, base, clear: !out.ctx });
      } finally {
        ctx.restore();
      }
    }

    paint(ctx, { W, H, pal, k, tx, ty, u, hover, hoverEdge, sel, near, base, clear }) {
      base();
      if (clear) ctx.clearRect(0, 0, W, H);
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.clip();

      // พื้นที่ที่มองเห็น (หน่วยโลก) สำหรับข้ามสิ่งที่อยู่นอกจอ
      const vx0 = -tx * u - 80;
      const vy0 = -ty * u - 80;
      const vx1 = (W - tx) * u + 80;
      const vy1 = (H - ty) * u + 80;

      ctx.translate(tx, ty);
      ctx.scale(k, k);

      for (const b of this.boxes) {
        if (b.x > vx1 || b.y > vy1 || b.x + b.w < vx0 || b.y + b.h < vy0) continue;
        roundRect(ctx, b.x, b.y, b.w, b.h, 16);
        ctx.fillStyle = pal.box;
        ctx.fill();
        ctx.lineWidth = u;
        ctx.strokeStyle = pal.boxLine;
        ctx.stroke();
      }

      ctx.lineCap = 'round';
      for (const e of this.edges) {
        const a = e.source;
        const b = e.target;
        if (Math.max(a.x, b.x) < vx0 || Math.min(a.x, b.x) > vx1 || Math.max(a.y, b.y) < vy0 || Math.min(a.y, b.y) > vy1) continue;
        const hot = e === hoverEdge || (sel && (a === sel || b === sel));
        ctx.globalAlpha = sel && !hot ? 0.12 : 1;
        const { cx, cy } = this.geom(e);
        // พัสดุ = เส้นทึบมีหัวลูกศร · ชื่อ/ที่อยู่เดียวกัน = เส้นประ · ลูกค้าฝากส่ง = เส้นจุด
        const isName = e.type === 'name';
        const isCust = e.type === 'cust';
        const plain = isName || isCust;
        const w = isName ? 1.5 : isCust ? 2 : 1.5 + Math.min(3, Math.log2(e.parcels.length) * 1.2);
        const color = hot ? pal.ink : isName ? pal.edgeName : pal.edge;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = w * u;
        ctx.setLineDash(isName ? [5 * u, 4 * u] : isCust ? [0.1 * u, 4.5 * u] : []);
        const p0 = toward(a, cx, cy, a.r * BOX_REACH + 2 * u);
        const tip = toward(b, cx, cy, b.r * BOX_REACH + 2 * u);
        const head = (8 + w * 1.2) * u;
        const end = plain ? tip : toward(tip, cx, cy, head * 0.8);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        if (e.curved) ctx.quadraticCurveTo(cx, cy, end.x, end.y);
        else ctx.lineTo(end.x, end.y);
        ctx.stroke();
        if (!plain) {
          // หัวลูกศรชี้เข้าหาผู้รับ
          const dx = tip.x - cx;
          const dy = tip.y - cy;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len;
          const uy = dy / len;
          const half = head * 0.5;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(tip.x, tip.y);
          ctx.lineTo(tip.x - ux * head - uy * half, tip.y - uy * head + ux * half);
          ctx.lineTo(tip.x - ux * head + uy * half, tip.y - uy * head - ux * half);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.setLineDash([]);

      for (const n of this.nodes) {
        if (n.x + n.r < vx0 || n.x - n.r > vx1 || n.y + n.r < vy0 || n.y - n.r > vy1) continue;
        ctx.globalAlpha = near && !near.has(n) ? 0.16 : 1;
        paintNode(ctx, n.x, n.y, n.r, n, pal, u);
        const matched = this.matches.has(n);
        if (matched) {
          // วงเหลืองของผลค้นหา + ขอบเข้มบาง ให้มองเห็นได้ทั้งบนพื้นขาวและพื้นมืด
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r * BOX_REACH + 5.5 * u, 0, TAU);
          ctx.lineWidth = 4 * u;
          ctx.strokeStyle = pal.match;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r * BOX_REACH + 7.5 * u, 0, TAU);
          ctx.lineWidth = u;
          ctx.strokeStyle = pal.ink;
          ctx.stroke();
        }
        if (n === sel || n === hover) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r * BOX_REACH + (matched ? 9 : 5) * u, 0, TAU);
          ctx.lineWidth = (n === sel ? 2.5 : 1.5) * u;
          ctx.strokeStyle = pal.ink;
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      // ── ป้ายข้อความ (ขนาดคงที่บนจอ) ──
      base();
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      const boxFont = clamp(k * 26, 9.5, 13.5);
      for (const b of this.boxes) {
        const sx = b.x * k + tx;
        const sy = b.y * k + ty;
        const bw = b.w * k;
        if (bw < 64 || sx > W || sy > H || sx + bw < 0 || sy + b.h * k < 0) continue;
        const x0 = sx + Math.min(14, 14 * k * 1.5);
        const y0 = sy + (HEAD * k) / 2 + boxFont * 0.45;
        const room = bw - 28;
        ctx.font = `700 ${boxFont}px ${FONT}`;
        ctx.fillStyle = pal.ink;
        const label = fitText(ctx, b.label, room);
        ctx.fillText(label, x0, y0);
        if (b.sub && label === b.label) {
          const lw = ctx.measureText(label).width;
          ctx.font = `400 ${boxFont * 0.92}px ${FONT}`;
          ctx.fillStyle = pal.muted;
          const sub = fitText(ctx, `   ${b.sub}`, room - lw);
          if (sub) ctx.fillText(sub, x0 + lw, y0);
        }
      }

      ctx.textAlign = 'center';
      if (k >= 0.55) {
        ctx.font = `600 10.5px ${FONT}`;
        for (const e of this.edges) {
          if (e.type !== 'parcel' || e.parcels.length < 2) continue;
          if (sel && e.source !== sel && e.target !== sel) continue;
          const { cx, cy } = this.geom(e);
          const sx = (0.25 * e.source.x + 0.5 * cx + 0.25 * e.target.x) * k + tx;
          const sy = (0.25 * e.source.y + 0.5 * cy + 0.25 * e.target.y) * k + ty;
          if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) continue;
          haloText(ctx, `×${e.parcels.length}`, sx, sy + 4, pal.label, pal.surface);
        }
      }

      // ป้ายอยู่ใต้จุด ยกเว้นเมื่อเส้นส่วนใหญ่เข้ามาจากด้านล่าง ให้ย้ายขึ้นไปไว้เหนือจุด (ไม่ให้ป้ายทับเส้น/หัวลูกศร)
      const pull = new Map();
      for (const e of this.edges) {
        const dy = e.target.y - e.source.y;
        const len = Math.hypot(e.target.x - e.source.x, dy) || 1;
        pull.set(e.source, (pull.get(e.source) || 0) + dy / len);
        pull.set(e.target, (pull.get(e.target) || 0) - dy / len);
      }
      for (const n of this.nodes) {
        const important = n === sel || n === hover || this.matches.has(n);
        const neighbor = near ? near.has(n) : false;
        if (near && !neighbor && !important) continue;
        if (!important && !neighbor && k < 0.8 && !(n.degree >= 3 && k >= 0.4)) continue;
        const sx = n.x * k + tx;
        if (sx < -100 || sx > W + 100) continue;
        const showName = n.topName && (important || k >= 1.1);
        const above = (pull.get(n) || 0) / Math.max(1, n.degree) > 0.3;
        const lines = [[fitTextFont(ctx, n.label, 150, `${important ? 700 : 600} 11.5px ${FONT}`), `${important ? 700 : 600} 11.5px ${FONT}`, pal.label]];
        if (showName) lines.push([fitTextFont(ctx, n.topName, 150, `400 10.5px ${FONT}`), `400 10.5px ${FONT}`, pal.muted]);
        const blockH = lines.length * 14;
        const top = above ? (n.y - n.r * 1.06) * k + ty - 6 - blockH : (n.y + n.r * 1.06) * k + ty + 5;
        if (top < -40 || top > H + 10) continue;
        let bw = 0;
        for (const [text, font] of lines) {
          ctx.font = font;
          bw = Math.max(bw, ctx.measureText(text).width);
        }
        ctx.globalAlpha = 0.86;
        roundRect(ctx, sx - bw / 2 - 4, top - 1, bw + 8, blockH + 2, 5);
        ctx.fillStyle = pal.surface;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.textBaseline = 'top';
        lines.forEach(([text, font, color], i) => {
          ctx.font = font;
          haloText(ctx, text, sx, top + i * 14, color, pal.surface);
        });
      }
    }

    // บันทึกมุมมองปัจจุบันเป็นภาพ PNG (พื้นขาว พร้อมหัวเรื่องและคำอธิบายสัญลักษณ์)
    exportPNG({ title, subtitle }) {
      const W = this.cw;
      // มุมมองที่จัดพอดีจอไว้: ตัดแถบที่เว้นไว้ให้คำอธิบายสัญลักษณ์บนจอออก (ในภาพมีคำอธิบายแยกไว้ด้านล่างแล้ว)
      const H = this.userMoved ? this.ch : Math.max(1, this.ch - this.fitBottom() + this.fitPad());
      const head = 72;
      const pal = PALETTE.light;
      const legendH = drawLegend(document.createElement('canvas').getContext('2d'), 20, 0, pal, W - 40, true);
      const foot = legendH + 22;
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = W * scale;
      canvas.height = (H + head + foot) * scale;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H + head + foot);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = pal.ink;
      ctx.font = `700 18px ${FONT}`;
      ctx.fillText(fitText(ctx, title, W - 40), 20, 32);
      ctx.fillStyle = pal.muted;
      ctx.font = `400 13px ${FONT}`;
      ctx.fillText(fitText(ctx, subtitle, W - 40), 20, 54);
      ctx.fillStyle = pal.boxLine;
      ctx.fillRect(0, head - 1, W, 1);
      ctx.fillRect(0, head + H, W, 1);
      this.draw({ ctx, width: W, height: H, dpr: scale, offsetY: head, scheme: 'light' });
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      drawLegend(ctx, 20, head + H + 11 + LEGEND_ROW / 2, pal, W - 40);
      return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    }
  }

  return { build, scene, partyKey, drawMini, boxIcon, GraphView, PALETTE };
})();
