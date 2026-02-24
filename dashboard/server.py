"""OpenPlanter Dashboard – FastAPI backend.

Provides a web UI for interacting with the OpenPlanter investigation agent:
  - Session management (list, view events/artifacts, resume)
  - Configuration & credential management
  - Data-source script execution
  - Live agent execution via WebSocket
  - Workspace file browsing

NOTE: This server reads configuration/session data directly from the
filesystem rather than importing the agent package, so it runs on any
Python 3.8+ without the 3.10+ requirement of the agent itself.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Resolve project root
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = PROJECT_ROOT
SESSION_ROOT_DIR = ".openplanter"

PROVIDER_DEFAULT_MODELS = {
    "openai": "gpt-5.2",
    "anthropic": "claude-opus-4-6",
    "openrouter": "anthropic/claude-sonnet-4-5",
    "cerebras": "qwen-3-235b-a22b-instruct-2507",
    "ollama": "llama3.2",
}

# ---------------------------------------------------------------------------
# Filesystem-based helpers (no agent import needed)
# ---------------------------------------------------------------------------

def _sessions_dir() -> Path:
    d = WORKSPACE / SESSION_ROOT_DIR / "sessions"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _list_sessions(limit: int = 200) -> List[Dict[str, Any]]:
    sdir = _sessions_dir()
    session_dirs = sorted(
        (p for p in sdir.iterdir() if p.is_dir()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    out = []
    for path in session_dirs[:limit]:
        meta_path = path / "metadata.json"
        meta = {}
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                pass
        out.append({
            "session_id": path.name,
            "path": str(path),
            "created_at": meta.get("created_at"),
            "updated_at": meta.get("updated_at"),
        })
    return out


def _load_state(session_id: str) -> Dict[str, Any]:
    state_path = _sessions_dir() / session_id / "state.json"
    if not state_path.exists():
        return {"session_id": session_id, "external_observations": []}
    try:
        return json.loads(state_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"session_id": session_id, "external_observations": []}


def _events_path(session_id: str) -> Path:
    return _sessions_dir() / session_id / "events.jsonl"


def _artifacts_dir(session_id: str) -> Path:
    return _sessions_dir() / session_id / "artifacts"


def _strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def _parse_env_file(path: Path) -> Dict[str, Optional[str]]:
    """Parse a .env file and return credential-relevant keys."""
    if not path.exists() or not path.is_file():
        return {}
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return {}

    env = {}
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = _strip_quotes(value.strip())
    return env


def _get_credentials() -> Dict[str, Optional[str]]:
    """Gather credentials from env vars, .env files, and credential stores."""
    creds = {
        "openai": None,
        "anthropic": None,
        "openrouter": None,
        "cerebras": None,
        "exa": None,
        "voyage": None,
    }

    # Map of cred key -> (env var names)
    env_map = {
        "openai": ("OPENPLANTER_OPENAI_API_KEY", "OPENAI_API_KEY"),
        "anthropic": ("OPENPLANTER_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"),
        "openrouter": ("OPENPLANTER_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"),
        "cerebras": ("OPENPLANTER_CEREBRAS_API_KEY", "CEREBRAS_API_KEY"),
        "exa": ("OPENPLANTER_EXA_API_KEY", "EXA_API_KEY"),
        "voyage": ("OPENPLANTER_VOYAGE_API_KEY", "VOYAGE_API_KEY"),
    }

    json_key_map = {
        "openai": "openai_api_key",
        "anthropic": "anthropic_api_key",
        "openrouter": "openrouter_api_key",
        "cerebras": "cerebras_api_key",
        "exa": "exa_api_key",
        "voyage": "voyage_api_key",
    }

    # 1. Environment variables
    for name, env_vars in env_map.items():
        for ev in env_vars:
            val = (os.getenv(ev) or "").strip()
            if val:
                creds[name] = val
                break

    # 2. Workspace credential store
    ws_cred_path = WORKSPACE / SESSION_ROOT_DIR / "credentials.json"
    if ws_cred_path.exists():
        try:
            ws_creds = json.loads(ws_cred_path.read_text(encoding="utf-8"))
            for name, jkey in json_key_map.items():
                if not creds[name] and ws_creds.get(jkey):
                    creds[name] = ws_creds[jkey].strip()
        except (json.JSONDecodeError, OSError):
            pass

    # 3. User credential store
    user_cred_path = Path.home() / ".openplanter" / "credentials.json"
    if user_cred_path.exists():
        try:
            user_creds = json.loads(user_cred_path.read_text(encoding="utf-8"))
            for name, jkey in json_key_map.items():
                if not creds[name] and user_creds.get(jkey):
                    creds[name] = user_creds[jkey].strip()
        except (json.JSONDecodeError, OSError):
            pass

    # 4. .env file
    env_path = WORKSPACE / ".env"
    if env_path.exists():
        env_data = _parse_env_file(env_path)
        for name, env_vars in env_map.items():
            if not creds[name]:
                for ev in env_vars:
                    val = (env_data.get(ev) or "").strip()
                    if val:
                        creds[name] = val
                        break

    return creds


def _get_agent_config() -> Dict[str, Any]:
    """Read agent config from environment variables (mirrors AgentConfig.from_env)."""
    return {
        "provider": os.getenv("OPENPLANTER_PROVIDER", "auto").strip().lower() or "auto",
        "model": os.getenv("OPENPLANTER_MODEL", "claude-opus-4-6"),
        "reasoning_effort": os.getenv("OPENPLANTER_REASONING_EFFORT", "high").strip().lower() or None,
        "max_depth": int(os.getenv("OPENPLANTER_MAX_DEPTH", "4")),
        "max_steps_per_call": int(os.getenv("OPENPLANTER_MAX_STEPS", "100")),
        "max_observation_chars": int(os.getenv("OPENPLANTER_MAX_OBS_CHARS", "6000")),
        "command_timeout_sec": int(os.getenv("OPENPLANTER_CMD_TIMEOUT", "45")),
        "recursive": os.getenv("OPENPLANTER_RECURSIVE", "true").strip().lower() in ("1", "true", "yes"),
        "acceptance_criteria": os.getenv("OPENPLANTER_ACCEPTANCE_CRITERIA", "true").strip().lower() in ("1", "true", "yes"),
        "demo": os.getenv("OPENPLANTER_DEMO", "").strip().lower() in ("1", "true", "yes"),
    }


def _load_settings() -> Dict[str, Any]:
    settings_path = WORKSPACE / SESSION_ROOT_DIR / "settings.json"
    if not settings_path.exists():
        return {}
    try:
        return json.loads(settings_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _save_settings(data: Dict[str, Any]) -> None:
    root = WORKSPACE / SESSION_ROOT_DIR
    root.mkdir(parents=True, exist_ok=True)
    settings_path = root / "settings.json"
    # Clean: only keep recognized keys
    valid_keys = {
        "default_model", "default_reasoning_effort",
        "default_model_openai", "default_model_anthropic",
        "default_model_openrouter", "default_model_cerebras",
        "default_model_ollama",
    }
    cleaned = {k: v for k, v in data.items() if k in valid_keys and v}
    settings_path.write_text(json.dumps(cleaned, indent=2), encoding="utf-8")


def _mask_key(key: Optional[str]) -> Optional[str]:
    if not key:
        return None
    if len(key) <= 8:
        return "****"
    return key[:4] + "..." + key[-4:]


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
app = FastAPI(title="OpenPlanter Dashboard")
app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")


# ---------------------------------------------------------------------------
# Routes – UI
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def index():
    html_path = Path(__file__).parent / "static" / "index.html"
    return HTMLResponse(html_path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Routes – Overview / Stats
# ---------------------------------------------------------------------------
@app.get("/api/overview")
async def api_overview():
    sessions = _list_sessions(limit=100)
    creds = _get_credentials()

    # Count scripts
    scripts_dir = WORKSPACE / "scripts"
    fetcher_scripts = sorted(scripts_dir.glob("fetch_*.py")) if scripts_dir.is_dir() else []
    analysis_scripts = [
        p for p in sorted(scripts_dir.glob("*.py"))
        if not p.name.startswith("fetch_") and p.name != "__init__.py" and p.name != "__pycache__"
    ] if scripts_dir.is_dir() else []

    # Count workspace files
    workspace_files = 0
    for _ in WORKSPACE.rglob("*"):
        workspace_files += 1
        if workspace_files > 5000:
            break

    providers_configured = []
    for prov in ("openai", "anthropic", "openrouter", "cerebras", "exa"):
        if creds.get(prov):
            providers_configured.append(prov.capitalize() if prov != "exa" else "Exa")

    return {
        "session_count": len(sessions),
        "recent_sessions": sessions[:5],
        "fetcher_script_count": len(fetcher_scripts),
        "analysis_script_count": len(analysis_scripts),
        "workspace_file_count": workspace_files,
        "providers_configured": providers_configured,
    }


# ---------------------------------------------------------------------------
# Routes – Sessions
# ---------------------------------------------------------------------------
@app.get("/api/sessions")
async def api_sessions():
    sessions = _list_sessions(limit=200)
    enriched = []
    for s in sessions:
        sid = s["session_id"]
        ep = _events_path(sid)
        event_count = 0
        objectives = []
        if ep.exists():
            try:
                lines = ep.read_text(encoding="utf-8").strip().splitlines()
                event_count = len(lines)
                for line in lines:
                    try:
                        evt = json.loads(line)
                        if evt.get("type") == "objective":
                            objectives.append(evt.get("payload", {}).get("text", ""))
                    except json.JSONDecodeError:
                        pass
            except OSError:
                pass

        ad = _artifacts_dir(sid)
        artifact_count = 0
        if ad.exists():
            artifact_count = sum(1 for f in ad.rglob("*") if f.is_file())

        enriched.append({
            **s,
            "event_count": event_count,
            "artifact_count": artifact_count,
            "objectives": objectives,
        })
    return enriched


@app.get("/api/sessions/{session_id}")
async def api_session_detail(session_id: str):
    state = _load_state(session_id)
    ep = _events_path(session_id)
    events = []
    if ep.exists():
        try:
            for line in ep.read_text(encoding="utf-8").strip().splitlines():
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        except OSError:
            pass

    ad = _artifacts_dir(session_id)
    artifacts = []
    if ad.exists():
        for f in sorted(ad.rglob("*")):
            if f.is_file():
                artifacts.append({
                    "path": str(f.relative_to(ad)),
                    "size": f.stat().st_size,
                })

    turn_history = state.get("turn_history", [])

    return {
        "session_id": session_id,
        "state": state,
        "events": events[-500:],
        "event_count": len(events),
        "artifacts": artifacts,
        "turn_history": turn_history,
    }


@app.get("/api/sessions/{session_id}/artifacts/{artifact_path:path}")
async def api_session_artifact(session_id: str, artifact_path: str):
    artifact_file = _artifacts_dir(session_id) / artifact_path
    if not artifact_file.exists():
        return JSONResponse({"error": "Artifact not found"}, status_code=404)
    try:
        content = artifact_file.read_text(encoding="utf-8")
        return {"path": artifact_path, "content": content}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ---------------------------------------------------------------------------
# Routes – Configuration
# ---------------------------------------------------------------------------
@app.get("/api/config")
async def api_config():
    settings = _load_settings()
    creds = _get_credentials()
    cfg = _get_agent_config()

    return {
        "settings": settings,
        "provider_defaults": PROVIDER_DEFAULT_MODELS,
        "credentials": {name: _mask_key(val) for name, val in creds.items()},
        "agent_config": cfg,
    }


@app.post("/api/config/settings")
async def api_update_settings(request: Request):
    body = await request.json()
    current = _load_settings()
    current.update({k: v for k, v in body.items() if v})
    _save_settings(current)
    return {"status": "ok", "settings": current}


# ---------------------------------------------------------------------------
# Routes – Data Sources / Scripts
# ---------------------------------------------------------------------------
@app.get("/api/scripts")
async def api_scripts():
    scripts_dir = WORKSPACE / "scripts"
    if not scripts_dir.is_dir():
        return {"fetchers": [], "analysis": []}

    fetchers = []
    analysis = []
    for p in sorted(scripts_dir.glob("*.py")):
        if p.name.startswith("__"):
            continue

        description = ""
        try:
            lines = p.read_text(encoding="utf-8").splitlines()
            in_docstring = False
            for line in lines[:30]:
                stripped = line.strip()
                if not in_docstring and (stripped.startswith('"""') or stripped.startswith("'''")):
                    # Single-line docstring
                    if stripped.count('"""') >= 2 or stripped.count("'''") >= 2:
                        description = stripped.strip("\"'").strip()
                        break
                    in_docstring = True
                    description = stripped.lstrip("\"'").strip()
                    continue
                elif in_docstring:
                    if '"""' in stripped or "'''" in stripped:
                        description += " " + stripped.rstrip("\"'").strip()
                        break
                    description += " " + stripped
                    continue
                elif stripped.startswith("#") and not stripped.startswith("#!"):
                    description = stripped.lstrip("# ").strip()
                    break
        except OSError:
            pass

        entry = {
            "name": p.name,
            "path": str(p.relative_to(WORKSPACE)),
            "size": p.stat().st_size,
            "description": description[:200],
        }
        if p.name.startswith("fetch_"):
            fetchers.append(entry)
        else:
            analysis.append(entry)

    return {"fetchers": fetchers, "analysis": analysis}


