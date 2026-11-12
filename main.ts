import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface HistoryRow {
  mint: string;
  rank: number;
  market_cap_lamports: string | number;
  venue: string;
}

interface Mark {
  at: string;
  ok: boolean;
  rows: HistoryRow[] | null;
}

interface Task {
  history_until: string;
  reads: string[];
  places?: number;
  size: { edges: number[] };
}

interface Coin {
  mint: string;
  firstWindowCap?: number;
  lastSeenCap: number;
  lastRank: number;
  score: number;
}

interface ScoredCoin extends Coin {
  expectedRank: number;
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
if (!Array.isArray(task.size?.edges) || task.size.edges.length === 0) {
  throw new Error('task must contain size-bin edges');
}

if (marks.some(({ time }) => !Number.isFinite(time))) throw new Error('history contains an invalid mark time');
marks.sort((a, b) => a.time - b.time || a.index - b.index);
const markTimes = marks.map(({ time }) => time);
const firstTime = markTimes[0]!;
const lastTime = markTimes[markTimes.length - 1]!;
const span = Math.max(0, lastTime - firstTime);
const windowStart = lastTime - span / 4;
const timeScale = Math.max(span / 4, 60_000);
const coins = new Map<string, Coin>();

for (let markIndex = 0; markIndex < marks.length; markIndex++) {
  const mark = marks[markIndex]!.mark;
  const markTime = markTimes[markIndex]!;
  const timeWeight = 0.5 ** ((lastTime - markTime) / timeScale);

  for (const row of mark.rows!) {
    if (typeof row.mint !== 'string' || !Number.isFinite(row.rank) || row.rank < 1) {
      throw new Error('history contains an invalid ranked row');
    }

    let capLamports: bigint;
    try {
      capLamports = BigInt(row.market_cap_lamports);
    } catch {
      throw new Error(`invalid market cap for ${row.mint}`);
    }
    if (capLamports <= 0n) throw new Error(`invalid market cap for ${row.mint}`);
    const cap = Number(capLamports);
    if (!Number.isFinite(cap)) throw new Error(`market cap is out of range for ${row.mint}`);

    let coin = coins.get(row.mint);
    if (coin === undefined) {
      coin = {
        mint: row.mint,
        ...(markTime >= windowStart ? { firstWindowCap: cap } : {}),
        lastSeenCap: cap,
        lastRank: row.rank,
        score: 0,
      };
      coins.set(row.mint, coin);
    } else {
      if (coin.firstWindowCap === undefined && markTime >= windowStart) {
        coin.firstWindowCap = cap;
      }
      coin.lastSeenCap = cap;
      coin.lastRank = row.rank;
    }

    if (row.rank <= 40) {
      coin.score +=
        timeWeight * ((41 - row.rank) / 40) * (row.venue === 'pool' ? 1.25 : 1);
    }
  }
}

for (const coin of coins.values()) {
  const growth = coin.firstWindowCap === undefined ? 1 : coin.lastSeenCap / coin.firstWindowCap;
  const logGrowth = Math.log10(growth);
  const momentum = Math.max(-0.3, Math.min(0.7, logGrowth));
  coin.score *= 1 + 0.35 * momentum;
}

const byScore = (a: Coin, b: Coin): number =>
  b.score - a.score || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0);
const allByScore = [...coins.values()].sort(byScore);
const topScoreMints = new Set(allByScore.slice(0, 50).map((coin) => coin.mint));
const candidates = allByScore.filter((coin) => coin.lastRank <= 60 || topScoreMints.has(coin.mint));
if (candidates.length < 5) throw new Error('history does not contain five forecast candidates');

const totalScore = candidates.reduce((sum, coin) => sum + coin.score, 0);
if (!(totalScore > 0)) throw new Error('candidate scores must have a positive sum');

let cumulativeScore = 0;
const rankedCandidates: ScoredCoin[] = candidates.map((coin) => {
  const expectedRank = 1 + (cumulativeScore / totalScore) * 40;
  cumulativeScore += coin.score;
  return { ...coin, expectedRank };
});

const readTimes = task.reads.map((read) => Date.parse(read)).sort((a, b) => a - b);
if (readTimes.some((time) => !Number.isFinite(time))) throw new Error('task contains an invalid answer read time');
const historyEnd = Date.parse(task.history_until);
if (!Number.isFinite(historyEnd)) throw new Error('task contains an invalid history end time');
const medianRead = readTimes[Math.floor(readTimes.length / 2)]!;
const horizonHours = (medianRead - historyEnd) / 3_600_000;
if (horizonHours < 0) throw new Error('invalid forecast horizon');

