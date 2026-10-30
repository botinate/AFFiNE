# BYOK: OpenAI-compatible models (models.dijar.ch)

Embeddings and transcription are provider-agnostic. Two knobs make custom
OpenAI-compatible models work:

- **`interface` on a BYOK model declaration** — `"chat"` (default) runs the
  normal LLM path; `"audio_transcriptions"` runs the whisper-style
  `POST {endpoint}/audio/transcriptions` path for the `transcript.audio` slot.
- **Embedding dimension tolerance** — the provider is asked for 1024 dims but
  shorter responses are zero-padded to the 1024 storage contract (cosine
  distances are exact under zero-padding), so e.g. a 768-dim `ebbinghaus`
  coexists with 1024-dim models. Responses longer than 1024 are rejected.

## 1. Config

Set (admin config / `updateAppConfig` / config file):

```
copilot.byok.allowCustomEndpoint = true
```

(`copilot.byok.enabled` defaults to true, `allowedProviders` already includes
`openai`.) BYOK is entitlement-gated; on self-hosted it is allowed for any
workspace with an owner.

## 2. Create the profile

Run once per workspace (as workspace admin). `interface` is only settable via
this mutation — the settings UI preserves it on later edits.

```graphql
mutation {
  createWorkspaceByokProfile(input: {
    workspaceId: "<workspace-id>"
    provider: openai
    name: "models.dijar.ch"
    description: "Self-hosted llama-swap gateway"
    credential: "not-needed"
    enabled: true
    definition: {
      endpoint: {
        kind: openai_compatible
        url: "https://models.dijar.ch/v1"
        dialect: chat_completions
      }
      models: [
        {
          modelId: "ebbinghaus"
          enabled: true
          capabilities: [{
            input: [text]
            output: [embedding]
            features: []
            attachmentKinds: []
            attachmentSources: []
          }]
        }
        {
          modelId: "edison-en"
          enabled: true
          interface: "audio_transcriptions"
          capabilities: [{
            input: [audio]
            output: [structured]
            features: []
            attachmentKinds: [audio]
            attachmentSources: [url, data, bytes, file_handle]
          }]
        }
        {
          modelId: "edison-ch"
          enabled: true
          interface: "audio_transcriptions"
          capabilities: [{
            input: [audio]
            output: [structured]
            features: []
            attachmentKinds: [audio]
            attachmentSources: [url, data, bytes, file_handle]
          }]
        }
        {
          modelId: "aristotle-smart"
          enabled: true
          capabilities: [{
            input: [text]
            output: [structured]
            features: []
            attachmentKinds: []
            attachmentSources: []
          }]
        }
      ]
    }
  }) { profileId }
}
```

Notes:

- `input: [audio]` on the Edison models keeps them out of the text-only
  summary step (capability matching is by declared input/output), so
  transcription and summarization route to different models automatically.
- The meeting-summary step needs a chat model that accepts JSON-schema
  structured output (`response_format: json_schema`). llama.cpp backends
  require `--jinja` for this; if the summary step errors, run llama-swap with
  `--jinja`, or add a second BYOK profile with a real OpenAI key as fallback
  (profiles are tried in `sortOrder`).
- Whisper-style models must not be used for chat: they are only routed for the
  transcription slot.

## 3. Verify

1. Settings → workspace → AI / BYOK: run "Test" — the embedding model probe
   hits `/v1/embeddings` and should verify.
2. Upload a short audio file to a doc → transcribe. Segments arrive with
   speaker defaulting to `Speaker`, times in seconds.
3. Check `copilotUsage` / BYOK usage metering — ASR calls record zero tokens.
