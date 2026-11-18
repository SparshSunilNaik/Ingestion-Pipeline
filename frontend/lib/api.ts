// Typed client for the Ingestion-Pipeline backend. All calls are same-origin (/api is proxied by Next.js),
// carry the session cookie, and send the CSRF header the backend requires for cookie-authenticated mutations.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

async function request<T>(path: string, init?: RequestInit & { signal?: AbortSignal }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-ip-csrf": "1", ...(init?.headers ?? {}) },
      cache: "no-store",
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "network_error", "Cannot reach the backend. Is it running on port 8000?");
  }
  if (!res.ok) {
    let code = "http_error";
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
      } else if (body?.detail) {
        message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      }
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized?.();
    throw new ApiError(res.status, code, message);
  }
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("application/json") ? res.json() : res.text()) as Promise<T>;
}

const q = (params: Record<string, string | number | boolean | undefined | null>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
};

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type Resolution = "resolved" | "ambiguous" | "external" | "unresolved";

export interface Job {
  id: number;
  kind: "ingest" | "agent_report" | "qa" | "selftest";
  repository_id: number | null;
  snapshot_id: number | null;
  requested_url: string;
  status: JobStatus;
  stage: string;
  progress: number;
  message: string | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  reused_cache: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  params: Record<string, unknown>;
}

export interface SnapshotBrief {
  id: number;
  commit_sha: string;
  status: string;
  default_branch: string | null;
  acquired_at: string;
  analyzer_version: string;
}

export interface Repository {
  id: number;
  owner: string;
  name: string;
  canonical_url: string;
  default_branch: string | null;
  current_snapshot_id: number | null;
  created_at: string;
  updated_at: string;
  snapshots: SnapshotBrief[];
  current: SnapshotBrief | null;
  latest_job: Job | null;
  current_summary: {
    languages_by_bytes: Record<string, number>;
    tracked_files: number | null;
    analyzed_files: number | null;
    total_bytes: number | null;
    is_partial: boolean | null;
    evidence_records: number | null;
  } | null;
}

export interface Coverage {
  tracked_files: number;
  analyzed_files: number;
  analyzed_bytes: number;
  eligible_text_files: number;
  budget_skipped_files: number;
  tracked_files_beyond_limit: number;
  is_partial: boolean;
  exclusions: Record<string, number>;
  limits: Record<string, number>;
}

export interface Snapshot {
  id: number;
  repository_id: number;
  commit_sha: string;
  default_branch: string | null;
  status: string;
  analyzer_version: string;
  acquired_at: string;
  commit_info: { sha?: string; author?: string; date?: string; subject?: string };
  recent_commits: { sha: string; author: string; date: string; subject: string }[];
  coverage: Coverage;
  inventory_summary: {
    languages_by_files: Record<string, number>;
    languages_by_bytes: Record<string, number>;
    categories: Record<string, number>;
    documentation_files: string[];
    test_files_count: number;
    ci_files: string[];
    container_files: string[];
    source_directories: string[];
    total_bytes: number;
  };
  analysis_summary: {
    stats?: Record<string, number>;
    evidence_records?: number;
    evidence_rejected?: number;
    graph?: { nodes: number; edges: number; edge_kinds: Record<string, number>; edge_resolution: Record<string, number> };
    central_files?: { key: string; path: string; imported_by: number }[];
    most_referenced_symbols?: { key: string; label: string; kind: string; path: string; references: number }[];
  };
  repository: { id: number; owner: string; name: string; canonical_url: string; default_branch: string | null };
}

export interface TreeFile {
  p: string;
  c: string;
  l: string | null;
  a: boolean;
  s: number;
  n: number | null;
  x: string | null;
}

export interface Source {
  path: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  language: string | null;
  lines: string[];
}

export interface SymbolRow {
  id: number;
  path: string;
  kind: string;
  name: string;
  qualified_name: string;
  start_line: number;
  end_line: number;
  exported: boolean;
  signature: string | null;
  docstring: string | null;
  evidence_id: string | null;
}

export interface NodeInfo {
  key: string;
  kind: string;
  label: string;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
}

export interface ViewNode extends NodeInfo {
  files?: number;
  languages?: Record<string, number>;
  focus?: boolean;
  is_route_handler?: boolean;
}

export interface ViewEdge {
  source: string;
  target: string;
  kind: string;
  resolution: Resolution;
  count: number;
  evidence_id: string | null;
  via?: string | null;
}

export interface GraphView {
  view: string;
  nodes: ViewNode[];
  edges: ViewEdge[];
  truncated: boolean;
}

export interface Related extends NodeInfo {
  relation?: string;
  resolution?: string;
  via?: string | null;
  evidence_id?: string | null;
  call_line?: number | null;
  depth?: number;
  callee_text?: string;
}

export interface Usage {
  definition: NodeInfo & { evidence_id: string | null };
  direct_references: Related[];
  importing_files: Related[];
  /** Files only: outgoing import / dependency edges. */
  imports?: Related[];
  direct_callees: Related[];
  related_routes: Related[];
  upstream_transitive: Related[];
  downstream_transitive: Related[];
  possible_dynamic_references: Related[];
  notes: string[];
}

