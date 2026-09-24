import path from 'node:path';
import { AuditLog } from '@jarvis/audit';
import { DEFAULT_POLICY, PermissionManager, type ConfirmHandler, type PermissionPolicy } from '@jarvis/permissions';
import { AgentBus } from '@jarvis/agent-communication';
import { AgentRegistry } from '@jarvis/agent-registry';
import { ToolRuntime } from '@jarvis/tool-runtime';
import { SkillRegistry } from '@jarvis/skills';
import { MemoryStore } from '@jarvis/memory';
import { ModelRouter, OpenRouterProvider, OpenAICompatibleProvider, DEFAULT_ROLES, type ModelProvider, type RoleConfig } from '@jarvis/model-router';
import { FileIndex, fileSystemTools } from '@jarvis/file-system';
import { terminalTools } from '@jarvis/terminal';
import { BrowserSession, browserTools, documentTools, type BrowserOptions } from '@jarvis/browser-control';
import { BraveSearchProvider, SearchRouter, TavilySearchProvider, pageMetaTool, researchTools } from '@jarvis/web-research';
import { PowerShellDriver, computerTools, type ComputerDriver } from '@jarvis/computer-control';
import { OpenRouterAudioSTT, SpeechRouter, VoiceLanguageManager, WhisperCompatibleSTT, OpenAICompatibleTTS } from '@jarvis/voice';
import { Orchestrator, memoryTools, type OrchestratorHooks } from '@jarvis/agent-runtime';
import type { GraphEvent } from '@jarvis/task-engine';
import { AGENT_CATALOG } from '@jarvis/agents-catalog';
import { SKILL_CATALOG } from '@jarvis/skills-catalog';
import { setLogRedactor, type CapabilityStatus } from '@jarvis/shared';
import { MemorySecretStore, redact, type SecretStore } from '@jarvis/security';

/** Names of secrets the user can configure (values live only in the encrypted store). */
export const SECRET_NAMES = [
  'OPENROUTER_API_KEY',
  'BRAVE_SEARCH_API_KEY',
  'TAVILY_API_KEY',
  'STT_API_KEY',
  'TTS_API_KEY',
  'LOCAL_LLM_API_KEY',
] as const;

export interface CoreSettings {
  roles: RoleConfig;
  permissionPolicy: PermissionPolicy;
  stt: { baseUrl: string; model: string };
  tts: { baseUrl: string; model: string; voice: string };
  localLlm?: { baseUrl: string };
  workspace: string;
}

export interface CoreOptions {
  dataDir?: string; // undefined = in-memory (tests)
  secrets?: SecretStore;
  settings?: Partial<CoreSettings>;
  confirm?: ConfirmHandler;
  hooks?: OrchestratorHooks;
  extraProviders?: ModelProvider[];
  browser?: BrowserOptions;
  computerDriver?: ComputerDriver;
  fetchImpl?: typeof fetch;
}

export function defaultSettings(workspace: string): CoreSettings {
  return {
    roles: structuredClone(DEFAULT_ROLES),
    permissionPolicy: structuredClone(DEFAULT_POLICY),
    stt: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
    tts: { baseUrl: 'https://api.openai.com/v1', model: 'tts-1', voice: 'alloy' },
    workspace,
  };
}

export type JarvisCore = ReturnType<typeof createJarvisCore>;

