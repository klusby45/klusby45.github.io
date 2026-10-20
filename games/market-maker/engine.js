// Market Maker game engine. Pure logic, no DOM, so it runs in the browser and in Node.
(function (root) {
  'use strict';

  const roundHalf = (x) => Math.round(x * 2) / 2;

  const DIE_MEAN = 3.5;
  const DIE_SQ_MEAN = 91 / 6;
  const DIE_VAR = 35 / 12;
  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  const sum = (vals) => vals.reduce((a, v) => a + v, 0);

  // Small seeded PRNG so Monte Carlo fair values don't jitter between renders.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Every equally likely assignment of the hidden dice (6^hidden of them).
  function diceWorlds(known, hidden) {
    let out = [[]];
    for (let k = 0; k < hidden; k++) {
      const next = [];
      for (const w of out) for (let v = 1; v <= 6; v++) next.push(w.concat(v));
      out = next;
    }
    return out;
  }

  const CARD_SAMPLES = 4000;

  // Hidden cards: exact for one card, Monte Carlo beyond that.
  function cardWorlds(known, hidden, rng) {
    if (hidden === 0) return [[]];
    const rest = [];
    const counts = Array(14).fill(4);
    for (const v of known) counts[v] -= 1;
    for (let v = 1; v <= 13; v++) for (let c = 0; c < counts[v]; c++) rest.push(v);
    if (hidden === 1) return rest.map((v) => [v]);
    const out = [];
    for (let n = 0; n < CARD_SAMPLES; n++) {
      const deck = rest.slice();
      const w = [];
      for (let k = 0; k < hidden; k++) {
        const j = k + Math.floor(rng() * (deck.length - k));
        [deck[k], deck[j]] = [deck[j], deck[k]];
        w.push(deck[k]);
      }
      out.push(w);
    }
    return out;
  }

  function rollDice(n, rng) {
    return Array.from({ length: n }, () => {
      const v = 1 + Math.floor(rng() * 6);
      return { kind: 'die', value: v };
    });
  }

  // Each scenario deals hidden items and reports the mean/sd of the final value
  // given which item values are known.
  const SCENARIOS = {
    diceSum: {
      id: 'diceSum',
      name: 'Sum of 5 dice',
      blurb: 'Five six-sided dice are rolled. The contract settles at their total.',
      count: 5,
      dollarsPerPoint: 20,
      deal: (rng) => rollDice(5, rng),
      combine: sum,
      worlds: diceWorlds,
      stats(known, hidden) {
        const s = known.reduce((a, v) => a + v, 0);
        return { mean: s + DIE_MEAN * hidden, sd: Math.sqrt(hidden * DIE_VAR) };
      },
    },

    cardSum: {
      id: 'cardSum',
      name: 'Sum of 4 cards',
      blurb: 'Four cards are dealt from a standard deck (A=1, J=11, Q=12, K=13). The contract settles at their total.',
      count: 4,
      dollarsPerPoint: 10,
      deal(rng) {
        const deck = Array.from({ length: 52 }, (_, i) => i);
        const out = [];
        for (let k = 0; k < 4; k++) {
          const j = k + Math.floor(rng() * (52 - k));
          [deck[k], deck[j]] = [deck[j], deck[k]];
          const c = deck[k];
          out.push({ kind: 'card', value: (c % 13) + 1, rank: RANKS[c % 13], suit: SUITS[Math.floor(c / 13)] });
        }
        return out;
      },
      combine: sum,
      worlds: cardWorlds,
      // Sampling without replacement from what's left of the deck.
      stats(known, hidden) {
        const s = known.reduce((a, v) => a + v, 0);
        if (hidden === 0) return { mean: s, sd: 0 };
        const N = 52 - known.length;
        let sum = 4 * 91;
        let sumSq = 4 * 819;
        for (const v of known) { sum -= v; sumSq -= v * v; }
        const mu = sum / N;
        const popVar = sumSq / N - mu * mu;
        const variance = N > 1 ? hidden * popVar * (N - hidden) / (N - 1) : 0;
        return { mean: s + hidden * mu, sd: Math.sqrt(Math.max(0, variance)) };
      },
    },

    diceProduct: {
      id: 'diceProduct',
      name: 'Product of 3 dice',
      blurb: 'Three six-sided dice are rolled. The contract settles at their product. Careful, it is skewed.',
      count: 3,
      dollarsPerPoint: 2,
      deal: (rng) => rollDice(3, rng),
      combine: (vals) => vals.reduce((p, v) => p * v, 1),
      worlds: diceWorlds,
      stats(known, hidden) {
        const p = known.reduce((a, v) => a * v, 1);
        const mean = p * Math.pow(DIE_MEAN, hidden);
        const sq = p * p * Math.pow(DIE_SQ_MEAN, hidden);
        return { mean, sd: Math.sqrt(Math.max(0, sq - mean * mean)) };
      },
    },
  };

  const DIFFICULTIES = {
    rookie: { id: 'rookie', name: 'Rookie', pInformed: 0.25 },
    pro: { id: 'pro', name: 'Pro', pInformed: 0.45 },
  };

  const ROUNDS_PER_SESSION = 5;
  const QUOTES_PER_REVEAL = 2;
  const TIMEOUT_FINE = 50;

  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function scenarioOrder(rng) {
    const ids = Object.keys(SCENARIOS);
    const extra = Array.from({ length: ROUNDS_PER_SESSION - ids.length }, () => ids[Math.floor(rng() * ids.length)]);
    return shuffle(ids.concat(extra), rng);
  }

  class Round {
    constructor(scenarioId, difficulty, rng) {
      this.scenario = SCENARIOS[scenarioId];
      this.difficulty = difficulty;
      this.rng = rng;
      this.items = this.scenario.deal(rng);
      this.value = this.scenario.combine(this.items.map((it) => it.value));
      this.seed = Math.floor(rng() * 4294967296);
      this.cache = null;
      this.quoteIndex = 0;
      this.revealed = 0;
      this.position = 0;
      this.cash = 0;
      this.fines = 0;
      this.turns = [];
      this.done = false;
    }

    get itemCount() { return this.scenario.count; }
    get turnCount() { return this.scenario.count * QUOTES_PER_REVEAL; }
    get hidden() { return this.itemCount - this.revealed; }
    get dollarsPerPoint() { return this.scenario.dollarsPerPoint; }

    knownValues(extraIndex) {
      const vals = this.items.slice(0, this.revealed).map((it) => it.value);
      if (extraIndex != null) vals.push(this.items[extraIndex].value);
      return vals;
    }

    publicStats() {
      return this.scenario.stats(this.knownValues(), this.hidden);
    }

    // Max width is one standard deviation of the public distribution.
    maxWidth() {
      return Math.max(1, roundHalf(this.publicStats().sd));
    }

    validate(bid, ask) {
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) return 'Enter both a bid and an ask.';
      if (ask <= bid) return 'Your ask has to be above your bid.';
      const cap = this.maxWidth();
      if (ask - bid > cap + 1e-9) return `Too wide. Max width right now is ${cap}.`;
      return null;
    }

    noiseTradeProb(bid, ask) {
      return 1 - 0.7 * ((ask - bid) / this.maxWidth());
    }

    // What an informed trader does if they peek at `peeked` with `known` revealed.
    informedAction(known, peeked, hidden, bid, ask) {
      const view = this.scenario.stats(known.concat(peeked), hidden - 1).mean;
      return view > ask ? 'buy' : view < bid ? 'sell' : 'pass';
    }

    // Bayesian fair value: every possible hidden world, weighted by how likely
    // it makes the trades seen so far. Cached until the next quote.
    posterior() {
      if (this.cache && this.cache.quoteIndex === this.quoteIndex) return this.cache;
      const known = this.knownValues();
      const hidden = this.hidden;
      const pInf = this.difficulty.pInformed;
      const rng = mulberry32(this.seed + this.revealed * 7919);
      // Past reveals match the real ones in every world, so a past trader's
      // action depends only on which value they peeked. Memoize per turn.
      const past = this.turns.filter((t) => !t.timedOut).map((t) => {
        const pastKnown = known.slice(0, t.revealed);
        const pastHidden = this.itemCount - t.revealed;
        const memo = new Map();
        const matches = (v) => {
          if (!memo.has(v)) memo.set(v, this.informedAction(pastKnown, v, pastHidden, t.bid, t.ask) === t.action);
          return memo.get(v);
        };
        const noise = t.action === 'pass' ? 1 - t.pNoise : t.pNoise / 2;
        return { t, pastHidden, matches, noise };
      });
      const worlds = this.scenario.worlds(known, hidden, rng).map((w) => {
        const full = known.concat(w);
        let weight = 1;
        for (const { t, pastHidden, matches, noise } of past) {
          let match = 0;
          for (let j = t.revealed; j < this.itemCount; j++) if (matches(full[j])) match += 1;
          weight *= pInf * (match / pastHidden) + (1 - pInf) * noise;
        }
        return { hiddenVals: w, value: this.scenario.combine(full), weight };
      });
      const total = worlds.reduce((a, w) => a + w.weight, 0);
      let mean = 0;
      let sq = 0;
      for (const w of worlds) {
        w.weight /= total;
        mean += w.weight * w.value;
        sq += w.weight * w.value * w.value;
      }
      this.cache = { quoteIndex: this.quoteIndex, worlds, mean, sd: Math.sqrt(Math.max(0, sq - mean * mean)) };
      return this.cache;
    }

    fairValue() { return this.posterior().mean; }

    // Expected P&L (in dollars) of a quote given everything you've seen,
    // reveals and trade flow. This is the luck-free skill score.
    expectedEdge(bid, ask) {
      const known = this.knownValues();
      const hidden = this.hidden;
      const pInf = this.difficulty.pInformed;
      const views = new Map();
      const actionFor = (v) => {
        if (!views.has(v)) views.set(v, this.informedAction(known, v, hidden, bid, ask));
        return views.get(v);
      };
      let informed = 0;
      for (const w of this.posterior().worlds) {
        let pnl = 0;
        for (const v of w.hiddenVals) {
          const a = actionFor(v);
          if (a === 'buy') pnl += ask - w.value;
          else if (a === 'sell') pnl += w.value - bid;
        }
        informed += w.weight * pnl / hidden;
      }
      // Noise traders are a coin flip on side, so they pay you half the width on average.
      const noise = this.noiseTradeProb(bid, ask) * (ask - bid) / 2;
      return (pInf * informed + (1 - pInf) * noise) * this.dollarsPerPoint;
    }

    // One trader arrives per quote. Informed traders peek at one hidden item
    // and trade only when your price is wrong from their point of view.
    // Noise traders trade at random, more often when your market is tight.
    quote(bid, ask) {
      const err = this.validate(bid, ask);
      if (err) throw new Error(err);
      const pub = this.publicStats();
      const fair = this.fairValue();
      const cap = this.maxWidth();
      const pNoise = this.noiseTradeProb(bid, ask);
      const edge = this.expectedEdge(bid, ask);
      const informed = this.rng() < this.difficulty.pInformed;
      let action = 'pass';
      let traderView = null;
      if (informed) {
        const peek = this.revealed + Math.floor(this.rng() * this.hidden);
        traderView = this.scenario.stats(this.knownValues(peek), this.hidden - 1).mean;
        action = this.informedAction(this.knownValues(), this.items[peek].value, this.hidden, bid, ask);
      } else if (this.rng() < pNoise) {
        action = this.rng() < 0.5 ? 'buy' : 'sell';
      }
      let price = null;
      if (action === 'buy') { price = ask; this.position -= 1; this.cash += ask; }
      if (action === 'sell') { price = bid; this.position += 1; this.cash -= bid; }
      const turn = {
        revealed: this.revealed, bid, ask, cap, edge, pNoise,
        fair, publicFair: pub.mean, sd: pub.sd,
        trader: informed ? 'informed' : 'noise', traderView,
        action, price, timedOut: false,
      };
      this.turns.push(turn);
      this.advance();
      return turn;
    }

    // Shot clock ran out without a valid quote: pay the fine, no trade.
    timeout() {
      const pub = this.publicStats();
      const fair = this.fairValue();
      this.fines += TIMEOUT_FINE;
      const turn = {
        revealed: this.revealed, bid: null, ask: null, cap: this.maxWidth(), edge: -TIMEOUT_FINE,
        fair, publicFair: pub.mean, sd: pub.sd, trader: null, traderView: null,
        action: 'pass', price: null, timedOut: true,
      };
      this.turns.push(turn);
      this.advance();
      return turn;
    }

    advance() {
      this.quoteIndex += 1;
      if (this.quoteIndex >= this.turnCount) {
        this.revealed = this.itemCount;
        this.done = true;
      } else {
        this.revealed = Math.floor(this.quoteIndex / QUOTES_PER_REVEAL);
      }
    }

    // True if the next quote comes right after a new item was revealed.
    get freshReveal() { return this.quoteIndex % QUOTES_PER_REVEAL === 0; }

    // Your P&L in dollars on a single trade once the value is known.
    tradePnl(turn) {
      if (turn.action === 'buy') return (turn.price - this.value) * this.dollarsPerPoint;
      if (turn.action === 'sell') return (this.value - turn.price) * this.dollarsPerPoint;
      return 0;
    }

    pnl() {
      return (this.cash + this.position * this.value) * this.dollarsPerPoint - this.fines;
    }

    breakdown() {
      const out = { pnl: this.pnl(), edge: 0, noise: 0, informed: 0, fines: this.fines, trades: 0, pricingError: 0, quoted: 0 };
      for (const t of this.turns) {
        out.edge += t.edge;
        if (t.action !== 'pass') { out[t.trader] += this.tradePnl(t); out.trades += 1; }
        if (!t.timedOut) {
          out.pricingError += Math.abs((t.bid + t.ask) / 2 - t.fair) / t.sd;
          out.quoted += 1;
        }
      }
      return out;
    }
  }

  class Session {
    constructor(difficultyId, rng = Math.random) {
      this.difficulty = DIFFICULTIES[difficultyId] || DIFFICULTIES.rookie;
      this.rng = rng;
      this.order = scenarioOrder(rng);
      this.rounds = [];
      this.nextRound();
    }

    get current() { return this.rounds[this.rounds.length - 1]; }
    get roundNumber() { return this.rounds.length; }
    get finished() { return this.rounds.length === ROUNDS_PER_SESSION && this.current.done; }

    nextRound() {
      if (this.rounds.length >= ROUNDS_PER_SESSION) return null;
      const r = new Round(this.order[this.rounds.length], this.difficulty, this.rng);
      this.rounds.push(r);
      return r;
    }

    summary() {
      const keys = ['pnl', 'edge', 'noise', 'informed', 'fines', 'trades', 'pricingError', 'quoted'];
      const s = Object.fromEntries(keys.map((k) => [k, 0]));
      for (const r of this.rounds) {
        if (!r.done) continue;
        const b = r.breakdown();
        for (const k of keys) s[k] += b[k];
      }
      s.avgPricingError = s.quoted ? s.pricingError / s.quoted : 0;
      return s;
    }
  }

  const api = { SCENARIOS, DIFFICULTIES, ROUNDS_PER_SESSION, QUOTES_PER_REVEAL, TIMEOUT_FINE, Round, Session, roundHalf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MarketMaker = api;
})(typeof window !== 'undefined' ? window : globalThis);
