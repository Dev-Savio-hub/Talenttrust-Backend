/**
 * In-memory escrow store. Mirrors the state machine of the on-chain Soroban
 * escrow contract so the API can be used without a database. Data lives only
 * for the lifetime of the process (or serverless instance).
 */

export type ContractStatus =
  | 'Created'
  | 'Funded'
  | 'Completed'
  | 'Disputed'
  | 'Resolved'
  | 'Cancelled';

export interface Milestone {
  index: number;
  title: string;
  amount: number;
  released: boolean;
}

export interface Dispute {
  raisedBy: string;
  reason: string;
  openedAt: string;
  freelancerBps?: number;
  resolvedAt?: string;
}

export interface EscrowContract {
  id: number;
  title: string;
  client: string;
  freelancer: string;
  token: string;
  milestones: Milestone[];
  totalAmount: number;
  fundedAmount: number;
  releasedAmount: number;
  status: ContractStatus;
  reputationIssued: boolean;
  dispute?: Dispute;
  createdAt: string;
  updatedAt: string;
}

export type RatingHistogram = [number, number, number, number, number];

export type ReputationSort = 'score' | 'completed' | 'average';

export interface Reputation {
  address: string;
  completedContracts: number;
  totalRating: number;
  averageRating: number;
  score: number;
  rank: number | null;
  histogram: RatingHistogram;
  lastRatedAt: string | null;
}

export interface ReputationPage {
  data: Reputation[];
  page: {
    limit: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
}

interface ReputationRecord {
  completed: number;
  total: number;
  histogram: RatingHistogram;
  lastRatedAt: string | null;
}

interface LeaderboardCache {
  priorWeight: number;
  globalMean: number;
  bySort: Record<ReputationSort, Reputation[]>;
  byAddress: Map<string, Reputation>;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_MILESTONES = 20;
const ACTIVE: ContractStatus[] = ['Created', 'Funded'];
const REPUTATION_SORTS: ReputationSort[] = ['score', 'completed', 'average'];

const round2 = (n: number): number => Math.round(n * 100) / 100;

const parsePriorWeight = (override?: number): number => {
  if (override !== undefined) return override;
  const raw = process.env.REPUTATION_PRIOR_WEIGHT;
  if (raw === undefined || raw === '') return 5;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5;
};

const encodeCursor = (sort: ReputationSort, address: string): string =>
  Buffer.from(JSON.stringify({ sort, address }), 'utf8').toString('base64url');

const decodeCursor = (cursor: string, expectedSort: ReputationSort): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'cursor is malformed');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new HttpError(400, 'invalid_cursor', 'cursor is malformed');
  }
  const { sort, address } = parsed as { sort?: unknown; address?: unknown };
  if (sort !== expectedSort || typeof address !== 'string' || !address) {
    throw new HttpError(400, 'invalid_cursor', 'cursor does not match query');
  }
  return address;
};

export class EscrowStore {
  private contracts = new Map<number, EscrowContract>();
  private reputation = new Map<string, ReputationRecord>();
  private leaderboardCache: LeaderboardCache | null = null;
  private nextId = 1;
  private priorWeightOverride?: number;

  constructor(options?: { priorWeight?: number }) {
    this.priorWeightOverride = options?.priorWeight;
  }

  list(filter: { status?: string; party?: string } = {}): EscrowContract[] {
    return [...this.contracts.values()].filter(
      (c) =>
        (!filter.status || c.status === filter.status) &&
        (!filter.party || c.client === filter.party || c.freelancer === filter.party),
    );
  }

  get(id: number): EscrowContract {
    const c = this.contracts.get(id);
    if (!c) throw new HttpError(404, 'contract_not_found', `Contract ${id} not found`);
    return c;
  }

