# Provider Configuration

All keys are entered in **Settings → Providers**. They are stored encrypted and are never displayed again.

| Provider                       | Secret                                                                    | Used for                                                                             | Notes                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| OpenRouter                     | `OPENROUTER_API_KEY`                                                      | All reasoning, planning, coding and vision. Speech-to-text with audio-capable models | https://openrouter.ai. Choose models per role in Settings → Models. Each role has a fallback chain       |
| Local OpenAI-compatible server | `LOCAL_LLM_API_KEY` (optional) plus `localLlm.baseUrl` in `settings.json` | Private/offline models (Ollama `http://localhost:11434/v1`, LM Studio, vLLM)         | Reference as provider `local` in the model roles                                                         |
| Brave Search                   | `BRAVE_SEARCH_API_KEY`                                                    | `web.search`                                                                         | Tried first                                                                                              |
| Tavily                         | `TAVILY_API_KEY`                                                          | `web.search`                                                                         | Fallback                                                                                                 |
| Whisper-compatible STT         | `STT_API_KEY` plus `stt.baseUrl` / `stt.model` in `settings.json`         | Speech recognition                                                                   | Default endpoint: OpenAI `/v1/audio/transcriptions`, model `whisper-1`. Groq and local servers also work |
| Cloud TTS                      | `TTS_API_KEY` plus `tts.*` in `settings.json`                             | Speech output when no Windows voice is installed for the language                    | Default: OpenAI `/v1/audio/speech`                                                                       |

Default model roles are editable starting points. Before release, check that the model ids exist in the OpenRouter catalogue (Settings → Models shows the live list).

## Adding a provider in code

Implement `ModelProvider` (`packages/model-router/src/types.ts`) or reuse `OpenAICompatibleProvider`, then register it in `createJarvisCore`. For search, implement `SearchProvider`. For speech, implement `SpeechToTextProvider` or `TextToSpeechProvider`.
