// Optional showcase content: a "Visa Payment App" mission of 20 demo tasks
// spread across the departments. They're created as demo tasks (createdBy
// "cto"), so the orchestrator runs them on the SIMULATED path — pure visual
// entertainment, no model calls. Enable with SEED_DEMO=true; idempotent so it
// won't duplicate across restarts (state persists in Postgres).

import { getTasks, createTask, addEvent } from "./store.js";

const MISSION = "Visa Payment App";

// department, title, prompt — a believable end-to-end build of a Visa card app.
const DEMO_TASKS = [
  ["observatory", "Research Visa payment app market", "Scan the market for consumer Visa card / wallet apps (Revolut, Wise, Monzo) and summarise positioning, key features, and differentiators."],
  ["observatory", "Survey card-issuing & BIN providers", "Find candidate card-issuing / BIN-sponsor providers for a Visa program and compare coverage, fees, and onboarding."],
  ["observatory", "Scan competitor onboarding flows", "Investigate how leading wallet apps handle sign-up, KYC, and card activation; note best-practice steps."],
  ["research_lab", "Write product requirements doc", "Draft a concise PRD for a Visa payment app: goals, target users, core flows, and success metrics."],
  ["research_lab", "Spec onboarding & KYC flow", "Write the step-by-step onboarding & KYC specification: welcome, sign-up/OTP, identity verification, account setup."],
  ["research_lab", "Draft fees & FX policy", "Document the fee schedule and FX handling (card issuance, top-up, spend, ATM, cross-currency)."],
  ["research_lab", "Write PCI-DSS compliance overview", "Summarise the PCI-DSS obligations relevant to the app and how each is addressed at a high level."],
  ["security", "Threat-model the payment flow", "Produce a threat model for the end-to-end payment flow: assets, actors, attack surfaces, and mitigations."],
  ["security", "PCI-DSS gap assessment", "Assess the design against PCI-DSS requirements and list prioritised gaps with remediations."],
  ["security", "Review tokenization & encryption", "Review the card-data tokenization and encryption-at-rest/in-transit approach and flag risks."],
  ["development", "Build welcome & sign-up screens", "Build the welcome + sign-up/OTP screens as a polished mobile UI (latest iPhone & Android sizes), with smooth transitions."],
  ["development", "Build KYC verification flow", "Build the KYC flow screens (ID capture, selfie, verifying state with auto-advance) with realistic states."],
  ["development", "Build card application & activation", "Build card application → card ACTIVATION (show the card, Activate action, animated success) → set-PIN screens."],
  ["development", "Build wallet home & balance", "Build the wallet home: balance with count-up animation, quick actions, recent transactions list."],
  ["development", "Build top-up & transfer flow", "Build top-up and transfer flows with amount entry, confirmation, and success animation."],
  ["development", "Build transaction history", "Build the transaction history screen with grouping, filters, and an empty/loading state."],
  ["development", "Build card controls & settings", "Build card controls (freeze/unfreeze, limits, show details) and the settings screen."],
  ["admin", "Catalog merchant category codes", "Organise a reference catalog of common Visa merchant category codes (MCCs) with descriptions."],
  ["admin", "Build fee & FX reference table", "Produce a clean reference table of the app's fees and FX spreads by transaction type."],
  ["admin", "Reconcile sample transaction ledger", "Reconcile a sample set of card transactions into a tidy ledger with running balances."],
];

export function seedDemoTasks() {
  if (getTasks().some((t) => t.mission === MISSION)) return 0; // already seeded
  let n = 0;
  for (const [department, title, prompt] of DEMO_TASKS) {
    createTask({ title, prompt, department, createdBy: "cto", mission: MISSION });
    n++;
  }
  addEvent({ kind: "system", text: `Seeded ${n} demo tasks — "${MISSION}" (simulated showcase)` });
  return n;
}
