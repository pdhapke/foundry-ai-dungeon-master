# AI Dungeon Master bootstrap tool protocol

Generated from `server/src/runner/bootstrap-tools.ts`. Provider tools are discovered from the live trusted catalog and are intentionally not copied into this document.

Total stable bootstrap tools: 10

## `context_get_root`

Read the deterministic root context manifest for this run.

```json
{
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false
}
```

## `context_read`

Read specific permitted context nodes by opaque node ID.

```json
{
  "type": "object",
  "properties": {
    "nodeIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "minItems": 1,
      "maxItems": 16
    }
  },
  "required": ["nodeIds"],
  "additionalProperties": false
}
```

## `context_expand`

Traverse permitted relationships from context nodes within the run budget.

```json
{
  "type": "object",
  "properties": {
    "nodeIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "minItems": 1,
      "maxItems": 8
    },
    "relation": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80
    },
    "depth": {
      "type": "integer",
      "minimum": 1,
      "maximum": 4
    }
  },
  "required": ["nodeIds", "relation", "depth"],
  "additionalProperties": false
}
```

## `context_search`

Search only context visible to the current resolver or presenter view.

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 16
    }
  },
  "required": ["query", "limit"],
  "additionalProperties": false
}
```

## `context_get_changes`

Read revision changes for already-known permitted context node references.

```json
{
  "type": "object",
  "properties": {
    "refs": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "minItems": 1,
      "maxItems": 32
    }
  },
  "required": ["refs"],
  "additionalProperties": false
}
```

## `context_get_source`

Read a bounded permitted excerpt through an opaque provenance handle.

```json
{
  "type": "object",
  "properties": {
    "sourceRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "startLine": {
      "type": "integer",
      "minimum": 1
    },
    "endLine": {
      "type": "integer",
      "minimum": 1
    }
  },
  "required": ["sourceRef", "startLine", "endLine"],
  "additionalProperties": false
}
```

## `tool_search`

Search trusted available operational capabilities by desired outcome.

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "minLength": 1,
      "maxLength": 1000
    },
    "alreadyLoaded": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "maxItems": 32
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 12
    }
  },
  "required": ["query", "alreadyLoaded", "limit"],
  "additionalProperties": false
}
```

## `tool_load`

Load full schemas for explicitly selected trusted tool descriptors.

```json
{
  "type": "object",
  "properties": {
    "toolIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "minItems": 1,
      "maxItems": 12
    }
  },
  "required": ["toolIds"],
  "additionalProperties": false
}
```

## `state_propose`

Submit a typed non-committing proposal for consequential state changes.

```json
{
  "type": "object",
  "properties": {
    "summary": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "operations": {
      "type": "array",
      "items": {
        "type": "object"
      },
      "minItems": 1,
      "maxItems": 12
    }
  },
  "required": ["summary", "operations"],
  "additionalProperties": false
}
```

## `run_complete`

Complete the run with recipient-safe output after all required context and proposal work.

```json
{
  "type": "object",
  "properties": {
    "finalText": {
      "type": "string",
      "minLength": 1,
      "maxLength": 40000
    },
    "contextReceiptId": {
      "type": ["string", "null"]
    },
    "proposalIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "maxItems": 12
    }
  },
  "required": ["finalText", "contextReceiptId", "proposalIds"],
  "additionalProperties": false
}
```
