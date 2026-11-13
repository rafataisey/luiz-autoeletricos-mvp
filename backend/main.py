"""API FastAPI da Luiz Autoelétricos. Execute:  uvicorn main:app --host 0.0.0.0 --port 8000"""
import os
import re
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Path as PathParam, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from auth import (authenticate, create_token, current_user, hash_password, login_limiter, public_limiter)
from models import Appointment, Base, Message, Part, SessionLocal, StockTransaction, User, engine, get_db
from schemas import (AppointmentIn, AppointmentOut, LoginIn, MessageOut, PartOut, PublicAppointmentOut,
                     PublicMessageIn, PullOut, SyncIn, SyncOut, TokenOut, UserOut, UUID4_RE)

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", BASE_DIR / "uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

MAX_PHOTO = 5 * 1024 * 1024
UUID4 = re.compile(UUID4_RE)
PHOTO_NAME = r"^[0-9a-f]{32}\.(jpg|png|webp)$"

# IDs fixos para que o seed do servidor e o fallback do IndexedDB coincidam (dados fictícios).
SEED_APPT_ID = "3f6c2a1e-8b4d-4c7a-9e21-5d0b7a6c1f10"
SEED_APPT_TOKEN = "b7e1c9a4-2d3f-4a68-8c5e-91f0a2d4e6b3"


# ---------------------------------------------------------------- seed
def seed(db: Session) -> None:
    if db.scalar(select(User).limit(1)):
        return
    password = os.getenv("SEED_PASSWORD", "oficina123")
    db.add(User(username="rudmar", full_name="Rudmar", role="Gerente", password_hash=hash_password(password)))
    db.add_all([
        Part(id=1, name="Filtro de Óleo Bosch OB0045", barcode="7891002004512",
             location="Corredor B — Prateleira 03", quantity=4, min_quantity=2),
        Part(id=2, name="Pastilha de Freio Dianteira", barcode="7891002009981",
             location="Corredor A — Prateleira 01", quantity=1, min_quantity=2),
    ])
    db.add(Appointment(id=SEED_APPT_ID, public_token=SEED_APPT_TOKEN, vehicle="Honda Civic 2018",
                       plate="ABC-1D23", customer_name="Mariana Souza", status="Aguardando Aprovação"))
    db.flush()
    db.add_all([
        Message(id="a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", appointment_id=SEED_APPT_ID, author_type="mecanico",
                author_name="Rudmar", text="Mariana, as pastilhas dianteiras do Civic estão no limite. Recomendo a troca."),
        Message(id="b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e", appointment_id=SEED_APPT_ID, author_type="cliente",
                author_name="Mariana Souza", text="Entendi. Pode trocar as duas rodas da frente?"),
        Message(id="c3d4e5f6-a7b8-4c9d-ae1f-2a3b4c5d6e7f", appointment_id=SEED_APPT_ID, author_type="mecanico",
                author_name="Rudmar", text="Sim, o par completo. Aguardo a sua aprovação por aqui para começar."),
    ])
    db.commit()
    print(f"[seed] usuário 'rudmar' criado (senha: {password}). Link do cliente demo: /?t={SEED_APPT_TOKEN}")


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        seed(db)
    yield


