"""Offline extraction of complete direct trace groups; no model or network."""
import json
from collections import defaultdict
from pathlib import Path

root = Path(__file__).resolve().parents[1] / "docs" / "attack-vision-evidence"
groups = defaultdict(dict)
for line in (root / "runtime-start.log").read_text(encoding="utf-8-sig", errors="replace").splitlines():
    try:
        event = json.loads(line)
    except ValueError:
        continue
    if event.get("type") == "pause-timing" and event.get("traceId"):
        groups[event["traceId"]][event["stage"]] = event

samples = []
for trace_id, stages in groups.items():
    required = ["request-arrival", "direct-queue-entered", "direct-action-result", "direct-response-written"]
    if not all(stage in stages for stage in required):
        continue
    arrival, queue, action, written = [stages[stage] for stage in required]
    assert arrival["atMs"] <= queue["atMs"] <= action["atMs"] <= written["atMs"]
    assert all(event["requestArrivedAtMs"] == arrival["atMs"] for event in (queue, action, written))
    samples.append({"traceId": trace_id, "arrivedAtMs": arrival["atMs"], "arrivalToQueueMs": queue["atMs"] - arrival["atMs"], "queueWaitMs": queue["queueWaitMs"],
        "arrivalToBackendResultMs": action["atMs"] - arrival["atMs"], "serviceExecutionMs": action["durationMs"], "arrivalToResponseWrittenMs": written["atMs"] - arrival["atMs"], "resultToResponseWrittenMs": written["atMs"] - action["atMs"]})
samples.sort(key=lambda sample: sample["arrivedAtMs"])
record = {"boundary": "Server arrival/queue/backend result/response-written, same trace ID. Browser delivery and paint not measured. Action/correlation IDs absent from these trace stages: command labels cannot be proven from trace alone.", "classification": "Direct zero-model controls only; cold/warm unknown; individual observations, no distribution claim", "sampleCount": len(samples), "samples": samples}
(root / "independent-direct-timings.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
print(json.dumps(record))
