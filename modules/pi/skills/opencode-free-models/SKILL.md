---
name: opencode-free-models
description: Add new free models to the OpenCode Zen provider extension
---

# OpenCode Free Models Skill

This skill documents the process for discovering and adding new free models to the OpenCode Zen provider extension (`modules/pi/package/extensions/opencode-free.ts`).

## Overview

The opencode-free extension provides free access to select AI models via the OpenCode Zen API when `OPENCODE_API_KEY` is not set (using public/anonymous access). This skill explains how to identify additional free models that work without authentication and add them to the extension.

## Discovering Available Free Models

Free models accessible via public API can be discovered through:

### 1. Check OpenCode Zen Models Endpoint
```bash
curl -s "https://opencode.ai/zen/v1/models" -H "Authorization: Bearer public" | \
  jq '.data[] | select(.id | test("free"; "i")) | {id: .id}'
```

### 2. Verify Model Specifications
```bash
curl -s "https://models.dev/api.json" | \
  jq 'to_entries | .[].value.models | to_entries | .[] | select(.key == "MODEL-ID") | 
      {model: .key, context: .value.limit.context, output: .value.limit.output, reasoning: .value.reasoning}'
```

## Recent Addition: nemotron-3-super-free and mimo-v2-flash-free

Following this process, two new free models were identified and added:

### nemotron-3-super-free
- **Provider**: NVIDIA
- **Context Window**: 1,000,000 tokens
- **Max Output**: 128,000 tokens  
- **Capabilities**: Reasoning, text input/output
- **Cost**: Free (0 input, 0 output)

### mimo-v2-flash-free  
- **Provider**: Unknown (via OpenCode Zen)
- **Context Window**: 262,144 tokens
- **Max Output**: 65,536 tokens
- **Capabilities**: Reasoning, text input/output
- **Cost**: Free (0 input, 0 output)

## How to Add a New Free Model

To add a new free model to `opencode-free.ts`:

### 1. Locate the Extension File
```bash
modules/pi/package/extensions/opencode-free.ts
```

### 2. Add Model to the Provider Registration
Inside the `models` array in `pi.registerProvider("opencode", { ... })`, add:

```typescript
{
  id: "your-model-id-free",
  name": "Your Model Display Name",
  reasoning": true/false,  // Based on model capabilities
  input": ["text"],        // or ["text", "image"] for multimodal
  cost": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow": CONTEXT_SIZE,  // From models.dev API
  maxTokens": OUTPUT_SIZE,       // From models.dev API or tested safe limit
  compat": {
    supportsDeveloperRole": false,
    maxTokensField": "max_tokens",
  },
},
```

### 3. Update Documentation
- Add the model to the "Free models available" list in the header comment
- Update the count in the note about accessible models (e.g., "these four are accessible")

### 4. Verify Existing Model Specifications
When adding new models, verify existing ones still match the API:
- Check contextWindow and maxTokens values against models.dev
- Ensure reasoning flag is set correctly

## Verification Steps

After adding a model:
1. Save the file and restart pi
2. Use `/model` command to select the new model
3. Test with a simple prompt to verify connectivity
4. Check that token limits work as expected

## Important Notes

- **Public API Only**: Only add models verified to work with `OPENCODE_API_KEY` unset (public/anonymous access)
- **Conservative Limits**: Start with safe maxTokens values; some providers may enforce stricter limits than advertised
- **Model Capabilities**: Adjust the `input` array based on actual model capabilities (text, image, audio, etc.)
- **Authentication**: If a model requires API key, it should NOT be added to this free models extension

## Related Resources

- Extension File: `modules/pi/package/extensions/opencode-free.ts`
- OpenCode Zen API: https://opencode.ai/zen/v1  
- Models.dev API: https://models.dev/api.json
- OpenCode Repository: https://github.com/anomalyco/opencode