import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface HistoryRow {
  mint: string;
  rank: number;
  market_cap_lamports: string | number;
  venue: string;
  created_at?: string;
  complete?: boolean;
  mayhem?: boolean;
  symbol?: string;
}

interface Mark {
  at: string;
  ok: boolean;
  rows: HistoryRow[] | null;
}

interface Task {
  reads: string[];
  cadence_minutes?: number;
  size: { edges: number[] };
}

type Group = 'P' | 'C';

interface Point {
  time: number;
  logCap: number;
  group: Group;
}

interface Coin {
  mint: string;
  symbol: string;
  createdAt: number;
  series: Point[];
  lastSeenCap: number;
  lastLogCap: number;
  lastRank: number;
  lastVenue: string;
  lastComplete: boolean;
  lastMayhem: boolean;
  lastGroup: Group;
}

interface StepSample {
  increment: number;
  age: number;
}

interface Dynamics {
  mu: number;
  sd: number;
  pCrash: number;
  crashSize: number;
  drifts: number[];
}

interface FieldCoin {
  logCap: number;
  birthStep: number;
  order: number;
}

interface RankedItem {
  logCap: number;
  candidateIndex?: number;
  fieldIndex?: number;
  birthStep?: number;
  order: number;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const task = JSON.parse(readFileSync(join(inputDir, 'task.json'), 'utf8')) as Task;
const parsedMarks = readFileSync(join(inputDir, 'history.ndjson'), 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Mark);
const marks = parsedMarks
  .filter((mark) => mark.ok && Array.isArray(mark.rows))
  .map((mark, index) => ({ mark, time: Date.parse(mark.at), index }));

if (marks.length === 0) throw new Error('history must contain successful marks with rows');
if (!Array.isArray(task.reads) || task.reads.length === 0) throw new Error('task must contain answer reads');
if (!Array.isArray(task.size?.edges) || task.size.edges.length !== 81) {
  throw new Error('task size must contain 81 edges');
}
if (marks.some(({ time }) => !Number.isFinite(time))) throw new Error('history contains an invalid mark time');
marks.sort((a, b) => a.time - b.time || a.index - b.index);

const stepMs = (task.cadence_minutes ?? 10) * 60_000;
if (!Number.isFinite(stepMs) || stepMs <= 0) throw new Error('invalid history cadence');
const edges = task.size.edges;
if (edges.some((edge, index) => !Number.isFinite(edge) || (index > 0 && edge <= edges[index - 1]!))) {
  throw new Error('task size-bin edges must be finite and increasing');
}
const allReadTimes = task.reads.map((read) => Date.parse(read));
if (allReadTimes.some((time) => !Number.isFinite(time))) throw new Error('task contains an invalid answer read time');
const reads = allReadTimes
  .map((time, index) => ({ time, index }))
  .sort((a, b) => a.time - b.time || a.index - b.index);
const firstNonemptyIndex = marks.findIndex(({ mark }) => mark.rows!.length > 0);
if (firstNonemptyIndex < 0) throw new Error('history contains no ranked rows');

const coins = new Map<string, Coin>();
const newcomerCaps: number[] = [];
let newcomerMarks = 0;

for (let markIndex = 0; markIndex < marks.length; markIndex++) {
  const { mark, time: markTime } = marks[markIndex]!;
  if (markIndex > firstNonemptyIndex) newcomerMarks++;

  for (const row of mark.rows!) {
    if (typeof row.mint !== 'string' || row.mint.length === 0 || !Number.isFinite(row.rank) || row.rank < 1) {
      throw new Error('history contains an invalid ranked row');
    }

    let capLamports: bigint;
    try {
      capLamports = BigInt(row.market_cap_lamports);
    } catch {
      throw new Error(`invalid market cap for ${row.mint}`);
    }
    if (capLamports <= 0n) throw new Error(`invalid market cap for ${row.mint}`);
    const capNumber = Number(capLamports);
    if (!Number.isFinite(capNumber)) throw new Error(`market cap is out of range for ${row.mint}`);
    const capSol = capNumber / 1e9;
    const logCap = Math.log10(capSol);
    if (!Number.isFinite(logCap)) throw new Error(`invalid market cap for ${row.mint}`);
    const seenBefore = coins.has(row.mint);

    if (!seenBefore) {
      const createdAt = row.created_at === undefined ? markTime : Date.parse(row.created_at);
      if (!Number.isFinite(createdAt)) throw new Error(`invalid creation time for ${row.mint}`);
      const coin: Coin = {
        mint: row.mint,
        symbol: typeof row.symbol === 'string' && row.symbol.length > 0 ? row.symbol : row.mint,
        createdAt,
        series: [],
        lastSeenCap: capNumber,
        lastLogCap: logCap,
        lastRank: row.rank,
        lastVenue: row.venue,
        lastComplete: row.complete === true,
        lastMayhem: row.mayhem === true,
        lastGroup: row.venue === 'pool' || row.complete === true ? 'P' : 'C',
      };
      coins.set(row.mint, coin);
      if (markIndex > firstNonemptyIndex && row.rank <= 100) newcomerCaps.push(logCap);
    } else {
      const coin = coins.get(row.mint)!;
      coin.lastSeenCap = capNumber;
      coin.lastLogCap = logCap;
      coin.lastRank = row.rank;
      coin.lastVenue = row.venue;
      coin.lastComplete = row.complete === true;
      coin.lastMayhem = row.mayhem === true;
      coin.lastGroup = row.venue === 'pool' || row.complete === true ? 'P' : 'C';
      if (coin.symbol === coin.mint && typeof row.symbol === 'string' && row.symbol.length > 0) {
        coin.symbol = row.symbol;
      }
    }

    const coin = coins.get(row.mint)!;
    coin.series.push({
      time: markTime,
      logCap,
      group: row.venue === 'pool' || row.complete === true ? 'P' : 'C',
    });
  }
}

const incrementSamples: StepSample[] = [];
const groupSamples: Record<Group, StepSample[]> = { P: [], C: [] };
const ageBoundaries = [0.25, 0.5, 1, 2, 4];

for (const coin of coins.values()) {
  for (let pointIndex = 1; pointIndex < coin.series.length; pointIndex++) {
    const first = coin.series[pointIndex - 1]!;
    const second = coin.series[pointIndex]!;
    const steps = Math.max(1, Math.round((second.time - first.time) / stepMs));
    const sample: StepSample = {
      increment: (second.logCap - first.logCap) / steps,
      age: (first.time - coin.createdAt) / 3_600_000,
    };
    incrementSamples.push(sample);
    groupSamples[first.group].push(sample);
  }
}

function computeDynamics(samples: StepSample[]): Dynamics {
  const mu = samples.length === 0
    ? 0
    : samples.reduce((sum, sample) => sum + sample.increment, 0) / samples.length;
  const variance = samples.length === 0
    ? 0
    : samples.reduce((sum, sample) => sum + (sample.increment - mu) ** 2, 0) / samples.length;
  const sd = Math.max(0.05, Math.min(0.3, Math.sqrt(variance)));
  const crashes = samples.filter((sample) => sample.increment < -0.45);
  const pCrash = Math.max(0.005, Math.min(0.08, crashes.length / Math.max(1, samples.length)));
  const crashMean = crashes.length === 0
    ? -0.7
    : crashes.reduce((sum, sample) => sum + sample.increment, 0) / crashes.length;
  const crashSize = Math.max(-1.2, Math.min(-0.45, crashMean));
  const drifts = Array.from({ length: ageBoundaries.length + 1 }, (_, bin) => {
    const lower = bin === 0 ? -Infinity : ageBoundaries[bin - 1]!;
    const upper = ageBoundaries[bin] ?? Infinity;
    const inBin = samples.filter((sample) => sample.age >= lower && sample.age < upper);
    const sum = inBin.reduce((total, sample) => total + sample.increment, 0);
    return (sum + 10 * mu) / (inBin.length + 10);
  });
  return { mu, sd, pCrash, crashSize, drifts };
}

const globalDynamics = computeDynamics(incrementSamples);
const dynamicsByGroup: Record<Group, Dynamics> = {
  P: groupSamples.P.length >= 150 ? computeDynamics(groupSamples.P) : globalDynamics,
  C: groupSamples.C.length >= 150 ? computeDynamics(groupSamples.C) : globalDynamics,
};

function ageBin(age: number): number {
  for (let index = 0; index < ageBoundaries.length; index++) {
    if (age < ageBoundaries[index]!) return index;
  }
  return ageBoundaries.length;
}

const newcomerLambda = newcomerCaps.length === 0
  ? 0
  : Math.max(0, Math.min(60, newcomerCaps.length / Math.max(1, newcomerMarks)));

const nonemptyMarks = marks.filter(({ mark }) => mark.rows!.length > 0);
const lastMark = nonemptyMarks[nonemptyMarks.length - 1]!;
const lastMarkTime = lastMark.time;
const lastMarkRows = lastMark.mark.rows!;
const lastMarkMints = new Set(lastMarkRows.map((row) => row.mint));
const orderedLastRows = [...lastMarkRows].sort((a, b) => a.rank - b.rank);
const rankFiveRow = orderedLastRows.find((row) => row.rank === 5) ?? orderedLastRows[4];
const rankFiveCap = rankFiveRow === undefined
  ? 0
  : Number(BigInt(rankFiveRow.market_cap_lamports));
const candidatesUnfiltered = [...coins.values()].filter(
  (coin) => lastMarkMints.has(coin.mint) || coin.lastSeenCap >= rankFiveCap / 10 ** 1.5,
);
const byLastCap = (a: Coin, b: Coin): number =>
  b.lastSeenCap - a.lastSeenCap || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0);
