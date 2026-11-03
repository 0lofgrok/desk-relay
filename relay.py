"""desk-relay: thin public front door for the trading desk.

The desk (running elsewhere, outbound-only) pushes snapshots and events here;
the iPhone web app reads them and queues commands that the desk long-polls.
Everything lives in memory: the desk re-pushes its full state every few seconds.

Env vars (set in Render, never committed):
  APP_TOKEN  - bearer token for the phone app (/api/*)
  DESK_KEY   - shared key for the desk (/desk/*), sent as X-Desk-Key
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import re
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------- logging ---
_SECRET_QS = re.compile(r"([?&](?:t|token|key)=)[^&\s\"]+", re.I)


class _RedactFilter(logging.Filter):
    """Strip ?t=... style secrets from access-log lines."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.args and isinstance(record.args, tuple):
            record.args = tuple(_SECRET_QS.sub(r"\1***", a) if isinstance(a, str) else a for a in record.args)
        if isinstance(record.msg, str):
            record.msg = _SECRET_QS.sub(r"\1***", record.msg)
        return True


logging.getLogger("uvicorn.access").addFilter(_RedactFilter())
log = logging.getLogger("relay")

APP_TOKEN = os.environ.get("APP_TOKEN", "")
DESK_KEY = os.environ.get("DESK_KEY", "")
STALE_AFTER = float(os.environ.get("STALE_AFTER", "120"))  # seconds without a push => offline
REDELIVER_AFTER = 60.0  # un-acked commands are handed out again after this
WEB_DIR = Path(__file__).parent / "web"

app = FastAPI(title="desk-relay", docs_url=None, redoc_url=None, openapi_url=None)


# ------------------------------------------------------------------ state ---
class Store:
    def __init__(self) -> None:
        self.snap: dict[str, Any] = {
            "state": None, "chart": None, "activity": None, "account": None, "settings": None,
            "coins": {}, "audits": {}, "agents": {},
        }
        self.last_push: float | None = None
        # commands from the phone, waiting for the desk
        self.commands: dict[str, dict] = {}
        self.cmd_event = asyncio.Event()
        # SSE fan-out
        self.subscribers: set[asyncio.Queue] = set()
        self.event_seq = 0
        self.recent_events: deque = deque(maxlen=200)


S = Store()


def _ok(provided: str | None, expected: str) -> bool:
    return bool(expected) and bool(provided) and hmac.compare_digest(provided.encode(), expected.encode())


def _app_auth(req: Request) -> bool:
    h = req.headers.get("authorization", "")
    tok = h[7:].strip() if h.lower().startswith("bearer ") else None
    return _ok(tok or req.query_params.get("t"), APP_TOKEN)


def _desk_auth(req: Request) -> bool:
    return _ok(req.headers.get("x-desk-key"), DESK_KEY)


UNAUTH = lambda: JSONResponse({"error": "unauthorized"}, status_code=401)  # noqa: E731


def _offline() -> JSONResponse | None:
    if S.last_push is None:
        return JSONResponse({"offline": True}, status_code=503)
    if time.time() - S.last_push > STALE_AFTER:
        return JSONResponse({"offline": True, "last_push": S.last_push}, status_code=503)
    return None


def _snap_response(value: Any) -> JSONResponse:
    off = _offline()
    if off is not None:
        return off
    if value is None:
        return JSONResponse({"error": "not_found"}, status_code=404)
    return JSONResponse(value, headers={"X-Desk-Last-Push": str(S.last_push), "Cache-Control": "no-store"})


