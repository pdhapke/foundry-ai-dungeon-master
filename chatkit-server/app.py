"""Official ChatKit protocol sidecar. Only the authenticated loopback gateway may call it."""
import asyncio
import base64
import hmac
import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from agents import Agent, Runner, RunConfig, ModelSettings, function_tool
import httpx2 as httpx
from agents.models.openai_responses import OpenAIResponsesModel
from chatkit.agents import AgentContext, simple_to_agent_input, stream_agent_response
from chatkit.server import ChatKitServer, StreamingResult
from chatkit.store import Store, NotFoundError
from chatkit.types import ThreadMetadata, ThreadItem, Page, HiddenContextItem
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import Response, StreamingResponse
from openai import AsyncOpenAI
from pydantic import TypeAdapter
from dm_prompt import DM_PROMPT


class SqliteStore(Store[dict]):
    def __init__(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, body TEXT NOT NULL)")
        self.db.commit()

    @staticmethod
    def owner(context):
        return json.dumps([context["worldId"], context["userId"]])

    async def load_thread(self, thread_id, context):
        row = self.db.execute("SELECT body FROM threads WHERE id=? AND owner=?", (thread_id, self.owner(context))).fetchone()
        if not row:
            raise NotFoundError("Conversation not found")
        return ThreadMetadata.model_validate_json(row[0])

    async def save_thread(self, thread, context):
        existing = self.db.execute("SELECT owner FROM threads WHERE id=?", (thread.id,)).fetchone()
        if existing and existing[0] != self.owner(context):
            raise NotFoundError("Conversation not found")
        self.db.execute("INSERT INTO threads VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", (thread.id, self.owner(context), thread.model_dump_json()))
        self.db.commit()

    async def load_threads(self, limit, after, order, context):
        rows = self.db.execute("SELECT body FROM threads WHERE owner=? ORDER BY rowid " + ("DESC" if order == "desc" else "ASC"), (self.owner(context),)).fetchall()
        return self.page([ThreadMetadata.model_validate_json(r[0]) for r in rows], after, limit)

    @staticmethod
    def page(values, after, limit):
        if after:
            index = next((i for i, v in enumerate(values) if v.id == after), None)
            values = values[index + 1:] if index is not None else []
        selected = values[:limit]
        return Page(data=selected, has_more=len(values) > limit, after=selected[-1].id if selected else None)

    async def load_thread_items(self, thread_id, after, limit, order, context):
        await self.load_thread(thread_id, context)
        rows = self.db.execute("SELECT body FROM items WHERE thread_id=? ORDER BY rowid " + ("DESC" if order == "desc" else "ASC"), (thread_id,)).fetchall()
        return self.page([TypeAdapter(ThreadItem).validate_json(r[0]) for r in rows], after, limit)

    async def save_item(self, thread_id, item, context):
        await self.load_thread(thread_id, context)
        existing = self.db.execute("SELECT thread_id FROM items WHERE id=?", (item.id,)).fetchone()
        if item.thread_id != thread_id or (existing and existing[0] != thread_id):
            raise NotFoundError("Item not found")
        self.db.execute("INSERT INTO items VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", (item.id, thread_id, item.model_dump_json()))
        self.db.commit()

    async def add_thread_item(self, thread_id, item, context):
        await self.save_item(thread_id, item, context)

    async def load_item(self, thread_id, item_id, context):
        await self.load_thread(thread_id, context)
        row = self.db.execute("SELECT body FROM items WHERE id=? AND thread_id=?", (item_id, thread_id)).fetchone()
        if not row:
            raise NotFoundError("Item not found")
        return TypeAdapter(ThreadItem).validate_json(row[0])

    async def delete_thread(self, thread_id, context):
        await self.load_thread(thread_id, context)
        self.db.execute("DELETE FROM items WHERE thread_id=?", (thread_id,))
        self.db.execute("DELETE FROM threads WHERE id=?", (thread_id,))
        self.db.commit()

    async def delete_thread_item(self, thread_id, item_id, context):
        await self.load_thread(thread_id, context)
        self.db.execute("DELETE FROM items WHERE id=? AND thread_id=?", (item_id, thread_id))
        self.db.commit()

    async def save_attachment(self, attachment, context):
        raise NotFoundError("Attachments are disabled")

    async def load_attachment(self, attachment_id, context):
        raise NotFoundError("Attachments are disabled")

    async def delete_attachment(self, attachment_id, context):
        raise NotFoundError("Attachments are disabled")


