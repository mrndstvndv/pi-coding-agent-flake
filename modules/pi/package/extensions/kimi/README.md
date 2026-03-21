# Kimi Extension

Moonshot AI (Kimi) provider integration for pi-coding-agent.

## Available Models

| Model | Context | Reasoning | Vision | Cost (input/output) |
|-------|---------|-----------|--------|---------------------|
| **kimi-for-coding** | 262K | ✅ | ❌ | Free (Beta) |
| **kimi-k2.5** | 262K | ✅ | ✅ | $0.6 / $3.0 |
| **kimi-latest** | 131K | ❌ | ✅ | $1.0 / $3.0 |
| **kimi-k2-turbo-preview** | 262K | ❌ | ❌ | $1.15 / $8.0 |
| **kimi-k2-thinking** | 262K | ✅ | ❌ | $0.6 / $2.5 |
| **moonshot-v1-8k** | 8K | ❌ | ❌ | $0.2 / $2.0 |
| **moonshot-v1-32k** | 32K | ❌ | ❌ | $1.0 / $3.0 |
| **moonshot-v1-128k** | 128K | ❌ | ❌ | $2.0 / $5.0 |

## Setup

### 1. Get API Key

Visit [Kimi Code Membership](https://www.kimi.com/code) to generate an API key.

### 2. Login

```bash
/login kimi
```

Enter your API key when prompted.

### 3. Select Model

```bash
# List available kimi models
/model kimi

# Select a specific model
/model kimi/kimi-k2.5
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `KIMI_BASE_URL` | Custom API endpoint | `https://api.kimi.com/coding/v1` |
| `MOONSHOT_BASE_URL` | Alternative base URL variable | - |
| `KIMI_USER_AGENT` | Custom User-Agent string | `KimiCLI/1.8.0` |

## Usage

Once logged in and a model is selected, use `pi` normally. The extension will:

- Automatically handle authentication via OAuth flow
- Use proper OpenAI-compatible API format
- Support reasoning/thinking modes for applicable models
- Handle vision input for models that support it

## Compatibility

This extension uses:
- **API**: `openai-completions` (OpenAI-compatible)
- **System Role**: Maps `developer` → `system` (legacy format)
- **Token Field**: Uses `max_tokens` instead of `max_completion_tokens`

## License

MIT
