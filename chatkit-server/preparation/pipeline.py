"""Private persisted orchestration; every model-produced step is submitted data."""
import copy
import hashlib
import json
from .workflow import build_request, validate_mock_output, VERSION

ORDER = ("inventory", "interview", "records", "retrieval", "validation")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


class PreparationPipeline:
    def __init__(self, inputs):
        build_request("inventory", inputs)
        self.state = {"version": VERSION, "inputs": copy.deepcopy(inputs), "inputDigest": digest(inputs),
                      "sourceManifest": [{"id": s["id"], "revision": s["revision"], "contentHash": digest(s["content"])} for s in inputs["sources"]],
                      "answersDigest": digest(inputs.get("answers", [])), "revision": 0, "status": "pending",
                      "steps": {step: {"status": "pending"} for step in ORDER}}

    @classmethod
    def restore(cls, state, world_id):
        if state.get("version") != VERSION or state.get("inputs", {}).get("worldId") != world_id:
            raise ValueError("Pipeline world/version mismatch")
        obj = cls(state["inputs"])
        if obj.state["inputDigest"] != state.get("inputDigest"):
            raise ValueError("Pipeline manifest mismatch")
        obj.state = copy.deepcopy(state)
        return obj

    def current(self):
        return next((step for step in ORDER if self.state["steps"][step]["status"] != "completed"), None)

    def _revision(self, expected):
        if type(expected) is not int or expected != self.state["revision"]:
            raise ValueError("Stale pipeline revision")

    def submit(self, pass_id, inputs, output, expected_revision):
        self._revision(expected_revision)
        if self.state["status"] not in ("pending", "blocked"):
            raise ValueError("Pipeline cannot receive a step in its current state")
        if pass_id != self.current():
            raise ValueError("Pipeline dependency order violation")
        build_request(pass_id, inputs)
        if digest(inputs) != self.state["inputDigest"]:
            self.state["status"] = "stale"
            self.state["steps"][pass_id]["status"] = "stale"
            self.state["revision"] += 1
            return self.status()
        result = validate_mock_output(pass_id, self.request()["untrustedInput"], output)
        blocked = output["status"] == "blocked"
        self.state["steps"][pass_id] = {"status": "blocked" if blocked else "completed", "output": copy.deepcopy(output),
                                       "outputDigest": digest(output), "validation": result}
        self.state["status"] = "blocked" if blocked else "completed" if self.current() is None else "pending"
        self.state["revision"] += 1
        return self.status()

    def request(self):
        if self.state["status"] not in ("pending", "blocked") or self.current() is None:
            raise ValueError("Pipeline is not ready for a request")
        inputs = copy.deepcopy(self.state["inputs"])
        prior = []
        for step in ORDER:
            if step == self.current():
                break
            saved = self.state["steps"][step]
            if saved["status"] != "completed" or digest(saved["output"]) != saved.get("outputDigest"):
                raise ValueError("Pipeline prior output integrity mismatch")
            # Recheck each prior pass against the exact earlier inputs, keeping
            # structured candidates with their pass/field identity as data.
            earlier = copy.deepcopy(inputs)
            if prior:
                earlier["priorOutputs"] = copy.deepcopy(prior)
            validate_mock_output(step, earlier, saved["output"])
            for name, value in saved["output"].items():
                if name in ("worldId", "version", "status", "readiness"):
                    continue
                for item in value if isinstance(value, list) else [value]:
                    prior.append({"passId": step, "field": name, "candidate": copy.deepcopy(item)})
        if prior:
            inputs["priorOutputs"] = prior
        # The usual input byte/array bounds refuse oversized composition; no
        # source or qualification is silently truncated to fit the next pass.
        return {**build_request(self.current(), inputs), "pipelineRevision": self.state["revision"], "publicationApproved": False}

    def control(self, operation, expected_revision):
        self._revision(expected_revision)
        status = self.state["status"]
        if operation == "cancel" and status not in ("cancelled", "completed"):
            self.state["status"] = "cancelled"
        elif operation == "pause" and status in ("pending", "blocked"):
            self.state["status"] = "paused"
        elif operation == "resume" and status == "paused":
            self.state["status"] = "pending"
        else:
            raise ValueError("Invalid pipeline state transition")
        self.state["revision"] += 1
        return self.status()

    def status(self):
        return {"version": VERSION, "worldId": self.state["inputs"]["worldId"], "revision": self.state["revision"],
                "status": self.state["status"], "currentPass": self.current(), "inputDigest": self.state["inputDigest"],
                "sourceManifest": copy.deepcopy(self.state["sourceManifest"]), "answersDigest": self.state["answersDigest"],
                "steps": {step: {key: value for key, value in result.items() if key in ("status", "outputDigest")} for step, result in self.state["steps"].items()},
                "modelCalls": 0, "publicationApproved": False, "private": True}
