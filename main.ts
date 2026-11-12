import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface HistoryRow {
  rank: number;
  mint: string;
  market_cap_lamports: string | number;
  venue: string;
}

interface Mark {
  at: string;
  ok: boolean;
  rows: HistoryRow[] | null;
}

interface Coin {
  mint: string;
  windowFirstCap?: number;
  lastSeenCap: number;
  lastCap: number;
  lastRank: number;
  score: number;
}

interface Task {
  history_until: string;
  reads: string[];
  size: { edges: number[] };
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const task = JSON.parse(readFileSync(join(inputDir, 'task.json'), 'utf8')) as Task;
const allMarks = readFileSync(join(inputDir, 'history.ndjson'), 'utf8')
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as Mark);
const marks = allMarks.filter((mark) => mark.ok && Array.isArray(mark.rows));
if (marks.length === 0) {
  throw new Error('history must contain successful marks with rows');
}
if (task.reads.length === 0) throw new Error('task must contain answer reads');

const markTimes = marks.map((mark) => Date.parse(mark.at));
if (markTimes.some((time) => !Number.isFinite(time))) throw new Error('history contains an invalid mark time');
const firstTime = markTimes[0]!;
const lastTime = markTimes[markTimes.length - 1]!;
const span = lastTime - firstTime;
const growthWindowStart = lastTime - span / 4;
const timeScale = Math.max(span / 4, 60_000);
const coins = new Map<string, Coin>();

for (let markIndex = 0; markIndex < marks.length; markIndex++) {
  const mark = marks[markIndex]!;
  const weight = 0.5 ** ((lastTime - markTimes[markIndex]!) / timeScale);

  for (const row of mark.rows!) {
    const cap = Number(BigInt(row.market_cap_lamports));
    if (!(cap > 0)) throw new Error(`invalid market cap for ${row.mint}`);

    let coin = coins.get(row.mint);
    if (coin === undefined) {
      coin = {
        mint: row.mint,
        ...(markTimes[markIndex]! >= growthWindowStart ? { windowFirstCap: cap } : {}),
        lastSeenCap: cap,
        lastCap: cap,
        lastRank: row.rank,
        score: 0,
      };
      coins.set(row.mint, coin);
    } else {
      if (coin.windowFirstCap === undefined && markTimes[markIndex]! >= growthWindowStart) {
        coin.windowFirstCap = cap;
      }
      coin.lastSeenCap = cap;
      coin.lastCap = cap;
      coin.lastRank = row.rank;
    }

    if (row.rank <= 40) {
      coin.score += weight * ((41 - row.rank) / 40) * (row.venue === 'pool' ? 1.25 : 1);
    }
  }
}

for (const coin of coins.values()) {
  const growth = coin.windowFirstCap === undefined ? 1 : coin.lastSeenCap / coin.windowFirstCap;
  const logGrowth = Math.log10(growth);
  const clampedGrowth = Math.max(-0.3, Math.min(0.7, logGrowth));
  coin.score *= 1 + 0.35 * clampedGrowth;
}

const byScore = (a: Coin, b: Coin): number =>
  b.score - a.score || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0);
const rankedCoins = [...coins.values()].sort(byScore);
const topScoreMints = new Set(rankedCoins.slice(0, 50).map((coin) => coin.mint));
const candidates = rankedCoins
  .filter((coin) => coin.lastRank <= 60 || topScoreMints.has(coin.mint))
  .slice(0, 50);
if (candidates.length < 5) throw new Error('history does not contain five forecast candidates');

const totalScore = candidates.reduce((sum, coin) => sum + coin.score, 0);
if (!(totalScore > 0)) throw new Error('candidate scores must have a positive sum');

let cumulativeScore = 0;
const expectedRanks = new Map<string, number>();
for (const coin of candidates) {
  expectedRanks.set(coin.mint, 1 + (cumulativeScore / totalScore) * 40);
  cumulativeScore += coin.score;
}