# Track running script processes
_running_scripts: Dict[str, Dict] = {}
_script_lock = threading.Lock()


@app.post("/api/scripts/run")
async def api_run_script(request: Request):
    body = await request.json()
    script_name = body.get("script", "")
    args = body.get("args", [])
    script_path = WORKSPACE / "scripts" / script_name

    if not script_path.exists() or not script_path.name.endswith(".py"):
        return JSONResponse({"error": "Script not found"}, status_code=404)

    run_id = "{}-{}".format(script_name, int(time.time()))

    def _run():
        try:
            result = subprocess.run(
                [sys.executable, str(script_path)] + args,
                capture_output=True,
                text=True,
                timeout=300,
                cwd=str(WORKSPACE),
            )
            with _script_lock:
                _running_scripts[run_id] = {
                    "status": "completed" if result.returncode == 0 else "failed",
                    "returncode": result.returncode,
                    "stdout": result.stdout[-10000:] if result.stdout else "",
                    "stderr": result.stderr[-5000:] if result.stderr else "",
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                }
        except subprocess.TimeoutExpired:
            with _script_lock:
                _running_scripts[run_id] = {
                    "status": "timeout",
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                }
        except Exception as e:
            with _script_lock:
                _running_scripts[run_id] = {
                    "status": "error",
                    "error": str(e),
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                }

    with _script_lock:
        _running_scripts[run_id] = {
            "status": "running",
            "script": script_name,
            "started_at": datetime.now(timezone.utc).isoformat(),
        }

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return {"run_id": run_id, "status": "running"}


