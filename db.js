/* db.js — IndexedDB nativo + fila de sincronização.
 * Carregado pela página (<script>) e pelo Service Worker (importScripts): não usar `window`/`localStorage`. */
const DB = (() => {
  'use strict';
  const NAME = 'luiz-autoeletricos';
  const VERSION = 1;
  let dbp = null, seq = 0, syncing = false;

  // ---- Seed fictício (espelha o seed do backend; mesmos IDs) ----
  const SEED = {
    parts: [
      { id: 1, name: 'Filtro de Óleo Bosch OB0045', barcode: '7891002004512', location: 'Corredor B — Prateleira 03', quantity: 4, min_quantity: 2 },
      { id: 2, name: 'Pastilha de Freio Dianteira', barcode: '7891002009981', location: 'Corredor A — Prateleira 01', quantity: 1, min_quantity: 2 },
    ],
    appointment: { id: '3f6c2a1e-8b4d-4c7a-9e21-5d0b7a6c1f10', public_token: 'b7e1c9a4-2d3f-4a68-8c5e-91f0a2d4e6b3',
      vehicle: 'Honda Civic 2018', plate: 'ABC-1D23', customer_name: 'Mariana Souza', status: 'Aguardando Aprovação',
      created_at: '2026-11-13T09:00:00Z' },
    messages: [
      { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', author_type: 'mecanico', author_name: 'Rudmar', created_at: '2026-11-13T09:05:00Z',
        text: 'Mariana, as pastilhas dianteiras do Civic estão no limite. Recomendo a troca.' },
      { id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', author_type: 'cliente', author_name: 'Mariana Souza', created_at: '2026-11-13T09:12:00Z',
        text: 'Entendi. Pode trocar as duas rodas da frente?' },
      { id: 'c3d4e5f6-a7b8-4c9d-ae1f-2a3b4c5d6e7f', author_type: 'mecanico', author_name: 'Rudmar', created_at: '2026-11-13T09:15:00Z',
        text: 'Sim, o par completo. Aguardo a sua aprovação por aqui para começar.' },
    ],
  };

  const uuid = () => {
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const nextTs = () => Date.now() + (seq++ % 1000) / 1000; // ordem estável dentro do mesmo milissegundo

  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(NAME, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('parts', { keyPath: 'id' }).createIndex('barcode', 'barcode', { unique: true });
        d.createObjectStore('appointments', { keyPath: 'id' });
        d.createObjectStore('messages', { keyPath: 'id' }).createIndex('appointment_id', 'appointment_id');
        d.createObjectStore('sync_queue', { keyPath: 'id' });
        d.createObjectStore('meta', { keyPath: 'key' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }

  async function tx(stores, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(stores, mode);
      let out;
      Promise.resolve(fn(t)).then(v => { out = v; }).catch(e => { try { t.abort(); } catch (_) {} rej(e); });
      t.oncomplete = () => res(out);
      t.onabort = () => rej(t.error || new Error('Transação abortada'));
    });
  }
  const getAll = (store) => tx(store, 'readonly', t => req(t.objectStore(store).getAll()));

  // ---- seed / sessão ----
  async function seedIfEmpty() {
    await tx(['parts', 'appointments', 'messages', 'meta'], 'readwrite', async t => {
      if (await req(t.objectStore('meta').get('seeded'))) return;
      SEED.parts.forEach(p => t.objectStore('parts').put(p));
      t.objectStore('appointments').put(SEED.appointment);
      SEED.messages.forEach(m => t.objectStore('messages').put({ ...m, appointment_id: SEED.appointment.id }));
      t.objectStore('meta').put({ key: 'seeded', value: true });
    });
  }
  const getSession = () => tx('meta', 'readonly', t => req(t.objectStore('meta').get('session')));
  const setSession = s => tx('meta', 'readwrite', t => { t.objectStore('meta').put({ ...s, key: 'session' }); });
  const clearSession = () => tx('meta', 'readwrite', t => { t.objectStore('meta').delete('session'); });

  // ---- peças ----
  const getParts = () => getAll('parts');
  const getPartByBarcode = code => tx('parts', 'readonly', t => req(t.objectStore('parts').index('barcode').get(code)));

  /** RF02: decrementa o saldo e enfileira a transação numa única transação atômica do IndexedDB. */
  function useStock(partId, qty = 1) {
    return tx(['parts', 'sync_queue'], 'readwrite', async t => {
      const store = t.objectStore('parts');
      const part = await req(store.get(partId));
      if (!part) return { ok: false, error: 'not_found' };
      if (part.quantity < qty) return { ok: false, error: 'no_stock', quantity: part.quantity };
      part.quantity -= qty;
      store.put(part);
      t.objectStore('sync_queue').put({ id: uuid(), type: 'stock_out', part_id: partId, qty, ts: nextTs() });
      return { ok: true, quantity: part.quantity, part };
    });
  }

  // ---- atendimentos / mensagens ----
  const getAppointments = async () => (await getAll('appointments')).sort((a, b) => b.created_at.localeCompare(a.created_at));
  async function addAppointment(data) {
    const a = { id: uuid(), public_token: uuid(), status: 'Aguardando Aprovação', created_at: new Date().toISOString(), ...data };
    await tx(['appointments', 'sync_queue'], 'readwrite', t => {
      t.objectStore('appointments').put(a);
      t.objectStore('sync_queue').put({ id: a.id, type: 'appointment', ts: nextTs(),
        data: { id: a.id, public_token: a.public_token, vehicle: a.vehicle, plate: a.plate, customer_name: a.customer_name, status: a.status } });
    });
    return a;
  }
  const getMessages = appointmentId => tx('messages', 'readonly', async t => {
    const list = await req(t.objectStore('messages').index('appointment_id').getAll(appointmentId));
    return list.sort((a, b) => a.created_at.localeCompare(b.created_at));
  });
  async function addTextMessage(appointmentId, text, authorName) {
    const m = { id: uuid(), appointment_id: appointmentId, author_type: 'mecanico', author_name: authorName, text, created_at: new Date().toISOString() };
    await tx(['messages', 'sync_queue'], 'readwrite', t => {
      t.objectStore('messages').put(m);
      t.objectStore('sync_queue').put({ id: m.id, type: 'message', ts: nextTs(), data: { id: m.id, appointment_id: appointmentId, text } });
    });
    return m;
  }
  async function addPhotoMessage(appointmentId, blob, altText, text, authorName) {
    const m = { id: uuid(), appointment_id: appointmentId, author_type: 'mecanico', author_name: authorName, text: text || '',
      alt_text: altText, photoBlob: blob, created_at: new Date().toISOString() };
    await tx(['messages', 'sync_queue'], 'readwrite', t => {
      t.objectStore('messages').put(m);
      t.objectStore('sync_queue').put({ id: m.id, type: 'photo', ts: nextTs(), appointment_id: appointmentId, alt_text: altText, text: text || '', blob });
    });
    return m;
  }

  // ---- fila / rejeições ----
  const getQueue = async () => (await getAll('sync_queue')).sort((a, b) => a.ts - b.ts);
  async function getRejections() { const r = await tx('meta', 'readonly', t => req(t.objectStore('meta').get('rejections'))); return r ? r.list : []; }
  const setRejections = list => tx('meta', 'readwrite', t => { t.objectStore('meta').put({ key: 'rejections', list }); });
  const REASONS = { saldo_insuficiente: 'saldo insuficiente no servidor', peca_inexistente: 'peça não existe no servidor',
    atendimento_inexistente: 'atendimento não encontrado', token_em_uso: 'link já em uso', foto_recusada: 'foto recusada (formato, tamanho ou descrição)' };
  const reasonText = r => REASONS[String(r).replace('rejected:', '')] || String(r);

  // ---- sincronização ----
  async function api(path, session, init = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      return await fetch(path, { ...init, signal: ctrl.signal, headers: { ...(init.headers || {}), Authorization: `Bearer ${session.token}` } });
    } finally { clearTimeout(timer); }
  }

  async function sync() {
    if (syncing) return { skipped: true };
    syncing = true;
    try {
      const session = await getSession();
      if (!session || !session.token) return { skipped: true };
      if (session.exp <= Date.now()) { await clearSession(); return { authError: true }; }

      const queue = await getQueue();
      const rejected = [];
      const drop = id => tx('sync_queue', 'readwrite', t => { t.objectStore('sync_queue').delete(id); });
      const settle = async (item, res) => {
        if (res === 'ok' || res === 'duplicate') await drop(item.id);
        else if (String(res).startsWith('rejected')) { await drop(item.id); rejected.push({ type: item.type, reason: reasonText(res), at: Date.now() }); }
      };

      const json = queue.filter(q => q.type !== 'photo');
      if (json.length) {
        const body = { appointments: [], messages: [], stock_out: [] };
        for (const q of json) {
          if (q.type === 'appointment') body.appointments.push(q.data);
          else if (q.type === 'message') body.messages.push(q.data);
          else if (q.type === 'stock_out') body.stock_out.push({ client_id: q.id, part_id: q.part_id, qty: q.qty });
        }
        const r = await api('/api/sync', session, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (r.status === 401) { await clearSession(); return { authError: true }; }
        if (r.status >= 400 && r.status < 500) throw new Error('Servidor recusou o lote (' + r.status + ')');
        if (!r.ok) throw new Error('Erro do servidor');
        const { results } = await r.json();
        for (const q of json) await settle(q, results[q.id]);
      }

      for (const q of queue.filter(x => x.type === 'photo')) {
        const fd = new FormData();
        fd.append('message_id', q.id); fd.append('alt_text', q.alt_text); fd.append('text', q.text || '');
        const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[q.blob.type] || 'jpg';
        fd.append('file', q.blob, `foto.${ext}`);
        const r = await api(`/api/appointments/${q.appointment_id}/photos`, session, { method: 'POST', body: fd });
        if (r.status === 401) { await clearSession(); return { authError: true }; }
        if (r.ok) await settle(q, 'ok');
        else if (r.status >= 400 && r.status < 500) await settle(q, 'rejected:foto_recusada');
        else throw new Error('Erro do servidor');
      }

      if (rejected.length) await setRejections([...(await getRejections()), ...rejected]);
      await pull(session);
      return { ok: true, rejected: rejected.length };
    } catch (e) {
      return { error: String(e && e.message || e) };
    } finally { syncing = false; }
  }

  /** Atualiza o cache local com o servidor, preservando baixas ainda pendentes. */
  async function pull(session) {
    const r = await api('/api/sync/pull', session);
    if (r.status === 401) { await clearSession(); return; }
    if (!r.ok) throw new Error('Falha ao atualizar dados');
    const data = await r.json();
    const pendingByPart = {};
    for (const q of await getQueue()) if (q.type === 'stock_out') pendingByPart[q.part_id] = (pendingByPart[q.part_id] || 0) + q.qty;
    await tx(['parts', 'appointments', 'messages'], 'readwrite', t => {
      const parts = t.objectStore('parts'); parts.clear();
      data.parts.forEach(p => parts.put({ ...p, quantity: Math.max(0, p.quantity - (pendingByPart[p.id] || 0)) }));
      data.appointments.forEach(a => t.objectStore('appointments').put(a));
      data.messages.forEach(m => t.objectStore('messages').put(m));
    });
  }

  return { open, uuid, seedIfEmpty, getSession, setSession, clearSession, getParts, getPartByBarcode, useStock,
    getAppointments, addAppointment, getMessages, addTextMessage, addPhotoMessage, getQueue, getRejections,
    clearRejections: () => setRejections([]), sync };
})();