const readTimes = task.reads.map((read) => Date.parse(read)).sort((a, b) => a - b);
if (readTimes.some((time) => !Number.isFinite(time))) throw new Error('task contains an invalid answer read time');
const medianRead = readTimes[Math.floor(readTimes.length / 2)]!;
const horizonHours = (medianRead - Date.parse(task.history_until)) / 3_600_000;
if (!Number.isFinite(horizonHours) || horizonHours < 0) throw new Error('invalid forecast horizon');
const sigma = Math.min(2.2 + 0.08 * horizonHours, 3.2);
const namedMass = Math.max(0.45 - 0.013 * horizonHours, 0.30);
const probabilities: Array<{ mint: string; place: number; p: number }> = [];
const placeWeights = new Map<number, number[]>();

for (let place = 1; place <= 5; place++) {
  const weights = candidates.map((coin) => {
    const difference = expectedRanks.get(coin.mint)! - place;
    return coin.score * Math.exp(-(difference * difference) / (2 * sigma * sigma));
  });
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(weightSum > 0)) throw new Error(`place ${place} has no candidate weight`);
  placeWeights.set(place, weights.map((weight) => weight / weightSum));

  const rawRows = candidates
    .map((coin, index) => ({ mint: coin.mint, place, p: namedMass * weights[index]! / weightSum }))
    .filter((row) => row.p >= 0.002);
  const rawSum = rawRows.reduce((sum, row) => sum + row.p, 0);
  const scale = rawSum > 1 ? 1 / rawSum : 1;
  for (const row of rawRows) {
    probabilities.push({ ...row, p: Number((row.p * scale).toFixed(6)) });
  }
}

const lastMarkRows = marks[marks.length - 1]!.rows!;
const lastMarkByRank = new Map(lastMarkRows.map((row) => [row.rank, row]));
const sizes: Array<{ place: number; bin: number; p: number }> = [];

function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
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
  return x >= 0 ? r : 2 - r;
}

function upperNormalTail(value: number, mean: number, standardDeviation: number): number {
  if (value === -Infinity) return 1;
  if (value === Infinity) return 0;
  return 0.5 * erfc((value - mean) / (standardDeviation * Math.SQRT2));
}

const edges = task.size.edges;
if (edges.length !== 81) throw new Error('task size must contain 81 edges');
const standardDeviation = Math.min(0.35 + 0.04 * horizonHours, 0.75);

for (let place = 1; place <= 5; place++) {
  const weights = placeWeights.get(place)!;
  let weightedLogCap = 0;
  for (let index = 0; index < candidates.length; index++) {
    const coin = candidates[index]!;
    const growth = coin.windowFirstCap === undefined ? 1 : coin.lastSeenCap / coin.windowFirstCap;
    const projectedCapSol = (coin.lastSeenCap / 1e9) * growth ** 0.25;
    weightedLogCap += weights[index]! * Math.log10(projectedCapSol);
  }

  const lastRankRow = lastMarkByRank.get(place);
  const lastRankLogCap =
    lastRankRow === undefined
      ? undefined
      : Math.log10(Number(BigInt(lastRankRow.market_cap_lamports)) / 1e9);
  let mean: number;
  if (lastRankLogCap !== undefined) {
    mean = (lastRankLogCap + weightedLogCap) / 2;
  } else if (Number.isFinite(weightedLogCap)) {
    mean = weightedLogCap;
  } else {
    mean = 3.0 - 0.12 * (place - 1);
  }
  if (!Number.isFinite(mean)) mean = 3.0 - 0.12 * (place - 1);

  for (let bin = 0; bin <= 81; bin++) {
    const low = bin === 0 ? -Infinity : edges[bin - 1]!;
    const high = bin === 81 ? Infinity : edges[bin]!;
    const probability = Math.max(0, upperNormalTail(low, mean, standardDeviation) - upperNormalTail(high, mean, standardDeviation));
    if (probability >= 0.0005) {
      sizes.push({ place, bin, p: Number(probability.toFixed(6)) });
    }
  }
}

const top5 = candidates.slice(0, 5).map((coin) => coin.mint);
const forecast = { probabilities, top5, sizes };
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'forecast.json'), `${JSON.stringify(forecast)}\n`);
