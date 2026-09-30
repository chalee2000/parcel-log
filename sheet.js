/*
 * นำเข้าข้อมูลพัสดุจากตาราง: ไฟล์ Excel (.xlsx) · CSV · ช่วงเซลล์ที่คัดลอกจาก Excel มาวาง
 *
 * อ่านไฟล์ในเครื่องทั้งหมด ไม่ใช้ไลบรารีภายนอก และไม่ส่งข้อมูลออกนอกเครื่อง
 * (.xlsx คือไฟล์ ZIP ที่มี XML ข้างใน — แตกไฟล์ด้วย DecompressionStream ของเบราว์เซอร์)
 *
 * จับคู่ชื่อคอลัมน์ภาษาไทย/อังกฤษเป็นข้อมูลพัสดุ เช่น ไฟล์ข้อมูลรับฝากของ KEX
 *   Consignment_No → เลขพัสดุ · Sender_Name / Sender_Mobile1 → ผู้ส่ง · Recipient_* → ผู้รับ + ที่อยู่
 *   Weight → น้ำหนัก · Surcharge → ค่าขนส่ง · product_Description → ประเภทสินค้า · IDCard → เลขบัตรประชาชนผู้ฝากส่ง
 * คอลัมน์อื่นที่มีข้อมูล (สาขา เลขใบเสร็จ พนักงาน ฯลฯ) เก็บเป็น "ข้อมูลเพิ่มเติม" ของพัสดุแต่ละรายการ
 * ผลลัพธ์มีรูปแบบเดียวกับ ParcelParser.parse() จึงใช้ขั้นตอนนำเข้าและจับคู่เครือข่ายเดียวกัน
 */
'use strict';