def _broadcast(event: dict) -> None:
    S.event_seq += 1
    event = {**event, "seq": S.event_seq}
    S.recent_events.append(event)
    for q in list(S.subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass  # slow client; it will resync from snapshots


def _queue_command(kind: str, payload: dict) -> dict:
    cmd = {"id": uuid.uuid4().hex, "kind": kind, "payload": payload, "ts": time.time(), "delivered_at": None}
    S.commands[cmd["id"]] = cmd
    S.cmd_event.set()
    return cmd


def _pending(now: float) -> list[dict]:
    return [c for c in S.commands.values() if c["delivered_at"] is None or now - c["delivered_at"] > REDELIVER_AFTER]


async def _json_body(req: Request) -> Any:
    try:
        return await req.json()
    except Exception:
        return None


# ----------------------------------------------------------------- health ---
@app.get("/healthz", response_class=PlainTextResponse)
async def healthz() -> str:
    return "ok"


# ------------------------------------------------------------- desk side ---
@app.post("/desk/push")
async def desk_push(req: Request):
    if not _desk_auth(req):
        return UNAUTH()
    body = await _json_body(req)
    if not isinstance(body, dict):
        return JSONResponse({"error": "json object required"}, status_code=400)
    for k in ("state", "chart", "activity", "account", "settings"):
        if k in body:
            S.snap[k] = body[k]
    # keyed collections merge per key; a null value removes the key
    for k, alias in (("coins", "coin"), ("audits", "audit"), ("agents", "agents")):
        part = body.get(k, body.get(alias) if alias != k else None)
        if isinstance(part, dict):
            for key, val in part.items():
                if val is None:
                    S.snap[k].pop(key, None)
                else:
                    S.snap[k][key] = val
    S.last_push = time.time()
    return {"ok": True, "last_push": S.last_push}


@app.post("/desk/event")
async def desk_event(req: Request):
    if not _desk_auth(req):
        return UNAUTH()
    body = await _json_body(req)
    events = body if isinstance(body, list) else [body]
    n = 0
    for ev in events:
        if isinstance(ev, dict):
            _broadcast(ev)
            n += 1
    if n == 0:
        return JSONResponse({"error": "event object(s) required"}, status_code=400)
    return {"ok": True, "count": n, "seq": S.event_seq}


@app.get("/desk/commands")
async def desk_commands(req: Request, wait: float = 25.0):
    if not _desk_auth(req):
        return UNAUTH()
    wait = max(0.0, min(wait, 50.0))
    deadline = time.time() + wait
    while True:
        now = time.time()
        pend = _pending(now)
        if pend or now >= deadline:
            break
        S.cmd_event.clear()
        try:
            await asyncio.wait_for(S.cmd_event.wait(), timeout=min(deadline - now, REDELIVER_AFTER))
        except asyncio.TimeoutError:
            pass
        if await req.is_disconnected():
            return JSONResponse({"commands": []})
    for c in pend:
        c["delivered_at"] = now
    return {"commands": [{k: c[k] for k in ("id", "kind", "payload", "ts")} for c in pend]}


@app.post("/desk/ack")
async def desk_ack(req: Request):
    if not _desk_auth(req):
        return UNAUTH()
    body = await _json_body(req)
    ids = body.get("ids") if isinstance(body, dict) else body
    if not isinstance(ids, list):
        return JSONResponse({"error": "ids list required"}, status_code=400)
    removed = sum(1 for i in ids if S.commands.pop(str(i), None) is not None)
    return {"ok": True, "acked": removed}


# ------------------------------------------------------------ phone reads ---
@app.get("/api/state")
async def api_state(req: Request):
    return _snap_response(S.snap["state"]) if _app_auth(req) else UNAUTH()


@app.get("/api/chart")
async def api_chart(req: Request, range: str | None = None):  # noqa: A002
    if not _app_auth(req):
        return UNAUTH()
    chart = S.snap["chart"]
    if range and isinstance(chart, dict) and range in chart:
        chart = chart[range]
    return _snap_response(chart)


@app.get("/api/activity")
async def api_activity(req: Request, before: float | None = None, limit: int = 50):
    if not _app_auth(req):
        return UNAUTH()
    acts = S.snap["activity"]
    if isinstance(acts, list):
        if before is not None:
            acts = [a for a in acts if isinstance(a, dict) and (a.get("ts") or 0) < before]
        acts = acts[: max(1, min(limit, 200))]
    return _snap_response(acts)


@app.get("/api/coin/{mint}")
async def api_coin(req: Request, mint: str):
    return _snap_response(S.snap["coins"].get(mint)) if _app_auth(req) else UNAUTH()


@app.get("/api/audit/{mint}")
async def api_audit(req: Request, mint: str):
    return _snap_response(S.snap["audits"].get(mint)) if _app_auth(req) else UNAUTH()


@app.get("/api/agents/{name}/decisions")
async def api_agent_decisions(req: Request, name: str):
    return _snap_response(S.snap["agents"].get(name)) if _app_auth(req) else UNAUTH()


@app.get("/api/account")
async def api_account(req: Request):
    return _snap_response(S.snap["account"]) if _app_auth(req) else UNAUTH()


@app.get("/api/settings")
async def api_settings_get(req: Request):
    return _snap_response(S.snap["settings"]) if _app_auth(req) else UNAUTH()


@app.get("/api/stream")
async def api_stream(req: Request):
    if not _app_auth(req):
        return UNAUTH()
    try:
        last_seen = int(req.headers.get("last-event-id") or req.query_params.get("since") or 0)
    except ValueError:
        last_seen = 0
    q: asyncio.Queue = asyncio.Queue(maxsize=500)
    backlog = [e for e in S.recent_events if e["seq"] > last_seen] if last_seen else []
    S.subscribers.add(q)

    async def gen():
        try:
            yield "retry: 3000\n\n"
            yield f"event: hello\ndata: {json.dumps({'offline': _offline() is not None, 'seq': S.event_seq})}\n\n"
            for e in backlog:
                yield _sse(e)
            while True:
                if await req.is_disconnected():
                    break
                try:
                    e = await asyncio.wait_for(q.get(), timeout=15)
                    yield _sse(e)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            S.subscribers.discard(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


def _sse(e: dict) -> str:
    name = e.get("type") or "message"
    return f"id: {e['seq']}\nevent: {name}\ndata: {json.dumps(e, separators=(',', ':'))}\n\n"


# ----------------------------------------------------------- phone writes ---
def _accepted(cmd: dict) -> JSONResponse:
    return JSONResponse({"queued": True, "id": cmd["id"]}, status_code=202)


@app.post("/api/settings")
async def api_settings_post(req: Request):
    if not _app_auth(req):
        return UNAUTH()
    body = await _json_body(req)
    if not isinstance(body, dict) or not body:
        return JSONResponse({"error": "settings object required"}, status_code=400)
    return _accepted(_queue_command("settings", body))


@app.post("/api/agents/{name}/{op}")
async def api_agent_op(req: Request, name: str, op: str):
    if not _app_auth(req):
        return UNAUTH()
    if op not in ("pause", "resume"):
        return JSONResponse({"error": "op must be pause or resume"}, status_code=404)
    return _accepted(_queue_command(op, {"agent": name}))


@app.post("/api/mode")
async def api_mode(req: Request):
    if not _app_auth(req):
        return UNAUTH()
    body = await _json_body(req) or {}
    mode = str(body.get("mode", "")).upper() if isinstance(body, dict) else ""
    if mode not in ("PAPER", "LIVE"):
        return JSONResponse({"error": "mode must be PAPER or LIVE"}, status_code=400)
    if mode == "LIVE" and body.get("confirm") != "LIVE":
        return JSONResponse({"error": "LIVE requires {\"confirm\":\"LIVE\"}"}, status_code=400)
    return _accepted(_queue_command("mode", {"mode": mode}))


@app.post("/api/push")
async def api_push(req: Request):
    if not _app_auth(req):
        return UNAUTH()
    body = await _json_body(req)
    return _accepted(_queue_command("push", body if isinstance(body, dict) else {}))


@app.post("/api/action")
async def api_action(req: Request):
    if not _app_auth(req):
        return UNAUTH()
    body = await _json_body(req)
    if not isinstance(body, dict) or not body.get("mint"):
        return JSONResponse({"error": "mint required"}, status_code=400)
    action = str(body.get("action", "")).capitalize()
    if action not in ("Bought", "Sold", "Skip"):
        return JSONResponse({"error": "action must be Bought, Sold or Skip"}, status_code=400)
    return _accepted(_queue_command("action", {**body, "action": action}))


# ---------------------------------------------------------------- web app ---
@app.api_route("/api/{rest:path}", methods=["GET", "POST"])
async def api_unknown(req: Request, rest: str):
    return UNAUTH() if not _app_auth(req) else JSONResponse({"error": "not_found"}, status_code=404)


if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
