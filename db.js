/*
 * ที่เก็บข้อมูลของแอพ (IndexedDB)
 * ข้อมูลทั้งหมดอยู่ในเบราว์เซอร์ของเครื่องนี้เท่านั้น — ไม่มีการส่งออกไปที่ใด
 *
 * parcels : { id, tracking, courier, date, deliveredAt, status,
 *             sender, senderPhone, senderAddress, receiver, receiverPhone, receiverAddress,
 *             drug, amount, note, geo, links[], origin, photoIds[], coverId, createdAt, updatedAt }
 * photos  : ไฟล์แนบ { id, parcelId, full: Blob (ไฟล์ต้นฉบับ), thumb: Blob|null (เฉพาะรูป),
 *             name, type, size, width, height, createdAt }
 * networks: ชื่อเครือข่ายที่ผู้ใช้ตั้ง { id, name, keys[] (หมายเลข/ชื่อในเครือข่ายตอนตั้งชื่อ), createdAt, updatedAt }
 */
'use strict';

const ParcelDB = (() => {
  const NAME = 'parcel-log';
  const VERSION = 2;
  let opening = null;

  const promisify = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const finished = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('transaction failed'));
  });

  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        if (!window.indexedDB) throw new Error('เบราว์เซอร์นี้ไม่รองรับ IndexedDB');
        const req = indexedDB.open(NAME, VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('parcels')) {
            db.createObjectStore('parcels', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('photos')) {
            db.createObjectStore('photos', { keyPath: 'id' }).createIndex('parcelId', 'parcelId');
          }
          if (!db.objectStoreNames.contains('networks')) {
            db.createObjectStore('networks', { keyPath: 'id' });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => db.close();
          resolve(db);
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('ฐานข้อมูลถูกเปิดค้างอยู่ในแท็บอื่น'));
      });
      opening.catch(() => { opening = null; });
    }
    return opening;
  }

  async function getAllParcels() {
    const db = await open();
    return promisify(db.transaction('parcels').objectStore('parcels').getAll());
  }

  async function getPhoto(id) {
    const db = await open();
    return promisify(db.transaction('photos').objectStore('photos').get(id));
  }

  // บันทึกพัสดุพร้อมรูปใหม่ และลบรูปที่ถูกเอาออก ภายในธุรกรรมเดียว
  async function saveParcel(parcel, addPhotos = [], removePhotoIds = []) {
    const db = await open();
    const tx = db.transaction(['parcels', 'photos'], 'readwrite');
    const photos = tx.objectStore('photos');
    removePhotoIds.forEach((id) => photos.delete(id));
    addPhotos.forEach((p) => photos.put(p));
    tx.objectStore('parcels').put(parcel);
    return finished(tx);
  }

  async function deleteParcel(id) {
    const db = await open();
    const tx = db.transaction(['parcels', 'photos'], 'readwrite');
    const photos = tx.objectStore('photos');
    photos.index('parcelId').getAllKeys(IDBKeyRange.only(id)).onsuccess = (e) => {
      e.target.result.forEach((key) => photos.delete(key));
    };
    tx.objectStore('parcels').delete(id);
    return finished(tx);
  }

  // บันทึกเฉพาะข้อมูลพัสดุหลายรายการ (ไม่แตะไฟล์แนบ) — ใช้ตอนนำเข้าข้อความ
  async function putParcels(list) {
    const db = await open();
    const tx = db.transaction('parcels', 'readwrite');
    const store = tx.objectStore('parcels');
    list.forEach((p) => store.put(p));
    return finished(tx);
  }

  // กู้คืนไฟล์สำรองรูปแบบใหม่: แทนที่พัสดุ และล้างไฟล์แนบเดิมของรายการนั้น (ไฟล์แนบจะตามมาทีละไฟล์)
  async function replaceParcel(parcel) {
    const db = await open();
    const tx = db.transaction(['parcels', 'photos'], 'readwrite');
    const photos = tx.objectStore('photos');
    photos.index('parcelId').getAllKeys(IDBKeyRange.only(parcel.id)).onsuccess = (e) => {
      e.target.result.forEach((key) => photos.delete(key));
    };
    tx.objectStore('parcels').put(parcel);
    return finished(tx);
  }

  async function putAttachment(att) {
    const db = await open();
    const tx = db.transaction('photos', 'readwrite');
    tx.objectStore('photos').put(att);
    return finished(tx);
  }

  // นำเข้าจากไฟล์สำรองรูปแบบเดิม: รายการที่มี id เดียวกันจะถูกแทนที่ทั้งข้อมูลและรูปภาพ
  async function importItems(items) {
    const db = await open();
    const tx = db.transaction(['parcels', 'photos'], 'readwrite');
    const parcels = tx.objectStore('parcels');
    const photos = tx.objectStore('photos');
    for (const { parcel, photos: list } of items) {
      photos.index('parcelId').getAllKeys(IDBKeyRange.only(parcel.id)).onsuccess = (e) => {
        e.target.result.forEach((key) => photos.delete(key));
        list.forEach((p) => photos.put(p));
      };
      parcels.put(parcel);
    }
    return finished(tx);
  }

  // ── ชื่อเครือข่าย ──
  async function getNetworkNames() {
    const db = await open();
    return promisify(db.transaction('networks').objectStore('networks').getAll());
  }

  async function putNetworkName(rec) {
    const db = await open();
    const tx = db.transaction('networks', 'readwrite');
    tx.objectStore('networks').put(rec);
    return finished(tx);
  }

  async function deleteNetworkName(id) {
    const db = await open();
    const tx = db.transaction('networks', 'readwrite');
    tx.objectStore('networks').delete(id);
    return finished(tx);
  }

  return {
    open, getAllParcels, getPhoto, saveParcel, deleteParcel, importItems, putParcels, replaceParcel, putAttachment,
    getNetworkNames, putNetworkName, deleteNetworkName,
  };
})();
