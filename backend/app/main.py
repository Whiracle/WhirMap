from __future__ import annotations

import asyncio
import os
import platform
import re
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .db import SessionLocal, get_db, init_db
from .models import (
    DeviceType,
    Edge,
    Group,
    Map,
    Node,
    NodeGroup,
    NodeStatusEvent,
    NodeStatusHistory,
    Notification,
    SessionToken,
    User,
    UserGroup,
    new_id,
)
from .security import hash_password, new_session_token, verify_password

app = FastAPI(title="Whiracle WhirMap", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PING_INTERVAL_SECONDS = int(os.getenv("PING_INTERVAL_SECONDS", "5"))
FRONTEND_DIST = Path(os.getenv("FRONTEND_DIST", "frontend/dist")).resolve()
SESSION_DAYS = int(os.getenv("SESSION_DAYS", "7"))

active_websockets: set[WebSocket] = set()


class LoginPayload(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)


class ChangePasswordPayload(BaseModel):
    current_password: str = Field(min_length=1)
    new_password: str = Field(min_length=6)


class CreateUserPayload(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=4)
    role: str = "member"
    group_ids: list[str] = Field(default_factory=list)


class PatchUserPayload(BaseModel):
    role: str | None = None
    password: str | None = None
    is_active: bool | None = None
    group_ids: list[str] | None = None


class CreateGroupPayload(BaseModel):
    name: str = Field(min_length=1)
    description: str | None = None


class PatchGroupPayload(BaseModel):
    name: str | None = None
    description: str | None = None


class CreateDeviceTypePayload(BaseModel):
    name: str = Field(min_length=1)
    icon: str = "📦"


class PatchDeviceTypePayload(BaseModel):
    name: str | None = None
    icon: str | None = None


class CreateNodePayload(BaseModel):
    label: str = Field(default="New Device", min_length=1)
    type: str = "device"
    ip: str | None = None
    x: float = 200
    y: float = 200
    monitor_enabled: bool = False
    group_ids: list[str] = Field(default_factory=list)


class PatchNodePayload(BaseModel):
    label: str | None = None
    type: str | None = None
    ip: str | None = None
    x: float | None = None
    y: float | None = None
    monitor_enabled: bool | None = None
    group_ids: list[str] | None = None


class CreateEdgePayload(BaseModel):
    source: str
    target: str
    label: str | None = None


class RenameMapPayload(BaseModel):
    name: str = Field(min_length=1)


# ---------------------------
# Auth + permission helpers
# ---------------------------

def require_role_value(role: str) -> str:
    if role not in {"admin", "member"}:
        raise HTTPException(status_code=400, detail="Role must be admin or member")
    return role


def group_to_ui(group: Group) -> dict[str, Any]:
    return {
        "id": group.id,
        "name": group.name,
        "description": group.description,
        "createdAt": group.created_at.isoformat() if group.created_at else None,
    }


def device_type_to_ui(item: DeviceType) -> dict[str, Any]:
    return {
        "id": item.id,
        "name": item.name,
        "icon": item.icon,
        "createdAt": item.created_at.isoformat() if item.created_at else None,
    }


def get_user_group_ids(db: Session, user_id: str) -> list[str]:
    return [row.group_id for row in db.query(UserGroup).filter(UserGroup.user_id == user_id).all()]


def get_node_group_ids(db: Session, node_id: str) -> list[str]:
    return [row.group_id for row in db.query(NodeGroup).filter(NodeGroup.node_id == node_id).all()]


def user_to_public(db: Session, user: User) -> dict[str, Any]:
    group_ids = get_user_group_ids(db, user.id)
    group_names = [g.name for g in db.query(Group).filter(Group.id.in_(group_ids)).all()] if group_ids else []
    return {
        "id": user.id,
        "username": user.username,
        "role": "member" if user.role == "support" else user.role,
        "isActive": user.is_active,
        "groupIds": group_ids,
        "groupNames": group_names,
        "createdAt": user.created_at.isoformat() if user.created_at else None,
    }


def get_user_by_token(db: Session, token: str | None) -> User | None:
    if not token:
        return None
    session = db.get(SessionToken, token)
    if not session:
        return None
    if session.expires_at < datetime.utcnow():
        db.delete(session)
        db.commit()
        return None
    user = db.get(User, session.user_id)
    if not user or not user.is_active:
        return None
    if user.role == "support":
        user.role = "member"
        db.add(user)
        db.commit()
    return user


def current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    token: str | None = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
    user = get_user_by_token(db, token)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


def require_admin(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    return user


def set_user_groups(db: Session, user_id: str, group_ids: list[str]) -> None:
    db.query(UserGroup).filter(UserGroup.user_id == user_id).delete(synchronize_session=False)
    valid = [item.id for item in db.query(Group).filter(Group.id.in_(group_ids)).all()] if group_ids else []
    for group_id in valid:
        db.add(UserGroup(user_id=user_id, group_id=group_id))


def set_node_groups(db: Session, node_id: str, group_ids: list[str]) -> None:
    db.query(NodeGroup).filter(NodeGroup.node_id == node_id).delete(synchronize_session=False)
    valid = [item.id for item in db.query(Group).filter(Group.id.in_(group_ids)).all()] if group_ids else []
    if not valid:
        default = db.get(Group, "group_default")
        valid = [default.id] if default else []
    for group_id in valid:
        db.add(NodeGroup(node_id=node_id, group_id=group_id))


def can_view_node(db: Session, user: User, node: Node) -> bool:
    if user.role == "admin":
        return True
    user_groups = set(get_user_group_ids(db, user.id))
    if not user_groups:
        return False
    node_groups = set(get_node_group_ids(db, node.id))
    return bool(user_groups.intersection(node_groups))


def filter_visible_nodes(db: Session, user: User, nodes: list[Node]) -> list[Node]:
    if user.role == "admin":
        return nodes
    return [node for node in nodes if can_view_node(db, user, node)]


@app.post("/api/auth/login")
def login(payload: LoginPayload, db: Session = Depends(get_db)) -> dict[str, Any]:
    user = db.query(User).filter(User.username == payload.username).first()
    if not user or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    if user.role == "support":
        user.role = "member"
        db.add(user)
    token = new_session_token()
    session = SessionToken(
        token=token,
        user_id=user.id,
        expires_at=datetime.utcnow() + timedelta(days=SESSION_DAYS),
    )
    db.add(session)
    db.commit()
    return {"token": token, "user": user_to_public(db, user)}


@app.get("/api/auth/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict[str, Any]:
    return {"user": user_to_public(db, user)}




@app.post("/api/auth/change-password")
def change_password(
    payload: ChangePasswordPayload,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    user.password_hash = hash_password(payload.new_password)
    user.updated_at = datetime.utcnow()
    db.add(user)
    db.commit()
    return {"ok": True}

@app.post("/api/auth/logout")
def logout(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
        session = db.get(SessionToken, token)
        if session:
            db.delete(session)
            db.commit()
    return {"ok": True}


@app.get("/api/users")
def list_users(_: User = Depends(require_admin), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    users = db.query(User).order_by(User.created_at.asc()).all()
    return [user_to_public(db, user) for user in users]


@app.post("/api/users")
def create_user(payload: CreateUserPayload, _: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    role = require_role_value(payload.role)
    username = payload.username.strip()
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=409, detail="Username already exists")
    user = User(
        id=new_id("user"),
        username=username,
        password_hash=hash_password(payload.password),
        role=role,
        is_active=True,
    )
    db.add(user)
    db.flush()
    set_user_groups(db, user.id, payload.group_ids)
    db.commit()
    db.refresh(user)
    return user_to_public(db, user)


@app.patch("/api/users/{user_id}")
def patch_user(user_id: str, payload: PatchUserPayload, admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    data = payload.model_dump(exclude_unset=True)
    if "role" in data and data["role"] is not None:
        new_role = require_role_value(data["role"])
        if user.id == admin.id and new_role != "admin":
            raise HTTPException(status_code=400, detail="You cannot remove admin role from your own account")
        user.role = new_role
    if "password" in data and data["password"]:
        user.password_hash = hash_password(data["password"])
    if "is_active" in data and data["is_active"] is not None:
        if user.id == admin.id and data["is_active"] is False:
            raise HTTPException(status_code=400, detail="You cannot disable your own account")
        user.is_active = data["is_active"]
    if "group_ids" in data and data["group_ids"] is not None:
        set_user_groups(db, user.id, data["group_ids"])
    user.updated_at = datetime.utcnow()
    db.add(user)
    db.commit()
    return user_to_public(db, user)


@app.delete("/api/users/{user_id}")
def delete_user(user_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    db.query(SessionToken).filter(SessionToken.user_id == user_id).delete(synchronize_session=False)
    db.query(UserGroup).filter(UserGroup.user_id == user_id).delete(synchronize_session=False)
    db.delete(user)
    db.commit()
    return {"ok": True}


@app.get("/api/groups")
def list_groups(_: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    groups = db.query(Group).order_by(Group.name.asc()).all()
    return [group_to_ui(group) for group in groups]


@app.get("/api/groups/overview")
def groups_overview(_: User = Depends(require_admin), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    groups = db.query(Group).order_by(Group.name.asc()).all()
    result: list[dict[str, Any]] = []
    for group in groups:
        user_links = db.query(UserGroup).filter(UserGroup.group_id == group.id).all()
        users: list[dict[str, Any]] = []
        for link in user_links:
            user = db.get(User, link.user_id)
            if user:
                users.append({
                    "id": user.id,
                    "username": user.username,
                    "role": "member" if user.role == "support" else user.role,
                    "isActive": user.is_active,
                })

        node_links = db.query(NodeGroup).filter(NodeGroup.group_id == group.id).all()
        node_ids = [link.node_id for link in node_links]
        devices: list[dict[str, Any]] = []
        if node_ids:
            nodes = db.query(Node).filter(Node.id.in_(node_ids)).order_by(Node.label.asc()).limit(12).all()
            devices = [
                {
                    "id": node.id,
                    "label": node.label,
                    "status": node_status_for_ui(db, node),
                    "ip": node.ip,
                    "mapId": node.map_id,
                }
                for node in nodes
            ]

        item = group_to_ui(group)
        item.update({
            "users": sorted(users, key=lambda value: value["username"].lower()),
            "deviceCount": len(node_ids),
            "devices": devices,
        })
        result.append(item)
    return result


@app.post("/api/groups")
def create_group(payload: CreateGroupPayload, _: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    name = payload.name.strip()
    if db.query(Group).filter(Group.name == name).first():
        raise HTTPException(status_code=409, detail="Group already exists")
    group = Group(id=new_id("group"), name=name, description=payload.description)
    db.add(group)
    db.commit()
    db.refresh(group)
    return group_to_ui(group)


@app.patch("/api/groups/{group_id}")
def patch_group(group_id: str, payload: PatchGroupPayload, _: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    group = db.get(Group, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    if payload.name is not None:
        group.name = payload.name.strip()
    if payload.description is not None:
        group.description = payload.description
    group.updated_at = datetime.utcnow()
    db.add(group)
    db.commit()
    return group_to_ui(group)


@app.get("/api/device-types")
def list_device_types(_: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    items = db.query(DeviceType).order_by(DeviceType.name.asc()).all()
    return [device_type_to_ui(item) for item in items]


@app.post("/api/device-types")
def create_device_type(payload: CreateDeviceTypePayload, _: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    name = payload.name.strip()
    if db.query(DeviceType).filter(DeviceType.name == name).first():
        raise HTTPException(status_code=409, detail="Device type already exists")
    item = DeviceType(id=new_id("dtype"), name=name, icon=payload.icon.strip() or "📦")
    db.add(item)
    db.commit()
    db.refresh(item)
    return device_type_to_ui(item)


@app.patch("/api/device-types/{device_type_id}")
def patch_device_type(device_type_id: str, payload: PatchDeviceTypePayload, _: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    item = db.get(DeviceType, device_type_id)
    if not item:
        raise HTTPException(status_code=404, detail="Device type not found")
    if payload.name is not None:
        item.name = payload.name.strip()
    if payload.icon is not None:
        item.icon = payload.icon.strip() or "📦"
    item.updated_at = datetime.utcnow()
    db.add(item)
    db.commit()
    return device_type_to_ui(item)


# ---------------------------
# Ping helpers
# ---------------------------

def parse_ping_latency_ms(output: str) -> float | None:
    patterns = [
        r"time[=<]\s*([0-9]+(?:[\.,][0-9]+)?)\s*ms",
        r"время[=<]\s*([0-9]+(?:[\.,][0-9]+)?)\s*мс",
        r"Average =\s*([0-9]+)ms",
        r"Среднее =\s*([0-9]+)мсек",
    ]
    for pattern in patterns:
        match = re.search(pattern, output, flags=re.IGNORECASE)
        if match:
            return float(match.group(1).replace(",", "."))
    return None


def build_ping_command(target: str) -> list[str]:
    system = platform.system().lower()
    if system == "windows":
        return ["ping", "-n", "1", "-w", "1000", target]
    return ["ping", "-c", "1", "-W", "1", target]


async def run_ping(target: str) -> dict[str, Any]:
    if not target or not target.strip():
        return {"target": target, "status": "disabled", "latency_ms": None, "stdout": "", "stderr": "", "returncode": None}

    command = build_ping_command(target.strip())

    def _run() -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=3,
            encoding="utf-8",
            errors="replace",
        )

    try:
        completed = await asyncio.to_thread(_run)
        combined = f"{completed.stdout}\n{completed.stderr}"
        latency_ms = parse_ping_latency_ms(combined)
        status = "up" if completed.returncode == 0 else "down"
        return {
            "target": target,
            "command": command,
            "status": status,
            "latency_ms": latency_ms,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
            "returncode": completed.returncode,
        }
    except Exception as exc:
        return {
            "target": target,
            "command": command,
            "status": "down",
            "latency_ms": None,
            "stdout": "",
            "stderr": str(exc),
            "returncode": -1,
        }


async def broadcast(message: dict[str, Any]) -> None:
    stale: list[WebSocket] = []
    for ws in active_websockets:
        try:
            await ws.send_json(message)
        except Exception:
            stale.append(ws)
    for ws in stale:
        active_websockets.discard(ws)


def record_status_event(
    db: Session,
    node: Node,
    status: str,
    latency_ms: float | None,
    source: str,
    checked_at: datetime | None = None,
) -> NodeStatusEvent:
    now = checked_at or datetime.utcnow()
    current = (
        db.query(NodeStatusEvent)
        .filter(NodeStatusEvent.node_id == node.id, NodeStatusEvent.ended_at.is_(None))
        .order_by(NodeStatusEvent.started_at.desc())
        .first()
    )

    if current and current.status == status:
        current.last_seen_at = now
        current.latency_ms = latency_ms
        current.source = source
        db.add(current)
        return current

    previous_status = current.status if current else None
    if current:
        current.ended_at = now
        current.last_seen_at = now
        db.add(current)

    event = NodeStatusEvent(
        node_id=node.id,
        status=status,
        started_at=now,
        last_seen_at=now,
        ended_at=None,
        latency_ms=latency_ms,
        source=source,
    )
    db.add(event)
    if previous_status is not None:
        create_status_notification(db, node, status, previous_status, now)
    return event


def seconds_between(start: datetime | None, end: datetime | None) -> int | None:
    if not start:
        return None
    actual_end = end or datetime.utcnow()
    return max(0, int((actual_end - start).total_seconds()))


def node_status_for_ui(db: Session, node: Node) -> str:
    if node.monitor_enabled:
        return node.status
    if node.child_map_id:
        return aggregate_map_status(db, node.child_map_id)
    return node.status


def aggregate_map_status(db: Session, map_id: str, seen: set[str] | None = None) -> str:
    seen = seen or set()
    if map_id in seen:
        return "unknown"
    seen.add(map_id)

    nodes = db.query(Node).filter(Node.map_id == map_id).all()
    statuses: list[str] = []
    for node in nodes:
        if node.monitor_enabled:
            statuses.append(node.status)
        elif node.child_map_id:
            statuses.append(aggregate_map_status(db, node.child_map_id, seen))

    if not statuses:
        return "disabled"
    if "down" in statuses:
        return "down"
    if "unknown" in statuses:
        return "unknown"
    if "up" in statuses:
        return "up"
    return "disabled"


def node_to_react_flow(db: Session, node: Node) -> dict[str, Any]:
    dtype = db.get(DeviceType, node.type) or db.get(DeviceType, "device")
    group_ids = get_node_group_ids(db, node.id)
    return {
        "id": node.id,
        "type": "networkNode",
        "position": {"x": node.x, "y": node.y},
        "data": {
            "label": node.label,
            "deviceType": dtype.id if dtype else "device",
            "deviceTypeName": dtype.name if dtype else "Device",
            "deviceIcon": dtype.icon if dtype else "📦",
            "groupIds": group_ids,
            "ip": node.ip,
            "childMapId": node.child_map_id,
            "monitorEnabled": node.monitor_enabled,
            "status": node_status_for_ui(db, node),
            "ownStatus": node.status,
            "latencyMs": node.latency_ms,
            "lastCheckedAt": node.last_checked_at.isoformat() if node.last_checked_at else None,
        },
    }


def edge_to_react_flow(edge: Edge) -> dict[str, Any]:
    return {
        "id": edge.id,
        "source": edge.source_node_id,
        "target": edge.target_node_id,
        "label": edge.label or "",
        "animated": False,
    }


def breadcrumbs_for_map(db: Session, map_obj: Map) -> list[dict[str, str]]:
    crumbs = [{"id": map_obj.id, "name": map_obj.name}]
    current = map_obj
    safety = 0
    while current.parent_node_id and safety < 20:
        safety += 1
        parent_node = db.get(Node, current.parent_node_id)
        if not parent_node:
            break
        parent_map = db.get(Map, parent_node.map_id)
        if not parent_map:
            break
        crumbs.append({"id": parent_map.id, "name": parent_map.name})
        current = parent_map
    return list(reversed(crumbs))


def map_path_for_node(db: Session, node: Node) -> str:
    map_obj = db.get(Map, node.map_id)
    if not map_obj:
        return node.map_id
    return " / ".join(crumb["name"] for crumb in breadcrumbs_for_map(db, map_obj))


def notification_to_ui(db: Session, item: Notification) -> dict[str, Any]:
    node = db.get(Node, item.node_id)
    map_path = map_path_for_node(db, node) if node else None
    return {
        "id": item.id,
        "nodeId": item.node_id,
        "nodeLabel": node.label if node else "Deleted device",
        "nodeIp": node.ip if node else None,
        "mapId": node.map_id if node else None,
        "mapPath": map_path,
        "status": item.status,
        "title": item.title,
        "message": item.message,
        "createdAt": item.created_at.isoformat() if item.created_at else None,
    }


def create_status_notification(db: Session, node: Node, status: str, previous_status: str, checked_at: datetime) -> Notification | None:
    if status not in {"up", "down"}:
        return None
    if previous_status not in {"up", "down"}:
        return None
    if previous_status == status:
        return None
    title = f"{node.label} is {'DOWN' if status == 'down' else 'UP'}"
    path = map_path_for_node(db, node)
    message = f"{node.label}{f' ({node.ip})' if node.ip else ''} changed from {previous_status.upper()} to {status.upper()} in {path}."
    item = Notification(
        node_id=node.id,
        status=status,
        title=title,
        message=message,
        created_at=checked_at,
    )
    db.add(item)
    return item


async def ping_worker() -> None:
    while True:
        await asyncio.sleep(PING_INTERVAL_SECONDS)
        with SessionLocal() as db:
            nodes = db.query(Node).filter(Node.monitor_enabled == True, Node.ip.isnot(None)).all()  # noqa: E712
            for node in nodes:
                result = await run_ping(node.ip or "")
                checked_at = datetime.utcnow()
                node.status = result["status"]
                node.latency_ms = result["latency_ms"]
                node.last_checked_at = checked_at
                node.updated_at = checked_at
                record_status_event(db, node, node.status, node.latency_ms, "worker", checked_at)
                db.add(node)
                db.commit()
                await broadcast({
                    "type": "node_status_changed",
                    "nodeId": node.id,
                    "status": node.status,
                    "latencyMs": node.latency_ms,
                    "lastCheckedAt": node.last_checked_at.isoformat(),
                })


@app.on_event("startup")
async def on_startup() -> None:
    init_db()
    asyncio.create_task(ping_worker())


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "frontend_dist": str(FRONTEND_DIST), "frontend_exists": FRONTEND_DIST.exists()}




@app.get("/api/search/nodes")
def search_nodes(
    q: str = Query(default=""),
    limit: int = Query(default=60, ge=1, le=200),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    query = q.strip().lower()
    if not query:
        return []

    results: list[dict[str, Any]] = []
    nodes = db.query(Node).order_by(Node.label.asc()).all()
    for node in nodes:
        if not can_view_node(db, user, node):
            continue
        map_obj = db.get(Map, node.map_id)
        if not map_obj:
            continue
        dtype = db.get(DeviceType, node.type) or db.get(DeviceType, "device")
        group_ids = get_node_group_ids(db, node.id)
        node_groups = db.query(Group).filter(Group.id.in_(group_ids)).all() if group_ids else []
        group_names = [group.name for group in node_groups]
        crumbs = breadcrumbs_for_map(db, map_obj)
        map_path = " / ".join(crumb["name"] for crumb in crumbs)
        haystack = " ".join([
            node.label or "",
            node.ip or "",
            dtype.name if dtype else "Device",
            dtype.icon if dtype else "",
            map_obj.name or "",
            map_path,
            " ".join(group_names),
            node.status or "",
        ]).lower()
        if query not in haystack:
            continue
        results.append({
            "nodeId": node.id,
            "label": node.label,
            "ip": node.ip,
            "status": node_status_for_ui(db, node),
            "ownStatus": node.status,
            "latencyMs": node.latency_ms,
            "lastCheckedAt": node.last_checked_at.isoformat() if node.last_checked_at else None,
            "mapId": map_obj.id,
            "mapName": map_obj.name,
            "mapPath": map_path,
            "breadcrumbs": crumbs,
            "deviceTypeName": dtype.name if dtype else "Device",
            "deviceIcon": dtype.icon if dtype else "📦",
            "groupIds": group_ids,
            "groupNames": group_names,
        })
        if len(results) >= limit:
            break
    return results




@app.get("/api/notifications")
def list_notifications(
    q: str = Query(default=""),
    limit: int = Query(default=100, ge=1, le=500),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    query = q.strip().lower()
    all_items = db.query(Notification).order_by(Notification.created_at.desc()).all()
    visible: list[Notification] = []
    for item in all_items:
        node = db.get(Node, item.node_id)
        if not node or not can_view_node(db, user, node):
            continue
        map_path = map_path_for_node(db, node)
        haystack = " ".join([
            item.title or "",
            item.message or "",
            item.status or "",
            node.label or "",
            node.ip or "",
            map_path or "",
        ]).lower()
        if query and query not in haystack:
            continue
        visible.append(item)
        if len(visible) >= limit:
            break
    return {
        "total": len([item for item in all_items if (db.get(Node, item.node_id) and can_view_node(db, user, db.get(Node, item.node_id)))]),
        "items": [notification_to_ui(db, item) for item in visible],
    }


@app.delete("/api/notifications/{notification_id}")
def delete_notification(notification_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict[str, Any]:
    item = db.get(Notification, notification_id)
    if not item:
        raise HTTPException(status_code=404, detail="Notification not found")
    node = db.get(Node, item.node_id)
    if not node or not can_view_node(db, user, node):
        raise HTTPException(status_code=403, detail="You do not have access to this notification")
    db.delete(item)
    db.commit()
    return {"ok": True}


@app.delete("/api/notifications")
def delete_all_notifications(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict[str, Any]:
    items = db.query(Notification).all()
    deleted = 0
    for item in items:
        node = db.get(Node, item.node_id)
        if node and can_view_node(db, user, node):
            db.delete(item)
            deleted += 1
    db.commit()
    return {"ok": True, "deleted": deleted}


@app.get("/api/maps")
def list_maps(user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    maps = db.query(Map).order_by(Map.created_at.asc()).all()
    if user.role == "admin":
        return [{"id": item.id, "name": item.name, "parentNodeId": item.parent_node_id} for item in maps]
    visible: list[dict[str, Any]] = []
    for item in maps:
        nodes = db.query(Node).filter(Node.map_id == item.id).all()
        if any(can_view_node(db, user, node) for node in nodes) or item.id == "root":
            visible.append({"id": item.id, "name": item.name, "parentNodeId": item.parent_node_id})
    return visible


@app.get("/api/maps/{map_id}")
def get_map(map_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict[str, Any]:
    map_obj = db.get(Map, map_id)
    if not map_obj:
        raise HTTPException(status_code=404, detail="Map not found")
    all_nodes = db.query(Node).filter(Node.map_id == map_id).all()
    nodes = filter_visible_nodes(db, user, all_nodes)
    visible_ids = {node.id for node in nodes}
    edges = [
        edge for edge in db.query(Edge).filter(Edge.map_id == map_id).all()
        if edge.source_node_id in visible_ids and edge.target_node_id in visible_ids
    ]
    return {
        "id": map_obj.id,
        "name": map_obj.name,
        "breadcrumbs": breadcrumbs_for_map(db, map_obj),
        "nodes": [node_to_react_flow(db, node) for node in nodes],
        "edges": [edge_to_react_flow(edge) for edge in edges],
    }


@app.patch("/api/maps/{map_id}")
def rename_map(map_id: str, payload: RenameMapPayload, _: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    map_obj = db.get(Map, map_id)
    if not map_obj:
        raise HTTPException(status_code=404, detail="Map not found")
    map_obj.name = payload.name
    map_obj.updated_at = datetime.utcnow()
    db.add(map_obj)
    db.commit()
    return {"ok": True, "id": map_obj.id, "name": map_obj.name}


@app.post("/api/maps/{map_id}/nodes")
def create_node(map_id: str, payload: CreateNodePayload, _: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    if not db.get(Map, map_id):
        raise HTTPException(status_code=404, detail="Map not found")
    if not db.get(DeviceType, payload.type):
        raise HTTPException(status_code=400, detail="Unknown device type")
    node = Node(
        id=new_id("node"),
        map_id=map_id,
        label=payload.label,
        type=payload.type,
        ip=payload.ip or None,
        x=payload.x,
        y=payload.y,
        monitor_enabled=payload.monitor_enabled,
        status="unknown" if payload.monitor_enabled else "disabled",
    )
    db.add(node)
    db.flush()
    set_node_groups(db, node.id, payload.group_ids)
    db.commit()
    db.refresh(node)
    return node_to_react_flow(db, node)


@app.patch("/api/nodes/{node_id}")
def patch_node(node_id: str, payload: PatchNodePayload, _: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    node = db.get(Node, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    data = payload.model_dump(exclude_unset=True)
    if "type" in data and data["type"] is not None and not db.get(DeviceType, data["type"]):
        raise HTTPException(status_code=400, detail="Unknown device type")
    for key, value in data.items():
        if key == "group_ids":
            continue
        if key == "monitor_enabled" and value is False:
            node.status = "disabled"
            node.latency_ms = None
        if key == "monitor_enabled" and value is True and node.status == "disabled":
            node.status = "unknown"
        setattr(node, key, value if value != "" else None)
    if "group_ids" in data and data["group_ids"] is not None:
        set_node_groups(db, node.id, data["group_ids"])
    node.updated_at = datetime.utcnow()
    db.add(node)
    db.commit()
    db.refresh(node)
    return node_to_react_flow(db, node)


@app.delete("/api/nodes/{node_id}")
def delete_node(node_id: str, _: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    node = db.get(Node, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    if node.child_map_id:
        raise HTTPException(status_code=409, detail="This node has a child map. Delete child map support is not implemented in MVP.")
    db.query(Edge).filter((Edge.source_node_id == node_id) | (Edge.target_node_id == node_id)).delete(synchronize_session=False)
    db.query(NodeStatusHistory).filter(NodeStatusHistory.node_id == node_id).delete(synchronize_session=False)
    db.query(NodeStatusEvent).filter(NodeStatusEvent.node_id == node_id).delete(synchronize_session=False)
    db.query(NodeGroup).filter(NodeGroup.node_id == node_id).delete(synchronize_session=False)
    db.query(Notification).filter(Notification.node_id == node_id).delete(synchronize_session=False)
    db.delete(node)
    db.commit()
    return {"ok": True}


@app.post("/api/maps/{map_id}/edges")
def create_edge(map_id: str, payload: CreateEdgePayload, _: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    if not db.get(Map, map_id):
        raise HTTPException(status_code=404, detail="Map not found")
    source = db.get(Node, payload.source)
    target = db.get(Node, payload.target)
    if not source or not target or source.map_id != map_id or target.map_id != map_id:
        raise HTTPException(status_code=400, detail="Source and target must exist on this map")
    edge = Edge(
        id=new_id("edge"),
        map_id=map_id,
        source_node_id=payload.source,
        target_node_id=payload.target,
        label=payload.label,
    )
    db.add(edge)
    db.commit()
    return edge_to_react_flow(edge)


@app.delete("/api/edges/{edge_id}")
def delete_edge(edge_id: str, _: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    edge = db.get(Edge, edge_id)
    if not edge:
        raise HTTPException(status_code=404, detail="Edge not found")
    db.delete(edge)
    db.commit()
    return {"ok": True}


@app.post("/api/nodes/{node_id}/child-map")
def create_child_map(node_id: str, _: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    node = db.get(Node, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    if node.child_map_id:
        child = db.get(Map, node.child_map_id)
        return {"ok": True, "childMapId": node.child_map_id, "childMapName": child.name if child else node.label}
    child_map = Map(id=new_id("map"), name=node.label, parent_node_id=node.id)
    node.child_map_id = child_map.id
    node.updated_at = datetime.utcnow()
    db.add_all([child_map, node])
    db.commit()
    return {"ok": True, "childMapId": child_map.id, "childMapName": child_map.name}


@app.post("/api/nodes/{node_id}/ping")
async def ping_node_now(node_id: str, _: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    node = db.get(Node, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    if not node.ip:
        raise HTTPException(status_code=400, detail="Node has no IP/hostname")
    result = await run_ping(node.ip)
    checked_at = datetime.utcnow()
    node.status = result["status"]
    node.latency_ms = result["latency_ms"]
    node.last_checked_at = checked_at
    if not node.monitor_enabled:
        node.monitor_enabled = True
    record_status_event(db, node, node.status, node.latency_ms, "manual", checked_at)
    db.add(node)
    db.commit()
    await broadcast({
        "type": "node_status_changed",
        "nodeId": node.id,
        "status": node.status,
        "latencyMs": node.latency_ms,
        "lastCheckedAt": node.last_checked_at.isoformat(),
    })
    return {"ok": True, "result": {k: v for k, v in result.items() if k not in {"stdout", "stderr"}}}


@app.get("/api/nodes/{node_id}/history")
def node_history(
    node_id: str,
    limit: int = Query(default=80, ge=1, le=500),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    node = db.get(Node, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    if not can_view_node(db, user, node):
        raise HTTPException(status_code=403, detail="You do not have access to this node")

    newest_first = (
        db.query(NodeStatusEvent)
        .filter(NodeStatusEvent.node_id == node_id)
        .order_by(NodeStatusEvent.started_at.desc())
        .limit(limit)
        .all()
    )
    events = list(reversed(newest_first))

    all_events = db.query(NodeStatusEvent).filter(NodeStatusEvent.node_id == node_id).all()
    down_events = [event for event in all_events if event.status == "down"]
    up_events = [event for event in all_events if event.status == "up"]
    total_downtime_seconds = sum(seconds_between(event.started_at, event.ended_at) or 0 for event in down_events)

    def event_to_ui(event: NodeStatusEvent) -> dict[str, Any]:
        duration_seconds = seconds_between(event.started_at, event.ended_at)
        return {
            "id": event.id,
            "status": event.status,
            "latencyMs": event.latency_ms,
            "startedAt": event.started_at.isoformat() if event.started_at else None,
            "lastSeenAt": event.last_seen_at.isoformat() if event.last_seen_at else None,
            "endedAt": event.ended_at.isoformat() if event.ended_at else None,
            "durationSeconds": duration_seconds,
            "isOpen": event.ended_at is None,
            "source": event.source,
        }

    return {
        "nodeId": node.id,
        "nodeLabel": node.label,
        "summary": {
            "events": len(all_events),
            "upEvents": len(up_events),
            "downEvents": len(down_events),
            "totalDowntimeSeconds": total_downtime_seconds,
            "currentStatus": node.status,
            "lastCheckedAt": node.last_checked_at.isoformat() if node.last_checked_at else None,
        },
        "items": [event_to_ui(event) for event in events],
    }


@app.websocket("/api/ws/status")
async def ws_status(websocket: WebSocket, token: str | None = None) -> None:
    with SessionLocal() as db:
        user = get_user_by_token(db, token)
    if not user:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    active_websockets.add(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        active_websockets.discard(websocket)


# React build serving. API routes must stay above this section.
if (FRONTEND_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")


@app.get("/")
def serve_root() -> FileResponse:
    index = FRONTEND_DIST / "index.html"
    if not index.exists():
        raise HTTPException(status_code=500, detail="Frontend build not found. Run npm run build in frontend/ first.")
    return FileResponse(index)


@app.get("/{full_path:path}")
def serve_spa(full_path: str) -> FileResponse:
    requested = FRONTEND_DIST / full_path
    if requested.exists() and requested.is_file():
        return FileResponse(requested)
    index = FRONTEND_DIST / "index.html"
    if not index.exists():
        raise HTTPException(status_code=500, detail="Frontend build not found. Run npm run build in frontend/ first.")
    return FileResponse(index)
