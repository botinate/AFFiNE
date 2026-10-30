//! Whisper-style `/audio/transcriptions` execution for models declared with
//! `interface: "audio_transcriptions"`.
//!
//! The ASR response is mapped onto the same structured-response contract the
//! LLM path produces (`[{ a, s, e, t }]` segments), so the TypeScript
//! transcription pipeline is unchanged.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use llm_adapter::{
  backend::{BackendError, BackendHttpClient, DefaultHttpClient, HttpBody, HttpRequest, MultipartPart},
  core::{CoreContent, CoreUsage, StructuredResponse},
  router::{ExecutableRequest, ExecutableResponse},
};
use serde_json::{Value, json};
use uuid::Uuid;
use zeroize::Zeroizing;

use super::{COPILOT_REQUEST_TIMEOUT, RuntimeError, RuntimeResult, dispatch};
use crate::llm::{
  byok::{CredentialEnvelopeKey, ModelInterface},
  route::{AuthorizedProviderProfile, AuthorizedTargetRef},
};

pub(super) fn extract_audio(request: &ExecutableRequest) -> RuntimeResult<(String, Vec<u8>)> {
  let ExecutableRequest::Structured(request) = request else {
    return Err(RuntimeError::invalid_state(
      "audio transcription requires a structured request",
    ));
  };
  for content in request.messages.iter().flat_map(|message| &message.content) {
    let CoreContent::Audio { source } = content else {
      continue;
    };
    return decode_audio_source(source);
  }
  Err(RuntimeError::invalid_input("audio transcription request has no audio attachment"))
}

fn decode_audio_source(source: &Value) -> RuntimeResult<(String, Vec<u8>)> {
  let media_type = source
    .get("media_type")
    .and_then(Value::as_str)
    .map(str::to_string)
    .unwrap_or_else(|| "audio/wav".to_string());
  let data = source
    .get("data")
    .or_else(|| source.get("data_base64"))
    .and_then(Value::as_str);
  let data = data.or_else(|| {
    source
      .get("url")
      .and_then(Value::as_str)
      .and_then(|url| url.strip_prefix("data:"))
      .and_then(|data| data.split_once(','))
      .filter(|(header, _)| header.ends_with(";base64"))
      .map(|(_, data)| data)
  });
  let Some(data) = data else {
    return Err(RuntimeError::invalid_state(
      "audio transcription requires inlined audio data",
    ));
  };
  let bytes = BASE64
    .decode(data)
    .map_err(|_| RuntimeError::invalid_input("invalid audio attachment"))?;
  if bytes.is_empty() {
    return Err(RuntimeError::invalid_input("invalid audio attachment"));
  }
  Ok((media_type, bytes))
}

pub(super) fn transcribe(
  http: &DefaultHttpClient,
  config: &llm_adapter::backend::BackendConfig,
  model: &str,
  media_type: &str,
  bytes: &[u8],
) -> RuntimeResult<Vec<Value>> {
  let mut headers = vec![(
    "authorization".to_string(),
    format!("Bearer {}", config.auth_token.expose()),
  )];
  headers.extend(config.headers.iter().map(|(name, value)| (name.clone(), value.clone())));
  let response = http
    .post_json(HttpRequest {
      url: format!("{}/audio/transcriptions", config.base_url.trim_end_matches('/')),
      headers,
      body: HttpBody::Multipart(vec![
        MultipartPart::File {
          name: "file".to_string(),
          file_name: format!("audio.{}", media_extension(media_type)),
          media_type: media_type.to_string(),
          bytes: bytes.to_vec(),
        },
        MultipartPart::Text {
          name: "model".to_string(),
          value: model.to_string(),
        },
        MultipartPart::Text {
          name: "response_format".to_string(),
          value: "verbose_json".to_string(),
        },
        MultipartPart::Text {
          name: "timestamp_granularities[]".to_string(),
          value: "segment".to_string(),
        },
      ]),
      timeout_ms: config.timeout_ms,
      egress_policy: config.egress_policy,
    })
    .map_err(asr_error)?;
  segment_contract(&response.body)
}

fn asr_error(error: BackendError) -> RuntimeError {
  // Phrasing matches the TypeScript retry classifier for upstream failures.
  RuntimeError::invalid_state(error.to_string())
}

/// Maps an OpenAI-style `verbose_json` transcription onto the transcript
/// segment contract `[{ a, s, e, t }]` (speaker/start/end/text, seconds).
fn segment_contract(response: &Value) -> RuntimeResult<Vec<Value>> {
  if let Some(segments) = response.get("segments").and_then(Value::as_array) {
    return Ok(
      segments
        .iter()
        .map(|segment| {
          json!({
            "a": segment.get("speaker").and_then(Value::as_str).unwrap_or(""),
            "s": segment.get("start").and_then(Value::as_f64).unwrap_or(0.0),
            "e": segment.get("end").and_then(Value::as_f64).unwrap_or(0.0),
            "t": segment.get("text").and_then(Value::as_str).unwrap_or(""),
          })
        })
        .collect(),
    );
  }
  // Plain-text transcription: one segment spanning the whole slice.
  let text = response.get("text").and_then(Value::as_str).unwrap_or("");
  let end = response.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
  Ok(vec![json!({ "a": "", "s": 0.0, "e": end, "t": text })])
}

