"""Esquemas Pydantic v2 com validação estrita (extra=forbid, limites de tamanho e formatos)."""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

UUID4_RE = r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
PLATE_RE = r"^[A-Z]{3}-?[0-9][A-Z0-9][0-9]{2}$"

Status = Literal["Aguardando Aprovação", "Em Andamento", "Concluído", "Entregue"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# ---------- Auth ----------
class LoginIn(Strict):
    username: str = Field(min_length=2, max_length=50)
    password: str = Field(min_length=4, max_length=72)


class UserOut(BaseModel):
    full_name: str
    role: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_at: int  # epoch em milissegundos
    user: UserOut


# ---------- Leitura ----------
def _iso(v):
    if isinstance(v, datetime):
        return v.isoformat(timespec="seconds") + "Z"
    return v


class PartOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    barcode: str
    location: str
    quantity: int
    min_quantity: int


class AppointmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    public_token: str
    vehicle: str
    plate: str
    customer_name: str
    status: str
    created_at: str

    _v = field_validator("created_at", mode="before")(_iso)


class MessageOut(BaseModel):
    id: str
    appointment_id: str
    author_type: str
    author_name: str
    text: str
    photo_url: str | None = None
    alt_text: str | None = None
    created_at: str

    _v = field_validator("created_at", mode="before")(_iso)


class PublicAppointmentOut(BaseModel):
    """Visão pública: sem IDs internos nem token."""
    vehicle: str
    plate: str
    customer_name: str
    status: str
    messages: list[MessageOut]


class PullOut(BaseModel):
    parts: list[PartOut]
    appointments: list[AppointmentOut]
    messages: list[MessageOut]


# ---------- Escrita / Sync ----------
class AppointmentIn(Strict):
    id: str = Field(pattern=UUID4_RE)
    public_token: str = Field(pattern=UUID4_RE)
    vehicle: str = Field(min_length=3, max_length=120)
    plate: str = Field(max_length=10)
    customer_name: str = Field(min_length=2, max_length=120)
    status: Status = "Aguardando Aprovação"

    @field_validator("plate")
    @classmethod
    def _plate(cls, v: str) -> str:
        import re
        v = v.upper()
        if not re.match(PLATE_RE, v):
            raise ValueError("Placa inválida")
        return v


class MessageIn(Strict):
    id: str = Field(pattern=UUID4_RE)
    appointment_id: str = Field(pattern=UUID4_RE)
    text: str = Field(min_length=1, max_length=2000)


class PublicMessageIn(Strict):
    id: str = Field(pattern=UUID4_RE)
    text: str = Field(min_length=1, max_length=2000)


class StockOutIn(Strict):
    client_id: str = Field(pattern=UUID4_RE)
    part_id: int = Field(ge=1)
    qty: int = Field(ge=1, le=100)


class SyncIn(Strict):
    appointments: list[AppointmentIn] = Field(default_factory=list, max_length=100)
    messages: list[MessageIn] = Field(default_factory=list, max_length=300)
    stock_out: list[StockOutIn] = Field(default_factory=list, max_length=300)


class SyncOut(BaseModel):
    # id da operação -> "ok" | "duplicate" | "rejected:<motivo>"
    results: dict[str, str]
