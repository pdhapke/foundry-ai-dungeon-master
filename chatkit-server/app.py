"""Official ChatKit protocol sidecar. Only the authenticated loopback gateway may call it."""
import asyncio
import base64
import hmac
import json
import os
import re
import hashlib
import sqlite3
import time
import math
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from agents import Agent, Runner, RunConfig, ModelSettings, RunHooks, function_tool
from agents.agent import ToolsToFinalOutputResult
from agents.exceptions import MaxTurnsExceeded
from openai.types.shared import Reasoning
import httpx2 as httpx
from agents.models.openai_responses import OpenAIResponsesModel
from chatkit.agents import AgentContext, simple_to_agent_input, stream_agent_response, ThreadItemConverter
from chatkit.server import ChatKitServer, StreamingResult
from chatkit.store import Store, NotFoundError
from chatkit.types import ThreadMetadata, ThreadItem, Page, HiddenContextItem, AssistantMessageItem, AssistantMessageContent, ThreadItemDoneEvent, ErrorEvent
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import Response, StreamingResponse
from openai import AsyncOpenAI
from pydantic import TypeAdapter, BaseModel, ConfigDict, Field, field_validator
from jsonschema import validate as validate_json_schema, ValidationError as SchemaValidationError
from dm_prompt import DM_PROMPT, DM_PROMPT_VERSION
from preparation.router import create_preparation_router
from working_context import assemble_input, validate_exchanges, ContextCapacityError, MODEL_OUTPUT_TOKENS, MAINTENANCE_REQUEST
import working_context as loaded_working_context
import player_observation as loaded_player_observation
from player_observation import ACTION as PLAYER_OBSERVATION_ACTION, validate_player_action, project_observation, project_surroundings, PlayerObservationStore

STARTUP_CODE_DIGEST = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
PLAYER_OBSERVATION_STARTUP_DIGEST = hashlib.sha256(Path(loaded_player_observation.__file__).read_bytes()).hexdigest()
RECIPE_ROOT = Path(__file__).parent / "recipes"
RECIPE_IDS = {"start-combat", "combat-round", "surroundings", "battlemap"}
PRIVATE_DATABASE_DEFAULT = str(Path(__file__).resolve().parents[5] / ".runtime" / "foundry-ai-dungeon-master" / "chatkit.sqlite")
WORKING_CONTEXT_STARTUP_DIGEST = hashlib.sha256(Path(loaded_working_context.__file__).read_bytes()).hexdigest()
RECIPE_STARTUP_BYTES = {name: (RECIPE_ROOT / name).read_bytes() for name in ["index.json"] + [recipe + ".json" for recipe in sorted(RECIPE_IDS)]}
RECIPE_MANIFEST_STARTUP_DIGEST = hashlib.sha256(b"".join(RECIPE_STARTUP_BYTES.values())).hexdigest()

def recipe_resource(recipe_id):
    if recipe_id not in RECIPE_IDS:
        raise ValueError("Unknown packaged DM recipe")
    content = RECIPE_STARTUP_BYTES[recipe_id + ".json"].decode("utf-8")
    if len(content.encode()) > 8192:
        raise ValueError("Packaged recipe exceeds context bound")
    return json.loads(content)

def prepared_instructions():
    index = RECIPE_STARTUP_BYTES["index.json"].decode("utf-8")
    if len(index.encode()) > 4096:
        raise ContextCapacityError("Packaged recipe index exceeds bound")
    contracts = {
        "start-combat": "Scene/participants; reuse encounter/add missing only; native missing initiative/player preference; stop for player rolls; start once; confirmed order/turn. No wrapper.",
        "combat-round": "Live round boundary/native NPCs; stop at player/reaction/choice/uncertainty; preserve progress, no replay/player skip. No coordinator.",
        "surroundings": "Native vision immediate; connected owned-token perception/no GM fallback; both detection directions, trap detection/activation/effects; no engine.",
        "battlemap": "Forest: read recipe; search ai_dm_preparation_workflow. mcp-test/TV/Digital Tabletop. Generation approval; browser review/apply/display; TV/ruler.",
    }
    compact = [{"id": r["id"], "status": r["status"], "entry": r["entry_point"], "contract": contracts[r["id"]]} for r in json.loads(index)["recipes"]]
    return DM_PROMPT + "\nTrusted recipes " + json.loads(index)["version"] + ":" + json.dumps(compact, separators=(",", ":"))


