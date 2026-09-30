/*
 * แปลงข้อความผลค้นหาพัสดุ (เช่น จากบอทค้นเลขพัสดุ) ให้เป็นรายการพัสดุ
 *
 * รองรับบรรทัดแบบ "ป้าย : ค่า" (มีอีโมจินำหน้าหรือไม่ก็ได้) หลายรูปแบบ เช่น
 *   ℹ️ เลขพัสดุ : TH0000000001A          📦 ข้อมูลพัสดุ : TH0000000002B
 *   ➡️ ผู้ส่ง : ชื่อ นามสกุล 0800000001      🥷 ชื่อลูกค้า : 0800000000(null)
 *   🔹 ที่อยู่ : …   หรือบรรทัดที่อยู่ที่ไม่มีป้าย ต่อจากบรรทัดผู้ส่ง/ผู้รับ
 *   🏋️ น้ำหนัก · 🔎 ขนาด · 🚚 ค่าขนส่ง · 📋 ประเภทสินค้า
 * ป้ายอื่นที่ไม่รู้จัก (เช่น สาขาปลายทาง ยอด COD) เก็บไว้เป็น "ข้อมูลเพิ่มเติม"
 * แยกรายการด้วย "[ ลำดับที่ N ]" หรือเส้น "_____" หรือเมื่อเจอป้ายหลักซ้ำ (เส้น "-----" คือคั่นหัวข้อในรายการเดียวกัน)
 */
'use strict';

