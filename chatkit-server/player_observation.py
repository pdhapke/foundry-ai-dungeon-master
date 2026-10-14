"""Deterministic player output lane. Never consumes GM history or model prose."""
import json
import re
import uuid

ACTION = "foundry.player-observation"
ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
DIGEST = re.compile(r"^[a-f0-9]{64}$")


def validate_player_action(payload, world_id):
    keys = {"requestId", "worldId", "sceneId", "userId", "clientId", "tokenId"}
    if not isinstance(payload, dict) or set(payload) != keys or any(not isinstance(payload[k], str) or not ID.fullmatch(payload[k]) for k in keys):
        raise ValueError("Invalid player observation selection")
    if payload["worldId"] != world_id:
        raise ValueError("Player observation world mismatch")
    return dict(payload)


def project_observation(raw, selection):
    """Only allowlisted native readiness produces deterministic public text.

    Native visible IDs are deliberately absent even on success. No area metadata,
    secret counts, diagnostics or environmental explanation is inferred.
    """
    unavailable = {"version": 1, "status": "incomplete", "facts": [], "text": "Player observations are unavailable; no description is confirmed."}
    if not isinstance(raw, dict):
        return unavailable
    if "ok" in raw and raw.get("ok") is not True:
        return unavailable
    report = raw.get("result") if raw.get("ok") is True else raw
    if not isinstance(report, dict):
        return unavailable
    status = report.get("status")
    if status != "complete":
        codes = {v.get("code") for v in report.get("issues", []) if isinstance(v, dict) and isinstance(v.get("code"), str)} if isinstance(report.get("issues"), list) else set()
        state = "NOT_CONNECTED" if "PLAYER_CLIENT_UNAVAILABLE" in codes else "stale" if status == "stale" else "unsupported" if status == "unsupported" else "incomplete"
        return {**unavailable, "status": state}
    seen = report.get("observation")
    if not isinstance(seen, dict):
        return unavailable
    fields = {"worldId": "worldId", "sceneId": "sceneId", "userId": "userId", "clientId": "clientId", "tokenId": "tokenId"}
    if any(seen.get(k) != selection[v] for k, v in fields.items()) or seen.get("isGM") is not False or seen.get("optedIn") is not True or seen.get("readiness") != "ready" or type(seen.get("pendingRenderFlags")) is not int or seen.get("pendingRenderFlags") != 0:
        return unavailable
    try:
        uuid.UUID(seen["id"])
    except (KeyError, ValueError, TypeError, AttributeError):
        return unavailable
    revision = seen.get("stateRevision")
    persistence = report.get("persistence")
    if not isinstance(revision, str) or not DIGEST.fullmatch(revision) or not isinstance(persistence, dict) or persistence.get("unchanged") is not True or persistence.get("beforeRevision") != revision or persistence.get("afterRevision") != revision:
        return unavailable
    # Native perception does not supply player-safe labels or semantic area prose.
    # Acknowledging validated readiness does not assert a threat/reveal/trap result.
    binding = {k: seen[k] for k in fields}
    binding.update(stateRevision=revision, observationId=seen["id"])
    return {"version": 1, "status": "ready", "binding": binding, "facts": [], "text": "Player perception is ready. A descriptive surroundings result is not yet supported."}


class PlayerObservationStore:
    """Separate approved-output records; never a SDK tool-protocol history."""
    def __init__(self, db):
        self.db = db
        db.execute("CREATE TABLE IF NOT EXISTS player_observations (id TEXT PRIMARY KEY, audience TEXT NOT NULL, body TEXT NOT NULL)")
        db.commit()

    def save(self, request_id, selection, result):
        audience = json.dumps([selection["worldId"], selection["sceneId"], selection["userId"], selection["clientId"], selection["tokenId"]])
        record_id = json.dumps([audience, request_id])
        body = json.dumps(result)
        prior = self.db.execute("SELECT body FROM player_observations WHERE id=? AND audience=?", (record_id, audience)).fetchone()
        if prior and prior[0] != body:
            raise ValueError("Player observation request already recorded; use a new request")
        self.db.execute("INSERT OR IGNORE INTO player_observations VALUES(?,?,?)", (record_id, audience, body))
        self.db.commit()
        return record_id

    def load(self, request_id, selection):
        audience = json.dumps([selection["worldId"], selection["sceneId"], selection["userId"], selection["clientId"], selection["tokenId"]])
        row = self.db.execute("SELECT body FROM player_observations WHERE id=? AND audience=?", (json.dumps([audience, request_id]), audience)).fetchone()
        return json.loads(row[0]) if row else None