def compact_schema_annotations(value):
    """Strip schema labels only, preserving names and literal default/enum data."""
    if not isinstance(value, dict):
        return value
    result = {}
    for key, item in value.items():
        if key == "title":
            continue
        if key in {"properties", "patternProperties", "$defs", "definitions", "dependentSchemas"}:
            result[key] = {name: compact_schema_annotations(schema) for name, schema in item.items()}
        elif key in {"anyOf", "allOf", "oneOf", "prefixItems"}:
            result[key] = [compact_schema_annotations(schema) for schema in item]
        elif key in {"items", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedProperties", "unevaluatedItems"}:
            result[key] = compact_schema_annotations(item)
        else:
            # enum/const/default/examples are data, not schemas, even with 'title'.
            result[key] = item
    return result


def model_context_window(model):
    # Exact verified model ID; do not infer capacities from a prefix or alias.
    # https://developers.openai.com/api/docs/models/gpt-5.6-sol
    # The auth catalog adapter currently supplies no trusted context capacity
    # to this resolver.
    # Unknown models retain the conservative fallback until separately verified.
    if model == "gpt-5.6-sol":
        return 1_050_000
    return 65536 if model in {"gpt-5.4", "gpt-5.4-2026-03-05"} else 32768


def agent_tool_schemas(agent):
    return [{"name": t.name, "description": t.description, "parameters": t.params_json_schema} for t in agent.tools]


def context_admission(model):
    agent = build_agent({"model": model, "apiKey": "offline-admission-placeholder", "readRun": "admission"})
    window = model_context_window(model)
    try:
        _, budget = assemble_input(agent.instructions, [], window=window, tool_schemas=agent_tool_schemas(agent))
    except ContextCapacityError:
        return {"admissible": False, "reason": "Permanent context exceeds selected model admission budget"}
    ceiling = window - budget["reservedToolsAndOutput"]
    remaining = ceiling - budget["tokenUpperBound"]
    return {"admissible": remaining >= 4096, "permanentTokenUpperBound": budget["tokenUpperBound"],
            "inputCeiling": ceiling, "reservedToolsAndOutput": budget["reservedToolsAndOutput"],
            "remainingInputUnits": remaining,
            "reason": "Full conversation and snapshot are checked again before every model request"}



class SqliteStore(Store[dict]):
    def __init__(self, path: str):
        public_data = Path(__file__).resolve().parents[5] / "Data" / "Data"
        if path != ":memory:" and Path(path).resolve().is_relative_to(public_data.resolve()):
            raise ValueError("Conversation database must be outside Foundry static Data storage")
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        legacy = os.environ.get("AI_DM_CHATKIT_LEGACY_DATABASE_PATH")
        destination_empty = not Path(path).exists()
        if path != ":memory:" and not destination_empty:
            probe = sqlite3.connect(path)
            try:
                tables = {row[0] for row in probe.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                destination_empty = tables <= {"threads", "items", "player_threads", "memory_summaries", "memory_summary_versions", "item_revisions", "acceptance_budgets"} and all(probe.execute('SELECT COUNT(*) FROM "' + table + '"').fetchone()[0] == 0 for table in tables)
            finally:
                probe.close()
        if path != ":memory:" and destination_empty and legacy and Path(legacy).is_file() and Path(legacy).resolve() != Path(path).resolve():
            # SQLite's backup API includes committed WAL data; source is untouched.
            source = sqlite3.connect(Path(legacy).resolve().as_uri() + "?mode=ro", uri=True)
            target = sqlite3.connect(path)
            try:
                source.backup(target)
                target.execute("CREATE TABLE IF NOT EXISTS storage_migration (source_hash TEXT NOT NULL, migrated_at TEXT NOT NULL)")
                target.execute("INSERT INTO storage_migration VALUES(?,?)", (hashlib.sha256(str(Path(legacy).resolve()).encode()).hexdigest(), datetime.now(timezone.utc).isoformat()))
                target.commit()
            finally:
                source.close()
                target.close()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, body TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS player_threads (thread_id TEXT PRIMARY KEY, selection TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS memory_summaries (thread_id TEXT PRIMARY KEY, version INTEGER NOT NULL, revision TEXT NOT NULL, watermark INTEGER NOT NULL, body TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS item_revisions (thread_id TEXT NOT NULL, item_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(thread_id,item_id,body))")
        self.db.execute("CREATE TABLE IF NOT EXISTS memory_summary_versions (thread_id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(thread_id,version))")
        self.db.execute("CREATE TABLE IF NOT EXISTS acceptance_budgets (scope TEXT PRIMARY KEY, consumed INTEGER NOT NULL)")
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

    async def memory_revision(self, thread_id, context):
        await self.load_thread(thread_id, context)
        rows = self.db.execute("SELECT rowid,id,body FROM items WHERE thread_id=? ORDER BY rowid", (thread_id,)).fetchall()
        return hashlib.sha256(json.dumps(rows).encode()).hexdigest(), (rows[-1][0] if rows else 0)

    async def publish_summary(self, thread_id, context, *, expected_revision, expected_version, watermark, text, sources):
        """Internal maintenance primitive: no generation and no browser write route.

        Caller must supply approved maintenance output; optimistic publication
        preserves last valid summary on delay/failure. Source IDs retain evidence.
        """
        revision, latest = await self.memory_revision(thread_id, context)
        old = self.db.execute("SELECT version,watermark FROM memory_summaries WHERE thread_id=?", (thread_id,)).fetchone()
        version = old[0] if old else 0
        ids = {r[0]: r[1] for r in self.db.execute("SELECT id,rowid FROM items WHERE thread_id=?", (thread_id,))}
        if revision != expected_revision or version != expected_version:
            return False
        if not isinstance(text, str) or not text or len(text.encode()) > 8192 or type(watermark) is not int or watermark < (old[1] if old else 1) or watermark > latest:
            raise ValueError("Invalid summary coverage")
        if not sources or any(source not in ids or ids[source] > watermark for source in sources):
            raise ValueError("Summary requires covered source messages")
        covered = self.db.execute("SELECT rowid,id,body FROM items WHERE thread_id=? AND rowid<=? ORDER BY rowid", (thread_id, watermark)).fetchall()
        validate_exchanges(await ReceiptHistoryConverter().to_agent_input([TypeAdapter(ThreadItem).validate_json(row[2]) for row in covered]))
        covered_revision = hashlib.sha256(json.dumps(covered).encode()).hexdigest()
        # Converter may yield. Recheck immediately before synchronous publication.
        self.db.execute("BEGIN IMMEDIATE")
        revision_now, _ = await self.memory_revision(thread_id, context)
        version_now = self.db.execute("SELECT version FROM memory_summaries WHERE thread_id=?", (thread_id,)).fetchone()
        if revision_now != expected_revision or (version_now[0] if version_now else 0) != expected_version:
            self.db.rollback()
            return False
        body = json.dumps({"version": version + 1, "text": text, "sources": sources, "coverageWatermark": watermark, "visibility": "gm-only"})
        self.db.execute("INSERT INTO memory_summary_versions VALUES(?,?,?)", (thread_id, version+1, body))
        self.db.execute("INSERT INTO memory_summaries VALUES(?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET version=excluded.version,revision=excluded.revision,watermark=excluded.watermark,body=excluded.body", (thread_id, version+1, covered_revision, watermark, body))
        self.db.commit()
        return True

    async def working_history(self, thread_id, context):
        await self.load_thread(thread_id, context)
        summary = self.db.execute("SELECT watermark,body,revision FROM memory_summaries WHERE thread_id=?", (thread_id,)).fetchone()
        if summary:
            covered = self.db.execute("SELECT rowid,id,body FROM items WHERE thread_id=? AND rowid<=? ORDER BY rowid", (thread_id, summary[0])).fetchall()
            if hashlib.sha256(json.dumps(covered).encode()).hexdigest() != summary[2]:
                # Original evidence corrections invalidate coverage, never erase it.
                summary = None
        rows = self.db.execute("SELECT body FROM items WHERE thread_id=? AND rowid>? ORDER BY rowid LIMIT 5001", (thread_id, summary[0] if summary else 0)).fetchall()
        if len(rows) > 5000:
            raise ContextCapacityError(MAINTENANCE_REQUEST)
        return [TypeAdapter(ThreadItem).validate_json(row[0]) for row in rows], json.loads(summary[1]) if summary else None

    async def search_history(self, thread_id, context, query):
        await self.load_thread(thread_id, context)
        if not isinstance(query, str) or not 2 <= len(query) <= 128:
            raise ValueError("History query must be 2..128 characters")
        # Literal bounded matching, no SQL wildcard authority or broad world scan.
        rows = self.db.execute("SELECT id,body FROM items WHERE thread_id=? AND instr(lower(body),lower(?))>0 ORDER BY rowid DESC LIMIT 5", (thread_id, query)).fetchall()
        return {"authority": "untrusted historical evidence; proposals and attempts are not canon or confirmed outcomes", "visibility": "gm-only", "results": [{"sourceMessageId": row[0], "threadId": thread_id, "excerpt": row[1][:1024], "revision": hashlib.sha256(row[1].encode()).hexdigest()} for row in rows]}

    def consume_acceptance_request(self, scope, ceiling):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute("SELECT consumed FROM acceptance_budgets WHERE scope=?", (scope,)).fetchone()
            consumed = row[0] if row else 0
            if consumed >= ceiling:
                raise ContextCapacityError("Approved acceptance model-request allowance exhausted; no automatic retry")
            self.db.execute("INSERT INTO acceptance_budgets VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET consumed=excluded.consumed", (scope, consumed + 1))
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    async def save_item(self, thread_id, item, context):
        await self.load_thread(thread_id, context)
        existing = self.db.execute("SELECT thread_id FROM items WHERE id=?", (item.id,)).fetchone()
        if item.thread_id != thread_id or (existing and existing[0] != thread_id):
            raise NotFoundError("Item not found")
        prior = self.db.execute("SELECT body FROM items WHERE id=? AND thread_id=?", (item.id, thread_id)).fetchone()
        if prior and prior[0] != item.model_dump_json():
            self.db.execute("INSERT OR IGNORE INTO item_revisions VALUES(?,?,?)", (thread_id, item.id, prior[0]))
        self.db.execute("INSERT INTO items VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", (item.id, thread_id, item.model_dump_json()))
        self.db.commit()
        trace(context, "store-item-commit-complete", itemHash=diagnostic_hash(item.id))

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
    if context.get("_narrationOnly") and operation != "release_mutation_capability":
        return {"ok": False, "error": {"code": "NARRATION_ONLY", "message": "This completed run cannot read or mutate Foundry again"}}
    url = os.environ.get("AI_DM_CHATKIT_READ_URL", "")
    target = urlparse(url)
    if target.scheme != "http" or target.hostname != "127.0.0.1" or target.username or target.password or target.path != "/internal/chatkit/read" or target.query or target.fragment or not context.get("readRun"):
        return {"ok": False, "error": {"code": "READ_UNAVAILABLE", "message": "Authorized Foundry reads unavailable"}}
    payload = {"operation": operation, "arguments": arguments or {}}
    if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > 32768:
        return {"ok": False, "error": {"code": "INPUT_BUDGET_EXCEEDED", "message": "Adapter request exceeds its bounded input allocation; propose fewer or smaller resources"}}
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            response = await client.post(url, headers={"x-chatkit-read-run": context["readRun"], "x-chatkit-secret": context["internalSecret"], "x-chatkit-world": context["worldId"], "x-chatkit-user": context["userId"], "x-chatkit-thread": context["threadId"]}, json=payload)
            if response.status_code != 200 or len(response.content) > 32768:
                return {"ok": False, "error": {"code": "READ_UNAVAILABLE", "message": "Authorized Foundry read failed"}}
            result = response.json()
            if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
                return {"ok": False, "error": {"code": "READ_UNAVAILABLE", "message": "Malformed authenticated adapter response"}}
            return result
    except (httpx.HTTPError, ValueError, KeyError):
        return {"ok": False, "error": {"code": "READ_UNAVAILABLE", "message": "Authorized Foundry read failed"}}


class CampaignProposedFile(BaseModel):
    """A proposed relative Markdown replacement, never a direct filesystem command."""
    model_config = ConfigDict(extra="forbid")
    path: str = Field(max_length=200)
    expected_revision: str | None = Field(description="Exact SHA256 revision from campaign_read; null only when creating a missing file")
    proposed_text: str = Field(max_length=16000)

class TokenLightPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    bright: float = Field(default=None, ge=0, le=10000, allow_inf_nan=False, json_schema_extra={"default": None, "multipleOf": 0.01})
    dim: float = Field(default=None, ge=0, le=10000, allow_inf_nan=False, json_schema_extra={"default": None, "multipleOf": 0.01})
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")
    alpha: float = Field(default=None, ge=0, le=1, allow_inf_nan=False)

    @field_validator("bright", "dim", "alpha", mode="before")
    @classmethod
    def numeric_patch(cls, value, info):
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError("Supplied numeric light fields must be finite numbers")
        if info.field_name in ("bright", "dim") and abs(value * 100 - round(value * 100)) > 1e-7:
            raise ValueError("Light radii require 0.01 scene-unit precision")
        return value

    def native_patch(self):
        patch = self.model_dump(exclude_unset=True)
        if not patch:
            raise ValueError("At least one light field is required")
        return patch


class TokenMove(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    x: float = Field(ge=0, le=100000)
    y: float = Field(ge=0, le=100000)


class AttackSequenceStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    step_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    scene_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    attacker_token_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    actor_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    item_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    activity_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    target_token_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    advantage: Literal["normal", "advantage", "disadvantage"]
    attack_mode: str | None
    ammunition_id: str | None
    ability_id: str | None

    def native_step(self):
        names = {"scene_id":"sceneId","attacker_token_id":"attackerTokenId","actor_id":"actorId","item_id":"itemId","activity_id":"activityId","target_token_id":"targetTokenId","attack_mode":"attackMode","ammunition_id":"ammunitionId","ability_id":"abilityId","advantage":"advantage"}
        return {"stepId":self.step_id,"attack":{"mode":"roll",**{alias:getattr(self,key) for key,alias in names.items() if getattr(self,key) is not None}}}


LATENCY_DIAGNOSTICS = {"writes": 0, "dropped": 0, "writeDurationMs": 0.0, "maxWriteDurationMs": 0.0}

def start_latency_scope(context):
    started = time.monotonic()
    context["_latencyOrigin"] = started
    context["_latencyScopeId"] = str(uuid.uuid4())
    return started


def trace(context, stage, **fields):
    now = time.monotonic()
    # Hook-local elapsed origins are spans, never the enclosing scope clock.
    if "elapsedMs" in fields:
        fields["hookDurationMs"] = fields.pop("elapsedMs")
    if "_latencyOrigin" not in context or "_latencyScopeId" not in context:
        start_latency_scope(context)
    print(json.dumps({"type": "pause-timing", "traceId": context.get("traceId", ""), "scopeId": context["_latencyScopeId"], "elapsedMs": max(0, (now-context["_latencyOrigin"])*1000), "stage": stage, "atMs": time.time()*1000, **fields}), flush=True)
    # Diagnostic writes never alter mechanics. Keep only metadata and same-process spans.
    trace_id = context.get("traceId", "")
    if not re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", trace_id):
        return
    if "_latencyOrigin" not in context or "_latencyScopeId" not in context:
        start_latency_scope(context)
    origin = context["_latencyOrigin"]
    allowed = {"durationMs", "request", "toolCalls", "outcome", "sinceModelRequestMs", "providerResponseHash", "providerRequestHash", "eventType", "transportRetryLimit", "itemHash", "callHash", "tokenUpperBound", "toolSchemaTokenUpperBound", "historyItems", "summaryVersion"}
    projected = {}
    for key, value in fields.items():
        if key not in allowed:
            continue
        if key in {"durationMs", "request", "toolCalls", "sinceModelRequestMs", "transportRetryLimit", "tokenUpperBound", "toolSchemaTokenUpperBound", "historyItems", "summaryVersion"}:
            if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1000000000:
                projected[key] = value
        elif key in {"providerResponseHash", "providerRequestHash", "itemHash", "callHash"}:
            if isinstance(value, str) and re.fullmatch(r"[a-f0-9]{24}", value): projected[key] = value
        elif key == "outcome":
            if value in ("confirmed", "uncertain", "partial", "failed", "failure", "denied", "cancelled", "decision-required"): projected[key] = value
        elif key == "eventType":
            if isinstance(value, str) and re.fullmatch(r"response\.[a-z_.]{1,80}", value): projected[key] = value
    row = {"schemaVersion": 1, "traceId": trace_id, "component": "python", "scopeId": context["_latencyScopeId"], "stage": stage,
           "elapsedMs": max(0, (now-origin)*1000), **projected}
    write_started = now
    try:
        database_path = os.environ.get("AI_DM_CHATKIT_DATABASE_PATH", PRIVATE_DATABASE_DEFAULT)
        if database_path == ":memory:":
            return
        path = Path(database_path).parent / "latency-traces.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size > 5000000:
            path.replace(path.with_suffix(".previous.jsonl"))
        with path.open("a", encoding="utf-8") as output:
            output.write(json.dumps(row, allow_nan=False) + "\n")
        LATENCY_DIAGNOSTICS["writes"] += 1
    except (OSError, ValueError):
        LATENCY_DIAGNOSTICS["dropped"] += 1
    finally:
        duration = (time.monotonic()-write_started)*1000
        LATENCY_DIAGNOSTICS["writeDurationMs"] += duration
        LATENCY_DIAGNOSTICS["maxWriteDurationMs"] = max(LATENCY_DIAGNOSTICS["maxWriteDurationMs"], duration)


def diagnostic_hash(value):
    return hashlib.sha256(str(value).encode()).hexdigest()[:24] if value else None


async def observe_model_stream(context, events):
    trace(context, "model-stream-invocation", request=context.get("_latencyRequests", 0))
    first = True
    args_seen = set()
    narration_seen = False
    async for event in events:
        event_type = getattr(event, "type", "")
        if first:
            trace(context, "model-first-event", eventType=event_type)
            first = False
        response = getattr(event, "response", None)
        if response and getattr(response, "id", None):
            trace(context, "model-provider-response", eventType=event_type, providerResponseHash=diagnostic_hash(response.id))
        if event_type in ("response.completed", "response.failed", "response.incomplete"):
            request_id = getattr(response, "_request_id", None)
            trace(context, "model-provider-request-id" if request_id else "model-provider-request-id-unavailable", providerRequestHash=diagnostic_hash(request_id))
        if event_type == "response.function_call_arguments.done":
            key = getattr(event, "item_id", None)
            if key not in args_seen:
                args_seen.add(key)
                trace(context, "model-complete-arguments-event", callHash=diagnostic_hash(key))
        elif event_type == "response.completed":
            for item in getattr(response, "output", []):
                if getattr(item, "type", "") == "function_call" and getattr(item, "id", None) not in args_seen:
                    args_seen.add(getattr(item, "id", None))
                    trace(context, "model-complete-arguments-event", callHash=diagnostic_hash(getattr(item, "id", None)))
        if event_type == "response.output_text.delta" and not narration_seen:
            trace(context, "model-first-text-event")
            narration_seen = True
        yield event


class LatencyResponsesModel(OpenAIResponsesModel):
    async def stream_response(self, *args, **kwargs):
        if self.latency_context.get("_acceptanceBudget"):
            settings = kwargs.get("model_settings") or (args[2] if len(args) > 2 else None)
            if (getattr(settings, "max_tokens", None) != ACCEPTANCE_OUTPUT_TOKENS
                    or "max_output_tokens" in (getattr(settings, "extra_body", None) or {})
                    or "max_output_tokens" in (getattr(settings, "extra_args", None) or {})):
                raise ContextCapacityError("Acceptance output cap missing or changed; no provider request")
        async for event in observe_model_stream(self.latency_context, super().stream_response(*args, **kwargs)):
            yield event


ACCEPTANCE_OUTPUT_TOKENS = 1024


def max_model_turns(context=None):
    # Explicit None disables the SDK's own default turn ceiling for normal use.
    # Only an authenticated, startup-configured test binding imposes a cap.
    budget = (context or {}).get("_acceptanceBudget")
    if budget is None:
        return None
    ceiling = budget.get("maxModelRequests")
    if type(ceiling) is not int or ceiling not in (1, 2, 3, 4, 5, 6):
        raise ContextCapacityError("Invalid test model-request allowance; no provider request")
    return ceiling



class ReceiptHistoryConverter(ThreadItemConverter):
    async def hidden_context_to_input(self, item):
        if isinstance(item.content, dict) and item.content.get("type") == "authoritative_tool_exchange_v1":
            return item.content["items"]
        return await super().hidden_context_to_input(item)


def receipt_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def attack_receipt_summary(receipt):
    outcome = receipt.get("outcome")
    if outcome not in ("confirmed", "decision-required"):
        return "Attack " + (outcome if outcome in ("failure", "uncertain") else "unconfirmed") + "; completion is not confirmed."
    state = receipt.get("state")
    if not isinstance(state, dict):
        return None
    stage = state.get("stage")
    attack = state.get("attackRoll")
    parts = []
    if isinstance(attack, dict) and receipt_number(attack.get("total")) and isinstance(attack.get("result"), str):
        parts.append(f"Attack: {attack['total']} ({attack['result'][:200]})")
    if state.get("hit") is False:
        parts.append("Miss")
    elif state.get("hit") is True:
        parts.append("Critical hit" if state.get("critical") is True else "Hit")
    if stage in ("damage-rolled", "damage-applied", "cancelled") and receipt_number(state.get("damageRolled")):
        rolls = state.get("damageRolls", [])
        breakdown = "; ".join(f"{r['total']} {r.get('type', 'damage')} ({r['result'][:200]})" for r in rolls[:16]
            if isinstance(r, dict) and receipt_number(r.get("total")) and isinstance(r.get("result"), str)) if isinstance(rolls, list) else ""
        parts.append(f"Damage rolled: {state['damageRolled']}" + (f" ({breakdown})" if breakdown else ""))
    if outcome == "confirmed" and stage == "damage-applied" and receipt_number(state.get("damageApplied")):
        before, after = state.get("hpBefore"), state.get("hpAfter")
        if isinstance(before, dict) and isinstance(after, dict) and all(receipt_number(hp.get(key)) for hp in (before, after) for key in ("value", "temp")):
            parts.append(f"Damage applied: {state['damageApplied']}; HP {before['value']} → {after['value']}, temporary HP {before['temp']} → {after['temp']}")
    elif stage == "damage-rolled":
        parts.append("Damage not applied")
    if outcome == "decision-required":
        parts.append("Player decision or reaction required; stop before continuing")
    if stage == "cancelled":
        parts.append("Damage application cancelled; no confirmed HP application; do not reroll" if isinstance(attack, dict) else "Attack roll cancelled; no completed attack")
    return ". ".join(parts) + "." if parts else None


def attack_sequence_receipt_summary(receipt):
    outcome = receipt.get("outcome")
    state = receipt.get("state")
    if not isinstance(state, dict) or not isinstance(state.get("steps"), list):
        return "Attack sequence unconfirmed; reconcile recorded steps before retrying."
    steps = state["steps"]
    count = state.get("completedStepCount")
    if type(count) is not int or not 0 <= count <= len(steps) <= 4:
        return None
    parts = [f"Attack sequence: {count} completed step(s); {outcome if outcome in ('confirmed','partial','decision-required','failure','uncertain') else 'unconfirmed'}."]
    for index, step in enumerate(steps):
        if not isinstance(step, dict): return None
        child = step.get("applyReceipt") or step.get("rollReceipt")
        if not isinstance(child, dict): continue
        summary = attack_receipt_summary(child)
        if summary: parts.append(f"Step {index+1}: {summary}")
        resource = (step.get("rollReceipt") or {}).get("state", {})
        resource = resource.get("resourceConsumption") if isinstance(resource, dict) else None
        if isinstance(resource, dict):
            before, after = resource.get("before"), resource.get("after")
            if resource.get("verified") is True and isinstance(before, list) and isinstance(after, list) and len(before) == len(after):
                for prior, current in zip(before, after):
                    if isinstance(prior, dict) and receipt_number(prior.get("spent")) and receipt_number(current):
                        parts.append(f"Resource spent: {prior['spent']} -> {current} (verified).")
            else: parts.append("Resource consumption unconfirmed; do not consume again.")
    if outcome != "confirmed":
        parts.append("Remaining steps are not confirmed; do not reroll completed or uncertain steps.")
    if isinstance(state.get("continuation"), dict):
        parts.append("A clean deadline continuation is available; resume only its exact recorded plan and ticket after validation.")
    if outcome == "decision-required": parts.append("Player choice or reaction required; automatic continuation unavailable.")
    return " ".join(parts)


def receipt_summary(tool_name, receipt):
    """Only receipt observations produce success text; arguments are never evidence."""
    if not isinstance(receipt, dict):
        return None
    if receipt.get("schemaVersion") == "attack-sequence-v1":
        return attack_sequence_receipt_summary(receipt)
    if receipt.get("schemaVersion") == "attack-actions-v1":
        return attack_receipt_summary(receipt)
    if receipt.get("outcome") != "confirmed":
        outcome = receipt.get("outcome")
        if outcome in ("uncertain", "partial", "failed", "failure", "denied") or receipt.get("ok") is False:
            return "Action " + (outcome or "failed") + "; completion is not confirmed."
        return None
    state = receipt.get("state", {})
    state = state if isinstance(state, dict) else {}
    if tool_name == "foundry_set_pause_state" and isinstance(receipt.get("paused"), bool):
        return "Game paused." if receipt["paused"] else "Game unpaused."
    action = receipt.get("action", {})
    kind = action.get("kind") if isinstance(action, dict) else None
    if kind == "door.state" and type(state.get("ds")) is int and state.get("ds") in (0, 1, 2):
        return ["Door closed.", "Door opened.", "Door locked."][state["ds"]]
    if kind == "actor.hp" and receipt_number(state.get("value")):
        return f"HP set to {state['value']}."
    if kind == "token.position" and all(receipt_number(state.get(k)) for k in ("x", "y")):
        return f"Token moved to ({state['x']}, {state['y']})."
    if kind == "token.light":
        requested, observed = action.get("light"), state.get("light")
        if isinstance(requested, dict) and requested and isinstance(observed, dict):
            def matches(key, value):
                actual = observed.get(key)
                if key == "color":
                    return (key in observed and actual is None) if value is None else isinstance(value, str) and isinstance(actual, str) and value.lower() == actual.lower()
                return receipt_number(value) and receipt_number(actual) and value == actual
            if set(requested) <= {"bright", "dim", "color", "alpha"} and all(matches(k, v) for k, v in requested.items()):
                return "Token emitted light cleared." if observed.get("bright") == 0 and observed.get("dim") == 0 else "Token emitted light updated."
        return None
    if kind == "combat.next" and all(receipt_number(state.get(k)) for k in ("round", "turn")):
        return f"Combat advanced: round {state['round']}, turn {state['turn']}."
    if kind == "actor.condition" and type(state.get("active")) is bool:
        return "Condition activated." if state["active"] else "Condition removed."
    if kind == "combat.initiative" and receipt_number(state.get("initiative")):
        return f"Initiative set to {state['initiative']}."
    rolls = [state] if kind == "dice.roll" else state.get("rolls", [])
    if kind in ("system.roll", "dice.roll") and isinstance(rolls, list) and rolls and len(rolls) <= 8:
        if all(isinstance(r, dict) and receipt_number(r.get("total")) and isinstance(r.get("result"), str) for r in rolls):
            return "Roll: " + "; ".join(f"{r['total']} ({r['result'][:200]})" for r in rolls) + "."
    return None


class RoutineCompletionContract(BaseModel):
    """Authenticated gateway assertion of the entire sole, explicitly resolved request.

    Never produced by the model or by retrieved/user-controlled metadata.
    """
    model_config = ConfigDict(extra="forbid", strict=True)
    version: Literal[1]
    toolName: Literal["foundry_set_pause_state", "foundry_move_token", "foundry_set_door_state",
        "foundry_set_token_light", "foundry_set_actor_hp", "foundry_set_actor_condition", "foundry_advance_combat_turn",
        "foundry_set_initiative", "foundry_roll_actor", "foundry_roll_dice"]
    arguments: dict[str, Any]

    @field_validator("version", mode="before")
    @classmethod
    def version_is_integer(cls, value):
        if type(value) is not int:
            raise ValueError("Completion contract version must be an integer")
        return value


def decode_completion_header(value):
    if not value:
        return None
    try:
        if len(value) > 4096:
            raise ValueError("Contract budget exceeded")
        contract = RoutineCompletionContract.model_validate_json(base64.b64decode(value, validate=True))
        return contract.model_dump()
    except (ValueError, TypeError):
        raise HTTPException(400, "Invalid authenticated completion contract") from None


def same_json(left, right):
    # JSON numbers 40 and 40.0 are semantically equal; booleans remain distinct.
    def normalize(value):
        if type(value) is float and math.isfinite(value) and value.is_integer():
            return int(value)
        if isinstance(value, dict):
            return {key: normalize(part) for key, part in value.items()}
        if isinstance(value, list):
            return [normalize(part) for part in value]
        return value
    return json.dumps(normalize(left), sort_keys=True, allow_nan=False) == json.dumps(normalize(right), sort_keys=True, allow_nan=False)


def completed_contract_receipt(contract, receipt, world_id):
    if not isinstance(receipt, dict) or receipt.get("outcome") != "confirmed" or receipt.get("worldId") != world_id:
        return False
    args, name = contract.arguments, contract.toolName
    if name == "foundry_set_pause_state":
        return type(receipt.get("paused")) is bool and same_json(receipt["paused"], args["paused"])
    if receipt.get("schemaVersion") != "core-actions-v1":
        return False
    kind = {"foundry_move_token": "token.position", "foundry_set_door_state": "door.state",
        "foundry_set_token_light": "token.light", "foundry_set_actor_hp": "actor.hp", "foundry_set_actor_condition": "actor.condition",
        "foundry_advance_combat_turn": "combat.next", "foundry_set_initiative": "combat.initiative",
        "foundry_roll_actor": "system.roll", "foundry_roll_dice": "dice.roll"}[name]
    action = {"kind": kind}
    rename = {"scene_id": "sceneId", "token_id": "targetId", "door_id": "targetId", "actor_id": "targetId",
        "combat_id": "targetId", "combatant_id": "combatantId", "condition_id": "conditionId", "roll_type": "rollType"}
    for key, value in args.items():
        action[rename.get(key, key)] = {"closed": 0, "open": 1, "locked": 2}[value] if key == "state" else value
    if "state" in action:
        action["value"] = action.pop("state")
    if not same_json(action, receipt.get("action")):
        return False
    state = receipt.get("state")
    if not isinstance(state, dict):
        return False
    expected = {k: action[k] for k in ("x", "y", "active", "initiative") if k in action}
    if kind == "door.state": expected["ds"] = action["value"]
    if kind == "actor.hp": expected["value"] = action["value"]
    if kind == "combat.initiative": expected["initiative"] = action["value"]
    if kind == "token.light":
        return receipt_summary(name, receipt) is not None
    return all(same_json(value, state.get(key)) for key, value in expected.items())


async def pause_receipt_final(context, results):
    """SDK-supported finalization only after complete, durable, confirmed semantics."""
    request = context.context.request_context
    execution = request.get("_completionExecution", {})
    if len(results) != 1 or execution.get("requests") != 1 or execution.get("calls") != 1 or not execution.get("durable"):
        return ToolsToFinalOutputResult(is_final_output=False)
    try:
        receipt = json.loads(results[0].output)
        summary = receipt_summary(results[0].tool.name, receipt)
        raw = request.get("completionContract")
        if raw:
            contract = RoutineCompletionContract.model_validate(raw)
            validate_json_schema(contract.arguments, results[0].tool.params_json_schema)
            eligible = contract.toolName == results[0].tool.name and same_json(contract.arguments, execution.get("arguments")) and completed_contract_receipt(contract, receipt, request["worldId"])
        else:
            # Compatibility with the existing authenticated sole-pause parser.
            eligible = request.get("pauseControlOnly") and results[0].tool.name == "foundry_set_pause_state" and receipt.get("outcome") == "confirmed" and same_json(receipt.get("paused"), execution.get("arguments", {}).get("paused"))
        if eligible and summary:
            return ToolsToFinalOutputResult(is_final_output=True, final_output=summary)
    except (TypeError, ValueError, KeyError, SchemaValidationError):
        pass
    return ToolsToFinalOutputResult(is_final_output=False)

async def persist_narration_basis_label(agent_context, marker_id, summary):
    """Deterministic visible historical scope, not a model's optional disclaimer."""
    request = agent_context.request_context
    message_id = "msg_narration_basis_" + marker_id.removeprefix("msg_narration_")
    text = "Narration describes the completed action: " + summary + " Later actions may have changed the world."
    try:
        existing = await agent_context.store.load_item(agent_context.thread.id, message_id, request)
        if not isinstance(existing, AssistantMessageItem) or [part.text for part in existing.content] != [text]:
            raise RuntimeError("Narration basis identity conflict; reconcile before continuing")
        return
    except NotFoundError:
        pass
    message = AssistantMessageItem(id=message_id, thread_id=agent_context.thread.id,
        created_at=datetime.now(timezone.utc), content=[AssistantMessageContent(text=text)])
    await agent_context.store.add_thread_item(agent_context.thread.id, message, request)
    trace(request, "narration-basis-label-persisted", itemHash=diagnostic_hash(message.id))
    await agent_context.stream(ThreadItemDoneEvent(item=message))
    trace(request, "narration-basis-label-enqueued", itemHash=diagnostic_hash(message.id))


async def narration_receipt_boundary(run_context, results, agent):
    """Conservative whole-request boundary; Node owns permanent revocation and release."""
    request = run_context.context.request_context
    execution = request.get("_completionExecution", {})
    raw = request.get("narrationContract")
    if not raw or request.get("_narrationBoundaryAttempted") or len(results) != 1 or execution.get("requests") != 1 or execution.get("calls") != 1 or not execution.get("durable"):
        return
    try:
        contract = RoutineCompletionContract.model_validate(raw)
        validate_json_schema(contract.arguments, results[0].tool.params_json_schema)
        receipt = json.loads(results[0].output)
        summary = receipt_summary(results[0].tool.name, receipt)
        eligible = summary and contract.toolName == results[0].tool.name and same_json(contract.arguments, execution.get("arguments")) and completed_contract_receipt(contract, receipt, request["worldId"])
    except (TypeError, ValueError, KeyError, SchemaValidationError):
        return
    if not eligible:
        return
    agent_context = run_context.context
    if not isinstance(agent_context, AgentContext):
        return
    marker_scope = json.dumps([request["worldId"], request["userId"], agent_context.thread.id, request.get("readRun", "")])
    marker = HiddenContextItem(id="msg_narration_" + hashlib.sha256(marker_scope.encode()).hexdigest()[:32],
        thread_id=agent_context.thread.id, created_at=datetime.now(timezone.utc),
        content=json.dumps({"type": "narration_boundary_v1", "status": "requested", "receiptSummary": summary,
                           "basis": "confirmed receipt observation; later controls may supersede it"}))
    await agent_context.store.add_thread_item(agent_context.thread.id, marker, request)
    request["_narrationBoundaryAttempted"] = True
    # Never restore this run's tools even if cancellation loses the server acknowledgement.
    request["_narrationOnly"] = True
    agent.tools = []
    agent.instructions += "\nThe requested mechanics have a durable confirmed receipt. Continue only with the requested narration, using the completed action as historical evidence. Do not perform further tools or claim that later world state is necessarily unchanged."
    trace(request, "narration-boundary-requested")
    response = await read_foundry(request, "release_mutation_capability", {"version": 1})
    result = response.get("result") if isinstance(response, dict) and response.get("ok") is True else None
    confirmed = isinstance(result, dict) and type(result.get("version")) is int and result["version"] == 1 and result.get("mutationCapability") == "permanently-revoked" and all(isinstance(result.get(key), str) and re.fullmatch(r"[a-f0-9]{64}", result[key]) for key in ("receiptDigest", "stateRevision")) and result.get("scope") == "confirmed-receipt-observation; may be superseded"
    basis = {"type": "narration_boundary_v1", "status": "confirmed" if confirmed else "acknowledgement-unavailable",
             "receiptSummary": summary, "basis": "confirmed receipt observation; later controls may supersede it"}
    if confirmed:
        basis.update(receiptDigest=result["receiptDigest"], stateRevision=result["stateRevision"])
        request["_narrationBoundary"] = result
        agent.instructions += "\nNarration receipt digest " + result["receiptDigest"] + "; observation revision " + result["stateRevision"] + ". These identify the receipt basis, not a grant to inspect or modify current state."
    marker.content = json.dumps(basis)
    await agent_context.store.save_item(agent_context.thread.id, marker, request)
    trace(request, "narration-boundary-confirmed" if confirmed else "narration-boundary-unacknowledged")
    await persist_narration_basis_label(agent_context, marker.id, summary)


class PauseTimingHooks(RunHooks):
    def __init__(self, context):
        self.context, self.requests, self.calls, self.start = context, 0, 0, time.monotonic()
        self.model_start = self.start
        self.tool_starts = {}
        self.seen_receipts = set()
        context["_completionExecution"] = {"requests": 0, "calls": 0, "durable": False}

    async def on_llm_start(self, context, agent, system_prompt, input_items):
        if "_workingContextBudget" in self.context:
            schemas = agent_tool_schemas(agent)
            # Recheck accumulated results before every provider request, not only
            # initial preparation. Overflow must never silently omit a turn.
            _, budget = assemble_input(system_prompt or "", input_items,
                window=self.context["_workingContextBudget"]["window"],
                reserve=MODEL_OUTPUT_TOKENS, tool_schemas=schemas)
            self.context["_workingContextBudget"] = budget
        if "_acceptanceBudget" in self.context:
            budget = self.context["_acceptanceBudget"]
            if getattr(getattr(agent, "model_settings", None), "max_tokens", None) != ACCEPTANCE_OUTPUT_TOKENS:
                raise ContextCapacityError("Acceptance output cap missing or changed; no provider request")
            if time.time() >= budget["expiresAt"]:
                raise ContextCapacityError("Approved acceptance fixture expired; no provider request")
            self.context["_conversationStore"].consume_acceptance_request(budget["scope"], budget["maxModelRequests"])
        self.requests += 1
        self.context["_completionExecution"]["requests"] = self.requests
        self.context["_latencyRequests"] = self.requests
        self.model_start = time.monotonic()
        trace(self.context, "model-request", request=self.requests, transportRetryLimit=0, model=agent.model.model,
              reasoning=agent.model_settings.reasoning.model_dump() if agent.model_settings.reasoning else None,
              toolNames=[tool.name for tool in agent.tools])

    async def on_llm_end(self, context, agent, response):
        trace(self.context, "model-response", request=self.requests, providerResponseHash=diagnostic_hash(response.response_id), providerRequestHash=diagnostic_hash(getattr(response, "request_id", None)), durationMs=(time.monotonic()-self.model_start)*1000)

    async def on_tool_start(self, context, agent, tool):
        try:
            validate_json_schema(json.loads(context.tool_arguments), tool.params_json_schema)
            trace(self.context, "model-actionable-arguments", request=self.requests, callHash=diagnostic_hash(getattr(context, "tool_call_id", None)))
        except (AttributeError, TypeError, ValueError, SchemaValidationError):
            trace(self.context, "model-arguments-not-schema-validated", request=self.requests)
        self.calls += 1
        self.context["_completionExecution"].update(calls=self.calls, durable=False)
        self.tool_starts[getattr(context, "tool_call_id", tool.name)] = time.monotonic()
        trace(self.context, "tool-start", tool=tool.name, toolCalls=self.calls, request=self.requests,
              sinceModelRequestMs=(time.monotonic()-self.model_start)*1000)

    async def on_tool_end(self, context, agent, tool, result):
        tool_started = self.tool_starts.pop(getattr(context, "tool_call_id", tool.name), time.monotonic())
        trace(self.context, "tool-result", tool=tool.name, toolCalls=self.calls,
              durationMs=(time.monotonic()-tool_started)*1000,
              elapsedMs=(time.monotonic()-self.start)*1000)
        agent_context = context.context
        if isinstance(agent_context, AgentContext) and getattr(context, "tool_call_id", None):
            # Store complete pairs before display, including cancellation after a committed effect.
            pair_scope = json.dumps([agent_context.request_context["worldId"], agent_context.request_context["userId"], agent_context.thread.id, context.tool_call_id])
            pair_id = "msg_tool_" + hashlib.sha256(pair_scope.encode()).hexdigest()[:32]
            pair = HiddenContextItem(id=pair_id, thread_id=agent_context.thread.id,
                created_at=datetime.now(timezone.utc), content={"type": "authoritative_tool_exchange_v1", "items": [
                    {"type": "function_call", "call_id": context.tool_call_id, "name": tool.name, "arguments": context.tool_arguments},
                    {"type": "function_call_output", "call_id": context.tool_call_id, "output": str(result)}]})
            try:
                existing_pair = await agent_context.store.load_item(agent_context.thread.id, pair_id, agent_context.request_context)
                if not isinstance(existing_pair, HiddenContextItem) or existing_pair.content != pair.content:
                    raise RuntimeError("Tool exchange identity conflict; reconcile before continuing")
            except NotFoundError:
                trace(self.context, "tool-exchange-persist-start", itemHash=diagnostic_hash(pair.id))
                await agent_context.store.add_thread_item(agent_context.thread.id, pair, agent_context.request_context)
                trace(self.context, "tool-exchange-persist-complete", itemHash=diagnostic_hash(pair.id))
        if tool.name.startswith("foundry_") and tool.name not in ("foundry_read_scene", "foundry_read_actor", "foundry_read_play_state", "foundry_read_attack_state", "foundry_read_token_perception"):
            try:
                receipt = json.loads(result)
                summary = receipt_summary(tool.name, receipt)
                receipt_key = receipt.get("correlationId") or getattr(context, "tool_call_id", None)
                if summary and receipt_key not in self.seen_receipts and isinstance(agent_context, AgentContext):
                    self.seen_receipts.add(receipt_key)
                    identity = json.dumps([agent_context.request_context["worldId"], agent_context.request_context["userId"], agent_context.thread.id, receipt_key])
                    message_id = "msg_receipt_" + hashlib.sha256(identity.encode()).hexdigest()[:32]
                    try:
                        existing_message = await agent_context.store.load_item(agent_context.thread.id, message_id, agent_context.request_context)
                        if not isinstance(existing_message, AssistantMessageItem) or [part.text for part in existing_message.content] != [summary]:
                            raise RuntimeError("Receipt identity conflict; reconcile before continuing")
                    except NotFoundError:
                        message = AssistantMessageItem(id=message_id, thread_id=agent_context.thread.id,
                            created_at=datetime.now(timezone.utc), content=[AssistantMessageContent(text=summary)])
                        trace(self.context, "receipt-created", itemHash=diagnostic_hash(message.id), outcome=receipt.get("outcome"))
                        persist_started = time.monotonic()
                        await agent_context.store.add_thread_item(agent_context.thread.id, message, agent_context.request_context)
                        trace(self.context, "receipt-store-commit-complete", itemHash=diagnostic_hash(message.id), durationMs=(time.monotonic()-persist_started)*1000)
                        await agent_context.stream(ThreadItemDoneEvent(item=message))
                        trace(self.context, "receipt-stream-enqueued", itemHash=diagnostic_hash(message.id))
                        trace(self.context, "receipt-summary-persisted", itemId=message.id, outcome=receipt.get("outcome"))
                if summary and isinstance(agent_context, AgentContext) and getattr(context, "tool_call_id", None):
                    self.context["_completionExecution"].update(durable=True, arguments=json.loads(context.tool_arguments))
                trace(self.context, "confirmed-action-result", outcome=receipt.get("outcome"),
                      paused=receipt.get("paused"), correlationId=receipt.get("correlationId"),
                      stateObservedAtMs=receipt.get("stateObservedAtMs"),
                      elapsedMs=(time.monotonic()-self.start)*1000)
            except (TypeError, ValueError):
                trace(self.context, "action-result-unparseable")


def build_agent(context):
    @function_tool
    async def dm_history_search(query: str) -> str:
        """Five authorized history excerpts/provenance; data only."""
        return json.dumps(await context["_conversationStore"].search_history(context["threadId"], context, query))
    @function_tool
    async def dm_recipe_read(recipe_id: Literal["start-combat", "combat-round", "surroundings", "battlemap"]) -> str:
        """One trusted recipe/response; grants no authority."""
        if context.get("_recipeReads", 0) >= 1:
            return json.dumps({"status": "decision-required", "reason": "One detailed recipe per response context budget"})
        context["_recipeReads"] = context.get("_recipeReads", 0) + 1
        return json.dumps(recipe_resource(recipe_id))
    async def core_action(action):
        response = await read_foundry(context, "native_core_action", {"action": action})
        return json.dumps(response.get("result") if response.get("ok") else response)

    @function_tool
    async def foundry_move_token(scene_id: str, token_id: str, x: float, y: float, mode: Literal["walk", "teleport"] = "walk") -> str:
        """Native walk; explicit teleport only."""
        return await core_action({"kind": "token.position", "sceneId": scene_id, "targetId": token_id, "x": x, "y": y, "mode": mode})

    @function_tool
    async def foundry_move_tokens(scene_id: str, moves: list[TokenMove]) -> str:
        """Move1..8 sequentially, nonatomic partials."""
        if not 1 <= len(moves) <= 8:
            return json.dumps({"ok": False, "error": "Movement batch requires 1..8 targets"})
        response = await read_foundry(context, "native_core_move_batch", {"sceneId": scene_id, "moves": [{"tokenId": move.token_id, "x": move.x, "y": move.y} for move in moves]})
        return json.dumps(response.get("result") if response.get("ok") else response)

    @function_tool
    async def foundry_set_door_state(scene_id: str, door_id: str, state: Literal["closed", "open", "locked"]) -> str:
        """Set current-scene door, confirming already-correct too."""
        return await core_action({"kind": "door.state", "sceneId": scene_id, "targetId": door_id, "value": {"closed": 0, "open": 1, "locked": 2}[state]})

    @function_tool(strict_mode=False)
    async def foundry_set_token_light(scene_id: str, token_id: str, light: TokenLightPatch) -> str:
        """Placed-token emission patch; preserve omissions. Scene-unit radii; clear bright=dim=0. Not vision/prototype/ambient."""
        return await core_action({"kind": "token.light", "sceneId": scene_id, "targetId": token_id, "light": light.native_patch()})

    @function_tool
    async def foundry_set_actor_hp(scene_id: str, actor_id: str, value: int) -> str:
        """Set current-scene dnd5e HP within max."""
        return await core_action({"kind": "actor.hp", "sceneId": scene_id, "targetId": actor_id, "value": value})

    @function_tool
    async def foundry_set_actor_condition(scene_id: str, actor_id: str, condition_id: str, active: bool) -> str:
        """Set current-scene configured condition."""
        return await core_action({"kind": "actor.condition", "sceneId": scene_id, "targetId": actor_id, "conditionId": condition_id, "active": active})

    @function_tool
    async def foundry_advance_combat_turn(scene_id: str, combat_id: str) -> str:
        """Advance identified combat once."""
        return await core_action({"kind": "combat.next", "sceneId": scene_id, "targetId": combat_id})

    @function_tool
    async def foundry_set_initiative(scene_id: str, combat_id: str, combatant_id: str, value: float) -> str:
        """Set identified combatant initiative."""
        return await core_action({"kind": "combat.initiative", "sceneId": scene_id, "targetId": combat_id, "combatantId": combatant_id, "value": value})

    @function_tool
    async def foundry_read_play_state() -> str:
        """Read current IDs/combat/system/conditions/rollKeys."""
        return json.dumps(await read_foundry(context, "native_core_state", {}))

    @function_tool
    async def foundry_roll_actor(scene_id: str, actor_id: str, roll_type: Literal["ability", "save", "skill"], key: str) -> str:
        """Native dnd5e rollKeys; total, no chat."""
        return await core_action({"kind": "system.roll", "sceneId": scene_id, "targetId": actor_id, "rollType": roll_type, "key": key})

    @function_tool
    async def foundry_set_pause_state(paused: bool) -> str:
        """GM pause/resume; no prior read."""
        response = await read_foundry(context, "native_set_pause_core", {"paused": paused})
        return json.dumps(response.get("result") if response.get("ok") else response)
    @function_tool
    async def tool_search(query: str, limit: int = 4) -> str:
        """Reviewed search: query<=256,limit1..8."""
        return json.dumps(await read_foundry(context, "tool_search", {"query": query, "limit": limit}))

    @function_tool
    async def tool_load(search_id: str, tool_id: str) -> str:
        """Load run search schema/grant; honor effects/revisions."""
        return json.dumps(await read_foundry(context, "tool_load", {"searchId": search_id, "toolId": tool_id}))

    @function_tool(strict_mode=False)
    async def tool_execute(grant_id: str, effect: Literal["read", "present", "propose", "session"], arguments: dict[str, Any]) -> str:
        """Execute loaded grant/schema; stable actionId, confirmed receipt."""
        return json.dumps(await read_foundry(context, "tool_execute", {"grantId": grant_id, "effect": effect, "arguments": arguments}))
    @function_tool
    async def campaign_read(path: str, start_line: int | None = None, end_line: int | None = None) -> str:
        """Read active-world section with revision/hash."""
        arguments = {"path": path}
        if start_line is not None:
            arguments["startLine"] = start_line
        if end_line is not None:
            arguments["endLine"] = end_line
        return json.dumps(await read_foundry(context, "campaign_read", arguments))

    @function_tool
    async def campaign_propose(proposal_id: str, title: str, files: list[CampaignProposedFile]) -> str:
        """Exact revision-checked batch1..32,<=16000bytes; versioned frontmatter; human approval only."""
        if not 1 <= len(files) <= 32:
            return json.dumps({"ok": False, "error": {"code": "PROPOSAL_INVALID", "message": "Proposal requires 1..32 files"}})
        arguments = {"proposalId": proposal_id, "title": title, "files": [{"path": file.path, "expectedRevision": file.expected_revision, "proposedText": file.proposed_text} for file in files]}
        if len(json.dumps(arguments, ensure_ascii=False).encode("utf-8")) > 16000:
            return json.dumps({"ok": False, "error": {"code": "INPUT_BUDGET_EXCEEDED", "message": "Campaign proposal exceeds 16000 UTF-8 bytes; submit a smaller consistent batch"}})
        return json.dumps(await read_foundry(context, "campaign_propose", arguments))

    @function_tool
    async def campaign_proposals(proposal_id: str | None = None) -> str:
        """Read proposal status and persistence receipt."""
        return json.dumps(await read_foundry(context, "campaign_proposals", {"proposalId": proposal_id} if proposal_id is not None else {}))
    @function_tool
    async def foundry_read_attack_state(scene_id: str | None = None, actor_id: str | None = None, request_id: str | None = None) -> str:
        """Read native dnd5e IDs/options or reconcile an exact request receipt."""
        args = {k: v for k, v in (("sceneId", scene_id), ("actorId", actor_id), ("requestId", request_id)) if v is not None}
        return json.dumps(await read_foundry(context, "native_attack_state", args))

    @function_tool
    async def foundry_roll_attack(action_id: str, scene_id: str, attacker_token_id: str, actor_id: str, item_id: str, activity_id: str,
        target_token_id: str, advantage: Literal["normal", "advantage", "disadvantage"] = "normal", attack_mode: str | None = None,
        ammunition_id: str | None = None, ability_id: str | None = None) -> str:
        """One native dnd5e activity/target; stable action_id; rolled damage is not applied."""
        action = {"mode": "roll", "sceneId": scene_id, "attackerTokenId": attacker_token_id, "actorId": actor_id, "itemId": item_id,
            "activityId": activity_id, "targetTokenId": target_token_id, "advantage": advantage}
        action.update({k: v for k, v in (("attackMode", attack_mode), ("ammunitionId", ammunition_id), ("abilityId", ability_id)) if v is not None})
        response = await read_foundry(context, "native_attack_action", {"actionId": action_id, "action": action})
        return json.dumps(response.get("result") if response.get("ok") else response)

    @function_tool
    async def foundry_apply_attack_damage(action_id: str, prior_attack_request_id: str) -> str:
        """Apply persisted confirmed damage once; no reroll; stop for choices/uncertainty."""
        response = await read_foundry(context, "native_attack_action", {"actionId": action_id, "action": {"mode": "apply", "priorAttackRequestId": prior_attack_request_id}})
        return json.dumps(response.get("result") if response.get("ok") else response)

    @function_tool
    async def foundry_attack_sequence(action_id: str, steps: list[AttackSequenceStep], max_duration_ms: int = 8000) -> str:
        """Explicit1..4 unique native steps,1000..8000ms; partial/choice/uncertain stops."""
        if not 1 <= len(steps) <= 4 or len({step.step_id for step in steps}) != len(steps) or not 1000 <= max_duration_ms <= 8000:
            return json.dumps({"ok":False,"error":"Sequence requires 1..4 unique explicit steps and duration 1000..8000ms"})
        response = await read_foundry(context, "native_attack_sequence", {"actionId":action_id,"action":{"mode":"execute","steps":[step.native_step() for step in steps],"maxDurationMs":max_duration_ms}})
        return json.dumps(response.get("result") if response.get("ok") else response)

    @function_tool
    async def foundry_resume_attack_sequence(action_id: str, prior_sequence_request_id: str, continuation_id: str, max_duration_ms: int = 8000) -> str:
        """Exact clean stored ticket only; never replay completed steps/resources."""
        response = await read_foundry(context, "native_attack_sequence", {"actionId":action_id,"action":{"mode":"resume","priorSequenceRequestId":prior_sequence_request_id,"continuationId":continuation_id,"maxDurationMs":max_duration_ms}})
        return json.dumps(response.get("result") if response.get("ok") else response)

    @function_tool
    async def foundry_roll_dice(formula: str) -> str:
        """Native NdS +/-integer; N1..99,S4/6/8/10/12/20/100; no chat/uncertain retries."""
        return await core_action({"kind": "dice.roll", "formula": formula})

    @function_tool
    async def foundry_propose_session_note(action_id: str, title: str, text: str) -> str:
        """Private journal proposal<=120title/4000text; stable ID; human Review native actions."""
        return json.dumps(await read_foundry(context, "native_propose_note", {"actionId": action_id, "title": title, "text": text}))

    @function_tool
    async def campaign_search(query: str) -> str:
        """Active-world Markdown search<=256; bounded attributed hashed excerpts."""
        return json.dumps(await read_foundry(context, "campaign", {"query": query}))

    @function_tool
    async def campaign_validate_sources() -> str:
        """Read-only campaign parser validation; no writes/shell."""
        return json.dumps(await read_foundry(context, "campaign_validate_sources"))

    @function_tool
    async def foundry_read_scene() -> str:
        """Read bounded current-scene token/actor IDs and summary."""
        return json.dumps(await read_foundry(context, "scene"))

    @function_tool
    async def foundry_read_token_perception(scene_id: str, token_id: str, effective_user_id: str, client_id: str) -> str:
        """Connected non-GM owned-token perception; no GM fallback or stale claims."""
        return json.dumps(await read_foundry(context, "token_perception", {"sceneId": scene_id, "tokenId": token_id, "effectiveUserId": effective_user_id, "clientId": client_id}))

    @function_tool
    async def foundry_read_actor(id: str) -> str:
        """Read current-scene actor name/type."""
        return json.dumps(await read_foundry(context, "actor", {"id": id}))

    async def finish_tools(run_context, results):
        if run_context.context.request_context.get("narrationContract"):
            await narration_receipt_boundary(run_context, results, agent)
            return ToolsToFinalOutputResult(is_final_output=False)
        return await pause_receipt_final(run_context, results)

    model = LatencyResponsesModel(model=context["model"], openai_client=AsyncOpenAI(api_key=context["apiKey"], max_retries=0))
    model.latency_context = context
    agent = Agent(
        name="Foundry assistant",
        instructions=prepared_instructions(),
        tool_use_behavior=finish_tools,
        model=model,
        model_settings=ModelSettings(store=False, max_tokens=ACCEPTANCE_OUTPUT_TOKENS if context.get("_acceptanceBudget") else None,
            reasoning=Reasoning(effort="none") if re.match(r"^gpt-5\.(?:[1-9])(?:[.-]|$)", context["model"]) else None),
        tools=([foundry_set_pause_state] if context.get("pauseControlOnly") else [dm_history_search, dm_recipe_read, foundry_set_pause_state, foundry_read_play_state, foundry_roll_actor, foundry_move_token, foundry_move_tokens, foundry_set_door_state, foundry_set_token_light, foundry_set_actor_hp, foundry_set_actor_condition, foundry_advance_combat_turn, foundry_set_initiative, foundry_read_scene, foundry_read_actor, foundry_read_token_perception, foundry_read_attack_state, foundry_roll_attack, foundry_apply_attack_damage, foundry_attack_sequence, foundry_resume_attack_sequence, campaign_search, campaign_validate_sources, campaign_read, campaign_propose, campaign_proposals, tool_search, tool_load, tool_execute, foundry_roll_dice, foundry_propose_session_note]) if context.get("readRun") else [],
    )

    for tool in agent.tools:
        tool.params_json_schema = compact_schema_annotations(tool.params_json_schema)
    return agent


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
        if isinstance(self.store, SqliteStore) and self.store.db.execute("SELECT 1 FROM player_threads WHERE thread_id=?", (thread.id,)).fetchone():
            raise ValueError("Player observation threads cannot invoke GM narration or inference")
        context = {**context, "threadId": thread.id}
        context["_conversationStore"] = self.store
        started = start_latency_scope(context)
        trace(context, "python-response-start")
        summary = None
        if isinstance(self.store, SqliteStore):
            try:
                history, summary = await self.store.working_history(thread.id, context)
            except ContextCapacityError as exc:
                yield ErrorEvent(message=str(exc), allow_retry=False)
                return
        else:
            items = await self.store.load_thread_items(thread.id, None, 5001, "desc", context)
            if items.has_more or len(items.data) > 5000:
                raise ContextCapacityError(MAINTENANCE_REQUEST)
            history = list(reversed(items.data))
        agent_context = AgentContext(thread=thread, store=self.store, request_context=context)
        agent_input = await ReceiptHistoryConverter().to_agent_input(history)
        snapshot = None
        if context.get("readRun"):
            # The same authoritative builder runs for typed messages and custom actions.
            query = retrieval_query(agent_input)
            snapshot = await read_foundry(context, "initial_context", {})
        agent = build_agent(context)
        schemas = agent_tool_schemas(agent)
        # Use an exact verified model capacity. Provider acceptance remains a
        # live gate; this preflight never dispatches or changes billing/auth.
        window = model_context_window(context.get("model"))
        try:
            agent_input, context["_workingContextBudget"] = assemble_input(prepared_instructions(), agent_input, snapshot, summary,
                window=window, reserve=MODEL_OUTPUT_TOKENS, tool_schemas=schemas)
        except ContextCapacityError as exc:
            trace(context, "context-capacity-refused", outcome="decision-required")
            yield ErrorEvent(message=str(exc), allow_retry=False)
            return
        trace(context, "context-prepared", durationMs=(time.monotonic()-started)*1000,
            **{key: context["_workingContextBudget"][key] for key in ("tokenUpperBound", "toolSchemaTokenUpperBound", "historyItems", "summaryVersion")})
        result = Runner.run_streamed(agent, agent_input, context=agent_context, hooks=PauseTimingHooks(context), run_config=RunConfig(tracing_disabled=True), max_turns=max_model_turns(context))
        try:
            first = True
            async for event in stream_agent_response(agent_context, result):
                if first:
                    trace(context, "first-stream-event", durationMs=(time.monotonic()-started)*1000)
                    first = False
                if getattr(event, "type", None) == "thread.item.done" and getattr(getattr(event, "item", None), "id", "").startswith("msg_receipt_"):
                    trace(context, "receipt-server-event-yield", itemHash=diagnostic_hash(event.item.id))
                yield event
        except ContextCapacityError as exc:
            trace(context, "context-capacity-refused", outcome="decision-required")
            yield ErrorEvent(message=str(exc), allow_retry=False)
        except MaxTurnsExceeded:
            # A tool may already have committed before the SDK reaches its next
            # turn boundary. Keep its durable pair/receipt, but never claim the
            # entire request is complete or invite replay of a committed action.
            trace(context, "assistant-turn-limit-reached", errorType="MaxTurnsExceeded")
            yield ErrorEvent(message="Model turn limit reached; completion of the full request is not confirmed. Any saved tool results and receipts are preserved. Review them before continuing; do not resubmit to replay actions.", allow_retry=False)
        except Exception as exc:
            execution = context.get("_completionExecution", {})
            if not context.get("_acceptanceBudget") and not execution.get("calls"):
                raise
            # ChatKit's default exception handler advertises retry. Once a tool
            # was attempted, or an expiring allowance was consumed, that advice
            # is unsafe. Record the type only: exception text may contain secrets.
            trace(context, "assistant-stream-failed", errorType=type(exc).__name__)
            yield ErrorEvent(message="Response stopped; completion of the full request is not confirmed. Any saved tool results and receipts are preserved. Review the action state before continuing; do not retry this request.", allow_retry=False)
        finally:
            trace(context, "assistant-stream-finished", durationMs=(time.monotonic()-started)*1000)
            result.cancel()

    async def action(self, thread, action, sender, context):
        if action.type == PLAYER_OBSERVATION_ACTION:
            selection = validate_player_action(action.payload, context["worldId"])
            if not isinstance(self.store, SqliteStore):
                raise ValueError("Separate player observation store unavailable")
            binding = json.dumps({k: selection[k] for k in ("worldId", "sceneId", "userId", "clientId", "tokenId")}, sort_keys=True)
            existing = self.store.db.execute("SELECT selection FROM player_threads WHERE thread_id=?", (thread.id,)).fetchone()
            if existing and existing[0] != binding:
                raise ValueError("Player thread audience cannot change")
            if not existing:
                if self.store.db.execute("SELECT 1 FROM items WHERE thread_id=?", (thread.id,)).fetchone():
                    raise ValueError("GM history cannot become a player observation thread")
                self.store.db.execute("INSERT INTO player_threads VALUES(?,?)", (thread.id, binding))
                self.store.db.commit()
            scoped = {**context, "threadId": thread.id}
            arguments = {"sceneId": selection["sceneId"], "tokenId": selection["tokenId"], "effectiveUserId": selection["userId"], "clientId": selection["clientId"]}
            first = project_surroundings(await read_foundry(scoped, "player_surroundings", arguments), selection)
            result = first
            if first["status"] == "ready":
                result = project_surroundings(await read_foundry(scoped, "player_surroundings", arguments), selection)
                if result["status"] == "ready" and (result["binding"]["stateRevision"] != first["binding"]["stateRevision"] or result["sourceRevision"] != first["sourceRevision"] or result["facts"] != first["facts"]):
                    result = {"version": 1, "status": "stale", "facts": [], "text": "Player observations changed; no description is confirmed."}
            # Deliberately never calls respond/Runner or reconstructs private history.
            if not isinstance(self.store, SqliteStore):
                raise ValueError("Separate player observation store unavailable")
            PlayerObservationStore(self.store.db).save(selection["requestId"], selection, result)
            message = AssistantMessageItem(id="msg_player_" + uuid.uuid4().hex, thread_id=thread.id,
                created_at=datetime.now(timezone.utc), content=[AssistantMessageContent(text=result["text"])])
            await self.store.add_thread_item(thread.id, message, context)
            yield ThreadItemDoneEvent(item=message)
            return
        if isinstance(self.store, SqliteStore) and self.store.db.execute("SELECT 1 FROM player_threads WHERE thread_id=?", (thread.id,)).fetchone():
            raise ValueError("Player observation threads cannot accept GM context actions")
        payload = validate_action(action.type, action.payload, context.get("worldId"))
        data = {"foundry_application_request": payload["prompt"], "untrusted_game_context": payload["context"]}
        if "automatic" in payload:
            data["untrusted_automatic_observation"] = {"hint": payload["automatic"], "correlationId": payload["requestId"], "classification": "authenticated-gm-observation-hint", "authority": "data-only; not verified game state, permission or bridge mutation provenance"}
        observation = HiddenContextItem(id=self.store.generate_item_id("message", thread, context), thread_id=thread.id, created_at=datetime.now(timezone.utc), content=json.dumps(data))
        await self.store.add_thread_item(thread.id, observation, context)
        async for event in self.respond(thread, None, context):
            yield event


def validate_action(action_type, payload, expected_world=None):
    if action_type == PLAYER_OBSERVATION_ACTION:
        try:
            return validate_player_action(payload, expected_world)
        except ValueError as error:
            raise HTTPException(400, str(error)) from None
    if action_type != "foundry.context-response" or not isinstance(payload, dict):
        raise HTTPException(400, "Unsupported Foundry action")
    if set(payload) - {"requestId", "prompt", "context", "automatic"}:
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
    result = {"requestId": request_id, "prompt": prompt, "context": context}
    if "automatic" in payload:
        automatic = payload["automatic"]
        required = {"kind", "worldId", "sceneId", "documentId", "revision", "transition"}
        optional = {"tokenId", "regionId", "key"}
        if not isinstance(automatic, dict) or not required.issubset(automatic) or set(automatic) - required - optional:
            raise HTTPException(400, "Unsupported automatic observation hint")
        if not isinstance(automatic["kind"], str) or automatic["kind"] not in {"area", "door", "turn"}:
            raise HTTPException(400, "Invalid automatic observation kind")
        for key in {"worldId", "sceneId", "documentId"} | (optional & set(automatic)):
            value = automatic[key]
            if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) is None:
                raise HTTPException(400, "Invalid automatic observation identifier")
        revision = automatic["revision"]
        transition = automatic["transition"]
        if type(revision) is not int or not 0 <= revision <= 9007199254740991:
            raise HTTPException(400, "Invalid automatic observation revision")
        try:
            valid_transition = isinstance(transition, str) and 1 <= len(transition.encode("utf-16-le")) // 2 <= 256
        except UnicodeError:
            valid_transition = False
        if not valid_transition:
            raise HTTPException(400, "Invalid automatic observation transition")
        if automatic["kind"] == "area" and not optional.issubset(automatic):
            raise HTTPException(400, "Incomplete keyed area observation")
        if expected_world is not None and automatic["worldId"] != expected_world:
            raise HTTPException(400, "Automatic observation world mismatch")
        ordered = [automatic["kind"], automatic["worldId"], automatic["sceneId"], automatic["documentId"], automatic.get("tokenId"), automatic.get("regionId"), automatic.get("key"), revision, transition]
        digest = hashlib.sha256(json.dumps(ordered, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
        if request_id != f"{automatic['kind']}-{digest}":
            raise HTTPException(400, "Automatic observation request identity mismatch")
        result["automatic"] = automatic.copy()
    return result


def create_app(store=None, server=None, secret=None):
    app = FastAPI()
    secret = secret or os.environ.get("AI_DM_CHATKIT_INTERNAL_SECRET", "")
    store = store or SqliteStore(os.environ.get("AI_DM_CHATKIT_DATABASE_PATH", PRIVATE_DATABASE_DEFAULT))
    server = server or FoundryChatKit(store)
    busy, recent = set(), {}
    # Operator-only startup configuration, never request/model-supplied limits.
    fixture_raw = os.environ.get("AI_DM_ACCEPTANCE_FIXTURES_JSON", "{}")
    if len(fixture_raw.encode()) > 8192:
        raise ValueError("Acceptance fixture configuration exceeds bound")
    acceptance_fixtures = json.loads(fixture_raw)
    if not isinstance(acceptance_fixtures, dict) or len(acceptance_fixtures) > 16:
        raise ValueError("Invalid acceptance fixture configuration")
    for fixture_id, fixture in acceptance_fixtures.items():
        if not isinstance(fixture_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", fixture_id) or not isinstance(fixture, dict) or set(fixture) != {"worldId", "userId", "threadId", "traceId", "maxModelRequests", "expiresAt"}:
            raise ValueError("Invalid acceptance fixture binding")
        if any(not isinstance(fixture[key], str) or not 1 <= len(fixture[key]) <= 128 for key in ("worldId", "userId", "threadId", "traceId")) or type(fixture["maxModelRequests"]) is not int or fixture["maxModelRequests"] not in (1, 2, 3, 4, 5, 6):
            raise ValueError("Invalid acceptance fixture ceiling")
        if not re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", fixture["traceId"]):
            raise ValueError("Acceptance fixture trace requires UUID")
        if not isinstance(fixture["expiresAt"], str):
            raise ValueError("Acceptance fixture expiry requires ISO timezone")
        expiry_date = datetime.fromisoformat(fixture["expiresAt"].replace("Z", "+00:00"))
        if expiry_date.utcoffset() is None:
            raise ValueError("Acceptance fixture expiry requires ISO timezone")
        expiry = expiry_date.timestamp()
        if not 0 < expiry - time.time() <= 86400:
            raise ValueError("Acceptance fixtures require expiry within 24 hours")
        fixture["expiresAt"] = expiry

    def authenticate(request):
        supplied = request.headers.get("x-chatkit-secret", "")
        if not secret or not hmac.compare_digest(secret, supplied):
            raise HTTPException(401, "Gateway authentication required")
        try:
            principal = json.loads(base64.b64decode(request.headers["x-chatkit-principal"]))
            if principal.get("isGm") is not True or not all(isinstance(principal.get(k), str) and 0 < len(principal[k]) <= 128 for k in ("worldId", "userId")):
                raise ValueError()
            return {**principal, "apiKey": request.headers.get("x-chatkit-api-key", ""), "model": request.headers.get("x-chatkit-model", ""), "readRun": request.headers.get("x-chatkit-read-run", ""), "internalSecret": secret, "traceId": request.headers.get("x-chatkit-trace", ""), "pauseControlOnly": request.headers.get("x-chatkit-pause-control") == "true", "coreControlOnly": request.headers.get("x-chatkit-core-control") == "true", "completionContract": decode_completion_header(request.headers.get("x-chatkit-completion", "")), "narrationContract": decode_completion_header(request.headers.get("x-chatkit-narration-contract", ""))}
        except Exception:
            raise HTTPException(403, "Invalid gateway principal") from None

    app.include_router(create_preparation_router(authenticate, store))

    @app.get("/health")
    async def health():
        return {"status": "ready", "protocol": "openai-chatkit", "promptVersion": DM_PROMPT_VERSION, "promptDigest": hashlib.sha256(DM_PROMPT.encode("utf-8")).hexdigest(), "codeDigest": STARTUP_CODE_DIGEST, "workingContextDigest": WORKING_CONTEXT_STARTUP_DIGEST, "recipeManifestDigest": RECIPE_MANIFEST_STARTUP_DIGEST, "playerObservationDigest": PLAYER_OBSERVATION_STARTUP_DIGEST, "maxModelTurns": max_model_turns(), "latencyDiagnostics": dict(LATENCY_DIAGNOSTICS)}

    @app.post("/context-admission")
    async def admission(request: Request):
        authenticate(request)
        raw = await request.body()
        if len(raw) > 512:
            raise HTTPException(413, "Admission input too large")
        try:
            body = json.loads(raw)
            if not isinstance(body, dict) or set(body) != {"model"} or not isinstance(body["model"], str) or not 0 < len(body["model"]) <= 128:
                raise ValueError()
        except ValueError:
            raise HTTPException(400, "Invalid model admission input") from None
        return context_admission(body["model"])

    @app.post("/chatkit/thread")
    async def bootstrap(request: Request):
        context = authenticate(request)
        try:
            raw_bootstrap = await request.body()
            if len(raw_bootstrap) > 4096:
                raise HTTPException(413, "Thread bootstrap too large")
            body = json.loads(raw_bootstrap) if raw_bootstrap else {}
        except ValueError:
            raise HTTPException(400, "Invalid thread bootstrap") from None
        if not isinstance(body, dict) or set(body) - {"playerObservation"}:
            raise HTTPException(400, "Invalid thread bootstrap")
        selection = None
        if "playerObservation" in body:
            supplied = body["playerObservation"]
            if not isinstance(supplied, dict) or set(supplied) != {"worldId", "sceneId", "userId", "clientId", "tokenId"}:
                raise HTTPException(400, "Invalid player audience")
            try:
                selection = validate_player_action({**supplied, "requestId": "bootstrap"}, context["worldId"])
            except ValueError:
                raise HTTPException(400, "Invalid player audience") from None
            if not isinstance(store, SqliteStore):
                raise HTTPException(503, "Player observation storage unavailable")
        thread = ThreadMetadata(id=store.generate_thread_id(context), created_at=datetime.now(timezone.utc))
        await store.save_thread(thread, context)
        if selection:
            binding = json.dumps({k: selection[k] for k in ("worldId", "sceneId", "userId", "clientId", "tokenId")}, sort_keys=True)
            store.db.execute("INSERT INTO player_threads VALUES(?,?)", (thread.id, binding))
            store.db.commit()
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
        allowed_inference = {"threads.create", "threads.add_user_message", "threads.custom_action", "threads.retry_after_item"}
        allowed_storage = {"threads.get_by_id", "threads.list", "items.list", "items.feedback", "threads.update", "threads.delete"}
        if not isinstance(operation, str) or operation not in allowed_inference | allowed_storage:
            raise HTTPException(400, "Unsupported ChatKit operation")
        thread_id = params.get("thread_id")
        fixture_id = request.headers.get("x-chatkit-acceptance-fixture")
        if fixture_id:
            fixture = acceptance_fixtures.get(fixture_id)
            if not fixture or time.time() >= fixture["expiresAt"] or any(fixture[key] != context.get(key) for key in ("worldId", "userId", "traceId")) or fixture["threadId"] != thread_id or not isinstance(store, SqliteStore):
                raise HTTPException(403, "Acceptance fixture binding is unavailable or mismatched")
            scope = hashlib.sha256(json.dumps([fixture_id, fixture["worldId"], fixture["userId"], fixture["threadId"], fixture["traceId"]]).encode()).hexdigest()
            context["_acceptanceBudget"] = {"scope": scope, "maxModelRequests": fixture["maxModelRequests"], "expiresAt": fixture["expiresAt"]}
        if thread_id:
            try:
                await store.load_thread(thread_id, context)
            except NotFoundError:
                raise HTTPException(404, "Conversation not found") from None
        player_observation = operation == "threads.custom_action" and params.get("action", {}).get("type") == PLAYER_OBSERVATION_ACTION
        if thread_id and isinstance(store, SqliteStore) and store.db.execute("SELECT 1 FROM player_threads WHERE thread_id=?", (thread_id,)).fetchone() and operation in allowed_inference and not player_observation:
            raise HTTPException(400, "Player observation threads cannot invoke inference or GM history")
        inference = operation in allowed_inference and not player_observation
        key = (store.owner(context), thread_id or "new")
        request_id = None
        if operation == "threads.custom_action":
            action = params.get("action", {})
            if not isinstance(action, dict):
                raise HTTPException(400, "Invalid Foundry action")
            payload = validate_action(action.get("type"), action.get("payload"), context["worldId"])
            request_id = (key, payload["requestId"])
        if inference or player_observation:
            if inference and (not context["apiKey"] or not context["model"]):
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









