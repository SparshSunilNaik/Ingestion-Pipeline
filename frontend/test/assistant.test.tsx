import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, Message } from "@/lib/api";
import { Assistant } from "@/components/workspace/assistant";
import { axeViolations, makeNav, renderWithNav } from "./helpers";

const api = vi.hoisted(() => ({
  conversations: vi.fn(),
  conversation: vi.fn(),
  createConversation: vi.fn(),
  ask: vi.fn(),
  cancelJob: vi.fn(),
  agentStatus: vi.fn(),
  agentModels: vi.fn(),
  evidence: vi.fn(),
  job: vi.fn(),
}));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api }));

const READY = { mode: "managed", available: true, version: "2.0.29", base_url: null, error: null, selected_model: "openai/gpt-5.6-terra", selected_model_available: true, agent_ready: true };

function conv(messages: Message[], id = 11): Conversation {
  return { id, snapshot_id: 7, title: "How does login work?", model: "openai/gpt-5.6-terra", created_at: "", updated_at: "", messages };
}
const msg = (m: Partial<Message> & Pick<Message, "id" | "role">): Message => ({ content: "", status: "complete", job_id: null, created_at: "", payload: {}, ...m });

beforeEach(() => {
  api.agentStatus.mockResolvedValue(READY);
  api.agentModels.mockResolvedValue([{ id: "openai/gpt-5.6-terra", name: "terra", family: null, enabled: true, context_limit: null }]);
  api.conversations.mockResolvedValue([]);
  api.evidence.mockResolvedValue({ id: "ev_1", path: "svc/auth.py", start_line: 4, end_line: 9, category: "call", subject: null, source_kind: "source", extraction_method: "python_ast", verification_status: "verified", verified_now: true, verification_reason: null, commit_sha: "0123", excerpt: null });
});