let candidateCoins = candidatesUnfiltered.sort(byLastCap).slice(0, 240);
if (candidateCoins.length < 5) candidateCoins = [...coins.values()].sort(byLastCap).slice(0, 240);
if (candidateCoins.length < 5) throw new Error('history does not contain five distinct forecast candidates');

const candidates = candidateCoins.map((coin) => {
  const lastPoint = coin.series[coin.series.length - 1]!;
  let startLogCap = coin.lastLogCap;
  if (!lastMarkMints.has(coin.mint)) {
    const missedSteps = Math.round((lastMarkTime - lastPoint.time) / stepMs);
    startLogCap += Math.min(0, globalDynamics.mu) * missedSteps;
  }
  return { coin, startLogCap };
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const random = mulberry32(0x9e3779b9);
let spareGaussian: number | undefined;
function gaussian(): number {
  if (spareGaussian !== undefined) {
    const value = spareGaussian;
    spareGaussian = undefined;
    return value;
  }
  let first = random();
  while (first <= 0) first = random();
  const second = random();
  const radius = Math.sqrt(-2 * Math.log(first));
  const angle = 2 * Math.PI * second;
  spareGaussian = radius * Math.sin(angle);
  return radius * Math.cos(angle);
}

function poisson(lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda >= 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gaussian()));
  const limit = Math.exp(-lambda);
  let product = 1;
  let count = 0;
  do {
    count++;
    product *= random();
  } while (product > limit);
  return count - 1;
}