  create(input: {
    title?: unknown;
    client?: unknown;
    freelancer?: unknown;
    token?: unknown;
    milestones?: unknown;
  }): EscrowContract {
    const { client, freelancer } = input;
    if (typeof client !== 'string' || typeof freelancer !== 'string' || !client || !freelancer) {
      throw new HttpError(400, 'invalid_parties', 'client and freelancer are required strings');
    }
    if (client === freelancer) {
      throw new HttpError(400, 'invalid_parties', 'client and freelancer must differ');
    }
    if (!Array.isArray(input.milestones) || input.milestones.length === 0) {
      throw new HttpError(400, 'invalid_milestones', 'milestones must be a non-empty array');
    }
    if (input.milestones.length > MAX_MILESTONES) {
      throw new HttpError(400, 'invalid_milestones', `at most ${MAX_MILESTONES} milestones`);
    }
    const milestones: Milestone[] = input.milestones.map((m: unknown, index: number) => {
      const raw = (typeof m === 'number' ? { amount: m } : m) as { title?: unknown; amount?: unknown };
      const amount = Number(raw?.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new HttpError(400, 'invalid_amount', `milestone ${index} amount must be positive`);
      }
      return {
        index,
        title: typeof raw.title === 'string' && raw.title ? raw.title : `Milestone ${index + 1}`,
        amount,
        released: false,
      };
    });
    const now = new Date().toISOString();
    const c: EscrowContract = {
      id: this.nextId++,
      title: typeof input.title === 'string' && input.title ? input.title : 'Untitled engagement',
      client,
      freelancer,
      token: typeof input.token === 'string' && input.token ? input.token : 'XLM',
      milestones,
      totalAmount: milestones.reduce((s, m) => s + m.amount, 0),
      fundedAmount: 0,
      releasedAmount: 0,
      status: 'Created',
      reputationIssued: false,
      createdAt: now,
      updatedAt: now,
    };
    this.contracts.set(c.id, c);
    return c;
  }

  private requireActive(c: EscrowContract) {
    if (!ACTIVE.includes(c.status)) {
      throw new HttpError(409, 'invalid_status', `Contract is ${c.status}`);
    }
  }

  private touch(c: EscrowContract) {
    c.updatedAt = new Date().toISOString();
    return c;
  }