app = FastAPI(title="Luiz Autoelétricos API", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"  # o token UUID viaja na URL do cliente
    resp.headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=()"
    resp.headers["Content-Security-Policy"] = "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
    if not request.url.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-cache")
    return resp


# ---------------------------------------------------------------- helpers
def _photo_url(name: str | None) -> str | None:
    return f"/api/photos/{name}" if name else None


def _msg_out(m: Message) -> MessageOut:
    return MessageOut(id=m.id, appointment_id=m.appointment_id, author_type=m.author_type,
                      author_name=m.author_name, text=m.text, photo_url=_photo_url(m.photo_filename),
                      alt_text=m.alt_text, created_at=m.created_at)


def _detect_image(head: bytes) -> tuple[str, str] | None:
    """Valida pelos bytes mágicos (não confia no Content-Type enviado)."""
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", "jpg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp", "webp"
    return None


async def _create_photo_message(db: Session, appt: Appointment, author_type: str, author_name: str,
                                message_id: str, text: str, alt_text: str, file: UploadFile) -> Message:
    if not UUID4.match(message_id):
        raise HTTPException(422, "ID de mensagem inválido")
    alt_text, text = alt_text.strip(), text.strip()
    if not (3 <= len(alt_text) <= 300):
        raise HTTPException(422, "A descrição da foto é obrigatória (3 a 300 caracteres)")
    if len(text) > 2000:
        raise HTTPException(422, "Texto muito longo")
    existing = db.get(Message, message_id)
    if existing:
        if existing.appointment_id != appt.id:
            raise HTTPException(409, "Conflito de ID")
        return existing
    data = await file.read(MAX_PHOTO + 1)
    if len(data) > MAX_PHOTO:
        raise HTTPException(413, "Foto maior que 5 MB")
    kind = _detect_image(data[:16])
    if not kind:
        raise HTTPException(415, "Formato não permitido. Use JPEG, PNG ou WebP")
    name = f"{uuid.uuid4().hex}.{kind[1]}"
    (UPLOAD_DIR / name).write_bytes(data)
    msg = Message(id=message_id, appointment_id=appt.id, author_type=author_type, author_name=author_name,
                  text=text, photo_filename=name, alt_text=alt_text)
    db.add(msg)
    db.commit()
    return msg


def _public_appt(db: Session, request: Request, token: str) -> Appointment:
    public_limiter.check(request.client.host if request.client else "?")
    appt = db.scalar(select(Appointment).where(Appointment.public_token == token))
    if not appt:
        raise HTTPException(404, "Link inválido")
    return appt


# ---------------------------------------------------------------- auth
@app.post("/api/auth/login", response_model=TokenOut)
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    login_limiter.check(f"{request.client.host if request.client else '?'}:{body.username.lower()}")
    user = authenticate(db, body.username, body.password)
    if not user:
        raise HTTPException(401, "Usuário ou senha incorretos")
    token, exp = create_token(user)
    return TokenOut(access_token=token, expires_at=exp, user=UserOut(full_name=user.full_name, role=user.role))


# ---------------------------------------------------------------- colaborador (autenticado)
@app.get("/api/sync/pull", response_model=PullOut)
def pull(_: User = Depends(current_user), db: Session = Depends(get_db)):
    parts = db.scalars(select(Part).order_by(Part.name)).all()
    appts = db.scalars(select(Appointment).order_by(Appointment.created_at.desc()).limit(100)).all()
    ids = [a.id for a in appts]
    msgs = db.scalars(select(Message).where(Message.appointment_id.in_(ids)).order_by(Message.created_at)).all() if ids else []
    return PullOut(parts=[PartOut.model_validate(p) for p in parts],
                   appointments=[AppointmentOut.model_validate(a) for a in appts],
                   messages=[_msg_out(m) for m in msgs])


@app.post("/api/sync", response_model=SyncOut)
def sync(body: SyncIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Aplica a fila offline de forma idempotente (cada operação tem um UUID do cliente)."""
    results: dict[str, str] = {}

    for a in body.appointments:
        if db.get(Appointment, a.id):
            results[a.id] = "duplicate"
        elif db.scalar(select(Appointment.id).where(Appointment.public_token == a.public_token)):
            results[a.id] = "rejected:token_em_uso"
        else:
            db.add(Appointment(id=a.id, public_token=a.public_token, vehicle=a.vehicle, plate=a.plate,
                               customer_name=a.customer_name, status=a.status, created_by=user.id))
            results[a.id] = "ok"
    db.flush()

    for m in body.messages:
        if db.get(Message, m.id):
            results[m.id] = "duplicate"
        elif not db.get(Appointment, m.appointment_id):
            results[m.id] = "rejected:atendimento_inexistente"
        else:
            db.add(Message(id=m.id, appointment_id=m.appointment_id, author_type="mecanico",
                           author_name=user.full_name, text=m.text))
            results[m.id] = "ok"

    for s in body.stock_out:
        if db.get(StockTransaction, s.client_id):
            results[s.client_id] = "duplicate"
            continue
        if not db.get(Part, s.part_id):
            results[s.client_id] = "rejected:peca_inexistente"
            continue
        # UPDATE atômico: nunca deixa o saldo ficar negativo, mesmo com sincronizações concorrentes.
        res = db.execute(update(Part).where(Part.id == s.part_id, Part.quantity >= s.qty)
                         .values(quantity=Part.quantity - s.qty))
        if res.rowcount != 1:
            results[s.client_id] = "rejected:saldo_insuficiente"
            continue
        db.add(StockTransaction(client_id=s.client_id, part_id=s.part_id, qty=s.qty, user_id=user.id))
        results[s.client_id] = "ok"

    db.commit()
    return SyncOut(results=results)


@app.post("/api/appointments/{appointment_id}/photos", response_model=MessageOut)
async def staff_photo(appointment_id: str = PathParam(pattern=UUID4_RE), message_id: str = Form(...),
                      alt_text: str = Form(...), text: str = Form(""), file: UploadFile = File(...),
                      user: User = Depends(current_user), db: Session = Depends(get_db)):
    appt = db.get(Appointment, appointment_id)
    if not appt:
        raise HTTPException(404, "Atendimento não encontrado")
    msg = await _create_photo_message(db, appt, "mecanico", user.full_name, message_id, text, alt_text, file)
    return _msg_out(msg)


# ---------------------------------------------------------------- cliente (link UUID, sem login)
@app.get("/api/public/{token}", response_model=PublicAppointmentOut)
def public_view(request: Request, token: str = PathParam(pattern=UUID4_RE), db: Session = Depends(get_db)):
    appt = _public_appt(db, request, token)
    return PublicAppointmentOut(vehicle=appt.vehicle, plate=appt.plate, customer_name=appt.customer_name,
                                status=appt.status, messages=[_msg_out(m) for m in appt.messages])


@app.post("/api/public/{token}/messages", response_model=MessageOut)
def public_message(body: PublicMessageIn, request: Request, token: str = PathParam(pattern=UUID4_RE),
                   db: Session = Depends(get_db)):
    appt = _public_appt(db, request, token)
    existing = db.get(Message, body.id)
    if existing:
        if existing.appointment_id != appt.id:
            raise HTTPException(409, "Conflito de ID")
        return _msg_out(existing)
    msg = Message(id=body.id, appointment_id=appt.id, author_type="cliente",
                  author_name=appt.customer_name, text=body.text)
    db.add(msg)
    db.commit()
    return _msg_out(msg)


@app.post("/api/public/{token}/photos", response_model=MessageOut)
async def public_photo(request: Request, token: str = PathParam(pattern=UUID4_RE), message_id: str = Form(...),
                       alt_text: str = Form(...), text: str = Form(""), file: UploadFile = File(...),
                       db: Session = Depends(get_db)):
    appt = _public_appt(db, request, token)
    msg = await _create_photo_message(db, appt, "cliente", appt.customer_name, message_id, text, alt_text, file)
    return _msg_out(msg)


# ---------------------------------------------------------------- fotos
@app.get("/api/photos/{name}")
def photo(name: str = PathParam(pattern=PHOTO_NAME)):
    """O nome é um UUID aleatório (128 bits) e o padrão bloqueia path traversal."""
    path = UPLOAD_DIR / name
    if not path.is_file():
        raise HTTPException(404)
    media = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}[name.rsplit(".", 1)[1]]
    return FileResponse(path, media_type=media, headers={"Cache-Control": "private, max-age=31536000, immutable"})


# ---------------------------------------------------------------- frontend estático (mesma origem)
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