@app.get("/api/scripts/status/{run_id}")
async def api_script_status(run_id: str):
    with _script_lock:
        info = _running_scripts.get(run_id)
    if info is None:
        return JSONResponse({"error": "Run not found"}, status_code=404)
    return info


# ---------------------------------------------------------------------------
# Routes – File Browser
# ---------------------------------------------------------------------------
@app.get("/api/files")
async def api_files(path: str = ""):
    target = (WORKSPACE / path).resolve()
    if not str(target).startswith(str(WORKSPACE)):
        return JSONResponse({"error": "Access denied"}, status_code=403)
    if not target.exists():
        return JSONResponse({"error": "Path not found"}, status_code=404)

    if target.is_file():
        try:
            content = target.read_text(encoding="utf-8")
            if len(content) > 100_000:
                content = content[:100_000] + "\n\n... (truncated)"
            return {
                "type": "file",
                "path": str(target.relative_to(WORKSPACE)),
                "name": target.name,
                "size": target.stat().st_size,
                "content": content,
            }
        except UnicodeDecodeError:
            return {
                "type": "file",
                "path": str(target.relative_to(WORKSPACE)),
                "name": target.name,
                "size": target.stat().st_size,
                "content": "(binary file)",
            }

    entries = []
    try:
        for child in sorted(target.iterdir()):
            if child.name.startswith(".") and child.name not in (".openplanter",):
                continue
            if child.name == "__pycache__":
                continue
            entry = {
                "name": child.name,
                "path": str(child.relative_to(WORKSPACE)),
                "is_dir": child.is_dir(),
            }
            if child.is_file():
                entry["size"] = child.stat().st_size
            entries.append(entry)
    except PermissionError:
        pass

    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))

    return {
        "type": "directory",
        "path": str(target.relative_to(WORKSPACE)),
        "entries": entries,
    }


