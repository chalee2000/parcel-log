/*
 * ฟังก์ชันช่วยที่ใช้ร่วมกันทุกไฟล์
 * ข้อความ · เบอร์โทร · ชื่อ · วันที่ (พ.ศ.) · การไฮไลต์คำค้น · ไฟล์
 */
'use strict';

const U = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const icon = (name, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

  const uid = () => (window.crypto && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  const debounce = (fn, ms) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  };

  const rafThrottle = (fn) => {
    let queued = false;
    return () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        fn();
      });
    };
  };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = (n) => Number(n || 0).toLocaleString('th-TH');

  // localStorage อาจใช้ไม่ได้ (โหมดส่วนตัว/ถูกปิด) จึงห่อ try/catch ไว้เสมอ
  const PREFIX = 'parcel-log:';
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
      } catch {
        /* ไม่มีที่เก็บก็ไม่เป็นไร — เป็นแค่การจำค่าที่เลือกไว้ */
      }
    },
  };

  // ───────── ข้อความและรหัส ─────────
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const lower = (s) => String(s ?? '').toLocaleLowerCase('th');
  const cleanCode = (s) => String(s ?? '').replace(/\s+/g, '').toUpperCase();
  const codeKey = (s) => String(s ?? '').toLowerCase().replace(/[^0-9a-z]/g, '');
  const digits = (s) => String(s ?? '').replace(/\D/g, '');

  // เบอร์ที่ขึ้นต้น +66 / 66 แปลงเป็นรูปแบบในประเทศ (0XX…)
  const phoneKey = (s) => {
    let d = digits(s);
    if (d.startsWith('66') && (d.length === 10 || d.length === 11)) d = `0${d.slice(2)}`;
    return d;
  };

  function formatPhone(raw) {
    const s = clean(raw);
    if (!s) return '';
    const d = phoneKey(s);
    if (/^0[689]\d{8}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
    if (/^02\d{7}$/.test(d)) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
    if (/^0[3-7]\d{7}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
    return s;
  }

  function phoneWarning(raw) {
    const s = clean(raw);
    if (!s) return '';
    if (/[^\d\s()+\-.]/.test(s)) return 'เบอร์โทรควรมีเฉพาะตัวเลข';
    if (s.startsWith('+') && !s.startsWith('+66')) return ''; // เบอร์ต่างประเทศ
    return /^0\d{8,9}$/.test(phoneKey(s)) ? '' : 'เบอร์โทรไทยควรมี 9–10 หลัก และขึ้นต้นด้วย 0';
  }

  const telHref = (phone) => {
    const s = clean(phone);
    return `tel:${s.startsWith('+') ? `+${digits(s)}` : digits(s)}`;
  };

  // ชื่อสำหรับเทียบว่าเป็นคนเดียวกัน: ตัดคำนำหน้าชื่อ ไม่สนตัวพิมพ์และช่องว่าง
  const TH_TITLE = /^(?:นางสาว|นาง|นาย|น\.ส\.|ด\.ช\.|ด\.ญ\.|เด็กชาย|เด็กหญิง|คุณ)\s*/;
  const EN_TITLE = /^(?:mrs|mr|ms|miss)(?:\.\s*|\s+)/i;
  function nameKey(name) {
    let s = lower(clean(name));
    const m = TH_TITLE.exec(s) || EN_TITLE.exec(s);
    if (m) {
      const rest = s.slice(m[0].length);
      // ตัดเฉพาะเมื่อส่วนที่เหลือขึ้นต้นด้วยพยัญชนะ/สระหน้า (กันกรณีชื่อจริงขึ้นต้นด้วย "นาย…")
      if (/^[ก-ฮเ-ไa-z]/.test(rest)) s = rest;
    }
    return s.length >= 2 ? s : '';
  }

  // เลขบัตรประชาชน 13 หลัก (ใช้เทียบว่าเป็นคนเดียวกัน) · แสดงแบบ 1-2345-67890-12-3
  const idCardKey = (s) => {
    const d = digits(s);
    return d.length === 13 ? d : '';
  };
  function formatIdCard(s) {
    const d = idCardKey(s);
    return d ? `${d[0]}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d[12]}` : clean(s);
  }
  // ตรวจหลักสุดท้ายของเลขบัตรประชาชน (กันพิมพ์ผิด)
  function idCardValid(s) {
    const d = idCardKey(s);
    if (!d) return false;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(d[i]) * (13 - i);
    return (11 - (sum % 11)) % 10 === Number(d[12]);
  }

  // ที่อยู่สำหรับเทียบว่าเป็นที่เดียวกัน: ตัดช่องว่าง/เครื่องหมาย และต้องยาวพอ มีเลขที่บ้าน (กันจับคู่ผิดจากที่อยู่กว้าง ๆ)
  function addressKey(address) {
    const s = lower(clean(address)).replace(/[\s,.;:'"()\-–—/\\]+/g, '');
    return s.length >= 15 && /\d/.test(s) ? s : '';
  }

  // เดาบริษัทขนส่งจากรูปแบบเลขพัสดุ (เฉพาะรูปแบบที่ชัดเจน)
  function guessCourier(code) {
    const c = cleanCode(code);
    if (/^[A-Z]{2}\d{9}TH$/.test(c)) return 'ไปรษณีย์ไทย';
    if (/^SPXTH/.test(c)) return 'SPX Express';
    if (/^LEX/.test(c)) return 'Lazada Express';
    return '';
  }

  // ───────── การค้นหา ─────────
  const PHONE_LIKE = /^[+\d()\-.\s]+$/;

  // แยกคำค้น: ถ้าพิมพ์เหมือนเบอร์โทรทั้งก้อน (มีขีด/เว้นวรรค) ถือเป็นคำเดียว
  function parseTerms(query) {
    const q = clean(query);
    if (!q) return [];
    const parts = PHONE_LIKE.test(q) && /\d/.test(q) ? [q] : q.split(' ');
    return parts.map((raw) => {
      const d = digits(raw);
      const phones = PHONE_LIKE.test(raw) && d ? [...new Set([d, phoneKey(raw)])] : [];
      return { raw, text: lower(raw), code: codeKey(raw), phones };
    });
  }

  // สระบน/ล่างและวรรณยุกต์ไทย — ห้ามตัดแยกจากพยัญชนะตอนไฮไลต์
  const COMBINING = /[̀-ͯัำ-ฺ็-๎]/;

  // คืน HTML ที่ครอบคำที่ตรงด้วย <mark> (เทียบแบบไม่สนตัวพิมพ์ ขีด หรือช่องว่าง ตามชนิดข้อมูล)
  function highlight(value, terms, kind = 'text') {
    const text = String(value ?? '');
    if (!text || !terms || !terms.length) return esc(text);
    let norm = '';
    const map = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let n;
      if (kind === 'phone') n = ch >= '0' && ch <= '9' ? ch : '';
      else if (kind === 'code') n = /[0-9a-z]/i.test(ch) ? ch.toLowerCase() : '';
      else n = ch.toLocaleLowerCase('th');
      for (let j = 0; j < n.length; j++) {
        norm += n[j];
        map.push(i);
      }
    }
    const ranges = [];
    for (const t of terms) {
      const needles = kind === 'phone' ? t.phones : [kind === 'code' ? t.code : t.text];
      for (const q of needles) {
        if (!q) continue;
        for (let at = norm.indexOf(q); at !== -1; at = norm.indexOf(q, at + q.length)) {
          let s = map[at];
          let e = map[at + q.length - 1] + 1;
          while (s > 0 && COMBINING.test(text[s])) s -= 1;
          while (e < text.length && COMBINING.test(text[e])) e += 1;
          ranges.push([s, e]);
        }
      }
    }
    if (!ranges.length) return esc(text);
    ranges.sort((a, b) => a[0] - b[0]);
    let out = '';
    let pos = 0;
    for (const [s, e] of ranges) {
      if (e <= pos) continue;
      const from = Math.max(s, pos);
      out += `${esc(text.slice(pos, from))}<mark>${esc(text.slice(from, e))}</mark>`;
      pos = e;
    }
    return out + esc(text.slice(pos));
  }

  // ───────── วันที่ (ปฏิทินพุทธศักราช) ─────────
  const LOCALE = 'th-TH-u-ca-buddhist';
  const fmtDate = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtDayLong = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtTime = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });

  const date = (ts) => fmtDate.format(ts);
  const time = (ts) => fmtTime.format(ts);
  const dateTime = (ts) => `${fmtDate.format(ts)} ${fmtTime.format(ts)} น.`;
  const dayLong = (ts) => fmtDayLong.format(ts);
  const dateRange = (a, b) => (startOfDay(a) === startOfDay(b) ? date(a) : `${date(a)} – ${date(b)}`);

  function startOfDay(ts = Date.now()) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function addDays(ts, n) {
    const d = new Date(ts);
    d.setDate(d.getDate() + n);
    return d.getTime();
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  // ค่าสำหรับ <input type="datetime-local"> (เวลาท้องถิ่น)
  function toLocalInput(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  function fromLocalInput(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime() : NaN;
  }
  function fileStamp() {
    const d = new Date();
    return `${d.getFullYear() + 543}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  }

  // ───────── ไฟล์ ─────────
  function formatBytes(n) {
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    (document.querySelector('dialog[open]') || document.body).append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  const blobToDataURL = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  function dataURLToBlob(url) {
    const comma = url.indexOf(',');
    const type = (/^data:([^;,]+)/.exec(url.slice(0, comma)) || [])[1] || 'application/octet-stream';
    const bin = atob(url.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  return {
    $, $$, esc, icon, uid, debounce, rafThrottle, clamp, num, store,
    clean, lower, cleanCode, codeKey, digits, phoneKey, formatPhone, phoneWarning, telHref, nameKey, addressKey, guessCourier,
    idCardKey, formatIdCard, idCardValid,
    parseTerms, highlight,
    date, time, dateTime, dayLong, dateRange, startOfDay, addDays, toLocalInput, fromLocalInput, fileStamp,
    formatBytes, download, blobToDataURL, dataURLToBlob,
  };
})();