const sigma = Math.min(2.2 + 0.08 * horizonHours, 3.2);
const namedMass = Math.max(0.45 - 0.013 * horizonHours, 0.3);
const placeWeights = new Map<number, number[]>();
const probabilities: Array<{ mint: string; place: number; p: number }> = [];
const places = task.places ?? 5;

for (let place = 1; place <= places; place++) {
  const kernels = rankedCandidates.map((coin) => {
    const difference = coin.expectedRank - place;
    return Math.exp(-(difference * difference) / (2 * sigma * sigma));
  });
  const kernelSum = kernels.reduce((sum, value) => sum + value, 0);
  if (!(kernelSum > 0)) throw new Error(`place ${place} has no candidate weight`);
  const weights = kernels.map((value) => value / kernelSum);
  placeWeights.set(place, weights);

  const rows = rankedCandidates
    .map((coin, index) => ({ mint: coin.mint, place, p: namedMass * weights[index]! }))
    .filter((row) => row.p >= 0.001)
    .sort((a, b) => b.p - a.p || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0))
    .slice(0, 100);
  probabilities.push(...rows);
}

const top5 = rankedCandidates
  .map((coin, index) => ({
    mint: coin.mint,
    expectation: Array.from(placeWeights.values()).reduce((sum, weights) => sum + weights[index]!, 0),
  }))
  .sort((a, b) => b.expectation - a.expectation || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0))
  .slice(0, 5)
  .map((coin) => coin.mint);

function erfc(value: number): number {
  const z = Math.abs(value);
  const t = 1 / (1 + 0.5 * z);
  const approximation =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return value >= 0 ? approximation : 2 - approximation;
}

function normalTail(value: number, mean: number, standardDeviation: number): number {
  if (value === -Infinity) return 1;
  if (value === Infinity) return 0;
  return 0.5 * erfc((value - mean) / (standardDeviation * Math.SQRT2));
}

const edges = task.size.edges;
if (edges.some((edge, index) => !Number.isFinite(edge) || (index > 0 && edge <= edges[index - 1]!))) {
  throw new Error('task size-bin edges must be finite and increasing');
}
const standardDeviation = Math.min(0.35 + 0.04 * horizonHours, 0.75);
const lastMarkCaps = new Map<string, number>();
for (const row of marks[marks.length - 1]!.mark.rows!) {
  lastMarkCaps.set(row.mint, Number(BigInt(row.market_cap_lamports)));
}

const sizes: Array<{ place: number; bin: number; p: number }> = [];
for (let place = 1; place <= places; place++) {
  const weights = placeWeights.get(place)!;
  let weightedLogCap = 0;
  let mostLikelyIndex = 0;
  for (let index = 0; index < rankedCandidates.length; index++) {
    const coin = rankedCandidates[index]!;
    const growth = coin.firstWindowCap === undefined ? 1 : coin.lastSeenCap / coin.firstWindowCap;
    const projectedCapSol = (coin.lastSeenCap / 1e9) * growth ** 0.25;
    weightedLogCap += weights[index]! * Math.log10(projectedCapSol);
    if (weights[index]! > weights[mostLikelyIndex]!) mostLikelyIndex = index;
  }

  const expectedCoin = rankedCandidates[mostLikelyIndex]!;
  const expectedCap = lastMarkCaps.get(expectedCoin.mint) ?? expectedCoin.lastSeenCap;
  const mean = 0.5 * Math.log10(expectedCap / 1e9) + 0.5 * weightedLogCap;
  const binProbabilities: number[] = [];
  for (let bin = 0; bin <= edges.length; bin++) {
    const low = bin === 0 ? -Infinity : edges[bin - 1]!;
    const high = bin === edges.length ? Infinity : edges[bin]!;
    binProbabilities.push(
      Math.max(0, normalTail(low, mean, standardDeviation) - normalTail(high, mean, standardDeviation)),
    );
  }
  const binTotal = binProbabilities.reduce((sum, value) => sum + value, 0);
  if (!(binTotal > 0)) throw new Error(`place ${place} has no size-bin probability`);
  let emittedTotal = 0;
  for (let bin = 0; bin < binProbabilities.length; bin++) {
    const probability =
      bin === binProbabilities.length - 1
        ? Math.max(0, 1 - emittedTotal)
        : binProbabilities[bin]! / binTotal;
    sizes.push({ place, bin, p: probability });
    emittedTotal += probability;
  }
}

const forecast = { probabilities, top5, sizes };
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'forecast.json'), `${JSON.stringify(forecast)}\n`);
