# desk-relay

Thin FastAPI relay between an outbound-only trading desk and its iPhone web app.
State lives in memory only; the desk re-pushes snapshots every few seconds.

Required env vars (set in the host's dashboard, never committed): `APP_TOKEN`, `DESK_KEY`.

Run: `uvicorn relay:app --host 0.0.0.0 --port $PORT`