export interface Impact {
  key: string;
  direct_dependents: Related[];
  transitive_dependents: Related[];
  potentially_affected_routes: Related[];
  related_tests: string[];
  unresolved_references: Related[];
  limitations: string[];
  truncated: boolean;
}

export interface EntryPoint {
  kind: string;
  label: string;
  framework?: string;
  start_key: string | null;
  handler_key?: string | null;
  evidence_id: string | null;
  traceable: boolean;
  line_range?: [number | null, number | null];
}

export interface FlowStep {
  index: number;
  parent: number | null;
  depth: number;
  from: string;
  to: NodeInfo;
  edge_kind: string;
  resolution: Resolution;
  via: string | null;
  callee_text: string | null;
  call_line: number | null;
  evidence_id: string | null;
  cycle: boolean;
  certainty: "direct" | "possible";
  leaf_reason: string | null;
}

export interface Flow {
  start: NodeInfo;
  steps: FlowStep[];
  truncated: boolean;
  stats: Record<string, number>;
  semantics: string;
}

export interface RetrievalResult {
  kind: "symbol" | "file" | "text";
  key: string;
  label: string;
  path: string;
  start_line: number;
  end_line: number;
  evidence_id: string | null;
  symbol_kind?: string;
  signature?: string;
  snippet?: string;
  score: number;
  signals: string[];
}

export interface Finding {
  id: number;
  kind: string;
  name: string;
  detail: Record<string, unknown>;
  evidence_id: string | null;
  confidence: string;
}

export interface Dependency {
  ecosystem: string;
  name: string;
  specifier: string | null;
  scope: string;
  manifest_path: string | null;
  status: string;
  evidence_id: string | null;
  import_count: number;
}

export interface EvidenceDetail {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  category: string;
  subject: string | null;
  source_kind: string;
  extraction_method: string;
  verification_status: string;
  verified_now: boolean;
  verification_reason: string | null;
  commit_sha: string;
  excerpt: string | null;
}

export type Basis = "source_evidence" | "configuration_evidence" | "documentation_claim" | "inventory_measured" | "heuristic" | "unknown" | "unsupported";

export interface Claim {
  statement: string;
  basis: Basis;
  evidence_ids: string[];
  note: string | null;
}

export interface Section {
  title: string;
  claims: Claim[];
}

export interface EvidenceRef {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  category: string;
  source_kind: string;
  verification_status: string;
}

export interface ReportContent {
  kind: "deterministic" | "agent";
  repository: string;
  commit_sha: string;
  generated_at: string;
  model: string | null;
  overview: Section[];
  installation: Section[];
  architecture: Section[];
  code_structure: Section[];
  engineering: Section[];
  agent_narrative: Section[];
  coverage: Coverage;
  evidence: EvidenceRef[];
  evidence_summary: Record<string, number>;
}

export interface ReportBrief {
  id: number;
  snapshot_id: number;
  kind: "deterministic" | "agent";
  status: string;
  model: string | null;
  created_at: string;
}

export interface Report extends ReportBrief {
  content: ReportContent;
  usage: Record<string, unknown>;
}

export interface AgentStatus {
  mode: string;
  available: boolean;
  version: string | null;
  base_url: string | null;
  error: string | null;
  selected_model: string;
  selected_model_available: boolean | null;
  agent_ready: boolean;
}

export interface AgentModel {
  id: string;
  name: string;
  family: string | null;
  enabled: boolean;
  context_limit: number | null;
}

export interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  status: "pending" | "complete" | "failed" | "cancelled";
  job_id: number | null;
  created_at: string;
  payload: {
    claims?: Claim[];
    limitations?: string[];
    grounding?: "grounded" | "partially_grounded" | "unsupported" | "insufficient_evidence";
    insufficient_evidence?: boolean;
    validation?: Record<string, unknown>;
    model?: string;
    intents?: string[];
    usage?: { model_calls?: number; latency_ms?: number; gateway?: { requests: number } };
    error?: string;
  };
}

export interface Conversation {
  id: number;
  snapshot_id: number;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
  messages?: Message[];
}

export interface Comparison {
  base: { id: number; commit_sha: string; analyzer_version: string };
  head: { id: number; commit_sha: string; analyzer_version: string };
  files: { added: string[]; removed: string[]; modified: { path: string; lines_before: number | null; lines_after: number | null }[]; counts: Record<string, number> };
  symbols: {
    added: { path: string; qualified_name: string; kind: string; start_line: number; end_line: number }[];
    removed: { path: string; qualified_name: string; kind: string }[];
    signature_changed: { path: string; qualified_name: string; signature_before: string | null; signature_after: string | null; start_line: number; end_line: number }[];
    counts: Record<string, number>;
  };
  dependencies: { added: Dependency[]; removed: Dependency[]; changed: (Dependency & { specifier_before: string | null; status_before: string })[] };
  routes: { added: { name: string; path: string; handler: string }[]; removed: { name: string; path: string; handler: string }[] };
  graph: { edges_added: ViewEdge[]; edges_removed: ViewEdge[]; counts: Record<string, number> };
  potential_impact: { unchanged_dependents_of_changed_code: (NodeInfo & { because_of: string; evidence_id: string | null })[]; count: number; note: string };
  limitations: string[];
}