  deposit(id: number, amountRaw: unknown): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new HttpError(400, 'invalid_amount', 'amount must be positive');
    }
    if (c.fundedAmount + amount > c.totalAmount) {
      throw new HttpError(409, 'over_funded', 'deposit exceeds contract total');
    }
    c.fundedAmount += amount;
    if (c.fundedAmount === c.totalAmount) c.status = 'Funded';
    return this.touch(c);
  }

  release(id: number, index: number): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    const m = c.milestones[index];
    if (!m) throw new HttpError(404, 'milestone_not_found', `Milestone ${index} not found`);
    if (m.released) throw new HttpError(409, 'already_released', 'Milestone already released');
    if (c.fundedAmount - c.releasedAmount < m.amount) {
      throw new HttpError(409, 'insufficient_funds', 'Escrow balance too low for this milestone');
    }
    m.released = true;
    c.releasedAmount += m.amount;
    if (c.milestones.every((x) => x.released)) c.status = 'Completed';
    return this.touch(c);
  }

  openDispute(id: number, raisedBy: unknown, reason: unknown): EscrowContract {
    const c = this.get(id);
    if (raisedBy !== c.client && raisedBy !== c.freelancer) {
      throw new HttpError(403, 'unauthorized', 'Only the client or freelancer can open a dispute');
    }
    this.requireActive(c);
    c.status = 'Disputed';
    c.dispute = {
      raisedBy,
      reason: typeof reason === 'string' && reason ? reason : 'No reason given',
      openedAt: new Date().toISOString(),
    };
    return this.touch(c);
  }

  resolveDispute(id: number, bpsRaw: unknown): EscrowContract {
    const c = this.get(id);
    if (c.status !== 'Disputed' || !c.dispute) {
      throw new HttpError(409, 'invalid_status', 'Contract is not disputed');
    }
    const bps = Number(bpsRaw);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      throw new HttpError(400, 'invalid_split', 'freelancerBps must be an integer 0..10000');
    }
    const held = c.fundedAmount - c.releasedAmount;
    const toFreelancer = Math.floor((held * bps) / 10_000);
    c.releasedAmount += toFreelancer;
    c.fundedAmount = c.releasedAmount;
    c.status = 'Resolved';
    c.dispute.freelancerBps = bps;
    c.dispute.resolvedAt = new Date().toISOString();
    return this.touch(c);
  }

  cancel(id: number): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    c.fundedAmount = c.releasedAmount;
    c.status = 'Cancelled';
    return this.touch(c);
  }

  rate(id: number, ratingRaw: unknown): Reputation {
    const c = this.get(id);
    if (c.status !== 'Completed') {
      throw new HttpError(409, 'invalid_status', 'Only completed contracts can be rated');
    }
    if (c.reputationIssued) {
      throw new HttpError(409, 'already_rated', 'Reputation already issued for this contract');
    }
    const rating = Number(ratingRaw);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new HttpError(400, 'invalid_rating', 'rating must be an integer 1..5');
    }
    const now = new Date().toISOString();
    const r = this.reputation.get(c.freelancer) ?? {
      completed: 0,
      total: 0,
      histogram: [0, 0, 0, 0, 0] as RatingHistogram,
      lastRatedAt: null,
    };
    r.completed += 1;
    r.total += rating;
    r.histogram[rating - 1] += 1;
    r.lastRatedAt = now;
    this.reputation.set(c.freelancer, r);
    this.leaderboardCache = null;
    c.reputationIssued = true;
    this.touch(c);
    return this.getReputation(c.freelancer);
  }

  private getLeaderboardCache(): LeaderboardCache {
    const C = parsePriorWeight(this.priorWeightOverride);
    if (this.leaderboardCache && this.leaderboardCache.priorWeight === C) {
      return this.leaderboardCache;
    }

    let globalTotal = 0;
    let globalCompleted = 0;
    for (const r of this.reputation.values()) {
      globalTotal += r.total;
      globalCompleted += r.completed;
    }
    const m = globalCompleted > 0 ? globalTotal / globalCompleted : 3;

    const entries: Reputation[] = [];
    for (const [address, r] of this.reputation.entries()) {
      if (r.completed < 1) continue;
      const averageRating = round2(r.total / r.completed);
      const score = round2((C * m + r.total) / (C + r.completed));
      entries.push({
        address,
        completedContracts: r.completed,
        totalRating: r.total,
        averageRating,
        score,
        rank: null,
        histogram: [...r.histogram] as RatingHistogram,
        lastRatedAt: r.lastRatedAt,
      });
    }

    const tieBreak = (a: Reputation, b: Reputation) => {
      if (b.completedContracts !== a.completedContracts) {
        return b.completedContracts - a.completedContracts;
      }
      return a.address.localeCompare(b.address);
    };

    const byScore = [...entries].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return tieBreak(a, b);
    });

    const byAddress = new Map<string, Reputation>();
    byScore.forEach((entry, idx) => {
      entry.rank = idx + 1;
      byAddress.set(entry.address, entry);
    });

    const byCompleted = [...byScore].sort((a, b) => tieBreak(a, b));
    const byAverage = [...byScore].sort((a, b) => {
      if (b.averageRating !== a.averageRating) return b.averageRating - a.averageRating;
      return tieBreak(a, b);
    });

    this.leaderboardCache = {
      priorWeight: C,
      globalMean: m,
      bySort: {
        score: byScore,
        completed: byCompleted,
        average: byAverage,
      },
      byAddress,
    };
    return this.leaderboardCache;
  }

  private cloneReputation(r: Reputation): Reputation {
    return {
      ...r,
      histogram: [...r.histogram] as RatingHistogram,
    };
  }

  getReputation(address: string): Reputation {
    const cache = this.getLeaderboardCache();
    const cached = cache.byAddress.get(address);
    if (cached) {
      return this.cloneReputation(cached);
    }
    return {
      address,
      completedContracts: 0,
      totalRating: 0,
      averageRating: 0,
      score: cache.priorWeight > 0 ? round2(cache.globalMean) : 0,
      rank: null,
      histogram: [0, 0, 0, 0, 0],
      lastRatedAt: null,
    };
  }

  listReputation(query: {
    sort?: unknown;
    minCompleted?: unknown;
    limit?: unknown;
    cursor?: unknown;
  } = {}): ReputationPage {
    const sortRaw = query.sort === undefined || query.sort === '' ? 'score' : query.sort;
    if (typeof sortRaw !== 'string' || !REPUTATION_SORTS.includes(sortRaw as ReputationSort)) {
      throw new HttpError(400, 'invalid_sort', 'sort must be one of score, completed, average');
    }
    const sort = sortRaw as ReputationSort;

    let minCompleted = 1;
    if (query.minCompleted !== undefined && query.minCompleted !== '') {
      const n = Number(query.minCompleted);
      if (!Number.isInteger(n) || n < 0) {
        throw new HttpError(400, 'invalid_min_completed', 'minCompleted must be a non-negative integer');
      }
      minCompleted = n;
    }

    let limit = 20;
    if (query.limit !== undefined && query.limit !== '') {
      const n = Number(query.limit);
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        throw new HttpError(400, 'invalid_limit', 'limit must be an integer 1..100');
      }
      limit = n;
    }

    let cursorAddress: string | undefined;
    if (query.cursor !== undefined && query.cursor !== '') {
      if (typeof query.cursor !== 'string') {
        throw new HttpError(400, 'invalid_cursor', 'cursor must be a string');
      }
      cursorAddress = decodeCursor(query.cursor, sort);
    }

    const cache = this.getLeaderboardCache();
    const filtered = cache.bySort[sort].filter((r) => r.completedContracts >= minCompleted);

    let startIndex = 0;
    if (cursorAddress !== undefined) {
      const idx = filtered.findIndex((r) => r.address === cursorAddress);
      if (idx === -1) {
        throw new HttpError(400, 'invalid_cursor', 'cursor not found in result set');
      }
      startIndex = idx + 1;
    }

    const slice = filtered.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < filtered.length;
    const nextCursor = hasMore && slice.length > 0 ? encodeCursor(sort, slice[slice.length - 1].address) : null;

    return {
      data: slice.map((r) => this.cloneReputation(r)),
      page: {
        limit,
        nextCursor,
        hasMore,
      },
    };
  }

  stats() {
    const all = this.list();
    const byStatus: Record<string, number> = {};
    for (const c of all) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    return {
      contracts: all.length,
      byStatus,
      totalEscrowed: all.reduce((s, c) => s + (c.fundedAmount - c.releasedAmount), 0),
      totalReleased: all.reduce((s, c) => s + c.releasedAmount, 0),
    };
  }

  /** Seed a few demo engagements so the API is explorable out of the box. */
  seed(): this {
    const a = this.create({
      title: 'Landing page redesign',
      client: 'GCLIENTDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      freelancer: 'GFREELANCERDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      milestones: [
        { title: 'Wireframes', amount: 250 },
        { title: 'Visual design', amount: 500 },
        { title: 'Implementation', amount: 750 },
      ],
    });
    this.deposit(a.id, 1500);
    this.release(a.id, 0);
    const b = this.create({
      title: 'Smart contract audit',
      client: 'GCLIENTDEMOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      freelancer: 'GFREELANCERDEMOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      milestones: [{ title: 'Audit report', amount: 2000 }],
    });
    this.deposit(b.id, 2000);
    this.release(b.id, 0);
    this.rate(b.id, 5);
    return this;
  }
}
