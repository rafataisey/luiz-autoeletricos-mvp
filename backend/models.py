"""Modelos SQLAlchemy (ORM = queries sempre parametrizadas) e sessão de banco."""
import os
from datetime import datetime, timezone

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./oficina.db")
_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=_connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(40))
    password_hash: Mapped[str] = mapped_column(String(100))


class Part(Base):
    __tablename__ = "parts"
    __table_args__ = (CheckConstraint("quantity >= 0", name="ck_parts_quantity_nonneg"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(160), index=True)
    barcode: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    location: Mapped[str] = mapped_column(String(80))
    quantity: Mapped[int] = mapped_column(Integer, default=0)
    min_quantity: Mapped[int] = mapped_column(Integer, default=1)


class StockTransaction(Base):
    """Baixas já aplicadas. `client_id` é a chave de idempotência vinda da sync_queue."""
    __tablename__ = "stock_transactions"

    client_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    part_id: Mapped[int] = mapped_column(ForeignKey("parts.id"))
    qty: Mapped[int] = mapped_column(Integer)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Appointment(Base):
    __tablename__ = "appointments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)  # UUID gerado no cliente (offline)
    public_token: Mapped[str] = mapped_column(String(36), unique=True, index=True)  # UUID v4 do link do cliente
    vehicle: Mapped[str] = mapped_column(String(120))
    plate: Mapped[str] = mapped_column(String(10))
    customer_name: Mapped[str] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(40), default="Aguardando Aprovação")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    messages: Mapped[list["Message"]] = relationship(back_populates="appointment", order_by="Message.created_at")


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)  # UUID do cliente (idempotência)
    appointment_id: Mapped[str] = mapped_column(ForeignKey("appointments.id"), index=True)
    author_type: Mapped[str] = mapped_column(String(10))  # "mecanico" | "cliente"
    author_name: Mapped[str] = mapped_column(String(120))
    text: Mapped[str] = mapped_column(Text, default="")
    photo_filename: Mapped[str | None] = mapped_column(String(50), nullable=True)
    alt_text: Mapped[str | None] = mapped_column(String(300), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    appointment: Mapped[Appointment] = relationship(back_populates="messages")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