const SheetImport = (() => {
  const { clean, lower, digits, formatPhone, nameKey, cleanCode, idCardKey, date, dateTime } = U;
  const { parseDate, parseGeo, splitNamePhone, isBlank } = ParcelParser;

  class SheetError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }

  const MESSAGES = {
    xls: 'ไฟล์ Excel รุ่นเก่า (.xls) ยังอ่านไม่ได้ — เปิดไฟล์ใน Excel แล้วกด “บันทึกเป็น” เลือกชนิด .xlsx (หรือ .csv) ก่อนนำเข้า',
    encrypted: 'ไฟล์นี้ถูกตั้งรหัสผ่าน — เปิดใน Excel แล้วเอารหัสผ่านออกก่อนนำเข้า',
    'bad-file': 'อ่านไฟล์ไม่ได้ — ไฟล์อาจเสียหาย หรือไม่ใช่ไฟล์ Excel/CSV',
    'no-sheet': 'ไม่พบแผ่นงานที่มีข้อมูลในไฟล์นี้',
    'no-inflate': 'เบราว์เซอร์นี้แตกไฟล์ Excel ไม่ได้ — ใช้ Chrome หรือ Edge รุ่นใหม่ หรือบันทึกไฟล์เป็น .csv แล้วนำเข้าแทน',
    'too-big': 'ไฟล์ใหญ่เกินกว่าจะอ่านได้ — แบ่งเป็นหลายไฟล์ หรือบันทึกเป็น .csv',
    empty: 'ไฟล์นี้ไม่มีข้อมูล',
  };
  const messageOf = (err) => MESSAGES[err && err.code] || MESSAGES['bad-file'];

  const extOf = (name) => ((/\.([a-z0-9]+)$/i.exec(name || '') || [])[1] || '').toLowerCase();
  const SHEET_EXT = new Set(['xlsx', 'xlsm', 'xltx', 'xltm', 'xls', 'csv', 'tsv']);
  const isTableFile = (file) => SHEET_EXT.has(extOf(file.name)) || /spreadsheet|ms-excel|csv/i.test(file.type || '');

  // ═════════ ZIP (โครงสร้างของไฟล์ .xlsx) ═════════
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const le32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
  const GZIP_HEAD = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]);

  // สารบัญไฟล์ใน ZIP (ชื่อไฟล์ตัวพิมพ์เล็ก → ตำแหน่ง/ขนาด)
  function zipEntries(buf) {
    let end = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (u32(buf, i) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new SheetError('bad-file');
    const count = u16(buf, end + 10);
    let p = u32(buf, end + 16);
    if (count === 0xffff || p === 0xffffffff) throw new SheetError('too-big');
    const utf8 = new TextDecoder();
    const entries = new Map();
    for (let n = 0; n < count; n++) {
      if (p + 46 > buf.length || u32(buf, p) !== 0x02014b50) throw new SheetError('bad-file');
      const nameLen = u16(buf, p + 28);
      const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/').replace(/^\//, '');
      entries.set(name.toLowerCase(), {
        method: u16(buf, p + 10),
        crc: u32(buf, p + 16),
        size: u32(buf, p + 20),
        fullSize: u32(buf, p + 24),
        offset: u32(buf, p + 42),
      });
      p += 46 + nameLen + u16(buf, p + 30) + u16(buf, p + 32);
    }
    return entries;
  }

  let rawInflate = true;
  async function inflate(data, entry) {
    if (typeof DecompressionStream !== 'function') throw new SheetError('no-inflate');
    let stream;
    let parts = [data];
    try {
      if (!rawInflate) throw new TypeError('deflate-raw');
      stream = new DecompressionStream('deflate-raw');
    } catch {
      // เบราว์เซอร์รุ่นเก่ายังไม่มี deflate-raw → ห่อข้อมูลเป็น gzip (ใช้ CRC และขนาดจากสารบัญ ZIP)
      rawInflate = false;
      stream = new DecompressionStream('gzip');
      parts = [GZIP_HEAD, data, le32(entry.crc), le32(entry.fullSize)];
    }
    return new Uint8Array(await new Response(new Blob(parts).stream().pipeThrough(stream)).arrayBuffer());
  }

  async function unzip(buf, entry) {
    const p = entry.offset;
    if (p + 30 > buf.length || u32(buf, p) !== 0x04034b50) throw new SheetError('bad-file');
    const start = p + 30 + u16(buf, p + 26) + u16(buf, p + 28);
    const data = buf.subarray(start, start + entry.size);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflate(data, entry);
    throw new SheetError('bad-file');
  }

  // ═════════ Excel (.xlsx) ═════════
  const byTag = (node, tag) => Array.from(node.getElementsByTagNameNS('*', tag));
  const childOf = (node, tag) => {
    for (const c of node.children) if (c.localName === tag) return c;
    return null;
  };
  const textOf = (node) => byTag(node, 't').filter((t) => t.parentNode.localName !== 'rPh').map((t) => t.textContent).join('');

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new SheetError('bad-file');
    return doc;
  }

  function resolvePart(base, target) {
    if (target.startsWith('/')) return target.slice(1);
    const parts = base.split('/').filter(Boolean);
    for (const seg of target.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg && seg !== '.') parts.push(seg);
    }
    return parts.join('/');
  }

  // รูปแบบตัวเลขที่เป็นวันที่/เวลา (รหัสมาตรฐานของ Excel หรือรูปแบบที่มี d m y h s / ว ด ป)
  function isDateFormat(id, code) {
    if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47)
      || (id >= 50 && id <= 58) || (id >= 71 && id <= 81)) return true;
    if (!code) return false;
    const s = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '').replace(/[_*]./g, '');
    return /[dmyhsวดปชนท]/i.test(s);
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  // เลขวันที่ของ Excel → "ปปปป-ดด-วว ชช:นน:วว" (เวลาท้องถิ่น) ให้ parseDate อ่านต่อได้
  function serialText(serial, date1904) {
    const days = Math.floor(serial);
    const secs = Math.round((serial - days) * 86400);
    const d = date1904 ? new Date(1904, 0, 1 + days, 0, 0, secs) : new Date(1899, 11, 30 + days, 0, 0, secs);
    if (!Number.isFinite(d.getTime())) return numText(serial);
    const hms = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    if (days <= 0) return hms; // เวลาอย่างเดียว
    const ymd = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    return secs ? `${ymd} ${hms}` : ymd;
  }

  // ตัวเลข → ข้อความสั้นที่สุดที่ยังตรงค่าเดิม (ตัดเศษทศนิยมเพี้ยน เช่น 1.2000000476837158 → 1.2)
  function numText(n) {
    if (Number.isInteger(n)) return Math.abs(n) < 1e21 ? n.toFixed(0) : String(n);
    for (let p = 1; p <= 15; p++) {
      const s = n.toPrecision(p);
      if (Math.abs(Number(s) - n) <= Math.abs(n) * 1e-7) return String(Number(s));
    }
    return String(n);
  }

  function isoText(v) {
    const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2})?))?/.exec(v || '');
    return m ? `${m[1]}${m[2] && m[2] !== '00:00:00' && m[2] !== '00:00' ? ` ${m[2]}` : ''}` : clean(v);
  }

  function colIndex(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i) | 32;
      if (c < 97 || c > 122) break;
      n = n * 26 + (c - 96);
    }
    return n - 1;
  }

  function cellText(cell, ctx) {
    const type = cell.getAttribute('t') || 'n';
    const vEl = childOf(cell, 'v');
    const v = vEl ? vEl.textContent : '';
    switch (type) {
      case 's': return clean(ctx.strings[Number(v)] ?? '');
      case 'inlineStr': {
        const is = childOf(cell, 'is');
        return is ? clean(textOf(is)) : '';
      }
      case 'str': return clean(v);
      case 'b': return v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : v;
      case 'e': return '';
      case 'd': return isoText(v);
      default: {
        if (v === '') return '';
        const n = Number(v);
        if (!Number.isFinite(n)) return clean(v);
        return ctx.dateStyles.has(Number(cell.getAttribute('s') || 0)) ? serialText(n, ctx.date1904) : numText(n);
      }
    }
  }

  // แถวของแผ่นงาน → อาร์เรย์ข้อความ (ข้ามแถวว่าง)
  function sheetRows(doc, ctx) {
    const rows = [];
    for (const row of byTag(doc, 'row')) {
      const cells = [];
      let c = -1;
      for (const cell of row.children) {
        if (cell.localName !== 'c') continue;
        const ref = cell.getAttribute('r');
        c = ref ? colIndex(ref) : c + 1;
        if (c < 0 || c > 16383) continue;
        const v = cellText(cell, ctx);
        if (v !== '') cells[c] = v;
      }
      if (cells.length) rows.push(Array.from(cells, (v) => v ?? ''));
    }
    return rows;
  }

  async function readXlsx(buf) {
    const zip = zipEntries(buf);
    if (zip.has('encryptioninfo')) throw new SheetError('encrypted');
    const utf8 = new TextDecoder();
    const part = async (path) => {
      const e = zip.get(path.toLowerCase());
      return e ? parseXml(utf8.decode(await unzip(buf, e))) : null;
    };

    const wb = await part('xl/workbook.xml');
    const rels = [];
    const relDoc = await part('xl/_rels/workbook.xml.rels');
    if (relDoc) {
      for (const r of byTag(relDoc, 'Relationship')) {
        rels.push({ id: r.getAttribute('Id'), type: r.getAttribute('Type') || '', path: resolvePart('xl', r.getAttribute('Target') || '') });
      }
    }
    const relPath = (suffix, fallback) => (rels.find((r) => r.type.endsWith(suffix)) || { path: fallback }).path;

    let sheets = [];
    let date1904 = false;
    if (wb) {
      const pr = byTag(wb, 'workbookPr')[0];
      date1904 = !!pr && /^(?:1|true)$/i.test(pr.getAttribute('date1904') || '');
      for (const s of byTag(wb, 'sheet')) {
        const idAttr = [...s.attributes].find((a) => a.localName === 'id' && a.namespaceURI);
        const rel = idAttr && rels.find((r) => r.id === idAttr.value);
        const state = s.getAttribute('state');
        if (rel) sheets.push({ name: s.getAttribute('name') || '', path: rel.path, hidden: !!state && state !== 'visible' });
      }
    }
    if (!sheets.length) {
      sheets = [...zip.keys()].filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort()
        .map((path, i) => ({ name: `Sheet${i + 1}`, path, hidden: false }));
    }

    const strings = [];
    const sst = await part(relPath('/sharedStrings', 'xl/sharedStrings.xml'));
    if (sst) for (const si of byTag(sst, 'si')) strings.push(textOf(si));

    const dateStyles = new Set();
    const styles = await part(relPath('/styles', 'xl/styles.xml'));
    if (styles) {
      const fmtRoot = byTag(styles, 'numFmts')[0];
      const formats = new Map(fmtRoot ? byTag(fmtRoot, 'numFmt').map((f) => [Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') || '']) : []);
      const xfs = byTag(styles, 'cellXfs')[0];
      if (xfs) {
        let i = 0;
        for (const xf of xfs.children) {
          if (xf.localName !== 'xf') continue;
          const id = Number(xf.getAttribute('numFmtId') || 0);
          if (isDateFormat(id, formats.get(id))) dateStyles.add(i);
          i += 1;
        }
      }
    }

    const ctx = { strings, dateStyles, date1904 };
    const out = [];
    for (const sh of sheets) {
      const doc = await part(sh.path);
      if (doc) out.push({ name: sh.name || `Sheet${out.length + 1}`, hidden: sh.hidden, rows: sheetRows(doc, ctx) });
    }
    if (!out.some((s) => s.rows.length)) throw new SheetError('no-sheet');
    return out;
  }

  // ═════════ CSV / ข้อความแบ่งด้วยแท็บ ═════════
  // ถอดรหัสข้อความ: UTF-8 (มี/ไม่มี BOM) · UTF-16 · ถ้าไม่ใช่ UTF-8 ถือเป็นภาษาไทยแบบ Windows (TIS-620/874)
  function decodeText(buf) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
    if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      try {
        return new TextDecoder('windows-874').decode(buf);
      } catch {
        return new TextDecoder().decode(buf);
      }
    }
  }

  function sniffDelimiter(text) {
    const line = String(text).slice(0, 8000).split(/\r?\n/).find((l) => l.trim()) || '';
    let best = ',';
    let max = 0;
    for (const ch of ['\t', ',', ';', '|']) {
      const n = line.split(ch).length - 1;
      if (n > max) {
        max = n;
        best = ch;
      }
    }
    return best;
  }

  // ="0812345678" (กันเลข 0 นำหน้าหายเมื่อเปิดใน Excel) → 0812345678
  const unwrapFormula = (v) => {
    const m = /^="([\s\S]*)"$/.exec(v);
    return m ? m[1] : v;
  };

  function parseDelimited(text, delim = sniffDelimiter(text)) {
    const src = String(text || '').replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let atStart = true;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch !== '"') field += ch;
        else if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
        continue;
      }
      if (ch === '"' && atStart) {
        quoted = true;
        atStart = false;
      } else if (ch === delim) {
        row.push(field);
        field = '';
        atStart = true;
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src[i + 1] === '\n') i += 1;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        atStart = true;
      } else {
        field += ch;
        atStart = false;
      }
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows.map((r) => r.map((v) => clean(unwrapFormula(v)))).filter((r) => r.some(Boolean));
  }

  // ตาราง HTML (ระบบเว็บหลายแห่งส่งออกเป็น HTML แต่ตั้งนามสกุล .xls) · DOMParser ไม่รันสคริปต์และไม่โหลดรูป
  function htmlTableRows(text) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const tables = [...doc.querySelectorAll('table')];
    if (!tables.length) return null;
    const table = tables.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
    return [...table.rows].map((tr) => [...tr.cells].map((td) => clean(td.textContent))).filter((r) => r.some(Boolean));
  }

  // อ่านไฟล์: .xlsx → แผ่นงาน · .csv/.tsv (และ .xls ที่เป็นข้อความ/HTML) → ตาราง · อื่น ๆ → ข้อความ ให้ผู้เรียกตัดสินใจต่อ
  async function readFile(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (!buf.length) throw new SheetError('empty');
    const ext = extOf(file.name);
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 3 && buf[3] === 4) {
      return { kind: 'sheets', sheets: await readXlsx(buf) };
    }
    if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
      throw new SheetError(ext === 'xls' ? 'xls' : 'encrypted');
    }
    const text = decodeText(buf);
    const one = (rows) => ({ kind: 'sheets', sheets: [{ name: file.name, hidden: false, rows }] });
    if (['xls', 'htm', 'html'].includes(ext) && /<table[\s>]/i.test(text.slice(0, 50000))) {
      const rows = htmlTableRows(text);
      if (rows && rows.length) return one(rows);
    }
    if (['csv', 'tsv', 'xls'].includes(ext) || /csv/i.test(file.type || '')) return one(parseDelimited(text));
    return { kind: 'text', text };
  }

  // ═════════ จับคู่ชื่อคอลัมน์ → ข้อมูลพัสดุ ═════════
  const norm = (h) => lower(clean(h)).replace(/[\s_\-.:()[\]{}/\\#*'"+,|]+/g, '');

  const FIELD_LABEL = {
    tracking: 'เลขพัสดุ',
    date: 'วันที่ฝากส่ง',
    deliveredAt: 'วันส่งมอบ',
    status: 'สถานะ',
    courier: 'บริษัทขนส่ง',
    sender: 'ชื่อผู้ส่ง',
    senderPhone: 'เบอร์ผู้ส่ง',
    senderAddress: 'ที่อยู่ผู้ส่ง',
    receiver: 'ชื่อผู้รับ',
    receiverPhone: 'เบอร์ผู้รับ',
    receiverAddress: 'ที่อยู่ผู้รับ',
    realSender: 'ชื่อผู้ฝากส่งตามบัตร',
    customer: 'ชื่อลูกค้า (ผู้ฝากส่ง)',
    customerPhone: 'เบอร์ลูกค้า',
    idCard: 'เลขบัตรประชาชนผู้ฝากส่ง',
    productType: 'ประเภทสินค้า',
    weight: 'น้ำหนัก',
    size: 'ขนาดกล่อง',
    fee: 'ค่าขนส่ง',
    drug: 'ชนิดยาเสพติด',
    amount: 'จำนวน/น้ำหนักของกลาง',
    note: 'หมายเหตุ',
    geo: 'พิกัด',
    link: 'ลิงก์ภาพ',
    lat: 'ละติจูด (พิกัด)',
    lng: 'ลองจิจูด (พิกัด)',
    sizeL: 'ความยาว (ขนาดกล่อง)',
    sizeW: 'ความกว้าง (ขนาดกล่อง)',
    sizeH: 'ความสูง (ขนาดกล่อง)',
    extrasList: 'ข้อมูลเพิ่มเติม (หลายรายการ)',
    extra: 'เก็บเป็นข้อมูลเพิ่มเติม',
    skip: 'ไม่นำเข้า',
  };
  // ตัวเลือกที่ผู้ใช้เปลี่ยนเองได้ในหน้าจับคู่คอลัมน์
  const CHOICES = ['tracking', 'date', 'deliveredAt', 'status', 'courier', 'sender', 'senderPhone', 'senderAddress',
    'receiver', 'receiverPhone', 'receiverAddress', 'realSender', 'customer', 'customerPhone', 'idCard',
    'productType', 'weight', 'size', 'fee', 'drug', 'amount', 'note', 'geo', 'link', 'extra', 'skip'];

  // ชื่อคอลัมน์ที่ตรงตัว (หลัง norm) → ช่องข้อมูล · เรียงตามความสำคัญ (ตัวแรกใช้ก่อน)
  const SYN = {
    tracking: ['consignmentno', 'consignmentnumber', 'trackingno', 'trackingnumber', 'trackingid', 'tracking', 'trackno',
      'waybillno', 'waybillnumber', 'waybill', 'awbno', 'awb', 'pno', 'parcelno', 'parcelnumber', 'shipmentno', 'consignment',
      'เลขพัสดุ', 'หมายเลขพัสดุ', 'เลขที่พัสดุ', 'เลขติดตามพัสดุ', 'เลขติดตาม', 'หมายเลขติดตาม', 'หมายเลขติดตามพัสดุ',
      'เลขแทร็ก', 'เลขแทรค', 'หมายเลขสิ่งของ', 'เลขที่สิ่งของ', 'เลขสิ่งของ', 'barcode', 'บาร์โค้ด'],
    date: ['createddate', 'createdate', 'createddatetime', 'createdat', 'createdtime', 'bookingdate', 'bookdate',
      'shipdate', 'shippingdate', 'senddate', 'sentdate', 'acceptdate', 'accepteddate', 'pickupdate', 'pickuptime', 'orderdate',
      'วันที่ฝากส่ง', 'วันที่ฝาก', 'วันที่ส่ง', 'วันที่รับฝาก', 'วันที่รับพัสดุ', 'วันเวลาที่ฝาก', 'วันที่ทำรายการ', 'วันที่สร้าง',
      'วันที่ตรวจพบส่ง', 'วันที่', 'date', 'datetime', 'created'],
    deliveredAt: ['delivereddate', 'delivereddatetime', 'deliveredat', 'deliveredtime', 'deliverydate', 'deliverydatetime',
      'poddate', 'poddatetime', 'signeddate', 'signdate', 'signedtime', 'finisheddate',
      'วันส่งมอบ', 'วันที่ส่งมอบ', 'วันที่ส่งสำเร็จ', 'วันที่นำจ่าย', 'วันที่เซ็นรับ', 'วันเวลาส่งมอบ'],
    status: ['statusname', 'statusdesc', 'statusdescription', 'laststatus', 'currentstatus', 'status',
      'สถานะ', 'สถานะพัสดุ', 'สถานะล่าสุด', 'สถานะการจัดส่ง'],
    courier: ['courier', 'couriername', 'carrier', 'carriername', 'บริษัทขนส่ง', 'ขนส่ง', 'ผู้ให้บริการขนส่ง'],
    sender: ['sendername', 'sender', 'shippername', 'shipper', 'srcname', 'fromname', 'ชื่อผู้ส่ง', 'ผู้ส่ง', 'ชื่อสกุลผู้ส่ง', 'ชื่อนามสกุลผู้ส่ง'],
    realSender: ['realsendername', 'actualsendername', 'realsender', 'depositorname', 'ชื่อผู้ฝากส่งจริง', 'ผู้ฝากส่งจริง', 'ชื่อผู้ฝากส่งตามบัตร'],
    receiver: ['recipientname', 'recipient', 'receivername', 'receiver', 'consigneename', 'consignee', 'dstname', 'toname',
      'ชื่อผู้รับ', 'ผู้รับ', 'ชื่อสกุลผู้รับ', 'ชื่อนามสกุลผู้รับ'],
    customer: ['customername', 'customer', 'membername', 'accountname', 'ลูกค้าผู้ฝากส่ง', 'ชื่อลูกค้า', 'ลูกค้า', 'ผู้ฝากส่ง', 'ชื่อผู้ฝากส่ง'],
    customerPhone: ['customerphone', 'customermobile', 'customertel', 'memberphone', 'เบอร์ลูกค้า', 'เบอร์โทรลูกค้า'],
    idCard: ['idcard', 'idcardno', 'idcardnumber', 'citizenid', 'citizenno', 'nationalid', 'personalid', 'idno',
      'เลขบัตรประชาชน', 'เลขบัตรประชาชนผู้ฝากส่ง', 'เลขบัตรประชาชนผู้ส่ง', 'เลขประจำตัวประชาชน', 'บัตรประชาชน', 'เลขบัตร'],
    productType: ['productdescription', 'producttype', 'productcategory', 'productname', 'product', 'itemdescription', 'itemname',
      'itemtype', 'goodsdescription', 'goodsname', 'goods', 'parceltype', 'ประเภทสินค้า', 'ประเภทพัสดุ', 'ชนิดสินค้า', 'หมวดสินค้า',
      'รายละเอียดสินค้า', 'ชื่อสินค้า', 'สินค้า', 'สิ่งของ'],
    weight: ['weight', 'weightkg', 'parcelweight', 'actualweight', 'grossweight', 'น้ำหนัก', 'น้ำหนักพัสดุ', 'น้ำหนักกก', 'น้ำหนักkg'],
    size: ['parcelsize', 'boxsize', 'size', 'dimension', 'dimensions', 'ขนาด', 'ขนาดกล่อง', 'ขนาดพัสดุ'],
    fee: ['shippingfee', 'shippingcost', 'shippingcharge', 'deliveryfee', 'deliverycharge', 'freight', 'freightcharge', 'freightfee',
      'postage', 'surcharge', 'ค่าขนส่ง', 'ค่าส่ง', 'ค่าจัดส่ง', 'ค่าบริการขนส่ง', 'ค่าฝากส่ง'],
    drug: ['ชนิดยาเสพติด', 'ของกลาง', 'ยาเสพติด'],
    amount: ['จำนวนน้ำหนักของกลาง', 'จำนวนของกลาง', 'น้ำหนักของกลาง', 'ปริมาณของกลาง'],
    note: ['remark', 'remarks', 'note', 'notes', 'comment', 'หมายเหตุ'],
    geo: ['พิกัด', 'พิกัดส่งมอบ', 'latlng', 'latlong', 'coordinates', 'gps', 'location'],
    link: ['ลิงก์ภาพรับพัสดุ', 'ลิงก์ภาพ', 'photourl', 'imageurl', 'podimage', 'podurl'],
    extrasList: ['ข้อมูลเพิ่มเติม'],
  };

  // คอลัมน์ระบบที่ไม่มีประโยชน์ต่อการสืบสวน (ธง/รหัสภายใน) และคอลัมน์ที่แอพนี้คำนวณเองตอนส่งออก CSV
  const NOISE = new Set([
    'recipientpostalcodeid', 'senderpostalcodeid', 'postalcodeid', 'lpreprint', 'samplepkg', 'isbsd', 'ismde', 'ismdeupdated',
    'senttomdec', 'qtyras', 'totaldiscountras', 'shipmentpriority', 'mincoverage', 'codsurchargepercentage', 'codaccountgroup',
    'satdelivery', 'custtype', 'isowner', 'intergroup', 'operationareacode', 'inserttosrvdatetime', 'updatetosrvdatetime',
    'lastupdated', 'updatedby', 'scllocation', 'cutofftime', 'qrcode', 'statusupdatedatetime', 'rowid', 'id', 'no',
    'ลำดับ', 'ลำดับที่', 'index', 'เครือข่าย', 'จำนวนไฟล์แนบ', 'บันทึกเข้าระบบ', 'ที่มา',
  ]);

  // คอลัมน์ที่เก็บเป็นข้อมูลเพิ่มเติม พร้อมชื่อภาษาไทย · money = จำนวนเงิน · count = จำนวนชิ้น (ไม่แสดงถ้าเป็น 1)
  const EXTRA = {
    branchid: ['สาขาที่รับฝาก'], branchcode: ['สาขาที่รับฝาก'], branch: ['สาขา'], branchname: ['สาขา'],
    originbranch: ['สาขาต้นทาง'], destinationbranch: ['สาขาปลายทาง'], dstbranch: ['สาขาปลายทาง'],
    receiptno: ['เลขที่ใบเสร็จ'], receiptnumber: ['เลขที่ใบเสร็จ'], invoiceno: ['เลขที่ใบแจ้งหนี้'],
    createdby: ['ผู้บันทึกรายการ'], hostname: ['เครื่องที่บันทึก'],
    servicecode: ['รหัสบริการ'], servicetype: ['ประเภทบริการ'],
    qty: ['จำนวนชิ้น', 'count'], quantity: ['จำนวนชิ้น', 'count'], pieces: ['จำนวนชิ้น', 'count'], pcs: ['จำนวนชิ้น', 'count'],
    vassurcharge: ['ค่าบริการเสริม', 'money'], declarevalue: ['มูลค่าสินค้าที่แจ้ง', 'money'], declaredvalue: ['มูลค่าสินค้าที่แจ้ง', 'money'],
    codamount: ['ยอด COD', 'money'], cod: ['ยอด COD', 'money'], totalvat: ['ภาษีมูลค่าเพิ่ม', 'money'], vat: ['ภาษีมูลค่าเพิ่ม', 'money'],
    totaldiscount: ['ส่วนลด', 'money'], discount: ['ส่วนลด', 'money'], insurancefee: ['ค่าประกัน', 'money'],
    totalamount: ['ยอดรวม', 'money'], totalprice: ['ยอดรวม', 'money'],
    estdeldate: ['กำหนดส่งถึง (โดยประมาณ)'], estimateddeliverydate: ['กำหนดส่งถึง (โดยประมาณ)'],
    statusdate: ['วันเวลาของสถานะ'], statusdatetime: ['วันเวลาของสถานะ'], laststatusdate: ['วันเวลาของสถานะ'],
    statuscode: ['รหัสสถานะล่าสุด'],
    routecode: ['รหัสเส้นทาง'], linehualroute: ['เส้นทางขนส่ง'], linehaulroute: ['เส้นทางขนส่ง'],
    passportno: ['เลขหนังสือเดินทางผู้ฝากส่ง'], passport: ['เลขหนังสือเดินทางผู้ฝากส่ง'],
    memberid: ['รหัสสมาชิก'], customerid: ['รหัสลูกค้า'], customercode: ['รหัสลูกค้า'],
    cmsorderno: ['เลขคำสั่งซื้อ'], orderno: ['เลขคำสั่งซื้อ'], orderid: ['เลขคำสั่งซื้อ'],
    consignmentref: ['เลขอ้างอิง'], refno: ['เลขอ้างอิง'], reference: ['เลขอ้างอิง'], sealno: ['เลขซีล'],
    productcode: ['รหัสสินค้า'], shipmenttype: ['ประเภทการฝากส่ง'], samplename: ['ชื่อสินค้าตัวอย่าง'], senderproduct: ['สินค้าของผู้ส่ง'],
    codaccountid: ['บัญชีรับเงิน COD'], chargeweight: ['น้ำหนักคิดค่าบริการ'], volumeweight: ['น้ำหนักตามปริมาตร'],
    recipientcontactperson: ['ผู้ติดต่อ (ผู้รับ)'], recipientemail: ['อีเมลผู้รับ'], senderemail: ['อีเมลผู้ส่ง'],
    recipientgender: ['เพศผู้รับ'],
  };

  // บทบาทในชื่อคอลัมน์ (ลูกค้าตรวจก่อน เพราะ "ผู้ฝากส่ง" ไม่ใช่ผู้ส่งบนใบพัสดุ)
  const ROLES = [
    ['customer', /customer|member|ลูกค้า|ผู้ฝากส่ง|ผู้ฝาก/],
    ['sender', /sender|shipper|ผู้ส่ง|^src|^from(?=[a-z])/],
    ['receiver', /recipient|receiver|consignee|ผู้รับ|^dst|^to(?=name|phone|mobile|tel|address)/],
  ];
  const PHONE_ATTR = /^(?:mobile|mobileno|mobilephone|phone|phoneno|phonenumber|tel|telno|telephone|telephoneno|contactno|contactnumber|เบอร์|เบอร์โทร|เบอร์โทรศัพท์|เบอร์มือถือ|โทร|โทรศัพท์|มือถือ|หมายเลขโทรศัพท์)\d*$/;
  const NAME_ATTR = /^(?:|name|fullname|ชื่อ|ชื่อสกุล|ชื่อนามสกุล|ชื่อและนามสกุล)$/;
  const FIRST_ATTR = /^(?:firstname|givenname|ชื่อจริง)$/;
  const LAST_ATTR = /^(?:lastname|surname|familyname|นามสกุล)$/;
  const IDCARD_ATTR = /^(?:idcard|idcardno|citizenid|nationalid|เลขบัตรประชาชน|บัตรประชาชน|เลขประจำตัวประชาชน)$/;
  const ADDR_PARTS = [
    ['addr', /^(?:address|addr|addressline|fulladdress|houseno|homeaddress|ที่อยู่|บ้านเลขที่|ที่อยู่เต็ม)\d*$/],
    ['village', /^(?:village|building|mooban|หมู่บ้าน|อาคาร)$/],
    ['moo', /^(?:moo|หมู่|หมู่ที่)$/],
    ['soi', /^(?:soi|lane|ซอย)$/],
    ['road', /^(?:road|street|ถนน)$/],
    ['tambon', /^(?:subdistrict|tambon|khwaeng|ตำบล|แขวง|ตำบลแขวง)$/],
    ['district', /^district$/],
    ['amphoe', /^(?:amphur|amphoe|amper|city|อำเภอ|เขต|อำเภอเขต)$/],
    ['province', /^(?:province|state|จังหวัด)$/],
    ['postcode', /^(?:postalcode|postcode|zipcode|zip|รหัสไปรษณีย์)$/],
  ];
  const PART_ORDER = ADDR_PARTS.map(([p]) => p);

  // เบอร์หลักก่อน (mobile1) แล้วเบอร์สำรอง · เบอร์บ้าน (telephone) ไว้ท้าย
  const phoneRank = (rest) => (Number((/\d$/.exec(rest) || ['1'])[0]) || 1)
    + (/^(?:tel|telephone|โทรศัพท์)/.test(rest) && !/mobile|มือถือ/.test(rest) ? 5 : 0);

  function classify(header) {
    const h = norm(header);
    if (!h) return { field: 'skip' };
    for (const field of Object.keys(SYN)) {
      const rank = SYN[field].indexOf(h);
      if (rank >= 0) return { field, rank };
    }
    if (NOISE.has(h)) return { field: 'skip' };
    if (EXTRA[h]) return { field: 'extra', label: EXTRA[h][0], format: EXTRA[h][1] || '' };
    for (const [role, re] of ROLES) {
      if (!re.test(h)) continue;
      const rest = h.replace(re, '');
      if (PHONE_ATTR.test(rest)) return { field: `${role}Phone`, rank: phoneRank(rest) };
      if (NAME_ATTR.test(rest)) return { field: role, rank: 50 };
      if (FIRST_ATTR.test(rest)) return { field: role, rank: 60, part: 'first' };
      if (LAST_ATTR.test(rest)) return { field: role, rank: 61, part: 'last' };
      if (IDCARD_ATTR.test(rest)) return { field: 'idCard', rank: 50 };
      if (role !== 'customer') {
        const part = ADDR_PARTS.find(([, r]) => r.test(rest));
        if (part) return { field: `${role}Address`, part: part[0] };
      }
      break;
    }
    if (/^(?:lat|latitude|ละติจูด)$/.test(h)) return { field: 'lat' };
    if (/^(?:lng|lon|long|longitude|ลองจิจูด)$/.test(h)) return { field: 'lng' };
    if (/^(?:length|ความยาว|ยาว)(?:cm)?$/.test(h)) return { field: 'sizeL' };
    if (/^(?:width|ความกว้าง|กว้าง)(?:cm)?$/.test(h)) return { field: 'sizeW' };
    if (/^(?:height|ความสูง|สูง)(?:cm)?$/.test(h)) return { field: 'sizeH' };
    return { field: 'extra', label: clean(header) };
  }

  // บริษัทขนส่งจากชุดคอลัมน์ที่เป็นเอกลักษณ์ของแต่ละระบบ
  function detectCourier(keys) {
    if (keys.has('consignmentno') && (keys.has('realsendername') || keys.has('linehualroute') || keys.has('branchid'))) return 'KEX Express';
    if (keys.has('pno') && (keys.has('dstname') || keys.has('srcname'))) return 'Flash Express';
    return '';
  }

  const colName = (i) => {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };

  // หาแถวหัวตาราง (ภายใน 30 แถวแรก แถวที่รู้จักชื่อคอลัมน์มากที่สุด) แล้วจับคู่ทุกคอลัมน์
  function analyze(rows) {
    let best = { score: -1, at: 0, columns: [] };
    for (let at = 0; at < Math.min(rows.length, 30); at++) {
      const columns = rows[at].map((h, index) => ({ index, header: clean(h), ...classify(h) }));
      const known = columns.filter((c) => c.field !== 'extra' && c.field !== 'skip').length;
      const score = known + (columns.some((c) => c.field === 'tracking') ? 5 : 0);
      if (score > best.score) best = { score, at, columns };
    }
    const data = rows.slice(best.at + 1);
    let width = best.columns.length;
    for (const r of data) width = Math.max(width, r.length);
    const columns = [];
    for (let i = 0; i < width; i++) {
      const c = best.columns[i] || { index: i, header: '', field: 'skip' };
      if (!c.header) c.header = `คอลัมน์ ${colName(i)}`;
      let filled = 0;
      for (const r of data) if (r[i] && !isBlank(r[i])) filled += 1;
      columns.push({ ...c, auto: c.field, filled });
    }
    return {
      headerRow: best.at,
      columns,
      courier: detectCourier(new Set(columns.map((c) => norm(c.header)))),
      dataRows: data.length,
      hasTracking: columns.some((c) => c.field === 'tracking' && c.filled),
    };
  }

  // ───────── แปลงค่าในเซลล์ ─────────
  function fixLeadingZero(p) {
    const d = digits(p);
    return /^[689]\d{8}$/.test(d) || /^[2-7]\d{7}$/.test(d) ? `0${d}` : p;
  }

  // เบอร์ในเซลล์ (อาจมีหลายเบอร์ หรือเลข 0 นำหน้าหายเพราะเก็บเป็นตัวเลข)
  function phoneValues(value) {
    const s = clean(value);
    if (!s || isBlank(s)) return [];
    let phones = splitNamePhone(s).phones;
    if (!phones.length && digits(s).length >= 8 && digits(s).length <= 10) phones = [s];
    return phones.map((p) => formatPhone(fixLeadingZero(p))).filter((p) => digits(p).length >= 8);
  }

  const toNumber = (s) => Number(String(s).replace(/[,\s฿]|บาท|thb/gi, ''));
  const moneyText = (s) => {
    const n = toNumber(s);
    if (!Number.isFinite(n)) return clean(s);
    return n ? `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท` : '';
  };

  function weightText(value, header) {
    const s = clean(value);
    if (!s || /[a-zก-๛]/i.test(s)) return s; // มีหน่วยอยู่แล้ว
    const n = toNumber(s);
    if (!Number.isFinite(n)) return s;
    if (!n) return '';
    const h = norm(header);
    const unit = /gram|กรัม/.test(h) || /[^k]g$/.test(h) ? 'g' : 'kg';
    return `${Number(n.toFixed(3))} ${unit}`;
  }

  // วันที่ในรูป ปปปป-ดด-วว (จาก Excel) แสดงเป็นวันที่ไทย · ตัวเลขศูนย์/ค่าว่างไม่เก็บ
  function extraValue(value, format) {
    const s = clean(value);
    if (!s || isBlank(s) || /^(?:0+(?:\.0+)?|false)$/i.test(s)) return '';
    if (format === 'money') return moneyText(s);
    if (format === 'count' && /^1(?:\.0+)?$/.test(s)) return '';
    const m = /^\d{4}-\d{2}-\d{2}(?: (\d{2}:\d{2}:\d{2}))?$/.exec(s);
    if (m) {
      const t = parseDate(s);
      if (t != null) return m[1] && m[1] !== '00:00:00' ? dateTime(t) : date(t);
    }
    return s;
  }

  // คำนำหน้าของแต่ละระดับในที่อยู่ (ใช้ตรวจว่าที่อยู่เต็มมีส่วนนั้นอยู่แล้วหรือยัง)
  const ADDR_PREFIX = {
    tambon: /^(?:ต\.|ตำบล|แขวง)\s*/,
    amphoe: /^(?:อ\.|อำเภอ|เขต)\s*/,
    province: /^(?:จ\.|จังหวัด)\s*/,
  };
  const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // ต่อที่อยู่จากหลายคอลัมน์ (บ้านเลขที่ หมู่ ซอย ถนน ตำบล อำเภอ จังหวัด รหัสไปรษณีย์)
  // เติม/ย่อคำนำหน้า (ต. อ. จ. · กรุงเทพฯ ใช้ แขวง เขต) และไม่ซ้ำส่วนที่ช่องที่อยู่เต็มระบุไว้แล้ว
  function composeAddress(parts) {
    const has = (k) => parts.some((p) => p.part === k);
    const bkk = parts.some((p) => p.part === 'province' && /กรุงเทพ|bangkok/i.test(p.value));
    const out = [];
    for (const { part, value } of parts) {
      let kind = part;
      if (kind === 'district') kind = has('amphoe') ? 'tambon' : has('tambon') ? 'amphoe' : '';
      let v = clean(value);
      const thai = /[ก-๛]/.test(v);
      if (kind === 'moo' && /^\d+$/.test(v)) v = `ม.${v}`;
      else if (kind === 'soi' && thai && !/^(?:ซ\.|ซอย)/.test(v)) v = `ซ.${v}`;
      else if (kind === 'road' && thai && !/^(?:ถ\.|ถนน)/.test(v)) v = `ถ.${v}`;
      let core = '';
      if (ADDR_PREFIX[kind] && thai) {
        core = v.replace(ADDR_PREFIX[kind], '');
        const inBkk = bkk || /^(?:แขวง|เขต)/.test(v);
        if (kind === 'tambon') v = `${inBkk ? 'แขวง' : 'ต.'}${core}`;
        else if (kind === 'amphoe') v = `${inBkk ? 'เขต' : 'อ.'}${core}`;
        else v = bkk ? core : `จ.${core}`;
      } else if (kind === 'postcode') {
        core = v;
      }
      // ข้ามส่วนที่ช่องที่อยู่เต็มระบุไว้แล้ว (เทียบเฉพาะระดับเดียวกัน เช่น ต.หลังสวน กับ อ.หลังสวน ไม่นับว่าซ้ำ)
      if (core) {
        const prefix = kind === 'tambon' ? '(?:ต\\.|ตำบล|แขวง)\\s*' : kind === 'amphoe' ? '(?:อ\\.|อำเภอ|เขต)\\s*'
          : kind === 'province' ? `(?:จ\\.|จังหวัด)${bkk ? '?' : ''}\\s*` : '';
        if (new RegExp(`(?:^|\\s)${prefix}${reEscape(core)}(?:\\s|$)`).test(out.join(' '))) continue;
      }
      out.push(v);
    }
    return out.join(' ');
  }

  function emptyRecord() {
    return {
      tracking: '', date: null, status: '', customer: '', customerPhone: '', sender: '', senderPhone: '', senderAddress: '',
      receiver: '', receiverPhone: '', receiverAddress: '', deliveredAt: null, geo: '', links: [], courier: '',
      productType: '', weight: '', size: '', fee: '', idCard: '', drug: '', amount: '', note: '', extras: [], extraPhones: [],
    };
  }

  const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

  // ตาราง → รายการพัสดุ (รูปแบบเดียวกับ ParcelParser.parse) · overrides = { เลขคอลัมน์: ช่องข้อมูล } ที่ผู้ใช้เลือกเอง
  function toRecords(rows, info, overrides = {}) {
    const columns = info.columns.map((c) => {
      const pick = overrides[c.index];
      if (!pick || pick === c.auto) return { ...c, field: c.auto };
      // คอลัมน์ที่ผู้ใช้เลือกเองใช้ก่อนคอลัมน์ที่ระบบจับคู่ให้
      return { index: c.index, header: c.header, auto: c.auto, filled: c.filled, field: pick, rank: -1, part: /Address$/.test(pick) ? 'addr' : undefined, label: c.label || c.header };
    });
    const byField = new Map();
    for (const c of columns) {
      if (!byField.has(c.field)) byField.set(c.field, []);
      byField.get(c.field).push(c);
    }
    for (const list of byField.values()) list.sort((a, b) => (a.rank ?? 50) - (b.rank ?? 50) || a.index - b.index);
    const listOf = (field) => byField.get(field) || [];

    const records = [];
    let blank = 0;
    for (const row of rows.slice(info.headerRow + 1)) {
      const cell = (c) => {
        const v = clean(row[c.index] ?? '');
        return isBlank(v) ? '' : v;
      };
      const used = new Set();
      const pick = (field) => {
        for (const c of listOf(field)) {
          const v = cell(c);
          if (v) {
            used.add(c.index);
            return { v, c };
          }
        }
        return { v: '', c: null };
      };
      const r = emptyRecord();
      const extra = (label, value) => {
        if (value && !r.extras.some((e) => e.label === label && e.value === value)) r.extras.push({ label, value });
      };

      r.tracking = cleanCode(pick('tracking').v).replace(/[^0-9A-Z]/g, '');

      for (const key of ['date', 'deliveredAt']) {
        const { v, c } = pick(key);
        if (!v) continue;
        const t = parseDate(v);
        if (t != null) r[key] = t;
        else extra(c.label || c.header, v);
      }

      const status = pick('status');
      if (/^\d+$/.test(status.v)) extra('สถานะ (รหัสในระบบ)', status.v);
      else r.status = status.v;

      // ชื่อ + เบอร์ของผู้ส่ง ผู้รับ ลูกค้า
      const nameOf = (role) => {
        const list = listOf(role);
        const whole = list.find((c) => !c.part && cell(c));
        if (whole) {
          used.add(whole.index);
          return cell(whole);
        }
        return list.filter((c) => c.part && cell(c)).sort((a, b) => (a.part === 'first' ? -1 : 1) - (b.part === 'first' ? -1 : 1))
          .map((c) => {
            used.add(c.index);
            return cell(c);
          }).join(' ');
      };
      const party = {};
      for (const role of ['sender', 'receiver', 'customer']) {
        const { name, phones: inName } = splitNamePhone(nameOf(role));
        const phones = [];
        for (const c of listOf(`${role}Phone`)) for (const p of phoneValues(cell(c))) if (!phones.includes(p)) phones.push(p);
        for (const p of inName) if (!phones.includes(p)) phones.push(p);
        party[role] = { name: /\d{6,}/.test(name) && !/[ก-๛a-z]/i.test(name) ? '' : name, phones };
      }
      // ผู้ฝากส่งตามบัตร: ถ้าเป็นคนเดียวกับผู้ส่งบนใบพัสดุไม่ต้องเก็บซ้ำ · ถ้าต่างกันถือเป็นลูกค้าผู้ฝากส่ง
      const real = splitNamePhone(pick('realSender').v).name;
      if (real) {
        const k = nameKey(real);
        if (!party.sender.name) party.sender.name = real;
        else if (k !== nameKey(party.sender.name) && k !== nameKey(party.customer.name)) {
          if (!party.customer.name) party.customer.name = real;
          else extra(FIELD_LABEL.realSender, real);
        }
      }
      const who = { sender: 'ผู้ส่ง', receiver: 'ผู้รับ', customer: 'ลูกค้า' };
      for (const role of ['sender', 'receiver', 'customer']) {
        r[role] = party[role].name;
        r[`${role}Phone`] = party[role].phones[0] || '';
        r.extraPhones.push(...party[role].phones.slice(1).map((p) => `${who[role]} ${p}`));
      }

      for (const role of ['sender', 'receiver']) {
        const parts = listOf(`${role}Address`)
          .map((c) => ({ part: c.part || 'addr', value: cell(c), index: c.index }))
          .filter((p) => p.value)
          .sort((a, b) => PART_ORDER.indexOf(a.part) - PART_ORDER.indexOf(b.part) || a.index - b.index);
        r[`${role}Address`] = composeAddress(parts);
      }

      const id = pick('idCard');
      if (idCardKey(id.v)) r.idCard = idCardKey(id.v);
      else if (id.v) extra(id.c.label || id.c.header, id.v);

      const weight = pick('weight');
      r.weight = weightText(weight.v, weight.c ? weight.c.header : '');
      r.size = pick('size').v;
      if (!r.size) {
        const dims = ['sizeL', 'sizeW', 'sizeH'].map((k) => pick(k).v).filter(Boolean);
        if (dims.length === 3) r.size = `${dims.join('×')} cm`;
      }
      r.fee = moneyText(pick('fee').v);
      r.courier = pick('courier').v || info.courier;
      for (const key of ['productType', 'drug', 'amount', 'note']) r[key] = pick(key).v;

      const geo = pick('geo').v;
      r.geo = geo ? parseGeo(geo) : '';
      if (!r.geo) {
        const lat = Number(pick('lat').v);
        const lng = Number(pick('lng').v);
        if (lat && lng && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) r.geo = `${lat},${lng}`;
      }

      for (const c of listOf('link')) {
        for (const url of cell(c).match(URL_RE) || []) r.links.push({ label: c.header, url });
      }
      // คอลัมน์ "ข้อมูลเพิ่มเติม" จากไฟล์ CSV ของแอพนี้: "หัวข้อ: ค่า | หัวข้อ: ค่า"
      for (const c of listOf('extrasList')) {
        for (const item of cell(c).split(/\s*\|\s*/)) {
          const at = item.indexOf(':');
          if (at > 0) extra(clean(item.slice(0, at)), clean(item.slice(at + 1)));
        }
      }
      for (const c of listOf('extra')) {
        const v = cell(c);
        if (!v) continue;
        const urls = v.match(URL_RE);
        if (urls && urls.join(' ') === v.replace(/\s+/g, ' ')) {
          for (const url of urls) r.links.push({ label: c.label || c.header, url });
        } else {
          extra(c.label || c.header, extraValue(v, c.format));
        }
      }
      // คอลัมน์สำรองของช่องเดียวกันที่ไม่ได้ใช้ (เช่น วันที่รับพัสดุ เมื่อมีวันที่ฝากแล้ว) → ข้อมูลเพิ่มเติม
      for (const key of ['tracking', 'date', 'deliveredAt', 'courier', 'productType', 'weight', 'size', 'fee', 'note']) {
        for (const c of listOf(key)) {
          if (used.has(c.index)) continue;
          extra(c.label || c.header, extraValue(cell(c), key === 'fee' ? 'money' : ''));
        }
      }

      // แถวที่ไม่มีทั้งเลขพัสดุและเบอร์โทร (เช่น แถวสรุป "รวม … รายการ" ท้ายตาราง) ไม่นับเป็นพัสดุ
      if (r.tracking || r.senderPhone || r.receiverPhone) records.push(r);
      else blank += 1;
    }
    return { records, columns, blank };
  }

  // ข้อความที่วางเป็นตาราง (คัดลอกช่วงเซลล์จาก Excel/Google Sheets) ที่มีคอลัมน์เลขพัสดุหรือไม่
  function tableFromText(text) {
    const s = String(text || '');
    const first = s.split(/\r?\n/).find((l) => l.trim()) || '';
    if (!first.includes('\t') && (first.match(/[,;]/g) || []).length < 2) return null;
    const rows = parseDelimited(s);
    if (rows.length < 2) return null;
    const info = analyze(rows);
    return info.hasTracking ? { rows, info } : null;
  }

  return {
    isTableFile, readFile, parseDelimited, analyze, toRecords, tableFromText, messageOf,
    FIELD_LABEL, CHOICES, norm, classify, composeAddress, numText, serialText,
  };
})();
