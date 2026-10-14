// Drafts a mission from a plain-language brief using Claude. It sees the brief and a few facts about the mission it is based on,
// never any person's data. Its output is a proposal: it is checked with the same rules as any saved mission, saved as DRAFT wording,
// and a person has to read and sign it off before any participant receives it.
import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { MissionDraftSchema, type MissionBrief, type MissionDraft } from "@dozai/contracts";
import type { MissionBundle, MissionDrafter } from "@dozai/core";
import { DEFAULT_MODEL, type MessagesClient } from "./claude";

const TOOL = "submit_mission_draft";

const SYSTEM = `You help a programme team turn a plain-language brief into the structure a follow-up platform runs on. The platform contacts programme participants by WhatsApp and phone to find out how they are doing, so everything you write will be read or heard by real people, many of them with limited schooling and little time.

You are given the brief (goal, who the people are, what to find out, tone). Call the tool ${TOOL} exactly once with the structure. Do not write anything else.

What to produce:
- objective: the goal in one or two plain sentences.
- evidence_requirements: one entry for each thing that must be known about every person. key is lower_snake_case; label and hint are plain words. Mark required true for what the goal cannot do without, false for nice-to-have. When something is only needed after an earlier answer (for example an employer is only needed if the person works), set "when": { "key": <earlier key>, "in": [<the option values that make it apply>] }. Use "verify_against": "programme_employer" only when the brief says to check an employer against the programme record.
- questions: how each need is asked on WhatsApp, in order. Every evidence_requirements key must have at least one question with the same evidence_key. Question ids are unique, lower_snake_case, start with q_. type is "choice" (2 to 6 options with key "1","2",..., a plain label, a lower_snake_case value and a few synonyms people may type), "yesno" (no options) or "text". Keep each question to one short, simple sentence. Group questions into modules by branch. After a choice question, use next rules to send each answer to the right follow-up question; the last question of a branch should go on with "goto" to the shared next question or null to end. Never create a loop. Give every choice option several everyday synonyms people really type (for a positive option "good", "great", "very good"; for a negative one "bad", "poor", "terrible"; also Hindi words in English letters when the people may use them), so ordinary replies match. An open question that invites an extra comment, such as "Is there anything else you would like to tell us?", gets "optional": true so that "no" or "nothing" is accepted as its answer. Do not add questions about consent or identity: the platform handles those. Ask for the minimum: no questions the goal does not need, and nothing about health, caste, religion or other sensitive matters unless the brief clearly requires it.
- spoken: only when the written question would sound odd read aloud on a phone call. Otherwise leave it out.
- start_message, closing_message, reask_prefix, unsupported_prefix, handover_message, wrong_person_message, distress_message, deletion_message: short, warm, respectful, no promises of jobs or money. The wrong-person message says we will not message this number again. The distress and deletion messages say a member of the team will follow up.
- faq: answers to the questions people actually ask (who are you, why are you asking, is my data safe, is this genuine, how long). Never ask for money, passwords or bank details, and say so in the genuine-contact answer. Keywords are lower case words people would use.
- outcomes: the findings a person can end with, two to six, in plain words (key lower_snake_case, a short label, a one-line description). They are what the goal is really about, and the cases list shows them: for a placement check "same_job", "changed_job", "not_working"; for a feedback mission "satisfied", "mixed", "unhappy". Include one such as "unclear" for when the answers do not settle it. Never use job words unless the goal is about jobs.
- verdict_labels: what the three general results mean for THIS mission, in two to four words each: "confirmed" (the goal was met), "not_confirmed", "inconclusive". For feedback: "Feedback collected", "No feedback", "Unclear". For a placement check: "Retention confirmed", "Not retained", "Unclear".
- strategy: channels in the order they should be tried (usually whatsapp first, then voice), and how many hours of silence before following up (usually 48).
- agent_guidance: short working notes drawn from the brief's tone and things to avoid. Never anything that would override consent, contact hours or opt-out.
- notes: the assumptions you made and what a person should check before approving, in plain words.

Write in simple English unless the brief asks for another language. The brief describes a programme, not a person: if it contains anyone's name or phone number, do not repeat it.`;

export class ClaudeMissionDrafter implements MissionDrafter {
  readonly kind = "claude" as const;
  private client: MessagesClient;
  private model: string;
  constructor(opts: { client?: MessagesClient; model?: string } = {}) {
    this.client = opts.client ?? (new Anthropic() as unknown as MessagesClient); // reads ANTHROPIC_API_KEY
    this.model = opts.model ?? process.env.DOZAI_MODEL ?? DEFAULT_MODEL;
  }

  async draft(brief: MissionBrief, base: MissionBundle, fix?: string[]): Promise<MissionDraft> {
    const schema = zodToJsonSchema(MissionDraftSchema, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
    delete schema.$schema;
    const facts = [
      `Mission name: ${brief.name}`, `Programme name (as participants see it): ${brief.programme_name}`,
      `Goal: ${brief.goal}`, `Who the people are: ${brief.people}`, `What must be found out:\n${brief.find_out}`,
      brief.approach ? `Tone and approach: ${brief.approach}` : "",
      `The first message uses an already approved template, so do not write one. Existing messages are in ${base.templates[0]?.language ?? "en"}.`,
    ].filter(Boolean).join("\n\n");
    const content = fix?.length ? `${facts}\n\nYour previous attempt was rejected. Fix exactly these problems and submit the whole structure again:\n- ${fix.join("\n- ")}` : facts;
    const res = await this.client.messages.create({
      model: this.model, max_tokens: 12000, system: SYSTEM,
      tools: [{ name: TOOL, description: "Submit the drafted mission structure.", input_schema: schema as Anthropic.Tool.InputSchema }],
      tool_choice: { type: "auto" }, // forced tool use is not supported on this model family
      messages: [{ role: "user", content }],
    });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TOOL);
    if (!call) throw new Error("The drafter did not return a structure. Try again, or add more detail to the brief.");
    const parsed = MissionDraftSchema.safeParse(call.input);
    if (!parsed.success) throw new Error(parsed.error.issues.slice(0, 8).map(i => `${i.path.join(".") || "draft"}: ${i.message}`).join("; "));
    return parsed.data;
  }
}