const ParcelParser = (() => {
  const { clean, digits, formatPhone, cleanCode } = U;

  // ชื่อป้าย (ตัดช่องว่างออกก่อนเทียบ) → ช่องข้อมูล
  const LABELS = [
    ['tracking', /^(?:เลขพัสดุ|หมายเลขพัสดุ|เลขที่พัสดุ|เลขติดตาม(?:พัสดุ)?|tracking(?:no\.?|number|id)?)$/i],
    ['date', /^(?:วันที่|วันที่ส่ง|วันที่ฝาก|วันที่ฝากส่ง|วันที่รับพัสดุ|date)$/i],
    ['status', /^(?:สถานะ|status)$/i],
    ['customer', /^(?:ชื่อลูกค้า|ลูกค้า|ผู้ฝากส่ง|บัญชีลูกค้า|customer)$/i],
    ['sender', /^(?:ผู้ส่ง|ชื่อผู้ส่ง|sender|from)$/i],
    ['senderPhone', /^(?:เบอร์ผู้ส่ง|เบอร์โทรผู้ส่ง|โทรผู้ส่ง)$/],
    ['senderAddress', /^ที่อยู่ผู้ส่ง$/],
    ['receiver', /^(?:ผู้รับ|ชื่อผู้รับ|receiver|recipient|to)$/i],
    ['receiverPhone', /^(?:เบอร์ผู้รับ|เบอร์โทรผู้รับ|โทรผู้รับ)$/],
    ['receiverAddress', /^ที่อยู่ผู้รับ$/],
    ['address', /^(?:ที่อยู่|address)$/i],
    ['delivered', /^(?:ส่งมอบ|วันที่ส่งมอบ|ส่งสำเร็จ|นำจ่าย|ส่งมอบถึงผู้รับ(?:เวลา)?|เวลาส่งมอบ|delivered)$/i],
    ['geo', /^(?:พิกัด|ตำแหน่ง|location|gps)$/i],
    ['photo', /^(?:ภาพ|รูป)/],
    ['courier', /^(?:ขนส่ง|บริษัทขนส่ง|courier)$/i],
    ['productType', /^(?:ประเภทสินค้า|ประเภทพัสดุ|หมวดสินค้า|หมวดหมู่สินค้า)$/],
    ['weight', /^(?:น้ำหนัก|น้ำหนักพัสดุ|weight)$/i],
    ['size', /^(?:ขนาด|ขนาดกล่อง|ขนาดพัสดุ|dimension|dimensions|size)$/i],
    ['fee', /^(?:ค่าขนส่ง|ค่าส่ง|ค่าจัดส่ง|ค่าบริการขนส่ง|shippingfee)$/i],
    ['idCard', /^(?:เลขบัตรประชาชน(?:ผู้ฝากส่ง|ผู้ส่ง|ลูกค้า)?|เลขประจำตัวประชาชน|บัตรประชาชน|เลขบัตร|idcard)$/i],
    ['drug', /^(?:ของกลาง|ชนิดยาเสพติด|ยาเสพติด)$/],
    ['amount', /^(?:จำนวน|ปริมาณ)$/],
    ['note', /^(?:หมายเหตุ|note)$/i],
  ];

  const HEAD = /ข้อมูลพัสดุ\s*\[\s*(ผู้รับ|ผู้ส่ง)\s*\]\s*[:：]\s*(.+)$/;
  const HEAD_CODE = /ข้อมูลพัสดุ\s*[:：]\s*([A-Za-z0-9-]{6,})/;
  const TOTAL = /ข้อมูลทั้งหมด\s*([\d,]+)\s*รายการ/;
  const RECORD_SEP = /^(?:\[?\s*ลำดับที่\s*\d+\s*\]?|_{5,})$/;
  const SECTION_SEP = /^[-=─—~*•.]{5,}$/;
  // ป้าย = อักษรไทย/ละติน · ข้ามอีโมจิและสัญลักษณ์นำหน้าทั้งหมด (เช่น ℹ️ ซึ่ง Unicode นับเป็นตัวอักษร)
  const LINE = /^[^ก-๛a-zA-Z0-9]*([ก-๛a-zA-Z][ก-๛a-zA-Z\s.]*?)\s*[:：]\s*(.*)$/;
  const URL_RE = /https?:\/\/[^\s<>"'`]+/i;
  // ป้ายที่ขึ้นรายการใหม่เมื่อซ้ำ (กรณีข้อความไม่มีเส้นคั่น)
  const STARTERS = new Set(['tracking', 'date', 'status', 'sender', 'receiver', 'delivered', 'customer']);
  const PARTY = new Set(['sender', 'receiver']);

  // ค่าว่างที่ระบบต้นทางใส่มา เช่น "-", "(null)", "- (-)", "ไม่พบภาพ"
  const isBlank = (v) => {
    const s = clean(v);
    return !s || /^[\s\-–—.:]*$/.test(s) || /^(?:\(?null\)?|none|n\/a|ไม่มี|ไม่ระบุ|ไม่พบ.*|-\s*\(\s*-\s*\))$/i.test(s);
  };

  function labelKey(label) {
    const s = label.replace(/\s+/g, '');
    for (const [key, re] of LABELS) if (re.test(s)) return key;
    return null;
  }

  // เดือนภาษาไทย (เต็ม/ย่อ) เช่น "29 ก.ย. 2569 02:27 น." "17 มกราคม 2568"
  const TH_MONTHS = [
    ['มกราคม', 'ม\\.?ค\\.?'], ['กุมภาพันธ์', 'ก\\.?พ\\.?'], ['มีนาคม', 'มี\\.?ค\\.?'], ['เมษายน', 'เม\\.?ย\\.?'],
    ['พฤษภาคม', 'พ\\.?ค\\.?'], ['มิถุนายน', 'มิ\\.?ย\\.?'], ['กรกฎาคม', 'ก\\.?ค\\.?'], ['สิงหาคม', 'ส\\.?ค\\.?'],
    ['กันยายน', 'ก\\.?ย\\.?'], ['ตุลาคม', 'ต\\.?ค\\.?'], ['พฤศจิกายน', 'พ\\.?ย\\.?'], ['ธันวาคม', 'ธ\\.?ค\\.?'],
  ];
  const TH_MONTH_RE = TH_MONTHS.map(([full, short]) => new RegExp(`^(?:${full}|${short})$`));
  const TH_DATE = new RegExp(`(\\d{1,2})\\s*(${TH_MONTHS.map(([full, short]) => `${full}|${short}`).join('|')})\\s*(\\d{2,4})`
    + '(?:\\s*(?:เวลา)?\\s*(\\d{1,2})[:.](\\d{2})(?:[:.](\\d{2}))?)?');

  function parseDate(value) {
    const s = clean(value);
    let m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T,]+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?)?/.exec(s);
    let y;
    let mo;
    let d;
    if (m) {
      [y, mo, d] = [+m[1], +m[2], +m[3]];
    } else if ((m = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T,]+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?)?/.exec(s))) {
      [d, mo, y] = [+m[1], +m[2], +m[3]];
      if (y < 100) y += y > 50 ? 2500 : 2000;
    } else if ((m = TH_DATE.exec(s))) {
      const month = m[2];
      [d, mo, y] = [+m[1], TH_MONTH_RE.findIndex((re) => re.test(month)) + 1, +m[3]];
      if (y < 100) y += 2500; // ปี พ.ศ. แบบย่อ เช่น 68
    } else {
      return null;
    }
    if (y > 2400) y -= 543; // พ.ศ. → ค.ศ.
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const t = new Date(y, mo - 1, d, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
    return Number.isFinite(t) ? t : null;
  }

  function parseGeo(value) {
    const m = /(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/.exec(value);
    if (!m) return '';
    const lat = +m[1];
    const lng = +m[2];
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? `${lat},${lng}` : '';
  }

  // "ชื่อ นามสกุล 0800000001" → ชื่อ + เบอร์ (รองรับเบอร์ที่มีขีด/เว้นวรรค หลายเบอร์ และ "0800000000(null)")
  const SEP_TOKEN = /^[,;:|/\\–—-]+$/;
  const isPhoneToken = (t) => /^\+?[\d()-]+$/.test(t) && /\d/.test(t);

  function takePhone(tokens, fromEnd) {
    let d = '';
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[fromEnd ? tokens.length - 1 - i : i];
      if (!isPhoneToken(t)) return 0;
      d = fromEnd ? digits(t) + d : d + digits(t);
      if (d.length >= 9) return d.length <= 12 ? i + 1 : 0;
    }
    return 0;
  }

  function splitNamePhone(value) {
    const spaced = clean(value)
      .replace(/([^\d\s+])(\+?\d{9,})/g, '$1 $2')
      .replace(/(\d{9,})([^\d\s])/g, '$1 $2');
    const tokens = spaced.split(' ').filter(Boolean);
    const trim = () => {
      while (tokens.length && SEP_TOKEN.test(tokens[tokens.length - 1])) tokens.pop();
      while (tokens.length && SEP_TOKEN.test(tokens[0])) tokens.shift();
    };
    const phones = [];
    trim();
    for (let guard = 0; guard < 4; guard++) {
      let n = takePhone(tokens, true);
      if (n) {
        phones.unshift(tokens.splice(tokens.length - n, n).join(' '));
        trim();
        continue;
      }
      n = takePhone(tokens, false);
      if (n) {
        phones.push(tokens.splice(0, n).join(' '));
        trim();
        continue;
      }
      break;
    }
    let name = tokens.join(' ')
      .replace(/(?:โทร\.?|tel\.?|เบอร์(?:โทร)?)\s*$/i, '')
      .replace(/[,;:|/\\–—-]+$/, '')
      .trim();
    if (isBlank(name)) name = '';
    return { name, phones: phones.map((p) => formatPhone(p)) };
  }

  function emptyRecord() {
    return { links: [], extraPhones: [], extras: [], lastKey: null, section: '' };
  }

  const meaningful = (c) => !!(c.tracking || c.sender || c.receiver || c.senderPhone || c.receiverPhone || c.customerPhone);

  function finish(c) {
    return {
      tracking: c.tracking || '',
      date: c.date ?? null,
      status: c.status || '',
      customer: c.customer || '',
      customerPhone: c.customerPhone || '',
      sender: c.sender || '',
      senderPhone: c.senderPhone || '',
      senderAddress: c.senderAddress || '',
      receiver: c.receiver || '',
      receiverPhone: c.receiverPhone || '',
      receiverAddress: c.receiverAddress || '',
      deliveredAt: c.delivered ?? null,
      geo: c.geo || '',
      links: c.links,
      courier: c.courier || '',
      productType: c.productType || '',
      weight: c.weight || '',
      size: c.size || '',
      fee: c.fee || '',
      idCard: c.idCard || '',
      drug: c.drug || '',
      amount: c.amount || '',
      note: c.note || '',
      extras: c.extras,
      extraPhones: c.extraPhones,
    };
  }

  function setParty(c, role, value) {
    const { name, phones } = splitNamePhone(value);
    c[role] = name;
    if (phones[0]) c[`${role}Phone`] = phones[0];
    const who = { sender: 'ผู้ส่ง', receiver: 'ผู้รับ', customer: 'ลูกค้า' }[role];
    c.extraPhones.push(...phones.slice(1).map((p) => `${who} ${p}`));
  }

  function addExtra(c, label, value) {
    const lab = clean(label);
    const val = clean(value);
    if (!lab || isBlank(val)) return;
    const ex = c.extras.find((e) => e.label === lab);
    if (ex) ex.value = val;
    else c.extras.push({ label: lab, value: val });
  }

  function parse(text) {
    const out = { records: [], query: null, total: null };
    let cur = emptyRecord();
    const push = () => {
      if (meaningful(cur)) out.records.push(finish(cur));
      cur = emptyRecord();
    };
    for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.replace(/​/g, '').trim();
      if (!line) continue;
      let m = HEAD.exec(line);
      if (m) {
        out.query = { role: m[1], phone: formatPhone(m[2]) };
        continue;
      }
      m = TOTAL.exec(line);
      if (m) {
        out.total = Number(m[1].replace(/,/g, ''));
        continue;
      }
      if (RECORD_SEP.test(line)) {
        push();
        continue;
      }
      if (SECTION_SEP.test(line)) {
        cur.lastKey = null;
        cur.section = '';
        continue;
      }
      m = HEAD_CODE.exec(line);
      if (m) {
        const code = cleanCode(m[1]).replace(/[^0-9A-Z]/g, '');
        if (/^0\d{8,9}$/.test(code)) {
          out.query = out.query || { role: '', phone: formatPhone(code) };
        } else {
          if (cur.tracking) push();
          cur.tracking = code;
        }
        cur.lastKey = null;
        continue;
      }
      m = LINE.exec(line);
      if (!m) {
        // บรรทัดที่ไม่มีป้าย ต่อจากผู้ส่ง/ผู้รับ = ที่อยู่ของคนนั้น
        if (PARTY.has(cur.lastKey)) {
          const key = `${cur.lastKey}Address`;
          cur[key] = cur[key] ? `${cur[key]} ${clean(line)}` : clean(line);
        }
        continue;
      }
      const label = clean(m[1]);
      const value = m[2].trim();
      let key = labelKey(label);
      // ไทม์ไลน์: บรรทัด "… เวลา" เปิดหัวข้อใหม่ ป้ายย่อยในหัวข้อเก็บเป็นข้อมูลเพิ่มเติมพร้อมชื่อหัวข้อ
      const timeLabel = /เวลา$/.test(label.replace(/\s+/g, ''));
      if (timeLabel && key !== 'date') cur.section = label.replace(/\s*เวลา$/, '');
      if (!key || (key === 'note' && cur.section)) {
        addExtra(cur, cur.section && !timeLabel ? `${cur.section} · ${label}` : label, value);
        cur.lastKey = null;
        continue;
      }
      if (STARTERS.has(key) && cur[key === 'delivered' ? 'delivered' : key] !== undefined && !isBlank(value)) push();
      cur.lastKey = key;
      if (isBlank(value)) continue;
      switch (key) {
        case 'tracking': cur.tracking = cleanCode(value).replace(/[^0-9A-Z]/g, ''); break;
        case 'date': cur.date = parseDate(value); break;
        case 'delivered': cur.delivered = parseDate(value); break;
        case 'status': cur.status = clean(value); break;
        case 'sender': setParty(cur, 'sender', value); break;
        case 'receiver': setParty(cur, 'receiver', value); break;
        case 'customer': setParty(cur, 'customer', value); break;
        case 'senderPhone':
        case 'receiverPhone': {
          const { phones } = splitNamePhone(value);
          if (phones[0]) cur[key] = phones[0];
          break;
        }
        case 'address':
          // "ที่อยู่ :" เป็นของผู้ส่งหรือผู้รับ ตามบรรทัดผู้ส่ง/ผู้รับล่าสุดก่อนหน้า
          cur[cur.lastAddressFor === 'receiver' ? 'receiverAddress' : 'senderAddress'] = clean(value);
          break;
        case 'idCard': cur.idCard = digits(value).length === 13 ? digits(value) : clean(value); break;
        case 'geo': cur.geo = parseGeo(value); break;
        case 'photo': {
          const url = URL_RE.exec(value);
          if (url) cur.links.push({ label, url: url[0] });
          break;
        }
        default:
          cur[key] = clean(value);
      }
      if (key === 'sender' || key === 'receiver') cur.lastAddressFor = key;
    }
    push();
    return out;
  }

  // ข้อความนี้น่าจะเป็นข้อมูลพัสดุหรือไม่ (ใช้ตัดสินใจเมื่อผู้ใช้กดวาง)
  function looksLike(text) {
    if (!text || text.length < 15) return false;
    if (!/เลขพัสดุ|หมายเลขพัสดุ|ข้อมูลพัสดุ|tracking/i.test(text)) return false;
    if (!/ผู้ส่ง|ผู้รับ|ลูกค้า|sender|receiver|recipient/i.test(text)) return false;
    return parse(text).records.some((r) => r.tracking);
  }

  return { parse, looksLike, splitNamePhone, parseDate, parseGeo, isBlank };
})();