async def read_foundry(context, operation, arguments=None):
    """Only Node-issued response capabilities may access the bounded read adapter."""
    url = os.environ.get("AI_DM_CHATKIT_READ_URL", "")
    target = urlparse(url)
    if target.scheme != "http" or target.hostname != "127.0.0.1" or target.username or target.password or target.path != "/internal/chatkit/read" or target.query or target.fragment or not context.get("readRun"):
        return {"ok": False, "error": {"code": "READ_UNAVAILABLE", "message": "Authorized Foundry reads unavailable"}}
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            response = await client.post(url, headers={"x-chatkit-read-run": context["readRun"], "x-chatkit-secret": context["internalSecret"], "x-chatkit-world": context["worldId"], "x-chatkit-user": context["userId"], "x-chatkit-thread": context["threadId"]}, json={"operation": operation, "arguments": arguments or {}})
            if response.status_code != 200 or len(response.content) > 32768:
                return {"ok": False, "error": {"code": "READ_UNAVAILABLE", "message": "Authorized Foundry read failed"}}
            return response.json()
    except (httpx.HTTPError, ValueError, KeyError):
        return {"ok": False, "error": {"code": "READ_UNAVAILABLE", "message": "Authorized Foundry read failed"}}


def build_agent(context):
    @function_tool
    async def foundry_roll_dice(action_id: str, formula: str) -> str:
        """Automatic native dice, no chat posting. Stable action_id for retries. Formula NdS plus optional integer modifier; N 1..99, S 4/6/8/10/12/20/100. Only completed receipt is an actual roll; uncertain must never be repeated under a new ID."""
        return json.dumps(await read_foundry(context, "native_roll", {"actionId": action_id, "formula": formula}))

    @function_tool
    async def foundry_propose_session_note(action_id: str, title: str, text: str) -> str:
        """Propose one private GM session journal (title max120, plain text max4000). No mutation until user explicitly approves in Review native actions. Stable action_id; pending is not success. Actor HP/doors/inventory/arbitrary actions are unavailable."""
        return json.dumps(await read_foundry(context, "native_propose_note", {"actionId": action_id, "title": title, "text": text}))

    @function_tool
    async def campaign_search(query: str) -> str:
        """Search active-world Markdown and retrieve bounded, hashed, attributed sections; query max 256 characters."""
        return json.dumps(await read_foundry(context, "campaign", {"query": query}))

    @function_tool
    async def campaign_validate_sources() -> str:
        """Read-only bounded Markdown parser validation; no filesystem writes, shell or external scripts."""
        return json.dumps(await read_foundry(context, "campaign_validate_sources"))

    @function_tool
    async def foundry_read_scene() -> str:
        """Read a bounded current-scene summary and its token/actor identifiers."""
        return json.dumps(await read_foundry(context, "scene"))

    @function_tool
    async def foundry_read_actor(id: str) -> str:
        """Read an actor name/type by an actor identifier present in the current scene."""
        return json.dumps(await read_foundry(context, "actor", {"id": id}))

    return Agent(
        name="Foundry assistant",
        instructions=DM_PROMPT,
        model=OpenAIResponsesModel(model=context["model"], openai_client=AsyncOpenAI(api_key=context["apiKey"], max_retries=0)),
        model_settings=ModelSettings(store=False),
        tools=[foundry_read_scene, foundry_read_actor, campaign_search, campaign_validate_sources, foundry_roll_dice, foundry_propose_session_note] if context.get("readRun") else [],
    )


def retrieval_query(agent_input):
    """Extract only the latest prompt; action hints do not supply retrieval authority."""
    if not agent_input:
        return ""
    content = agent_input[-1].get("content", "")
    if isinstance(content, list):
        content = " ".join(part.get("text", "") for part in content if isinstance(part, dict))
    if not isinstance(content, str):
        return ""
    try:
        payload = json.loads(content)
        if isinstance(payload, dict) and isinstance(payload.get("foundry_application_request"), str):
            content = payload["foundry_application_request"]
    except ValueError:
        pass
    return content[:256]


class FoundryChatKit(ChatKitServer[dict]):
    async def respond(self, thread, input, context):
        context = {**context, "threadId": thread.id}
        items = await self.store.load_thread_items(thread.id, None, 20, "desc", context)
        agent_context = AgentContext(thread=thread, store=self.store, request_context=context)
        agent_input = await simple_to_agent_input(list(reversed(items.data)))
        # Preserve recent complete messages under a context budget; storage retains full history.
        while len(agent_input) > 1 and len(json.dumps(agent_input, ensure_ascii=False)) > 40000:
            agent_input.pop(0)
        if context.get("readRun"):
            # The same authoritative builder runs for typed messages and custom actions.
            query = retrieval_query(agent_input)
            snapshot = await read_foundry(context, "context", {"query": query})
            agent_input.append({"role": "user", "content": json.dumps({"untrusted_authorized_foundry_snapshot": snapshot})})
        result = Runner.run_streamed(build_agent(context), agent_input, context=agent_context, run_config=RunConfig(tracing_disabled=True), max_turns=8)
        try:
            async for event in stream_agent_response(agent_context, result):
                yield event
        finally:
            result.cancel()

    async def action(self, thread, action, sender, context):
        payload = validate_action(action.type, action.payload)
        observation = HiddenContextItem(id=self.store.generate_item_id("message", thread, context), thread_id=thread.id, created_at=datetime.now(timezone.utc), content=json.dumps({"foundry_application_request": payload["prompt"], "untrusted_game_context": payload["context"]}))
        await self.store.add_thread_item(thread.id, observation, context)
        async for event in self.respond(thread, None, context):
            yield event


