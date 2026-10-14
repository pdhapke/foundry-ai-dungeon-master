"""Node test probe: ephemeral controlled HTTP adapter, no model calls."""
import asyncio
import json
import os
from agents.tool_context import ToolContext
from app import build_agent


async def main():
    context = {"apiKey": "mock", "model": "fixture", "readRun": os.environ["CONTRACT_READ_TOKEN"], "internalSecret": "internal", "worldId": "world", "userId": "gm", "threadId": "thread"}
    tools = {tool.name: tool for tool in build_agent(context).tools}

    async def invoke(name, arguments):
        encoded = json.dumps(arguments)
        call = ToolContext(context=context, tool_name=name, tool_call_id="probe", tool_arguments=encoded)
        envelope = json.loads(await tools[name].on_invoke_tool(call, encoded))
        assert envelope["ok"] is True, envelope
        outcome = envelope["result"]
        assert outcome["ok"] is True, outcome
        return outcome["value"]

    search = await invoke("tool_search", {"query": "dice roll", "limit": 4})
    loaded = await invoke("tool_load", {"search_id": search["searchId"], "tool_id": "ai_dm_roll_dice"})
    result = await invoke("tool_execute", {"grant_id": loaded["grant"]["grantId"], "effect": "present", "arguments": {"actionId": "python-probe", "formula": "1d6+3"}})
    assert result["result"]["status"] == "completed", result
    print("Python-to-HTTP-adapter-to-catalog-to-controlled-MCP PASS")


if __name__ == "__main__":
    asyncio.run(main())
