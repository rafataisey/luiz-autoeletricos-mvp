/* app.js — 3 telas (Início, Peças, Chat/Alertas) + visão pública do cliente (?t=UUID). */
(() => {
  'use strict';

  // ------------------------------------------------------------------ utilidades
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const PLATE = /^[A-Z]{3}-?[0-9][A-Z0-9][0-9]{2}$/;
  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX_PHOTO = 5 * 1024 * 1024;
  const hhmm = iso => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const dhm = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const units = n => `${n} ${n === 1 ? 'unidade' : 'unidades'}`;

  const ICONS = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    camera: '<path d="M4 7h3l2-3h6l2 3h3v13H4z"/><circle cx="12" cy="13" r="4"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
    wifi: '<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1"/>',
    wifioff: '<path d="M2 2l20 20"/><path d="M8.5 16a5 5 0 0 1 7 0"/><path d="M5 12.5a10 10 0 0 1 5-2.5M19 12.5a10 10 0 0 0-2.5-1.8"/><circle cx="12" cy="19.5" r="1"/>',
    warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
    clip: '<path d="M21 11l-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"/>',
    sync: '<path d="M21 12a9 9 0 0 0-15-6.7L3 8M3 3v5h5M3 12a9 9 0 0 0 15 6.7L21 16M21 21v-5h-5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  };
  const icon = (n, cls = 'w-6 h-6') => `<svg class="${cls} shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[n]}</svg>`;

  const state = { session: null, route: 'home', sub: null, apptId: null, online: navigator.onLine,
    parts: [], appts: [], queue: [], rejections: [], query: '' };
  let objectUrls = [];

  const announce = msg => { const l = $('#live'); l.textContent = ''; setTimeout(() => { l.textContent = msg; }, 30); };
  const statusBadge = s => `<span class="inline-flex items-center gap-1 rounded-full border border-amber-800 bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-950">${icon('clock', 'w-4 h-4')}${esc(s)}</span>`;
  const netBadge = () => state.online
    ? `<span class="inline-flex items-center gap-1 rounded-full bg-green-100 px-3 py-1 text-sm font-bold text-green-950">${icon('wifi', 'w-4 h-4')}Online</span>`
    : `<span class="inline-flex items-center gap-1 rounded-full bg-amber-100 px-3 py-1 text-sm font-bold text-amber-950">${icon('wifioff', 'w-4 h-4')}Offline</span>`;
  const lowParts = () => state.parts.filter(p => p.quantity <= p.min_quantity);

  // ------------------------------------------------------------------ dados / sincronização
  async function refreshData() {
    [state.parts, state.appts, state.queue, state.rejections] = await Promise.all([
      DB.getParts(), DB.getAppointments(), DB.getQueue(), DB.getRejections()]);
    state.parts.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  let syncTimer = null;
  async function runSync(manual = false) {
    if (!state.session || state.session.demo || !state.online) return;
    const r = await DB.sync();
    if (r.authError) { state.session = null; await show('home'); return; }
    await refreshData();
    chrome();
    if (state.route === 'chat' && state.apptId) await loadMessages();
    if (manual) announce(r.error ? 'Não foi possível sincronizar agora.' : 'Sincronização concluída.');
  }
  async function afterLocalChange() {
    await refreshData(); chrome();
    try { const reg = await navigator.serviceWorker?.ready; await reg?.sync?.register('sync-queue'); } catch (_) {}
    runSync();
  }

  // ------------------------------------------------------------------ cromo: cabeçalho, banners, navegação
  function chrome() {
    const s = state.session;
    $('#app-header').innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <p class="text-lg font-extrabold">Luiz Autoelétricos</p>${netBadge()}
      </div>
      ${s ? `<div class="flex flex-wrap items-center justify-between gap-x-3 px-3 pb-2 text-sm">
        <p>${esc(s.name)} · ${esc(s.role)}${s.demo ? ' (demonstração)' : ''}<span class="block text-slate-200">Sessão até ${hhmm(s.exp)}</span></p>
        <button class="btn text-white underline" data-action="logout">Sair</button></div>` : ''}`;
    document.documentElement.style.setProperty('--header-h', $('#app-header').offsetHeight + 'px');
    renderBanners();
    const alerts = alertItems().length;
    const items = [['home', 'Início', 'home'], ['parts', 'Peças', 'box'], ['chat', 'Chat', 'chat'], ['alerts', 'Alertas', 'bell']];
    $('#bottom-nav').hidden = !s;
    $('#bottom-nav').innerHTML = `<ul class="grid grid-cols-4">${items.map(([r, label, ic]) => `
      <li><button class="tap relative flex w-full flex-col items-center justify-center gap-0.5 px-1 py-2 text-xs font-bold ${state.route === r ? 'bg-slate-900 text-white' : 'text-slate-900'}"
        data-action="nav" data-to="${r}" ${state.route === r ? 'aria-current="page"' : ''}>
        ${icon(ic)}<span>${label}${r === 'alerts' && alerts ? `<span class="ml-1 rounded-full bg-red-800 px-1.5 text-white">${alerts}<span class="sr-only"> pendentes</span></span>` : ''}</span>
      </button></li>`).join('')}</ul>`;
    document.documentElement.style.setProperty('--nav-h', $('#bottom-nav').offsetHeight + 'px');
  }

  function alertItems() {
    const items = [];
    if (!state.online) items.push({ kind: 'offline', text: 'Você está offline. Tudo continua salvo neste aparelho.' });
    if (state.queue.length) items.push({ kind: 'sync', text: `${state.queue.length} ${state.queue.length === 1 ? 'pendência' : 'pendências'} de sincronização. ${state.online ? 'Envio em andamento ou aguardando.' : 'Serão enviadas quando a conexão voltar.'}` });
    for (const p of lowParts()) items.push({ kind: 'low', text: `Estoque mínimo: ${p.name} — restam ${units(p.quantity)} (mínimo ${p.min_quantity}).` });
    for (const r of state.rejections) items.push({ kind: 'rej', text: `Item recusado pelo servidor (${r.reason}). Confira o estoque e refaça se necessário.` });
    return items;
  }

  function banner(a) {
    const style = { offline: ['amber', 'wifioff'], sync: ['amber', 'sync'], low: ['orange', 'warn'], rej: ['red', 'warn'] }[a.kind];
    const [c, ic] = style;
    const tone = { amber: 'border-amber-800 bg-amber-50 text-amber-950', orange: 'border-orange-800 bg-orange-50 text-orange-950', red: 'border-red-800 bg-red-50 text-red-950' }[c];
    const extra = a.kind === 'sync' && state.online ? `<button class="btn btn-secondary" data-action="sync-now">Sincronizar agora</button>`
      : a.kind === 'rej' ? `<button class="btn btn-secondary" data-action="dismiss-rej">Dispensar</button>` : '';
    return `<div class="flex flex-wrap items-center gap-2 rounded-xl border-2 p-3 ${tone}" role="${a.kind === 'low' || a.kind === 'rej' ? 'alert' : 'status'}">
      ${icon(ic)}<p class="min-w-0 flex-1 font-semibold">${esc(a.text)}</p>${extra}</div>`;
  }
  function renderBanners() {
    const el = $('#banners');
    // No topo: sincronização, offline e estoque mínimo (a lista completa fica na aba Alertas).
    el.innerHTML = state.session && state.route !== 'alerts' ? alertItems().filter(a => a.kind !== 'rej').slice(0, 3).map(banner).join('') : '';
  }

  // ------------------------------------------------------------------ navegação
  async function show(route, sub = null) {
    state.route = route; state.sub = sub;
    revokeUrls();
    const main = $('#main');
    if (!state.session) { renderLogin(main); chrome(); return; }
    await refreshData();
    ({ home: renderHome, parts: renderParts, chat: renderChat, alerts: renderAlerts })[route](main);
    chrome();
    if (route === 'chat') await loadMessages();
    main.focus({ preventScroll: true }); window.scrollTo(0, 0);
  }
  const revokeUrls = () => { objectUrls.forEach(URL.revokeObjectURL); objectUrls = []; };

  // ------------------------------------------------------------------ login
  function renderLogin(main) {
    $('#bottom-nav').hidden = true;
    main.innerHTML = `
      <section class="mx-auto max-w-md rounded-2xl bg-white p-4 shadow">
        <h1 class="mb-3 text-2xl font-bold">Entrar</h1>
        <form id="loginForm" class="space-y-3" novalidate>
          <div><label for="u" class="block font-semibold">Usuário</label>
            <input id="u" class="field" autocomplete="username" autocapitalize="none" required></div>
          <div><label for="p" class="block font-semibold">Senha</label>
            <input id="p" type="password" class="field" autocomplete="current-password" required></div>
          <p id="loginErr" class="font-semibold text-red-900" role="alert"></p>
          <button class="btn btn-primary w-full" type="submit">Entrar</button>
        </form>
        <hr class="my-4 border-slate-400">
        <p class="mb-2 text-sm text-slate-800">Sem conexão com o servidor? Use os dados de demonstração deste aparelho (não sincroniza).</p>
        <button class="btn btn-secondary w-full" data-action="demo">Entrar em modo demonstração</button>
      </section>`;
  }
  async function doLogin(e) {
    e.preventDefault();
    const err = $('#loginErr'); err.textContent = '';
    const username = $('#u').value.trim(), password = $('#p').value;
    if (!username || !password) { err.textContent = 'Informe usuário e senha.'; return; }
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      if (r.status === 429) { err.textContent = 'Muitas tentativas. Aguarde um minuto.'; return; }
      if (!r.ok) { err.textContent = 'Usuário ou senha incorretos.'; return; }
      const d = await r.json();
      state.session = { token: d.access_token, exp: d.expires_at, name: d.user.full_name, role: d.user.role };
      await DB.setSession(state.session);
      await show('home'); runSync();
    } catch (_) { err.textContent = 'Sem conexão com o servidor. Use o modo demonstração ou tente novamente.'; }
  }

  // ------------------------------------------------------------------ Tela 1: Início
  function renderHome(main) {
    if (state.sub === 'list') return renderApptList(main);
    if (state.sub === 'new') return renderNewAppt(main);
    main.innerHTML = `
      <h1 class="mb-3 text-2xl font-bold">Início</h1>
      <div class="mb-5 grid grid-cols-1 gap-2 min-[360px]:grid-cols-3">
        <button class="tap qbtn border-2 border-slate-900 bg-white text-slate-900" data-action="quick" data-to="list">${icon('list', 'w-8 h-8')}<span>Atendimentos</span></button>
        <button class="tap qbtn border-2 border-slate-900 bg-amber-400 text-slate-900 min-[360px]:min-h-[8.5rem]" data-action="nav" data-to="parts">${icon('box', 'w-10 h-10')}<span class="text-lg">Consultar Peças</span></button>
        <button class="tap qbtn border-2 border-slate-900 bg-white text-slate-900" data-action="quick" data-to="new">${icon('plus', 'w-8 h-8')}<span>Novo Atendimento</span></button>
      </div>
      <h2 class="mb-2 text-xl font-bold">Resumo do pátio</h2>
      <dl class="grid grid-cols-1 gap-2">
        ${[['Atendimentos abertos', state.appts.length], ['Peças em estoque mínimo', lowParts().length], ['Pendências de sincronização', state.queue.length]].map(([k, v]) => `
          <div class="flex items-center justify-between rounded-xl border-2 border-slate-400 bg-white p-3"><dt class="font-semibold">${k}</dt><dd class="text-2xl font-extrabold">${v}</dd></div>`).join('')}
      </dl>`;
  }

  const backBtn = () => `<button class="btn btn-secondary mb-3" data-action="nav" data-to="home">← Voltar ao início</button>`;

  function renderApptList(main) {
    main.innerHTML = `${backBtn()}<h1 class="mb-3 text-2xl font-bold">Atendimentos</h1>
      <ul class="space-y-2">${state.appts.map(a => `
        <li><button class="tap w-full rounded-xl border-2 border-slate-900 bg-white p-3 text-left" data-action="open-chat" data-id="${esc(a.id)}">
          <span class="block text-lg font-bold">${esc(a.vehicle)} — ${esc(a.plate)}</span>
          <span class="block">Cliente: ${esc(a.customer_name)}</span><span class="mt-1 block">${statusBadge(a.status)}</span></button></li>`).join('') || '<li>Nenhum atendimento ainda.</li>'}</ul>`;
  }

  function renderNewAppt(main) {
    main.innerHTML = `${backBtn()}<h1 class="mb-3 text-2xl font-bold">Novo Atendimento</h1>
      <form id="apptForm" class="space-y-3 rounded-2xl bg-white p-4 shadow" novalidate>
        <div><label for="veh" class="block font-semibold">Veículo (modelo e ano)</label><input id="veh" class="field" maxlength="120" placeholder="Ex.: Honda Civic 2018" required></div>
        <div><label for="plate" class="block font-semibold">Placa</label><input id="plate" class="field uppercase" maxlength="8" autocapitalize="characters" placeholder="ABC-1D23" required></div>
        <div><label for="cust" class="block font-semibold">Nome do cliente</label><input id="cust" class="field" maxlength="120" autocomplete="off" required></div>
        <p id="apptErr" class="font-semibold text-red-900" role="alert"></p>
        <button class="btn btn-primary w-full" type="submit">Criar e gerar link</button>
      </form>`;
  }
  async function createAppt(e) {
    e.preventDefault();
    const vehicle = $('#veh').value.trim(), plate = $('#plate').value.trim().toUpperCase(), customer_name = $('#cust').value.trim();
    const err = $('#apptErr');
    if (vehicle.length < 3) { err.textContent = 'Informe o veículo.'; return; }
    if (!PLATE.test(plate)) { err.textContent = 'Placa inválida. Use o formato ABC-1D23 ou ABC1234.'; return; }
    if (customer_name.length < 2) { err.textContent = 'Informe o nome do cliente.'; return; }
    const a = await DB.addAppointment({ vehicle, plate, customer_name });
    state.apptId = a.id;
    await afterLocalChange();
    const link = clientLink(a);
    openDialog(`<h2 class="mb-2 text-xl font-bold">Atendimento criado</h2>
      <p class="mb-2">Envie este link ao cliente. Ele acompanha e conversa sem precisar de login.</p>
      <p class="mb-3 break-all rounded-lg border-2 border-slate-400 bg-slate-50 p-2 font-mono text-sm">${esc(link)}</p>
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-primary" data-action="copy-link" data-link="${esc(link)}">${icon('link')}Copiar link</button>
        ${navigator.share ? `<button class="btn btn-secondary" data-action="share-link" data-link="${esc(link)}">Compartilhar</button>` : ''}
        <button class="btn btn-secondary" data-action="open-chat" data-id="${esc(a.id)}">Abrir chat</button>
      </div>`);
  }
  const clientLink = a => `${location.origin}/?t=${a.public_token}`;

  // ------------------------------------------------------------------ Tela 2: Peças
  function renderParts(main) {
    main.innerHTML = `
      <h1 class="mb-3 text-2xl font-bold">Consultar Peças</h1>
      <form id="searchForm" role="search" class="mb-2 flex items-end gap-2">
        <div class="min-w-0 flex-1"><label for="q" class="block font-semibold">Nome (mín. 3 letras) ou código de barras</label>
          <input id="q" type="search" class="field" inputmode="search" autocomplete="off" enterkeyhint="search" value="${esc(state.query)}"></div>
        <button type="button" class="btn btn-primary" data-action="scan" aria-label="Ler código de barras com a câmera">${icon('camera')}</button>
      </form>
      <p id="hint" class="mb-3 text-sm text-slate-800"></p>
      <div id="feedback" role="status" aria-live="polite"></div>
      <div id="results" class="space-y-3"></div>`;
    runSearch();
  }

  async function runSearch() {
    const q = ($('#q')?.value ?? state.query).trim();
    state.query = q;
    const hint = $('#hint'), box = $('#results');
    if (!box) return;
    let found = [];
    if (/^\d{8,14}$/.test(q)) {                         // código de barras: busca exata pelo índice
      const p = await DB.getPartByBarcode(q);
      found = p ? [p] : [];
    } else if (q.length >= 3) {
      const nq = norm(q);
      found = state.parts.filter(p => norm(p.name).includes(nq) || p.barcode.includes(q));
    } else {
      hint.textContent = q ? 'Digite pelo menos 3 letras ou o código completo.' : 'Digite o nome da peça ou leia o código de barras.';
      box.innerHTML = ''; return;
    }
    hint.textContent = found.length ? `${found.length} ${found.length === 1 ? 'resultado' : 'resultados'}` : '';
    box.innerHTML = found.map(partCard).join('') || `<p class="rounded-xl border-2 border-slate-400 bg-white p-3 font-semibold">Nenhuma peça encontrada.</p>`;
  }

  function partCard(p) {
    const low = p.quantity <= p.min_quantity, zero = p.quantity <= 0;
    return `<article class="rounded-2xl border-2 border-slate-900 bg-white p-4 shadow" aria-labelledby="pn-${p.id}">
      <h2 id="pn-${p.id}" class="text-xl font-bold">${esc(p.name)}</h2>
      <dl class="mt-2 space-y-1">
        <div class="flex gap-2"><dt class="font-semibold">Código:</dt><dd class="font-mono">${esc(p.barcode)}</dd></div>
        <div class="flex gap-2"><dt class="font-semibold">Local:</dt><dd>${esc(p.location)}</dd></div>
        <div class="flex flex-wrap items-center gap-2"><dt class="font-semibold">Saldo:</dt><dd class="text-3xl font-extrabold">${p.quantity}</dd>
          ${low ? `<span class="inline-flex items-center gap-1 rounded-full border border-orange-900 bg-orange-100 px-3 py-1 text-sm font-bold text-orange-950">${icon('warn', 'w-4 h-4')}${zero ? 'Sem saldo' : 'Estoque baixo'}</span>` : ''}</div>
      </dl>
      <button class="btn btn-primary mt-3 w-full text-lg" data-action="use" data-id="${p.id}" ${zero ? 'disabled aria-disabled="true"' : ''}>
        ${zero ? 'Sem saldo para baixa' : 'Confirmar Uso (-1)'}</button>
    </article>`;
  }

  async function useOne(id) {
    const r = await DB.useStock(id, 1);
    const fb = $('#feedback');
    if (!r.ok) {
      fb.innerHTML = feedback('red', 'warn', r.error === 'no_stock' ? 'Sem saldo: não é possível registrar a baixa.' : 'Peça não encontrada.');
      return;
    }
    if (navigator.vibrate) navigator.vibrate(60);
    const msg = `Baixa registrada: restam ${units(r.quantity)}`;
    fb.innerHTML = feedback('green', 'check', msg + (state.online ? '.' : '. Será sincronizada quando houver conexão.'));
    announce(msg);
    await afterLocalChange();
    runSearch();
  }
  const feedback = (c, ic, text) => {
    const tone = { green: 'border-green-900 bg-green-50 text-green-950', red: 'border-red-900 bg-red-50 text-red-950' }[c];
    return `<div class="mb-3 flex items-center gap-2 rounded-xl border-2 p-3 font-bold ${tone}">${icon(ic)}<p>${esc(text)}</p></div>`;
  };

  // Leitura por câmera (BarcodeDetector) com fallback para digitação
  let scanStream = null, scanTimer = null;
  async function openScanner() {
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
      announce('Leitura por câmera indisponível neste aparelho. Digite o código.');
      $('#hint').textContent = 'Leitura por câmera indisponível neste aparelho. Digite o código de barras no campo.';
      $('#q').focus(); return;
    }
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (_) { $('#hint').textContent = 'Permissão da câmera negada. Digite o código de barras.'; $('#q').focus(); return; }
    openDialog(`<h2 class="mb-2 text-xl font-bold">Ler código de barras</h2>
      <video id="scanVideo" class="w-full rounded-xl bg-black" playsinline muted aria-label="Imagem da câmera"></video>
      <p class="my-2" role="status">Aponte para o código de barras.</p>
      <button class="btn btn-secondary w-full" data-action="close-dlg">Cancelar</button>`, stopScanner);
    const v = $('#scanVideo'); v.srcObject = scanStream; await v.play();
    const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e'] });
    scanTimer = setInterval(async () => {
      try {
        const codes = await det.detect(v);
        if (codes.length) { const code = codes[0].rawValue; closeDialog(); $('#q').value = code; runSearch(); announce('Código lido: ' + code); }
      } catch (_) {}
    }, 250);
  }
  function stopScanner() { clearInterval(scanTimer); scanStream?.getTracks().forEach(t => t.stop()); scanStream = null; }

  // ------------------------------------------------------------------ Tela 3: Alertas e Chat
  function renderChat(main) {
    if (!state.appts.length) { main.innerHTML = `<h1 class="mb-3 text-2xl font-bold">Chat do atendimento</h1><p>Nenhum atendimento. Crie um em “Novo Atendimento”.</p>`; return; }
    if (!state.appts.some(a => a.id === state.apptId)) state.apptId = state.appts[0].id;
    const a = state.appts.find(x => x.id === state.apptId);
    main.innerHTML = `
      <h1 class="mb-3 text-2xl font-bold">Chat do atendimento</h1>
      ${state.appts.length > 1 ? `<label for="apptSel" class="block font-semibold">Atendimento</label>
        <select id="apptSel" class="field mb-3">${state.appts.map(x => `<option value="${esc(x.id)}" ${x.id === a.id ? 'selected' : ''}>${esc(x.vehicle)} — ${esc(x.plate)}</option>`).join('')}</select>` : ''}
      <section class="mb-3 rounded-2xl border-2 border-slate-900 bg-white p-3" aria-label="Veículo ativo">
        <p class="text-lg font-bold">${esc(a.vehicle)} — ${esc(a.plate)}</p>
        <p>Cliente: ${esc(a.customer_name)}</p>
        <p class="my-1">${statusBadge(a.status)}</p>
        <button class="btn btn-secondary mt-1" data-action="copy-link" data-link="${esc(clientLink(a))}">${icon('link')}Copiar link do cliente</button>
      </section>
      <h2 class="mb-2 text-xl font-bold">Mensagens</h2>
      <div id="log" role="log" aria-live="polite" aria-label="Histórico de mensagens" class="space-y-2 pb-3"></div>
      <form id="composer" class="sticky -mx-3 border-t-2 border-slate-900 bg-white p-3" style="bottom:var(--nav-h)" novalidate>
        <label for="msg" class="block font-semibold">Mensagem</label>
        <textarea id="msg" class="field mb-2" rows="2" maxlength="2000"></textarea>
        <div class="grid grid-cols-2 gap-2">
          <button type="button" class="btn btn-secondary" data-action="attach">${icon('clip')}Anexar Foto</button>
          <button type="submit" class="btn btn-primary">${icon('send')}Enviar</button>
        </div>
      </form>`;
  }

  function messageHtml(m, mine, pending) {
    let img = '';
    if (m.photoBlob || m.photo_url) {
      let src = m.photo_url;
      if (m.photoBlob) { src = URL.createObjectURL(m.photoBlob); objectUrls.push(src); }
      img = `<figure class="mt-2"><img src="${esc(src)}" alt="${esc(m.alt_text || 'Foto do atendimento')}" class="max-h-72 w-full rounded-lg object-contain bg-slate-100" loading="lazy">
        <figcaption class="mt-1 text-sm">Foto: ${esc(m.alt_text || '')}</figcaption></figure>`;
    }
    return `<article class="max-w-[92%] rounded-2xl border-2 p-3 ${mine ? 'ml-auto border-blue-900 bg-blue-50' : 'border-slate-500 bg-white'}">
      <p class="text-sm font-bold">${esc(m.author_name)} <span class="font-normal text-slate-800">· ${dhm(m.created_at)}</span></p>
      ${m.text ? `<p class="mt-1 whitespace-pre-wrap break-words">${esc(m.text)}</p>` : ''}${img}
      ${pending ? `<p class="mt-1 inline-flex items-center gap-1 text-sm font-bold text-amber-950">${icon('clock', 'w-4 h-4')}Aguardando envio</p>` : ''}</article>`;
  }

  async function loadMessages() {
    const log = $('#log'); if (!log || !state.apptId) return;
    const msgs = await DB.getMessages(state.apptId);
    const pend = new Set(state.queue.map(q => q.id));
    revokeUrls();
    const stick = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    log.innerHTML = msgs.map(m => messageHtml(m, m.author_type === 'mecanico', pend.has(m.id))).join('') || '<p>Nenhuma mensagem ainda.</p>';
    if (stick) window.scrollTo(0, document.body.scrollHeight);
  }

  async function sendText(e) {
    e.preventDefault();
    const ta = $('#msg'), text = ta.value.trim();
    if (!text) { announce('Digite uma mensagem antes de enviar.'); ta.focus(); return; }
    await DB.addTextMessage(state.apptId, text, state.session.name);
    ta.value = '';
    await afterLocalChange(); await loadMessages(); window.scrollTo(0, document.body.scrollHeight);
  }

  function renderAlerts(main) {
    const items = alertItems();
    main.innerHTML = `<h1 class="mb-3 text-2xl font-bold">Alertas</h1>
      <div class="space-y-2">${items.map(banner).join('') || `<p class="rounded-xl border-2 border-green-900 bg-green-50 p-3 font-bold text-green-950">${icon('check')} Nenhum alerta no momento.</p>`}</div>
      <button class="btn btn-primary mt-4 w-full" data-action="nav" data-to="chat">${icon('chat')}Abrir chat do atendimento</button>`;
  }

  // ------------------------------------------------------------------ fotos (mecânico e cliente)
  async function prepareImage(file) {
    if (!ALLOWED.includes(file.type)) throw new Error('Formato não permitido. Use JPEG, PNG ou WebP.');
    let blob = file;
    if (file.size > 1_000_000 && 'createImageBitmap' in window) {   // reduz fotos grandes da câmera
      try {
        const bmp = await createImageBitmap(file);
        const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        const out = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
        if (out && out.size < file.size) blob = out;
      } catch (_) {}
    }
    if (blob.size > MAX_PHOTO) throw new Error('A foto continua maior que 5 MB. Escolha outra.');
    return blob;
  }

  function openPhotoDialog(onSubmit) {
    openDialog(`<h2 class="mb-2 text-xl font-bold">Anexar foto</h2>
      <form id="photoForm" class="space-y-3" novalidate>
        <div><label for="file" class="block font-semibold">Foto (JPEG, PNG ou WebP, até 5 MB)</label>
          <input id="file" type="file" accept="image/jpeg,image/png,image/webp" class="field" required></div>
        <div><label for="alt" class="block font-semibold">Descrição da foto (obrigatória)</label>
          <input id="alt" class="field" maxlength="300" placeholder="Ex.: Pastilha dianteira esquerda desgastada" required></div>
        <p id="photoErr" class="font-semibold text-red-900" role="alert"></p>
        <div class="grid grid-cols-2 gap-2"><button type="button" class="btn btn-secondary" data-action="close-dlg">Cancelar</button>
          <button type="submit" class="btn btn-primary">Enviar foto</button></div>
      </form>`);
    $('#photoForm').addEventListener('submit', async e => {
      e.preventDefault();
      const err = $('#photoErr'), f = $('#file').files[0], alt = $('#alt').value.trim();
      if (!f) { err.textContent = 'Escolha uma foto.'; return; }
      if (alt.length < 3) { err.textContent = 'Escreva a descrição da foto (mín. 3 letras).'; return; }
      try { const blob = await prepareImage(f); await onSubmit(blob, alt); closeDialog(); }
      catch (ex) { err.textContent = ex.message || 'Não foi possível enviar a foto.'; }
    });
  }

  // ------------------------------------------------------------------ diálogo
  let dlgClose = null;
  function openDialog(html, onClose) {
    const d = $('#dlg'); d.innerHTML = html; dlgClose = onClose || null;
    if (!d.open) d.showModal();
  }
  function closeDialog() { const d = $('#dlg'); if (d.open) d.close(); }
  $('#dlg').addEventListener('close', () => { if (dlgClose) dlgClose(); dlgClose = null; });

  // ------------------------------------------------------------------ eventos globais
  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-action]'); if (!el) return;
    const act = el.dataset.action;
    if (el.tagName === 'A') e.preventDefault();
    switch (act) {
      case 'nav': closeDialog(); return show(el.dataset.to);
      case 'quick': return show('home', el.dataset.to);
      case 'open-chat': closeDialog(); state.apptId = el.dataset.id; return show('chat');
      case 'use': el.disabled = true; await useOne(Number(el.dataset.id)); return;
      case 'scan': return openScanner();
      case 'close-dlg': return closeDialog();
      case 'attach': return openPhotoDialog(async (blob, alt) => {
        await DB.addPhotoMessage(state.apptId, blob, alt, $('#msg')?.value.trim() || '', state.session.name);
        if ($('#msg')) $('#msg').value = '';
        await afterLocalChange(); await loadMessages();
      });
      case 'copy-link': try { await navigator.clipboard.writeText(el.dataset.link); announce('Link copiado.'); el.textContent = 'Link copiado ✓'; } catch (_) { announce('Não foi possível copiar. Selecione o link manualmente.'); } return;
      case 'share-link': try { await navigator.share({ title: 'Acompanhe seu atendimento — Luiz Autoelétricos', url: el.dataset.link }); } catch (_) {} return;
      case 'sync-now': return runSync(true);
      case 'dismiss-rej': await DB.clearRejections(); await refreshData(); chrome(); if (state.route === 'alerts') renderAlerts($('#main')); return;
      case 'logout': await DB.clearSession(); state.session = null; return show('home');
      case 'demo':
        state.session = { demo: true, name: 'Rudmar', role: 'Gerente', exp: Date.now() + 12 * 3600 * 1000 };
        await DB.setSession(state.session); return show('home');
    }
  });
  document.addEventListener('submit', e => {
    if (e.target.id === 'loginForm') return doLogin(e);
    if (e.target.id === 'apptForm') return createAppt(e);
    if (e.target.id === 'composer') return sendText(e);
    if (e.target.id === 'searchForm') { e.preventDefault(); runSearch(); }
  });
  document.addEventListener('input', e => { if (e.target.id === 'q') runSearch(); });
  document.addEventListener('change', e => { if (e.target.id === 'apptSel') { state.apptId = e.target.value; show('chat'); } });

  window.addEventListener('online', () => { state.online = true; chrome(); runSync(); });
  window.addEventListener('offline', () => { state.online = false; chrome(); });
  navigator.serviceWorker?.addEventListener('message', async e => { if (e.data === 'SYNCED') { await refreshData(); chrome(); } });

  // ------------------------------------------------------------------ visão pública do cliente
  async function bootClient(token) {
    const main = $('#main');
    $('#bottom-nav').hidden = true;
    $('#app-header').innerHTML = `<div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2"><p class="text-lg font-extrabold">Luiz Autoelétricos</p><span id="net"></span></div>`;
    const setNet = () => { $('#net').innerHTML = netBadge(); };
    let data = null;

    const render = () => {
      if (!data) return;
      revokeUrls();
      const log = $('#log'); if (!log) return;
      log.innerHTML = data.messages.map(m => messageHtml(m, m.author_type === 'cliente', false)).join('') || '<p>Nenhuma mensagem ainda.</p>';
    };
    const load = async () => {
      try {
        const r = await fetch(`/api/public/${token}`);
        if (r.status === 404 || r.status === 422) { main.innerHTML = '<h1 class="text-2xl font-bold">Link inválido</h1><p>Confira o link com a oficina.</p>'; return false; }
        if (!r.ok) throw new Error();
        data = await r.json();
        $('#vehCard').innerHTML = `<p class="text-lg font-bold">${esc(data.vehicle)} — ${esc(data.plate)}</p><p>Olá, ${esc(data.customer_name)}!</p><p class="mt-1">${statusBadge(data.status)}</p>`;
        render(); return true;
      } catch (_) { $('#cliErr').textContent = 'Sem conexão. Mostrando a última versão, se houver.'; return true; }
    };
    const post = async (path, init) => {
      if (!state.online) throw new Error('Você está offline. Conecte-se para enviar.');
      const r = await fetch(`/api/public/${token}${path}`, init);
      if (!r.ok) throw new Error(r.status === 429 ? 'Muitas mensagens. Aguarde um instante.' : r.status === 415 ? 'Formato de foto não permitido.' : r.status === 413 ? 'Foto maior que 5 MB.' : 'Não foi possível enviar.');
    };

    main.innerHTML = `<h1 class="mb-3 text-2xl font-bold">Acompanhamento do atendimento</h1>
      <section id="vehCard" class="mb-3 rounded-2xl border-2 border-slate-900 bg-white p-3" aria-label="Seu veículo"></section>
      <p id="cliErr" class="mb-2 font-semibold text-amber-950" role="status"></p>
      <div id="log" role="log" aria-live="polite" aria-label="Mensagens" class="space-y-2 pb-3"></div>
      <form id="cliForm" class="sticky bottom-0 -mx-3 border-t-2 border-slate-900 bg-white p-3" novalidate>
        <label for="msg" class="block font-semibold">Sua mensagem</label>
        <textarea id="msg" class="field mb-2" rows="2" maxlength="2000"></textarea>
        <div class="grid grid-cols-2 gap-2"><button type="button" class="btn btn-secondary" id="cliAttach">${icon('clip')}Anexar Foto</button>
          <button type="submit" class="btn btn-primary">${icon('send')}Enviar</button></div></form>`;
    $('#main').style.paddingBottom = '1rem';
    setNet();
    window.addEventListener('online', () => { state.online = true; setNet(); load(); });
    window.addEventListener('offline', () => { state.online = false; setNet(); });

    $('#cliForm').addEventListener('submit', async e => {
      e.preventDefault();
      const ta = $('#msg'), text = ta.value.trim(); if (!text) { ta.focus(); return; }
      try { await post('/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: DB.uuid(), text }) }); ta.value = ''; $('#cliErr').textContent = ''; await load(); window.scrollTo(0, document.body.scrollHeight); }
      catch (ex) { $('#cliErr').textContent = ex.message; }
    });
    $('#cliAttach').addEventListener('click', () => openPhotoDialog(async (blob, alt) => {
      const fd = new FormData(); fd.append('message_id', DB.uuid()); fd.append('alt_text', alt); fd.append('text', $('#msg').value.trim());
      fd.append('file', blob, 'foto.' + ({ 'image/png': 'png', 'image/webp': 'webp' }[blob.type] || 'jpg'));
      await post('/photos', { method: 'POST', body: fd }); $('#msg').value = ''; await load();
    }));
    if (await load()) setInterval(() => { if (state.online && !document.hidden) load(); }, 8000);
  }

  // ------------------------------------------------------------------ inicialização
  async function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    const t = new URLSearchParams(location.search).get('t');
    if (t) {
      if (!UUID4.test(t)) { $('#main').innerHTML = '<h1 class="text-2xl font-bold">Link inválido</h1>'; return; }
      return bootClient(t.toLowerCase());
    }
    await DB.open(); await DB.seedIfEmpty();
    const s = await DB.getSession();
    state.session = s && s.exp > Date.now() ? s : null;
    if (s && !state.session) await DB.clearSession();
    await show('home');
    runSync();
    syncTimer = setInterval(() => runSync(), 30000);
  }
  boot();
})();