def project_surroundings(raw, selection):
    """Consume only the authenticated adapter's typed observable/reveal contract.

    Private provenance stays outside public text; unknown observations do not
    become affirmative claims. This lane performs no retrieval or model pass.
    """
    unavailable = {"version": 1, "status": "incomplete", "facts": [], "unknowns": ["area", "threat", "being-noticed", "trap"], "text": "Player observations are unavailable; no description is confirmed."}
    if not isinstance(raw, dict) or ("ok" in raw and raw.get("ok") is not True):
        return unavailable
    value = raw.get("result") if raw.get("ok") is True else raw
    if not isinstance(value, dict):
        return unavailable
    if value.get("status") != "ready":
        status = value.get("status")
        issues = value.get("issues")
        if isinstance(issues, list) and any(isinstance(issue, dict) and issue.get("code") in ("NOT_CONNECTED", "PLAYER_CLIENT_UNAVAILABLE") for issue in issues):
            status = "NOT_CONNECTED"
        return {**unavailable, "status": status if status in ("NOT_CONNECTED", "stale", "unsupported", "incomplete") else "incomplete"}
    binding = value.get("binding")
    required = {"worldId", "sceneId", "userId", "clientId", "tokenId", "stateRevision", "observationId"}
    if set(value) != {"version", "status", "binding", "facts", "unknowns", "sourceRevision"} or value.get("version") != 1 or type(value.get("version")) is not int or not isinstance(binding, dict) or set(binding) != required:
        return unavailable
    if any(binding.get(k) != selection[k] for k in ("worldId", "sceneId", "userId", "clientId", "tokenId")):
        return unavailable
    revision = binding.get("stateRevision")
    source_revision = value.get("sourceRevision")
    if not isinstance(revision, str) or not DIGEST.fullmatch(revision) or not isinstance(source_revision, str) or not DIGEST.fullmatch(source_revision):
        return unavailable
    try:
        uuid.UUID(binding["observationId"])
    except (KeyError, ValueError, TypeError, AttributeError):
        return unavailable
    facts, unknowns = value.get("facts"), value.get("unknowns")
    kinds = {"visible-barrier": "unobserved-area", "visible-door": "unobserved-area", "public-description": "unobserved-area"}
    allowed_unknowns = {"threat", "being-noticed", "trap", "unobserved-area"}
    if not isinstance(facts, list) or len(facts) > 16 or not isinstance(unknowns, list) or any(not isinstance(v, str) or v not in allowed_unknowns for v in unknowns) or len(set(unknowns)) != len(unknowns) or not {"threat", "being-noticed", "trap", "unobserved-area"}.issubset(unknowns):
        return unavailable
    approved = []
    for fact in facts:
        if not isinstance(fact, dict) or set(fact) != {"kind", "description", "basis", "decision"}:
            return unavailable
        kind, text, basis, decision = fact.get("kind"), fact.get("description"), fact.get("basis"), fact.get("decision")
        if not isinstance(kind, str) or kind not in kinds or not isinstance(text, str) or not text.strip() or len(text) > 1000 or any(ord(c) < 32 and c not in '\n\t' for c in text) or basis != ("native-visible-query-point" if kind == "public-description" else "native-visible-barrier"):
            return unavailable
        if not isinstance(decision, dict) or set(decision) != {"visibility", "audience", "activation", "dependencies", "policyRevision"} or decision.get("visibility") != "public":
            return unavailable
        audience = decision.get("audience")
        if audience != {"kind": "public"}:
            return unavailable
        if decision.get("visibility") == "public" and audience != {"kind": "public"}:
            return unavailable
        if decision.get("activation") != {"status": "active", "conditionRef": None} or not isinstance(decision.get("policyRevision"), str) or decision["policyRevision"] != "player-surroundings-v1":
            return unavailable
        dependencies = decision.get("dependencies")
        if not isinstance(dependencies, list) or not dependencies or len(dependencies) > 32:
            return unavailable
        for dependency in dependencies:
            if not isinstance(dependency, dict) or set(dependency) != {"nodeId", "revision"} or any(not isinstance(dependency.get(k), str) or not DIGEST.fullmatch(dependency[k]) for k in ("nodeId", "revision")):
                return unavailable
        # No private provenance, source labels or opaque IDs are public prose.
        approved.append({"kind": kind, "description": text, "basis": basis, "decision": {
            "visibility": "public", "audience": {"kind": "public"},
            "activation": {"status": "active", "conditionRef": None},
            "dependencies": [{"nodeId": d["nodeId"], "revision": d["revision"]} for d in dependencies],
            "policyRevision": "player-surroundings-v1"}})
    if not approved:
        return {**unavailable, "status": "unsupported"}
    return {"version": 1, "status": "ready", "binding": dict(binding), "sourceRevision": source_revision,
            "facts": approved, "unknowns": list(unknowns), "text": " ".join(f["description"] for f in approved)}



