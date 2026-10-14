"""Authenticated internal gateway entry, bound to the existing private store."""
import json
import re
from fastapi import APIRouter, HTTPException, Request
from .workflow import InterviewSession, build_request, template_resource, validate_mock_output, player_safe_report
from .pipeline import PreparationPipeline


def create_preparation_router(authenticate, store):
    router = APIRouter()
    db = getattr(store, "db", None)
    if db is not None:
        db.execute("CREATE TABLE IF NOT EXISTS preparation_interviews (world_id TEXT NOT NULL, user_id TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(world_id,user_id,session_id))")
        db.execute("CREATE TABLE IF NOT EXISTS preparation_pipelines (world_id TEXT NOT NULL, user_id TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(world_id,user_id,session_id))")
        db.commit()

    @router.post("/preparation")
    async def preparation(request: Request):
        context = authenticate(request)
        raw = await request.body()
        if len(raw) > 42000:
            raise HTTPException(413, "Preparation input too large")
        try:
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("Object required")
            action = payload.get("action")
            allowed = {"template": {"action", "passId"}, "request": {"action", "passId", "inputs"},
                       "validate": {"action", "passId", "inputs", "output"},
                       "pipeline": {"action", "sessionId", "operation", "inputs", "output", "passId", "expectedRevision"},
                       "interview": {"action", "sessionId", "operation", "audience", "expectedRevision", "questionId", "text", "mode", "approved"}}
            if action not in allowed or set(payload) - allowed[action]:
                raise ValueError("Unexpected preparation action fields")
            if action == "template":
                return template_resource(payload["passId"])
            if action in ("request", "validate"):
                inputs = payload["inputs"]
                if inputs.get("worldId") != context["worldId"]:
                    raise ValueError("World binding mismatch")
                if action == "request":
                    return build_request(payload["passId"], inputs)
                result = validate_mock_output(payload["passId"], inputs, payload["output"])
                return {**result, "playerSafeReport": player_safe_report(payload["output"])}
            if action not in ("interview", "pipeline") or db is None:
                raise ValueError("Unsupported action or private store unavailable")
            session_id = payload.get("sessionId")
            if not isinstance(session_id, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session_id) is None:
                raise ValueError("Bounded session ID required")
            key = (context["worldId"], context["userId"], session_id)
            if action == "pipeline":
                operation = payload.get("operation", "status")
                allowed_fields = {"create": {"inputs"}, "status": set(), "request": set(), "submit": {"inputs", "output", "passId", "expectedRevision"},
                                  "pause": {"expectedRevision"}, "resume": {"expectedRevision"}, "cancel": {"expectedRevision"}}
                if operation not in allowed_fields or set(payload) - {"action", "sessionId", "operation"} - allowed_fields[operation]:
                    raise ValueError("Unexpected pipeline fields")
                row = db.execute("SELECT revision,body FROM preparation_pipelines WHERE world_id=? AND user_id=? AND session_id=?", key).fetchone()
                if operation == "create":
                    inputs = payload["inputs"]
                    if inputs.get("worldId") != context["worldId"]:
                        raise ValueError("Pipeline world binding mismatch")
                    if row:
                        pipeline = PreparationPipeline.restore(json.loads(row[1]), context["worldId"])
                        if pipeline.state["inputs"] != inputs:
                            raise ValueError("Existing pipeline has different inputs")
                    else:
                        pipeline = PreparationPipeline(inputs)
                elif row:
                    pipeline = PreparationPipeline.restore(json.loads(row[1]), context["worldId"])
                else:
                    raise ValueError("Pipeline unavailable")
                if operation == "request":
                    return pipeline.request()
                if operation == "submit":
                    if payload["inputs"].get("worldId") != context["worldId"]:
                        raise ValueError("Pipeline source world mismatch")
                    pipeline.submit(payload["passId"], payload["inputs"], payload["output"], payload.get("expectedRevision"))
                elif operation in ("pause", "resume", "cancel"):
                    pipeline.control(operation, payload.get("expectedRevision"))
                if not row:
                    db.execute("INSERT INTO preparation_pipelines VALUES(?,?,?,?,?)", (*key, pipeline.state["revision"], json.dumps(pipeline.state)))
                elif operation in ("submit", "pause", "resume", "cancel"):
                    changed = db.execute("UPDATE preparation_pipelines SET revision=?,body=? WHERE world_id=? AND user_id=? AND session_id=? AND revision=?", (pipeline.state["revision"], json.dumps(pipeline.state), *key, row[0])).rowcount
                    if changed != 1:
                        raise ValueError("Concurrent pipeline edit")
                db.commit()
                return pipeline.status()
            row = db.execute("SELECT revision,body FROM preparation_interviews WHERE world_id=? AND user_id=? AND session_id=?", key).fetchone()
            operation = payload.get("operation", "read")
            operation_fields = {"start": {"audience"}, "read": set(), "answer": {"expectedRevision", "questionId", "text", "mode", "approved"},
                                "pause": {"expectedRevision"}, "resume": {"expectedRevision"}}
            if operation not in operation_fields or set(payload) - {"action", "sessionId", "operation"} - operation_fields[operation]:
                raise ValueError("Unexpected interview fields")
            if "approved" in payload and type(payload["approved"]) is not bool:
                raise ValueError("Approval must be boolean")
            if row:
                session = InterviewSession.restore(json.loads(row[1]), context["worldId"])
            elif operation == "start":
                session = InterviewSession(context["worldId"], session_id, payload.get("audience", "player"))
            else:
                raise ValueError("Interview unavailable")
            if operation in ("answer", "pause", "resume"):
                if type(payload.get("expectedRevision")) is not int or payload.get("expectedRevision") != session.revision:
                    raise ValueError("Stale interview revision")
                if operation == "answer":
                    session.answer(payload["questionId"], payload["text"], session.revision, payload.get("mode", "out-of-character"), payload.get("approved") is True)
                elif operation == "pause":
                    session.pause()
                else:
                    session.resume(context["worldId"])
            elif operation not in ("start", "read"):
                raise ValueError("Unknown interview operation")
            body = json.dumps(session.snapshot())
            if row and operation in ("answer", "pause", "resume"):
                changed = db.execute("UPDATE preparation_interviews SET revision=?,body=? WHERE world_id=? AND user_id=? AND session_id=? AND revision=?", (session.revision, body, *key, row[0])).rowcount
                if changed != 1:
                    raise ValueError("Concurrent interview edit")
            elif not row:
                db.execute("INSERT INTO preparation_interviews VALUES(?,?,?,?,?)", (*key, session.revision, body))
            db.commit()
            return {"session": session.snapshot(), "questions": session.next_questions(), "private": True, "modelCalls": 0}
        except (ValueError, KeyError, TypeError, AttributeError):
            if db is not None:
                db.rollback()
            raise HTTPException(400, "Invalid preparation request or stale private interview") from None

    return router