/** Assembles the complete JARVIS runtime from packages. */
export function createJarvisCore(opts: CoreOptions = {}) {
  setLogRedactor((v) => redact(v));
  const secrets = opts.secrets ?? new MemorySecretStore();
  const settings: CoreSettings = { ...defaultSettings(opts.settings?.workspace ?? process.cwd()), ...opts.settings };
  const secret = (n: (typeof SECRET_NAMES)[number]) => () => secrets.get(n) || undefined;

  const audit = new AuditLog(opts.dataDir ? path.join(opts.dataDir, 'audit.jsonl') : undefined);
  const permissions = new PermissionManager(settings.permissionPolicy, audit, opts.confirm);
  const bus = new AgentBus();
  const registry = new AgentRegistry();
  const tools = new ToolRuntime(permissions, audit);
  const memory = new MemoryStore(opts.dataDir ? path.join(opts.dataDir, 'memory.db') : ':memory:');
  memory.markInterruptedTasks();

  // Model gateway: OpenRouter primary + optional local OpenAI-compatible server (Ollama/LM Studio).
  const router = new ModelRouter(settings.roles);
  router.register(new OpenRouterProvider({ apiKey: secret('OPENROUTER_API_KEY'), fetchImpl: opts.fetchImpl }));
  if (settings.localLlm?.baseUrl)
    router.register(new OpenAICompatibleProvider({ id: 'local', baseUrl: settings.localLlm.baseUrl, apiKey: secret('LOCAL_LLM_API_KEY'), requiresKey: false, fetchImpl: opts.fetchImpl }));
  for (const p of opts.extraProviders ?? []) router.register(p);

  // Tools
  const fileIndex = new FileIndex();
  const browser = new BrowserSession({ profileDir: opts.dataDir ? path.join(opts.dataDir, 'browser-profile') : undefined, ...opts.browser });
  const search = new SearchRouter([new BraveSearchProvider(secret('BRAVE_SEARCH_API_KEY'), opts.fetchImpl), new TavilySearchProvider(secret('TAVILY_API_KEY'), opts.fetchImpl)]);
  const computer = opts.computerDriver ?? new PowerShellDriver();
  for (const t of [
    ...fileSystemTools(fileIndex),
    ...terminalTools(),
    ...browserTools(browser),
    ...documentTools(browser),
    ...researchTools(search, opts.fetchImpl),
    pageMetaTool(opts.fetchImpl),
    ...computerTools(computer),
    ...memoryTools(memory),
  ])
    tools.register(t);

  const skills = new SkillRegistry(tools);
  for (const s of SKILL_CATALOG) skills.register(s);

  for (const a of AGENT_CATALOG) registry.register(a);
  const refreshAgentHealth = () => {
    for (const a of registry.list()) registry.setUnavailableTools(a.def.id, a.def.tools.filter((t) => tools.statusOf(t).state !== 'active'));
  };
  refreshAgentHealth();

  // Voice
  const voiceLanguages = new VoiceLanguageManager();
  const speech = new SpeechRouter([
    new WhisperCompatibleSTT({ baseUrl: settings.stt.baseUrl, model: settings.stt.model, apiKey: secret('STT_API_KEY'), requiresKey: true, fetchImpl: opts.fetchImpl }),
    new OpenRouterAudioSTT(router),
  ]);
  const tts = new OpenAICompatibleTTS({ baseUrl: settings.tts.baseUrl, model: settings.tts.model, defaultVoice: settings.tts.voice, apiKey: secret('TTS_API_KEY'), fetchImpl: opts.fetchImpl });

  // Live graph/progress/reply-delta stream for UIs, layered over caller hooks.
  type LiveEvent = { kind: 'graph'; requestId: string; event: GraphEvent } | { kind: 'delta'; requestId: string; text: string };
  const liveListeners = new Set<(e: LiveEvent) => void>();
  const emitLive = (e: LiveEvent) => {
    for (const l of liveListeners) l(e);
  };
  const orchestrator = new Orchestrator(
    { bus, registry, router, tools, skills, memory, workspace: settings.workspace },
    {
      ...opts.hooks,
      onGraphEvent: (requestId, event) => {
        opts.hooks?.onGraphEvent?.(requestId, event);
        emitLive({ kind: 'graph', requestId, event });
      },
      onReplyDelta: (requestId, text) => {
        opts.hooks?.onReplyDelta?.(requestId, text);
        emitLive({ kind: 'delta', requestId, text });
      },
    },
  );

  function capabilities(): CapabilityStatus[] {
    const modelOk = router.isRoleAvailable('reasoning');
    const list: CapabilityStatus[] = [
      { id: 'models', label: 'AI models (OpenRouter)', state: modelOk ? 'active' : 'not_configured', requirement: modelOk ? undefined : 'Add an OpenRouter API key in Settings > Providers' },
      { id: 'orchestration', label: 'Agent orchestration', state: modelOk ? 'active' : 'not_configured', requirement: modelOk ? undefined : 'Requires a configured model provider' },
      { id: 'voice.stt', label: 'Speech recognition', state: speech.available().length ? 'active' : 'not_configured', requirement: speech.available().length ? undefined : 'Add an OpenRouter key (audio model) or a Whisper-compatible STT key' },
      { id: 'voice.tts', label: 'Speech synthesis', state: 'active', reason: tts.isConfigured() ? 'Cloud TTS configured' : 'Using Windows voices (local)' },
    ];
    const modules = new Map<string, string[]>();
    for (const t of tools.list()) modules.set(t.module, [...(modules.get(t.module) ?? []), t.id]);
    for (const [mod, ids] of modules) {
      const states = ids.map((i) => tools.statusOf(i));
      const active = states.filter((s) => s.state === 'active').length;
      const first = states.find((s) => s.state !== 'active');
      list.push({ id: `module.${mod}`, label: mod, state: active === ids.length ? 'active' : active > 0 ? 'degraded' : (first?.state ?? 'disabled'), reason: first?.reason });
    }
    return list;
  }

  return {
    settings,
    secrets,
    audit,
    permissions,
    bus,
    registry,
    tools,
    skills,
    memory,
    router,
    browser,
    fileIndex,
    search,
    speech,
    tts,
    voiceLanguages,
    orchestrator,
    capabilities,
    refreshAgentHealth,
    onLive(fn: (e: LiveEvent) => void): () => void {
      liveListeners.add(fn);
      return () => liveListeners.delete(fn);
    },
    async shutdown() {
      await browser.close();
      memory.close();
    },
  };
}
