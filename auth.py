"""Autenticação: bcrypt + JWT (12 h) + limitador de tentativas simples em memória."""
import os
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from models import User, get_db

ALGORITHM = "HS256"
TOKEN_TTL = timedelta(hours=12)
_bearer = HTTPBearer(auto_error=False)


def _load_secret() -> str:
    env = os.getenv("JWT_SECRET")
    if env:
        return env
    path = Path(__file__).with_name(".jwt_secret")
    if path.exists():
        return path.read_text().strip()
    value = secrets.token_urlsafe(48)
    path.write_text(value)
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return value


SECRET_KEY = _load_secret()


# ---------- senhas ----------
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except ValueError:
        return False


_DUMMY_HASH = hash_password(secrets.token_urlsafe(8))  # iguala o tempo quando o usuário não existe


# ---------- JWT ----------
def create_token(user: User) -> tuple[str, int]:
    exp = datetime.now(timezone.utc) + TOKEN_TTL
    token = jwt.encode({"sub": str(user.id), "exp": exp}, SECRET_KEY, algorithm=ALGORITHM)
    return token, int(exp.timestamp() * 1000)


def authenticate(db: Session, username: str, password: str) -> User | None:
    user = db.scalar(select(User).where(User.username == username.lower()))
    ok = verify_password(password, user.password_hash if user else _DUMMY_HASH)
    return user if (user and ok) else None


def current_user(
    cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    unauthorized = HTTPException(status.HTTP_401_UNAUTHORIZED, "Sessão inválida ou expirada",
                                 headers={"WWW-Authenticate": "Bearer"})
    if not cred:
        raise unauthorized
    try:
        payload = jwt.decode(cred.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        user = db.get(User, int(payload["sub"]))
    except (jwt.PyJWTError, KeyError, ValueError):
        raise unauthorized
    if not user:
        raise unauthorized
    return user


# ---------- limitador de taxa ----------
class RateLimiter:
    def __init__(self, limit: int, window_s: int):
        self.limit, self.window = limit, window_s
        self.hits: dict[str, deque] = defaultdict(deque)

    def check(self, key: str) -> None:
        now = time.monotonic()
        dq = self.hits[key]
        while dq and now - dq[0] > self.window:
            dq.popleft()
        if len(dq) >= self.limit:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Muitas tentativas. Aguarde um instante.")
        dq.append(now)


login_limiter = RateLimiter(limit=8, window_s=60)
public_limiter = RateLimiter(limit=120, window_s=60)