describe("Investigation assistant", () => {
  it("creates an investigation on the first question, with the explicitly selected model", async () => {
    const user = userEvent.setup();
    api.createConversation.mockResolvedValue(conv([], 21));
    api.ask.mockResolvedValue({ question_id: 1, reply_id: 2, job: { id: 5 } });
    const { nav } = renderWithNav(<Assistant />);
    const box = await screen.findByRole("textbox", { name: "Question for the assistant" });
    await waitFor(() => expect(box).toBeEnabled());
    expect(screen.getByRole("combobox", { name: "Model for a new investigation" })).toHaveValue("openai/gpt-5.6-terra");
    await user.type(box, "Where is login used?{Enter}");
    await waitFor(() => expect(api.ask).toHaveBeenCalledWith(21, "Where is login used?", null));
    expect(api.createConversation).toHaveBeenCalledWith(7, "openai/gpt-5.6-terra");
    expect(nav.setParams).toHaveBeenCalledWith({ c: "21" });
  });

  it("explains clearly when the model is unavailable and keeps the composer disabled", async () => {
    api.agentStatus.mockResolvedValue({ ...READY, available: true, agent_ready: false, selected_model_available: false, error: null });
    renderWithNav(<Assistant />);
    expect(await screen.findByText(/The AI model is not available/)).toBeInTheDocument();
    expect(screen.getByText(/is not offered by OpenCode/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Question for the assistant" })).toBeDisabled();
  });

  it("renders an evidence-backed answer with grounding and navigable citations", async () => {
    const user = userEvent.setup();
    api.conversations.mockResolvedValue([conv([])]);
    api.conversation.mockResolvedValue(
      conv([
        msg({ id: 1, role: "user", content: "How does login work?" }),
        msg({
          id: 2,
          role: "assistant",
          content: "login creates an account and issues a token.",
          payload: { grounding: "grounded", model: "openai/gpt-5.6-terra", claims: [{ statement: "login calls issue_token", basis: "source_evidence", evidence_ids: ["ev_1"], note: null }], limitations: ["Dynamic calls were not resolved."] },
        }),
      ]),
    );
    const { nav, container } = renderWithNav(<Assistant />, makeNav({}, { c: "11" }));
    expect(await screen.findByText("login creates an account and issues a token.")).toBeInTheDocument();
    expect(screen.getByText("grounded in source")).toBeInTheDocument();
    expect(screen.getByText("1/1 statements cite verified source")).toBeInTheDocument();
    expect(screen.getByText("Dynamic calls were not resolved.")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "svc/auth.py:4-9, open svc/auth.py lines 4–9" }));
    expect(nav.openSource).toHaveBeenCalledWith({ path: "svc/auth.py", start: 4, end: 9 });
    expect(await axeViolations(container)).toEqual([]);
  });

  it("offers cancel while answering and retry after a failure", async () => {
    const user = userEvent.setup();
    api.conversations.mockResolvedValue([conv([])]);
    api.conversation.mockResolvedValue(conv([msg({ id: 1, role: "user", content: "Q?" }), msg({ id: 2, role: "assistant", status: "pending", job_id: 9 })]));
    api.cancelJob.mockResolvedValue({});
    api.job.mockResolvedValue({ id: 9, stage: "investigating" });
    renderWithNav(<Assistant />, makeNav({}, { c: "11" }));
    expect(await screen.findByText("Reading code and writing the answer…")).toBeInTheDocument(); // the job's real stage
    await user.click(await screen.findByRole("button", { name: "Cancel the running investigation" }));
    expect(api.cancelJob).toHaveBeenCalledWith(9);

    api.conversation.mockResolvedValue(conv([msg({ id: 1, role: "user", content: "Q?" }), msg({ id: 2, role: "assistant", status: "failed", content: "Model unavailable" })]));
    api.ask.mockResolvedValue({ question_id: 3, reply_id: 4, job: { id: 10 } });
    renderWithNav(<Assistant />, makeNav({}, { c: "11" }));
    await user.click((await screen.findAllByRole("button", { name: "Retry" }))[0]);
    await waitFor(() => expect(api.ask).toHaveBeenCalledWith(11, "Q?", null));
  });

  it("offers contextual actions for the selected symbol and sends a precise question", async () => {
    const user = userEvent.setup();
    api.createConversation.mockResolvedValue(conv([], 30));
    api.ask.mockResolvedValue({ question_id: 1, reply_id: 2, job: { id: 5 } });
    renderWithNav(
      <Assistant />,
      makeNav({ selection: { kind: "symbol", key: "sym:svc/auth.py#login", label: "login", path: "svc/auth.py", start: 4, end: 9, symbolKind: "function" } }),
    );
    expect(await screen.findByText("attached")).toBeInTheDocument();
    const impact = screen.getByRole("button", { name: /Assess change impact/ });
    await waitFor(() => expect(impact).toBeEnabled());
    await user.click(impact);
    await waitFor(() =>
      expect(api.ask).toHaveBeenCalledWith(30, "What could be affected if function login (svc/auth.py:4-9) changes? Include routes and tests.", "sym:svc/auth.py#login"),
    );
  });

  it("sends the attached context with a typed question, and not after it is detached", async () => {
    const user = userEvent.setup();
    api.createConversation.mockResolvedValue(conv([], 31));
    api.ask.mockResolvedValue({ question_id: 1, reply_id: 2, job: { id: 5 } });
    renderWithNav(
      <Assistant />,
      makeNav({ selection: { kind: "symbol", key: "sym:svc/auth.py#login", label: "login", path: "svc/auth.py", start: 4, end: 9, symbolKind: "function" } }),
    );
    const box = await screen.findByRole("textbox", { name: "Question for the assistant" });
    await waitFor(() => expect(box).toBeEnabled());
    await user.type(box, "What does this return?{Enter}");
    await waitFor(() => expect(api.ask).toHaveBeenCalledWith(31, "What does this return?", "sym:svc/auth.py#login"));
    await user.click(screen.getByRole("button", { name: "Detach login" }));
    expect(screen.getByRole("button", { name: /attach login/ })).toBeInTheDocument();
  });

  it("ignores a conversation that belongs to a different snapshot", async () => {
    api.conversations.mockResolvedValue([conv([], 11)]);
    renderWithNav(<Assistant />, makeNav({}, { c: "999" }));
    expect(await screen.findByText("New investigation")).toBeInTheDocument();
    expect(api.conversation).not.toHaveBeenCalled();
  });
});
