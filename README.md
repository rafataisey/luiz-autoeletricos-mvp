# Luiz Autoelétricos — MVP (PWA offline-first + FastAPI)

## Estrutura
```
oficina/
├── backend/
│   ├── requirements.txt
│   ├── models.py     # SQLAlchemy (users, parts, stock_transactions, appointments, messages)
│   ├── schemas.py    # Pydantic v2 estrito (UUID v4, placa, limites, extra=forbid)
│   ├── auth.py       # bcrypt, JWT 12 h, limitador de tentativas
│   └── main.py       # API + seed automático + serve o frontend
└── frontend/
    ├── index.html  manifest.json  sw.js
    ├── db.js       # IndexedDB nativo + sync_queue + sincronização
    ├── app.js      # 3 telas + visão pública do cliente (?t=UUID)
    └── icons/
```

## Executar
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```
Abra http://localhost:8000. Login de teste: **rudmar / oficina123** (defina `SEED_PASSWORD` e `JWT_SECRET` no ambiente para trocar).
Link de cliente de demonstração: `http://localhost:8000/?t=b7e1c9a4-2d3f-4a68-8c5e-91f0a2d4e6b3`

No celular, o PWA exige **HTTPS** (câmera, Service Worker e instalação). Em teste local use um túnel HTTPS (ex.: cloudflared/ngrok) ou reverse proxy com certificado.

## Como o offline funciona
- Peças, atendimentos e mensagens ficam no IndexedDB; a busca roda 100% local.
- "Confirmar Uso (-1)" altera o saldo local e grava a baixa na `sync_queue` na **mesma transação** IndexedDB.
- A fila é enviada em `POST /api/sync` (evento `online`, a cada 30 s, botão "Sincronizar agora" e Background Sync no Chrome/Android). Cada operação tem UUID: reenviar não duplica.
- O servidor aplica a baixa com `UPDATE ... WHERE quantity >= qty`; se faltar saldo, recusa e o app mostra o alerta.
- "Modo demonstração" do login usa só os dados locais (sem sincronizar).

## Segurança (resumo)
SQL via ORM parametrizado · validação Pydantic estrita · bcrypt + JWT 12 h · limite de tentativas no login e nas rotas públicas · cliente só acessa por UUID v4 · fotos validadas por bytes mágicos (JPEG/PNG/WebP), máx. 5 MB, descrição obrigatória, nome de arquivo aleatório · todo texto é escapado ao renderizar (XSS) · cabeçalhos `nosniff`, `X-Frame-Options`, `Referrer-Policy: no-referrer`.

## Antes de ir para produção
- Gerar o CSS do Tailwind com a CLI (hoje usa o CDN, que o Service Worker guarda em cache após o 1º acesso online) e então endurecer a CSP.
- Trocar SQLite por PostgreSQL (`DATABASE_URL`), colocar atrás de HTTPS e ajustar o IP do cliente atrás de proxy.
- Fotos ficam em `backend/uploads/` e são acessadas por URL com nome aleatório (sem login); para mais rigor, use URLs assinadas.