fn media_extension(media_type: &str) -> &'static str {
  match media_type.split(';').next().unwrap_or("").trim() {
    "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
    "audio/mpeg" | "audio/mp3" => "mp3",
    "audio/ogg" | "audio/opus" => "ogg",
    "audio/webm" => "webm",
    "audio/mp4" | "audio/x-m4a" | "audio/m4a" => "m4a",
    "audio/flac" | "audio/x-flac" => "flac",
    "audio/aac" => "aac",
    _ => "wav",
  }
}

pub(super) fn structured_response(model: &str, segments: &[Value]) -> RuntimeResult<ExecutableResponse> {
  let segments = Value::Array(segments.to_vec());
  Ok(ExecutableResponse::Structured(StructuredResponse {
    id: Uuid::new_v4().to_string(),
    model: model.to_string(),
    output_text: segments.to_string(),
    output_json: Some(segments),
    usage: CoreUsage {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cached_tokens: None,
      reported: false,
    },
    finish_reason: "stop".to_string(),
    reasoning_details: None,
  }))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn execute_transcription(
  request: &ExecutableRequest,
  profiles: &[AuthorizedProviderProfile],
  candidates: &[AuthorizedTargetRef],
  managed_credentials: &std::collections::HashMap<String, Zeroizing<String>>,
  key: &CredentialEnvelopeKey,
) -> RuntimeResult<dispatch::CopilotExecutionResult> {
  let (media_type, bytes) = extract_audio(request)?;
  let http = DefaultHttpClient::default();
  let mut last_error = RuntimeError::invalid_state("audio transcription failed");
  for candidate in candidates {
    let profile = profiles
      .get(candidate.profile_index)
      .ok_or_else(|| RuntimeError::invalid_state("invalid authorized route profile"))?;
    let model = profile
      .models
      .get(candidate.model_index)
      .ok_or_else(|| RuntimeError::invalid_state("invalid authorized route model"))?;
    if model.interface != ModelInterface::AudioTranscriptions {
      continue;
    }
    let credential = dispatch::resolve_credential(key, profile, managed_credentials)?;
    let config = llm_adapter::target::compile_backend_target(llm_adapter::target::BackendTargetInput {
      provider: dispatch::provider(&profile.provider)?,
      operation: llm_adapter::target::BackendOperation::Structured,
      endpoint: profile.endpoint.clone(),
      openai_dialect: profile.openai_dialect,
      model: model.model_id.clone(),
      credential: llm_adapter::target::BackendCredential::new(credential),
      timeout_ms: Some(COPILOT_REQUEST_TIMEOUT.as_millis() as u64),
      egress_policy: profile.egress_policy,
    })
    .map_err(|error| RuntimeError::invalid_state(error.to_string()))?
    .config;
    let segments = match transcribe(&http, &config, &model.model_id, &media_type, &bytes) {
      Ok(segments) => segments,
      Err(error) => {
        last_error = error;
        continue;
      }
    };
    let result = dispatch::response_value(structured_response(&model.model_id, &segments)?)?;
    let route = dispatch::route_identity(profile, &model.model_id);
    return Ok(dispatch::CopilotExecutionResult {
      events: vec![
        dispatch::ProductEvent::RouteSelected { route: route.clone() },
        dispatch::ProductEvent::Usage {
          route,
          usage: dispatch::ProductUsage::Tokens(CoreUsage {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            cached_tokens: None,
            reported: false,
          }),
        },
      ],
      result,
    });
  }
  Err(last_error)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn maps_verbose_json_segments_to_contract() {
    let response = json!({
      "text": "hello world",
      "segments": [
        { "start": 0.0, "end": 1.25, "text": " hello " },
        { "start": 1.25, "end": 2.0, "text": "world", "speaker": "Alice" }
      ]
    });
    assert_eq!(
      segment_contract(&response).unwrap(),
      vec![
        json!({ "a": "", "s": 0.0, "e": 1.25, "t": " hello " }),
        json!({ "a": "Alice", "s": 1.25, "e": 2.0, "t": "world" })
      ]
    );
  }

  #[test]
  fn falls_back_to_single_segment_without_segments() {
    assert_eq!(
      segment_contract(&json!({ "text": "hi", "duration": 1.5 })).unwrap(),
      vec![json!({ "a": "", "s": 0.0, "e": 1.5, "t": "hi" })]
    );
  }

  #[test]
  fn decodes_data_and_data_url_sources() {
    let encoded = BASE64.encode(b"fake-audio");
    let (media_type, bytes) =
      decode_audio_source(&json!({ "data": encoded, "media_type": "audio/mpeg" })).unwrap();
    assert_eq!(media_type, "audio/mpeg");
    assert_eq!(bytes, b"fake-audio");

    let (media_type, bytes) =
      decode_audio_source(&json!({ "url": format!("data:audio/wav;base64,{encoded}") })).unwrap();
    assert_eq!(media_type, "audio/wav");
    assert_eq!(bytes, b"fake-audio");

    assert!(decode_audio_source(&json!({ "url": "https://example.test/a.wav" })).is_err());
    assert!(decode_audio_source(&json!({ "data": "!!!" })).is_err());
  }

  #[test]
  fn maps_media_type_to_extension() {
    assert_eq!(media_extension("audio/mpeg"), "mp3");
    assert_eq!(media_extension("audio/mp4; codecs=opus"), "m4a");
    assert_eq!(media_extension("weird/thing"), "wav");
  }
}
