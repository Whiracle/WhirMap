from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from .models import Base, DeviceType, Group, Map, Node, NodeGroup, User, new_id
from .security import hash_password

DB_PATH = Path(os.getenv("DB_PATH", "data/app.db"))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        default_type = db.get(DeviceType, "device")
        if not default_type:
            db.add(DeviceType(id="device", name="Device", icon="📦"))
        elif default_type.name == "device":
            default_type.name = "Device"
            db.add(default_type)

        default_group = db.get(Group, "group_default")
        if not default_group:
            db.add(Group(id="group_default", name="Default", description="Default visibility group"))
        db.commit()

        if not db.query(User).first():
            username = os.getenv("DEFAULT_ADMIN_USERNAME", "admin")
            password = os.getenv("DEFAULT_ADMIN_PASSWORD", "admin123")
            db.add(User(
                id=new_id("user"),
                username=username,
                password_hash=hash_password(password),
                role="admin",
                is_active=True,
            ))
            db.commit()

        # Compatibility helpers for older local databases.
        for user in db.query(User).all():
            if user.role == "support":
                user.role = "member"
                db.add(user)
        db.commit()

        known_type_ids = {item.id for item in db.query(DeviceType).all()}
        for node in db.query(Node).all():
            if node.type not in known_type_ids:
                node.type = "device"
                db.add(node)
            has_group = db.query(NodeGroup).filter(NodeGroup.node_id == node.id).first()
            if not has_group:
                db.add(NodeGroup(node_id=node.id, group_id="group_default"))
        db.commit()

        root = db.get(Map, "root")
        if root:
            return

        db.add(Map(id="root", name="Company Network"))
        db.commit()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
