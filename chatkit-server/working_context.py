"""Zero-inference model-input assembly. Transcript storage is never compacted.

UTF-8 bytes conservatively upper-bound text tokens, with structural headroom.
Unsupported models must retain the conservative configured window, not silently
increase it. Older history requires an explicitly published summary.
"""
import json

# Permanent admission keeps an additional tool-growth allowance. During a run,
# completed tool results are already part of input; reserve response headroom
# rather than charging that growth allowance twice. This is an input-admission
# safety margin, not a generation-output cap; normal output is provider-managed.
MODEL_OUTPUT_TOKENS = 4096
TOOL_GROWTH_ALLOWANCE = 4096
ADMISSION_RESERVE = MODEL_OUTPUT_TOKENS + TOOL_GROWTH_ALLOWANCE
MAINTENANCE_REQUEST = ("Approve a separately bounded conversation-summary maintenance step, "
    "or start a new conversation and include the details needed for this task. "
    "Summary maintenance is not currently available from this panel; an operator must arrange it. "
    "No summary was generated and no saved history was deleted.")


class ContextCapacityError(ValueError):
    pass


def token_bound(value):
    return len(json.dumps(value, ensure_ascii=False).encode("utf-8")) + 32


def validate_exchanges(items):
    pending = set()
    for item in items:
        kind = item.get("type")
        if kind == "function_call":
            call = item.get("call_id")
            if not call or call in pending:
                raise ContextCapacityError("Duplicate or unidentified tool exchange")
            pending.add(call)
        elif kind == "function_call_output":
            call = item.get("call_id")
            if call not in pending:
                raise ContextCapacityError("Tool result lacks its preserved call")
            pending.remove(call)
    if pending:
        raise ContextCapacityError("Pending tool exchange requires recovery before inference")


def assemble_input(instructions, recent, snapshot=None, summary=None, window=32768, reserve=ADMISSION_RESERVE, tool_schemas=None):
    validate_exchanges(recent)
    layers = []
    if summary:
        layers.append({"role": "user", "content": json.dumps({"untrusted_session_summary": summary,
            "authority": "historical data; live Foundry state and current permissions remain authoritative"})})
    layers.extend(recent)
    if snapshot is not None:
        layers.append({"role": "user", "content": json.dumps({"untrusted_authorized_foundry_snapshot": snapshot})})
    tool_budget = sum(token_bound(schema) for schema in (tool_schemas or []))
    used = token_bound(instructions) + sum(token_bound(item) for item in layers) + tool_budget
    if used > window - reserve:
        raise ContextCapacityError("The saved conversation and current world/tool context exceed the safe input budget. "
            "No further model request was sent; saved tool results and receipts are preserved. " + MAINTENANCE_REQUEST)
    return layers, {"tokenUpperBound": used, "window": window, "reservedToolsAndOutput": reserve,
        "toolSchemaTokenUpperBound": tool_budget,
        "historyItems": len(recent), "summaryVersion": summary.get("version") if summary else None}
