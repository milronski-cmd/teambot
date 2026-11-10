/** One row of a service-credit table: a month with uptime strictly below `below` (%) earns `pct` % credit. */
export interface CreditTier {
  below: number;
  pct: number;
}

/**
 * Hosting plans. The subscription pays for hosting only: model/provider costs are never billed by the cloud
 * (customers bring their own keys or CLI logins, see docs/PROVIDER_POLICY.md).
 *
 * Override or extend via CLOUD_PLANS (JSON array of partial plans, merged by id), e.g.
 *   CLOUD_PLANS='[{"id":"starter","price":"€ 12 per maand"}]'
 * Stripe prices are linked per plan with STRIPE_PRICE_<ID> (e.g. STRIPE_PRICE_STARTER=price_123).
 */
export interface Plan {
  id: string;
  name: string;
  /** Display price, e.g. "€ 9 per maand". */
  price: string;
  description: string;
  /** Paid plans need a subscription (Stripe Checkout, or set by the operator in manual mode). */
  paid: boolean;
  /** shared = we run the instance (default); dedicated = the customer runs it in their own VPC, we monitor. */
  deployment?: 'shared' | 'dedicated';
  seats: number;
  /** Monthly availability target in % (SLA), or null when the plan has no availability guarantee. */
  slaTarget?: number | null;
  /**
   * Service credits when the target is missed. EXAMPLE DEFAULTS: the real table is an owner decision (docs/SLA.md);
   * override per plan with CLOUD_PLANS, e.g. [{"id":"team","credits":[{"below":99.9,"pct":10},...]}].
   */
  credits?: CreditTier[];
  /** Monthly hosting price in cents (credit amounts are computed from it); null = on quote. */
  monthlyPriceCents?: number | null;
  currency?: string;
  storageGb: number;
  memoryMb: number;
  cpus: number;
  pids: number;
}

export const DEFAULT_PLANS: Plan[] = [
  {
    id: 'trial',
    name: 'Proef',
    price: 'Gratis, 14 dagen',
    description: 'Probeer TeamBot Cloud zonder betaalgegevens.',
    paid: false,
    seats: 3,
    slaTarget: null,
    monthlyPriceCents: 0,
    storageGb: 1,
    memoryMb: 512,
    cpus: 0.5,
    pids: 256,
  },
  {
    id: 'starter',
    name: 'Starter',
    price: '€ 9 per maand',
    description: 'Voor jezelf of een klein team. Je bots staan altijd aan.',
    paid: true,
    seats: 3,
    slaTarget: 99.5,
    // Example defaults (owner decision, see docs/SLA.md §7).
    credits: [
      { below: 99.5, pct: 10 },
      { below: 99.0, pct: 25 },
      { below: 95.0, pct: 50 },
    ],
    monthlyPriceCents: 900,
    currency: 'eur',
    storageGb: 5,
    memoryMb: 1024,
    cpus: 1,
    pids: 512,
  },
  {
    id: 'team',
    name: 'Team',
    price: '€ 29 per maand',
    description: 'Meer mensen, meer opslag en meer rekenkracht.',
    paid: true,
    seats: 15,
    slaTarget: 99.9,
    // Example defaults (owner decision, see docs/SLA.md §7).
    credits: [
      { below: 99.9, pct: 10 },
      { below: 99.0, pct: 25 },
      { below: 95.0, pct: 50 },
    ],
    monthlyPriceCents: 2900,
    currency: 'eur',
    storageGb: 25,
    memoryMb: 2048,
    cpus: 2,
    pids: 1024,
  },
  {
    id: 'dedicated',
    name: 'Dedicated',
    price: 'Op offerte',
    description: 'TeamBot op je eigen server of in je eigen VPC. Wij bewaken, ondersteunen en leveren updates; je data blijft bij jou.',
    paid: true,
    deployment: 'dedicated',
    seats: 100,
    // No availability guarantee on a server the customer runs (docs/SLA.md §2); measured and reported only.
    slaTarget: null,
    monthlyPriceCents: null,
    currency: 'eur',
    // Resources are the customer's own server; these only matter for the shared provisioners.
    storageGb: 0,
    memoryMb: 0,
    cpus: 0,
    pids: 0,
  },
];

export const isDedicatedPlan = (p: Plan) => p.deployment === 'dedicated';

export function loadPlans(env: NodeJS.ProcessEnv = process.env, trialDays = 14): Plan[] {
  const plans = DEFAULT_PLANS.map((p) => ({ ...p }));
  const trial = plans.find((p) => p.id === 'trial');
  if (trial) trial.price = `Gratis, ${trialDays} dagen`;
  if (env.CLOUD_PLANS) {
    let extra: Partial<Plan>[];
    try {
      extra = JSON.parse(env.CLOUD_PLANS);
    } catch {
      throw new Error('CLOUD_PLANS is geen geldige JSON');
    }
    for (const e of extra) {
      if (!e?.id || !/^[a-z0-9-]{2,20}$/.test(e.id)) throw new Error('CLOUD_PLANS: elk abonnement heeft een id (a-z, 0-9, -)');
      const cur = plans.find((p) => p.id === e.id);
      if (cur) Object.assign(cur, e);
      else plans.push({ ...DEFAULT_PLANS[1], name: e.id, ...e } as Plan);
    }
  }
  for (const p of plans) {
    if (p.slaTarget !== undefined && p.slaTarget !== null && !(p.slaTarget > 0 && p.slaTarget <= 100)) throw new Error(`CLOUD_PLANS: slaTarget van ${p.id} moet tussen 0 en 100 liggen`);
    for (const t of p.credits || []) {
      if (!(t.below > 0 && t.below <= 100) || !(t.pct > 0 && t.pct <= 100)) throw new Error(`CLOUD_PLANS: ongeldige credit-regel in ${p.id}`);
    }
    // Highest threshold first; the lowest matching threshold wins (see creditFor in reports.ts).
    p.credits = [...(p.credits || [])].sort((a, b) => b.below - a.below);
  }
  return plans;
}

export function planById(plans: Plan[], id: string | null | undefined): Plan {
  return plans.find((p) => p.id === id) || plans[0];
}