# ---------------------------------------------------------------------------
# Routes – Agent Execution (WebSocket)
# ---------------------------------------------------------------------------
@app.websocket("/ws/agent")
async def ws_agent(websocket: WebSocket):
    await websocket.accept()
    process = None
    try:
        data = await websocket.receive_json()
        objective = data.get("objective", "").strip()
        if not objective:
            await websocket.send_json({"type": "error", "message": "No objective provided"})
            return

        provider = data.get("provider", "auto")
        model = data.get("model", "")
        max_steps = data.get("max_steps", 100)
        max_depth = data.get("max_depth", 4)
        reasoning_effort = data.get("reasoning_effort", "high")

        await websocket.send_json({"type": "status", "message": "Initializing agent..."})

        cmd = [
            sys.executable, "-m", "agent",
            "--workspace", str(WORKSPACE),
            "--headless",
            "--task", objective,
            "--max-steps", str(max_steps),
            "--max-depth", str(max_depth),
        ]
        if provider != "auto":
            cmd.extend(["--provider", provider])
        if model:
            cmd.extend(["--model", model])
        if reasoning_effort:
            cmd.extend(["--reasoning-effort", reasoning_effort])

        await websocket.send_json({
            "type": "status",
            "message": "Launching agent with model={}, provider={}...".format(model or "default", provider),
        })

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(WORKSPACE),
            env=dict(os.environ, PYTHONUNBUFFERED="1"),
        )

        async def read_stream(stream, stream_type):
            while True:
                line = await stream.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").rstrip()
                if text:
                    try:
                        await websocket.send_json({
                            "type": stream_type,
                            "message": text,
                        })
                    except Exception:
                        break

        await asyncio.gather(
            read_stream(process.stdout, "stdout"),
            read_stream(process.stderr, "stderr"),
        )

        returncode = await process.wait()
        await websocket.send_json({
            "type": "complete",
            "returncode": returncode,
            "message": "Agent finished with exit code {}".format(returncode),
        })

    except WebSocketDisconnect:
        if process and process.returncode is None:
            try:
                process.terminate()
            except Exception:
                pass
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Routes – Wiki
# ---------------------------------------------------------------------------
@app.get("/api/wiki")
async def api_wiki():
    wiki_dir = WORKSPACE / "wiki"
    if not wiki_dir.is_dir():
        return {"pages": []}
    pages = []
    for f in sorted(wiki_dir.rglob("*.md")):
        pages.append({
            "name": f.stem,
            "path": str(f.relative_to(WORKSPACE)),
            "size": f.stat().st_size,
        })
    return {"pages": pages}


@app.get("/api/wiki/{page_path:path}")
async def api_wiki_page(page_path: str):
    wiki_file = WORKSPACE / page_path
    if not wiki_file.exists():
        return JSONResponse({"error": "Page not found"}, status_code=404)
    try:
        content = wiki_file.read_text(encoding="utf-8")
        return {"path": page_path, "content": content}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    import uvicorn
    port = int(os.getenv("OPENPLANTER_DASHBOARD_PORT", "8420"))
    print("\n  🌱 OpenPlanter Dashboard starting on http://localhost:{}\n".format(port))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    main()