def validate_action(action_type, payload):
    if action_type != "foundry.context-response" or not isinstance(payload, dict):
        raise HTTPException(400, "Unsupported Foundry action")
    if set(payload) - {"requestId", "prompt", "context"}:
        raise HTTPException(400, "Unsupported action fields")
    prompt, request_id, context = payload.get("prompt"), payload.get("requestId"), payload.get("context", {})
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 4000 or not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
        raise HTTPException(400, "Invalid prompt or request ID")
    if not isinstance(context, dict) or set(context) - {"sceneId", "sceneName", "controlledTokenIds", "controlledActorIds", "targetTokenIds", "combatId", "round", "turn"}:
        raise HTTPException(400, "Unsupported game context")
    for key, value in context.items():
        if key.endswith("Ids"):
            valid = isinstance(value, list) and len(value) <= 20 and all(isinstance(v, str) and len(v) <= 128 for v in value)
        elif key in {"round", "turn"}:
            valid = value is None or (type(value) is int and 0 <= value <= 100000)
        else:
            valid = value is None or (isinstance(value, str) and len(value) <= 200)
        if not valid:
            raise HTTPException(400, "Invalid game context field")
    return {"requestId": request_id, "prompt": prompt, "context": context}


def create_app(store=None, server=None, secret=None):
    app = FastAPI()
    secret = secret or os.environ.get("AI_DM_CHATKIT_INTERNAL_SECRET", "")
    store = store or SqliteStore(os.environ.get("AI_DM_CHATKIT_DATABASE_PATH", ".runtime/chatkit.sqlite"))
    server = server or FoundryChatKit(store)
    busy, recent = set(), {}

    def authenticate(request):
        supplied = request.headers.get("x-chatkit-secret", "")
        if not secret or not hmac.compare_digest(secret, supplied):
            raise HTTPException(401, "Gateway authentication required")
        try:
            principal = json.loads(base64.b64decode(request.headers["x-chatkit-principal"]))
            if principal.get("isGm") is not True or not all(isinstance(principal.get(k), str) and 0 < len(principal[k]) <= 128 for k in ("worldId", "userId")):
                raise ValueError()
            return {**principal, "apiKey": request.headers.get("x-chatkit-api-key", ""), "model": request.headers.get("x-chatkit-model", ""), "readRun": request.headers.get("x-chatkit-read-run", ""), "internalSecret": secret}
        except Exception:
            raise HTTPException(403, "Invalid gateway principal") from None

    @app.get("/health")
    async def health():
        return {"status": "ready", "protocol": "openai-chatkit"}

    @app.post("/chatkit/thread")
    async def bootstrap(request: Request):
        context = authenticate(request)
        thread = ThreadMetadata(id=store.generate_thread_id(context), created_at=datetime.now(timezone.utc))
        await store.save_thread(thread, context)
        return {"threadId": thread.id}

    @app.post("/chatkit")
    async def endpoint(request: Request):
        context = authenticate(request)
        raw = await request.body()
        if len(raw) > 32768:
            raise HTTPException(413, "ChatKit request is too large")
        try:
            body = json.loads(raw)
        except Exception:
            raise HTTPException(400, "Invalid ChatKit request") from None
        if not isinstance(body, dict) or not isinstance(body.get("params", {}), dict):
            raise HTTPException(400, "Invalid ChatKit request")
        operation, params = body.get("type"), body.get("params", {})
        thread_id = params.get("thread_id")
        if thread_id:
            try:
                await store.load_thread(thread_id, context)
            except NotFoundError:
                raise HTTPException(404, "Conversation not found") from None
        inference = operation in {"threads.create", "threads.add_user_message", "threads.custom_action", "threads.retry_after_item"}
        key = (store.owner(context), thread_id or "new")
        request_id = None
        if operation == "threads.custom_action":
            action = params.get("action", {})
            if not isinstance(action, dict):
                raise HTTPException(400, "Invalid Foundry action")
            payload = validate_action(action.get("type"), action.get("payload"))
            request_id = (key, payload["requestId"])
        if inference:
            if not context["apiKey"] or not context["model"]:
                raise HTTPException(503, "Authorized OpenAI credentials are unavailable")
            if key in busy:
                raise HTTPException(409, "A response is already running")
            now = time.monotonic()
            for old in [k for k, v in recent.items() if now - v > 300]:
                recent.pop(old)
            if request_id in recent:
                raise HTTPException(409, "This Foundry trigger was already processed")
            if request_id:
                if len(recent) >= 1000:
                    recent.pop(next(iter(recent)))
                recent[request_id] = now
            busy.add(key)
        try:
            result = await server.process(raw, context)
        except Exception:
            busy.discard(key)
            raise HTTPException(400, "Invalid or unsupported ChatKit request") from None
        if isinstance(result, StreamingResult):
            async def stream():
                try:
                    async for event in result:
                        if await request.is_disconnected():
                            break
                        yield event
                finally:
                    busy.discard(key)
                    await result.json_events.aclose()
            return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})
        busy.discard(key)
        return Response(content=result.json, media_type="application/json")

    return app


app = create_app()
