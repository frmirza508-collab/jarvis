import type { AgentDefinitionInput, Department } from '@jarvis/agent-registry';

/**
 * Built-in specialist catalog. Each specialist is a configuration of the one
 * shared agent runtime: a focused instruction set, a capability list used for
 * routing, the tools/skills it may use and the permission categories it may
 * request. New specialists are added here or created dynamically at runtime by
 * the Agent Builder (validated against the same schema).
 */

const FS_READ = ['fs.read', 'fs.list', 'fs.search', 'fs.metadata'];
const FS_WRITE = [...FS_READ, 'fs.write', 'fs.edit', 'fs.mkdir', 'fs.copy', 'fs.move'];
const WEB = ['web.search', 'web.fetch'];
const BROWSER = [
  'browser.open',
  'browser.extract',
  'browser.click',
  'browser.type',
  'browser.fill_form',
  'browser.screenshot',
  'browser.download',
  'browser.close',
];
const CODE = [...FS_WRITE, 'shell.run', 'git.status', 'git.diff'];
const MEM = ['memory.search', 'memory.remember'];
const DOCS = ['documents.pdf', ...FS_WRITE];

interface Spec {
  id: string;
  name: string;
  focus: string;
  capabilities: string[];
  tools?: string[];
  skills?: string[];
  permissions?: AgentDefinitionInput['permissions'];
  role?: AgentDefinitionInput['modelRole'];
  reviewer?: string;
}

function dept(department: Department, specs: Spec[]): AgentDefinitionInput[] {
  return specs.map((s) => ({
    id: s.id,
    name: s.name,
    department,
    description: s.focus,
    capabilities: s.capabilities,
    tools: [...new Set([...(s.tools ?? []), ...MEM])],
    skills: s.skills ?? [],
    permissions: s.permissions ?? ['READ'],
    modelRole: s.role ?? 'reasoning',
    reviewer: s.reviewer,
    instructions: `You are the ${s.name} inside JARVIS. Focus: ${s.focus} Work only on the task you were assigned, use tools to obtain facts instead of guessing, cite evidence for claims, report files you created as artifacts, and say clearly when something could not be done.`,
    dynamic: false,
  }));
}

const CODER_PERMS: Spec['permissions'] = ['READ', 'WRITE', 'EXECUTE'];
const coder = (id: string, name: string, focus: string, extra: string[] = []): Spec => ({
  id,
  name,
  focus,
  capabilities: ['coding', ...extra],
  tools: CODE,
  skills: ['coding.run_checks', 'coding.inspect_repo'],
  permissions: CODER_PERMS,
  role: 'coding',
  reviewer: 'code-review',
});