function evolve(logCap: number, group: Group, age: number): number {
  const dynamics = dynamicsByGroup[group];
  const drift = dynamics.drifts[ageBin(age)]!;
  const delta = random() < dynamics.pCrash
    ? dynamics.crashSize + 0.1 * gaussian()
    : drift + dynamics.sd * gaussian();
  return logCap + delta;
}

function binOf(logCap: number): number {
  let low = 0;
  let high = edges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (logCap < edges[middle]!) high = middle;
    else low = middle + 1;
  }
  return low;
}

const lastReadTime = reads[reads.length - 1]!.time;
const stepsToLastRead = Math.max(1, Math.ceil((lastReadTime - lastMarkTime) / stepMs));
const numCandidates = candidates.length;
const numSims = Math.max(600, Math.min(3000, Math.floor(9_000_000 / Math.max(1, stepsToLastRead * (numCandidates + 48)))));
const targetSteps = reads.map(({ time }) => Math.max(1, Math.ceil((time - lastMarkTime) / stepMs)));
const placeCounts = new Uint32Array(numCandidates * 5);
const sizeCounts = new Uint32Array(5 * 82);
let fieldOrder = 0;

for (let simulation = 0; simulation < numSims; simulation++) {
  const state = candidates.map((candidate) => candidate.startLogCap);
  let field: FieldCoin[] = [];
  let currentStep = 0;

  for (let readIndex = 0; readIndex < reads.length; readIndex++) {
    const targetStep = targetSteps[readIndex]!;
    while (currentStep < targetStep) {
      const nextStep = currentStep + 1;
      const elapsedAtStart = currentStep * stepMs;
      for (let index = 0; index < candidates.length; index++) {
        const coin = candidates[index]!.coin;
        const age = (lastMarkTime + elapsedAtStart - coin.createdAt) / 3_600_000;
        state[index] = evolve(state[index]!, coin.lastGroup, age);
      }

      const spawnCount = newcomerCaps.length === 0 ? 0 : poisson(newcomerLambda);
      for (let index = 0; index < spawnCount; index++) {
        const selected = Math.floor(random() * newcomerCaps.length);
        field.push({
          logCap: newcomerCaps[selected]!,
          birthStep: nextStep,
          order: fieldOrder++,
        });
      }
      for (const newcomer of field) {
        const age = ((nextStep - newcomer.birthStep) * stepMs) / 3_600_000;
        newcomer.logCap = evolve(newcomer.logCap, 'C', age);
      }
      field.sort((a, b) => b.logCap - a.logCap || a.birthStep - b.birthStep || a.order - b.order);
      if (field.length > 48) field.length = 48;
      currentStep = nextStep;
    }

    const ranked: RankedItem[] = candidates.map((candidate, candidateIndex) => ({
      logCap: state[candidateIndex]!,
      candidateIndex,
      order: candidateIndex,
    }));
    for (let fieldIndex = 0; fieldIndex < field.length; fieldIndex++) {
      const newcomer = field[fieldIndex]!;
      ranked.push({
        logCap: newcomer.logCap,
        fieldIndex,
        birthStep: newcomer.birthStep,
        order: newcomer.order,
      });
    }
    ranked.sort((a, b) => {
      const byCap = b.logCap - a.logCap;
      if (byCap !== 0) return byCap;
      const aIsCandidate = a.candidateIndex !== undefined;
      const bIsCandidate = b.candidateIndex !== undefined;
      if (aIsCandidate !== bIsCandidate) return aIsCandidate ? -1 : 1;
      if (aIsCandidate) return a.candidateIndex! - b.candidateIndex!;
      return a.birthStep! - b.birthStep! || a.order - b.order;
    });

    for (let placeIndex = 0; placeIndex < 5; placeIndex++) {
      const holder = ranked[placeIndex]!;
      if (holder.candidateIndex !== undefined) {
        placeCounts[holder.candidateIndex * 5 + placeIndex]++;
      }
      sizeCounts[placeIndex * 82 + binOf(holder.logCap)]++;
    }
  }
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

const observationCount = numSims * reads.length;
const probabilities: Array<{ mint: string; place: number; p: number }> = [];
for (let placeIndex = 0; placeIndex < 5; placeIndex++) {
  const rows = candidates
    .map(({ coin }, candidateIndex) => ({
      mint: coin.mint,
      place: placeIndex + 1,
      p: placeCounts[candidateIndex * 5 + placeIndex]! / observationCount,
    }))
    .filter((row) => row.p >= 0.0008)
    .sort((a, b) => b.p - a.p || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0))
    .slice(0, 100)
    .map((row) => ({ ...row, p: round6(row.p) }));
  let totalMicros = rows.reduce((sum, row) => sum + Math.round(row.p * 1_000_000), 0);
  if (totalMicros > 1_000_000 && rows.length > 0) {
    const largestMicros = Math.round(rows[0]!.p * 1_000_000);
    rows[0]!.p = Math.max(0, largestMicros - (totalMicros - 1_000_000)) / 1_000_000;
    totalMicros = rows.reduce((sum, row) => sum + Math.round(row.p * 1_000_000), 0);
    while (totalMicros > 1_000_000) {
      rows[0]!.p = Math.max(0, Math.round(rows[0]!.p * 1_000_000) - 1) / 1_000_000;
      totalMicros = rows.reduce((sum, row) => sum + Math.round(row.p * 1_000_000), 0);
    }
  }
  probabilities.push(...rows);
}
probabilities.sort(
  (a, b) =>
    a.place - b.place || b.p - a.p || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0),
);