export const api = {
  authStatus: () => request<{ auth_mode: string; authenticated: boolean; method: string | null }>("/api/auth/status"),
  login: (token: string) => request<{ authenticated: boolean }>("/api/auth/login", { method: "POST", body: JSON.stringify({ token }) }),
  logout: () => request<{ authenticated: boolean }>("/api/auth/logout", { method: "POST" }),
  health: () => request<{ status: string; version: string }>("/api/health"),
  ready: () => request<{ worker_running: boolean; agent: Record<string, unknown> }>("/api/health/ready"),
  validateUrl: (url: string) => request<{ valid: boolean; canonical_url: string | null; error: string | null }>("/api/repositories/validate", { method: "POST", body: JSON.stringify({ url }) }),
  createJob: (url: string) => request<{ job: Job; created: boolean }>("/api/jobs", { method: "POST", body: JSON.stringify({ url }) }),
  jobs: (limit = 30) => request<Job[]>(`/api/jobs${q({ limit })}`),
  job: (id: number) => request<Job>(`/api/jobs/${id}`),
  cancelJob: (id: number) => request<Job>(`/api/jobs/${id}/cancel`, { method: "POST" }),
  repositories: () => request<Repository[]>("/api/repositories"),
  refreshRepository: (id: number) => request<{ job: Job; created: boolean }>(`/api/repositories/${id}/refresh`, { method: "POST" }),
  snapshot: (id: number) => request<Snapshot>(`/api/snapshots/${id}`),
  tree: (id: number) => request<{ files: TreeFile[] }>(`/api/snapshots/${id}/tree`),
  source: (id: number, path: string) => request<Source>(`/api/snapshots/${id}/source${q({ path })}`),
  symbols: (id: number, p: { q?: string; path?: string; kind?: string; limit?: number }) => request<SymbolRow[]>(`/api/snapshots/${id}/symbols${q(p)}`),
  findings: (id: number, kind?: string) => request<Finding[]>(`/api/snapshots/${id}/findings${q({ kind })}`),
  dependencies: (id: number) => request<Dependency[]>(`/api/snapshots/${id}/dependencies`),
  evidence: (id: string) => request<EvidenceDetail>(`/api/evidence/${encodeURIComponent(id)}`),
  graphView: (id: number, p: { view: string; focus?: string; radius?: number; path_prefix?: string; limit?: number }) => request<GraphView>(`/api/snapshots/${id}/graph/view${q(p)}`),
  usage: (id: number, key: string) => request<Usage>(`/api/snapshots/${id}/usage${q({ key })}`),
  impact: (id: number, key: string) => request<Impact>(`/api/snapshots/${id}/impact${q({ key })}`),
  entryPoints: (id: number) => request<EntryPoint[]>(`/api/snapshots/${id}/flows/entry-points`),
  trace: (id: number, key: string, range?: [number | null, number | null]) =>
    request<Flow>(`/api/snapshots/${id}/flows/trace${q({ key, line_start: range?.[0] ?? undefined, line_end: range?.[1] ?? undefined })}`),
  retrieve: (id: number, query: string, limit = 12) => request<{ results: RetrievalResult[]; tokens: string[] }>(`/api/snapshots/${id}/retrieve${q({ q: query, limit })}`),
  reports: (id: number) => request<ReportBrief[]>(`/api/snapshots/${id}/reports`),
  report: (id: number) => request<Report>(`/api/reports/${id}`),
  reportMarkdownUrl: (id: number) => `/api/reports/${id}/markdown`,
  requestAgentReport: (id: number) => request<{ job: Job }>(`/api/snapshots/${id}/agent-report`, { method: "POST" }),
  compare: (base: number, head: number) => request<Comparison>(`/api/compare${q({ base, head })}`),
  conversations: (snapshotId: number) => request<Conversation[]>(`/api/snapshots/${snapshotId}/conversations`),
  createConversation: (snapshotId: number, model?: string) => request<Conversation>(`/api/snapshots/${snapshotId}/conversations`, { method: "POST", body: JSON.stringify({ model }) }),
  conversation: (id: number) => request<Conversation>(`/api/conversations/${id}`),
  ask: (conversationId: number, content: string) =>
    request<{ question_id: number; reply_id: number; job: Job }>(`/api/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ content }) }),
  agentStatus: () => request<AgentStatus>("/api/agent/status"),
  agentModels: () => request<AgentModel[]>("/api/agent/models"),
  selectModel: (model: string) => request<AgentStatus>("/api/agent/model", { method: "PUT", body: JSON.stringify({ model }) }),
};

export interface RecentConversation extends Conversation {
  repository: string;
  commit_sha: string;
  questions: number;
}

export const recentConversations = (limit = 8) => fetch(`/api/conversations?limit=${limit}`, { credentials: "same-origin", cache: "no-store" }).then(async (r) => {
  if (!r.ok) throw new ApiError(r.status, "http_error", `${r.status}`);
  return (await r.json()) as RecentConversation[];
});