export const AGENT_CATALOG: AgentDefinitionInput[] = [
  ...dept('executive', [
    {
      id: 'orchestrator',
      name: 'Master JARVIS Orchestrator',
      focus:
        'Understands the user request, decides whether to answer directly or delegate, and presents one concise final result.',
      capabilities: ['general', 'conversation', 'orchestration'],
      tools: [...FS_READ, ...WEB],
    },
    {
      id: 'agent-supervisor',
      name: 'Agent Supervisor',
      focus:
        'Monitors specialist health, reassigns work away from degraded agents and enforces task budgets.',
      capabilities: ['supervision'],
    },
    {
      id: 'task-planner',
      name: 'Task Planner',
      focus: 'Decomposes goals into a dependency graph of typed tasks assigned to the best specialists.',
      capabilities: ['planning'],
    },
    {
      id: 'failure-recovery',
      name: 'Failure Recovery Manager',
      focus: 'Diagnoses failed tasks, proposes corrected retries or alternative approaches.',
      capabilities: ['recovery', 'debugging-plan'],
    },
    {
      id: 'final-verification',
      name: 'Final Verification Manager',
      focus:
        'Checks that deliverables exist, match the request and that claims are supported before JARVIS answers.',
      capabilities: ['verification'],
      tools: FS_READ,
    },
  ]),
  ...dept('engineering', [
    coder(
      'software-architect',
      'Software Architect',
      'Designs system architecture, module boundaries and technical decisions with trade-offs.',
      ['architecture'],
    ),
    coder(
      'frontend-developer',
      'Frontend Developer',
      'Builds web and desktop user interfaces with React, TypeScript and CSS.',
      ['frontend'],
    ),
    coder('backend-developer', 'Backend Developer', 'Builds APIs, services and data access layers.', [
      'backend',
    ]),
    coder(
      'fullstack-developer',
      'Full-Stack Developer',
      'Delivers features end-to-end across frontend and backend.',
      ['frontend', 'backend'],
    ),
    coder('mobile-developer', 'Mobile Developer', 'Builds cross-platform mobile applications.', ['mobile']),
    coder('flutter-developer', 'Flutter Developer', 'Builds Flutter/Dart applications.', [
      'mobile',
      'flutter',
    ]),
    coder('android-developer', 'Android Developer', 'Builds native Android apps with Kotlin/Java.', [
      'mobile',
      'android',
    ]),
    coder('ios-developer', 'iOS Developer', 'Builds native iOS apps with Swift.', ['mobile', 'ios']),
    coder('python-developer', 'Python Developer', 'Writes, tests and packages Python code and scripts.', [
      'python',
    ]),
    coder('java-developer', 'Java Developer', 'Develops Java/JVM applications.', ['java']),
    coder('cpp-developer', 'C/C++ Developer', 'Develops and debugs C and C++ software and builds.', ['cpp']),
    coder('dotnet-developer', '.NET Developer', 'Develops C#/.NET applications and Windows tooling.', [
      'dotnet',
    ]),
    coder(
      'database-engineer',
      'Database Engineer',
      'Designs schemas, migrations and queries; tunes database performance.',
      ['database'],
    ),
    coder('api-engineer', 'API Engineer', 'Designs and implements REST/GraphQL APIs and integrations.', [
      'api',
      'backend',
    ]),
    coder(
      'devops-engineer',
      'DevOps Engineer',
      'Automates builds, CI/CD pipelines and infrastructure as code.',
      ['devops'],
    ),
    coder('cloud-engineer', 'Cloud Engineer', 'Plans and operates cloud infrastructure and deployments.', [
      'cloud',
      'devops',
    ]),
    coder(
      'git-agent',
      'Git/GitHub Agent',
      'Performs version-control operations: status, diffs, commits, branches.',
      ['git'],
    ),
    {
      id: 'code-review',
      name: 'Code Review Agent',
      focus: 'Reviews code and diffs for correctness, security and maintainability; returns concrete issues.',
      capabilities: ['code-review', 'review'],
      tools: [...FS_READ, 'git.status', 'git.diff'],
      skills: ['coding.inspect_repo'],
      role: 'coding',
    },
    coder(
      'debugging-agent',
      'Debugging Agent',
      'Reproduces failures, locates root causes and verifies fixes.',
      ['debugging'],
    ),
    coder('testing-engineer', 'Testing Engineer', 'Writes and runs unit, integration and end-to-end tests.', [
      'testing',
    ]),
    coder(
      'release-agent',
      'Deployment/Release Agent',
      'Prepares builds, versioning, release notes and deployment steps.',
      ['release', 'devops'],
    ),
  ]),
  ...dept('research', [
    {
      id: 'web-research',
      name: 'Web Research Agent',
      focus: 'Searches the web, gathers sources and summarises findings with citations.',
      capabilities: ['research', 'web-research'],
      tools: [...WEB, 'browser.open', 'browser.extract'],
      skills: ['research.deep'],
      permissions: ['READ', 'NETWORK', 'BROWSER'],
      reviewer: 'fact-verification',
    },
    {
      id: 'documentation-research',
      name: 'Documentation Research Agent',
      focus: 'Finds and reads official technical documentation to answer precise questions.',
      capabilities: ['research', 'docs-research'],
      tools: WEB,
      skills: ['research.deep'],
      permissions: ['READ', 'NETWORK'],
    },
    {
      id: 'competitive-research',
      name: 'Competitive Research Agent',
      focus: 'Researches competitors, products, pricing and positioning.',
      capabilities: ['research', 'competitive-analysis'],
      tools: [...WEB, 'browser.open', 'browser.extract'],
      skills: ['research.deep'],
      permissions: ['READ', 'NETWORK', 'BROWSER'],
      reviewer: 'fact-verification',
    },
    {
      id: 'data-collection',
      name: 'Data Collection Agent',
      focus: 'Collects structured data from sources into tables/files.',
      capabilities: ['data-collection'],
      tools: [...WEB, ...FS_WRITE],
      permissions: ['READ', 'NETWORK', 'WRITE'],
    },
    {
      id: 'web-scraping',
      name: 'Web Scraping Agent',
      focus: 'Extracts content from web pages respecting site terms and robots rules.',
      capabilities: ['scraping'],
      tools: [...WEB, 'browser.open', 'browser.extract'],
      permissions: ['READ', 'NETWORK', 'BROWSER'],
    },
    {
      id: 'browser-automation',
      name: 'Browser Automation Agent',
      focus: 'Operates the browser: navigates, clicks, types, fills forms, downloads files.',
      capabilities: ['browser'],
      tools: [...BROWSER, 'browser.upload'],
      permissions: ['READ', 'BROWSER', 'NETWORK', 'WRITE', 'SENSITIVE'],
    },
    {
      id: 'fact-verification',
      name: 'Fact Verification Agent',
      focus:
        'Cross-checks claims against independent sources and labels them verified, disputed or unverified.',
      capabilities: ['fact-check', 'review'],
      tools: WEB,
      permissions: ['READ', 'NETWORK'],
    },
    {
      id: 'knowledge-extraction',
      name: 'Knowledge Extraction Agent',
      focus: 'Extracts entities, facts and structured knowledge from documents.',
      capabilities: ['extraction'],
      tools: FS_READ,
    },
  ]),
  ...dept('design', [
    {
      id: 'ui-ux',
      name: 'UI/UX Agent',
      focus: 'Designs user flows, wireframes and usability improvements.',
      capabilities: ['design', 'ux'],
      tools: FS_WRITE,
      permissions: ['READ', 'WRITE'],
    },
    {
      id: 'graphic-design',
      name: 'Graphic Design Agent',
      focus: 'Produces layout, color and typography guidance and SVG graphics.',
      capabilities: ['design', 'graphics'],
      tools: FS_WRITE,
      permissions: ['READ', 'WRITE'],
    },
    {
      id: 'brand-design',
      name: 'Brand Design Agent',
      focus: 'Develops brand identity: naming, voice, palettes and guidelines.',
      capabilities: ['design', 'branding'],
      tools: FS_WRITE,
      permissions: ['READ', 'WRITE'],
    },
    {
      id: 'image-generation',
      name: 'Image Generation Agent',
      focus: 'Writes image-generation prompts and, when an image provider is configured, generates images.',
      capabilities: ['image-generation'],
      tools: FS_WRITE,
      permissions: ['READ', 'WRITE'],
    },
    {
      id: 'image-editing',
      name: 'Image Editing Agent',
      focus: 'Plans image edits and runs local image tooling when installed.',
      capabilities: ['image-editing'],
      tools: [...FS_WRITE, 'shell.run'],
      permissions: ['READ', 'WRITE', 'EXECUTE'],
    },
    {
      id: 'video-editing',
      name: 'Video Editing Agent',
      focus: 'Plans edits and drives local tools such as ffmpeg when installed.',
      capabilities: ['video-editing'],
      tools: [...FS_WRITE, 'shell.run'],
      permissions: ['READ', 'WRITE', 'EXECUTE'],
    },
    {
      id: 'motion-graphics',
      name: 'Motion Graphics Agent',
      focus: 'Designs animations and motion specifications (CSS/Lottie/Three.js).',
      capabilities: ['motion'],
      tools: FS_WRITE,
      permissions: ['READ', 'WRITE'],
    },
    {
      id: 'presentation',
      name: 'Presentation Agent',
      focus: 'Builds slide outlines and presentation documents.',
      capabilities: ['presentation', 'documents'],
      tools: DOCS,
      skills: ['docs.report_pdf'],
      permissions: ['READ', 'WRITE'],
    },
  ]),
  ...dept('marketing', [
    {
      id: 'seo',
      name: 'SEO Agent',
      focus: 'Audits pages for SEO, analyses keywords and produces SEO reports.',
      capabilities: ['seo', 'analysis'],
      tools: [...WEB, 'browser.open', 'browser.extract'],
      skills: ['marketing.seo_audit'],
      permissions: ['READ', 'NETWORK', 'BROWSER'],
    },
    {
      id: 'content-strategy',
      name: 'Content Strategy Agent',
      focus: 'Plans content calendars, topics and distribution.',
      capabilities: ['content-strategy', 'marketing'],
      tools: WEB,
      permissions: ['READ', 'NETWORK'],
    },
    {
      id: 'copywriting',
      name: 'Copywriting Agent',
      focus: 'Writes persuasive, on-brand copy in English, Urdu or Chinese.',
      capabilities: ['copywriting', 'writing'],
      role: 'fast',
    },
    {
      id: 'social-media',
      name: 'Social Media Agent',
      focus: 'Creates social posts and campaign plans per platform.',
      capabilities: ['social-media', 'marketing'],
      role: 'fast',
    },
    {
      id: 'ads',
      name: 'Ads Agent',
      focus: 'Plans ad campaigns, audiences, budgets and ad copy.',
      capabilities: ['ads', 'marketing'],
    },
    {
      id: 'email-marketing',
      name: 'Email Marketing Agent',
      focus: 'Writes email sequences and newsletter content.',
      capabilities: ['email-marketing', 'writing'],
      role: 'fast',
    },
    {
      id: 'analytics',
      name: 'Analytics Agent',
      focus: 'Analyses data files and metrics; builds comparisons and summaries.',
      capabilities: ['analytics', 'analysis'],
      tools: [...FS_READ, 'shell.run'],
      permissions: ['READ', 'EXECUTE'],
    },
    {
      id: 'lead-generation',
      name: 'Lead Generation Agent',
      focus: 'Researches prospects from public sources and organises lead lists.',
      capabilities: ['lead-generation'],
      tools: [...WEB, ...FS_WRITE],
      permissions: ['READ', 'NETWORK', 'WRITE'],
    },
  ]),
  ...dept('business', [
    {
      id: 'business-analyst',
      name: 'Business Analyst',
      focus: 'Analyses requirements, processes and business cases.',
      capabilities: ['business-analysis', 'analysis'],
    },
    {
      id: 'crm',
      name: 'CRM Agent',
      focus: 'Organises customer records and follow-ups in local files or configured CRMs.',
      capabilities: ['crm'],
      tools: FS_WRITE,
      permissions: ['READ', 'WRITE'],
    },
    {
      id: 'sales',
      name: 'Sales Agent',
      focus: 'Drafts sales outreach, pitches and objection handling.',
      capabilities: ['sales', 'writing'],
      role: 'fast',
    },
    {
      id: 'proposal',
      name: 'Proposal Agent',
      focus: 'Writes proposals and quotations as documents.',
      capabilities: ['proposal', 'documents'],
      tools: DOCS,
      skills: ['docs.report_pdf'],
      permissions: ['READ', 'WRITE'],
    },
    {
      id: 'invoice',
      name: 'Invoice Agent',
      focus: 'Prepares invoices and payment summaries as documents.',
      capabilities: ['invoice', 'documents'],
      tools: DOCS,
      skills: ['docs.report_pdf'],
      permissions: ['READ', 'WRITE'],
    },
    {
      id: 'project-management',
      name: 'Project Management Agent',
      focus: 'Builds plans, timelines, task lists and status reports.',
      capabilities: ['project-management', 'planning'],
      tools: FS_WRITE,
      permissions: ['READ', 'WRITE'],
    },
    {
      id: 'customer-support',
      name: 'Customer Support Agent',
      focus: 'Drafts support replies and knowledge-base answers.',
      capabilities: ['support', 'writing'],
      role: 'fast',
    },
    {
      id: 'documentation',
      name: 'Documentation Agent',
      focus: 'Writes reports, manuals and documentation, and exports PDF.',
      capabilities: ['documents', 'writing'],
      tools: DOCS,
      skills: ['docs.report_pdf'],
      permissions: ['READ', 'WRITE'],
    },
  ]),
  ...dept('security', [
    {
      id: 'cybersecurity',
      name: 'Cybersecurity Agent',
      focus: 'Reviews code/configuration for vulnerabilities and recommends defensive fixes.',
      capabilities: ['security-review', 'review'],
      tools: [...FS_READ, 'git.diff'],
    },
    {
      id: 'permission-safety',
      name: 'Permission/Safety Agent',
      focus: 'Assesses the risk of planned actions and explains required permissions.',
      capabilities: ['safety'],
    },
    {
      id: 'sysadmin',
      name: 'System Administration Agent',
      focus: 'Inspects and maintains the local system via safe commands.',
      capabilities: ['system', 'sysadmin'],
      tools: [...FS_READ, 'shell.run', 'computer.windows', 'computer.screens'],
      permissions: ['READ', 'EXECUTE', 'SYSTEM'],
    },
    {
      id: 'windows-automation',
      name: 'Windows Automation Agent',
      focus: 'Controls Windows apps: launches programs, manages windows, types and clicks.',
      capabilities: ['computer-control', 'system'],
      tools: [
        'computer.screenshot',
        'computer.screens',
        'computer.windows',
        'computer.window',
        'computer.launch',
        'computer.clipboard_read',
        'computer.clipboard_write',
        'computer.mouse',
        'computer.type',
        'computer.hotkey',
        'computer.inspect',
      ],
      permissions: ['READ', 'SYSTEM', 'EXECUTE', 'SENSITIVE'],
    },
    {
      id: 'performance-monitoring',
      name: 'Performance Monitoring Agent',
      focus: 'Measures CPU, memory and process usage and reports anomalies.',
      capabilities: ['monitoring'],
      tools: ['shell.run'],
      permissions: ['READ', 'EXECUTE'],
    },
    {
      id: 'backup-recovery',
      name: 'Backup/Recovery Agent',
      focus: 'Creates and verifies file backups and restores them on request.',
      capabilities: ['backup', 'files'],
      tools: FS_WRITE,
      permissions: ['READ', 'WRITE'],
    },
  ]),
  ...dept('knowledge-ai', [
    {
      id: 'knowledge-manager',
      name: 'Knowledge Manager',
      focus: 'Organises the knowledge base and answers questions from stored knowledge.',
      capabilities: ['knowledge', 'memory'],
    },
    {
      id: 'memory-manager',
      name: 'Memory Manager',
      focus: 'Stores, updates and prunes memories according to retention rules.',
      capabilities: ['memory'],
    },
    {
      id: 'learning',
      name: 'Learning Agent',
      focus: 'Extracts verified lessons from completed tasks for future reuse.',
      capabilities: ['learning'],
    },
    {
      id: 'model-router-agent',
      name: 'Model Router Agent',
      focus: 'Recommends which model role/provider suits a task based on measured performance.',
      capabilities: ['model-routing'],
    },
    {
      id: 'prompt-engineering',
      name: 'Prompt Engineering Agent',
      focus: 'Writes and improves prompts and agent instructions.',
      capabilities: ['prompting', 'writing'],
    },
    {
      id: 'ai-research',
      name: 'AI Research Agent',
      focus: 'Researches AI models, papers and techniques with citations.',
      capabilities: ['research', 'ai-research'],
      tools: WEB,
      skills: ['research.deep'],
      permissions: ['READ', 'NETWORK'],
    },
    {
      id: 'skill-builder',
      name: 'Skill Builder Agent',
      focus: 'Designs new reusable skills from repeated successful workflows.',
      capabilities: ['skill-building'],
    },
    {
      id: 'agent-builder',
      name: 'Agent Builder Agent',
      focus: 'Designs new specialist agent definitions when no existing agent fits.',
      capabilities: ['agent-building'],
    },
  ]),
  ...dept('qa-operations', [
    {
      id: 'qa-reviewer',
      name: 'QA Reviewer',
      focus: 'Reviews deliverables against the request and acceptance criteria; returns concrete issues.',
      capabilities: ['review', 'qa'],
      tools: FS_READ,
    },
    {
      id: 'file-operations',
      name: 'File Operations Agent',
      focus: 'Finds, organises, copies, moves and renames files and folders.',
      capabilities: ['files'],
      tools: [...FS_WRITE, 'fs.delete'],
      permissions: ['READ', 'WRITE', 'DESTRUCTIVE'],
    },
  ]),
];