const candidatesByExpectation = candidates
  .map(({ coin }, candidateIndex) => {
    let probabilitySum = 0;
    let weightedPlace = 0;
    for (let placeIndex = 0; placeIndex < 5; placeIndex++) {
      const count = placeCounts[candidateIndex * 5 + placeIndex]!;
      probabilitySum += count;
      weightedPlace += (placeIndex + 1) * count;
    }
    return {
      coin,
      probabilitySum,
      expectedPlace: probabilitySum > 0 ? weightedPlace / probabilitySum : Infinity,
      candidateIndex,
    };
  })
  .filter((candidate) => candidate.probabilitySum > 0)
  .sort(
    (a, b) =>
      b.probabilitySum - a.probabilitySum ||
      a.expectedPlace - b.expectedPlace ||
      (a.coin.mint < b.coin.mint ? -1 : a.coin.mint > b.coin.mint ? 1 : 0),
  );
const topCandidates = candidatesByExpectation.slice(0, 5).map((candidate) => candidate.coin.mint);
if (topCandidates.length < 5) {
  for (const candidate of candidates) {
    if (!topCandidates.includes(candidate.coin.mint)) topCandidates.push(candidate.coin.mint);
    if (topCandidates.length === 5) break;
  }
}

const sizes: Array<{ place: number; bin: number; p: number }> = [];
for (let placeIndex = 0; placeIndex < 5; placeIndex++) {
  const counts = Array.from({ length: 82 }, (_, bin) => sizeCounts[placeIndex * 82 + bin]!);
  const denominator = observationCount + 0.6 * 82;
  const roundedMicros = counts.map((count) => Math.round(((count + 0.6) / denominator) * 1_000_000));
  const largestBin = counts.reduce((best, count, bin) => (count > counts[best]! ? bin : best), 0);
  const roundedTotal = roundedMicros.reduce((sum, value) => sum + value, 0);
  roundedMicros[largestBin] = Math.max(0, roundedMicros[largestBin]! + 1_000_000 - roundedTotal);
  for (let bin = 0; bin < 82; bin++) {
    sizes.push({ place: placeIndex + 1, bin, p: roundedMicros[bin]! / 1_000_000 });
  }
}

const forecast = { probabilities, top5: topCandidates, sizes };
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'forecast.json'), `${JSON.stringify(forecast)}\n`);
