import assert from "node:assert/strict";
import test from "node:test";

import {
  EXECUTION_BID_UNAVAILABLE,
  EXECUTION_QUOTE_INVERTED,
  accountExecution,
  resolveExecutionBar,
  resolveExecutionQuote,
  valuePosition,
} from "../lib/execution.js";

const CONFIG = {
  fee: { buyPerGram: 1, sellPerGram: 2 },
  strategy: { slippagePerGram: 0.5, estimatedSpreadPerGram: 0.2, maxLossPerGram: 2 },
};

test("execution quote preserves real CMB bid/ask without adding estimated spread", () => {
  const quote = resolveExecutionQuote({
    quote: { customerBuy: 105, customerSell: 100, source: "cmb", quality: "primary" },
  }, CONFIG);
  assert.equal(quote.ask, 105);
  assert.equal(quote.bid, 100);
  assert.equal(quote.spreadPerGram, 5);
  assert.equal(quote.synthetic, false);
  assert.equal(quote.components.estimatedSpreadAppliedPerGram, 0);
});

test("execution quote rejects an inverted customer spread", () => {
  const quote = resolveExecutionQuote({ quote: { buyPrice: 95, sellPrice: 100, source: "cmb" } }, CONFIG);
  assert.equal(quote.available, false);
  assert.equal(quote.reasonCode, EXECUTION_QUOTE_INVERTED);
});

test("execution fallback preserves asymmetric side offsets and applies a minimum synthetic spread", () => {
  const asymmetric = resolveExecutionQuote({ referencePrice: 100, buyOffset: 2.5, sellOffset: -2.5 }, CONFIG);
  assert.equal(asymmetric.ask, 102.5);
  assert.equal(asymmetric.bid, 97.5);
  assert.equal(asymmetric.spreadPerGram, 5);
  assert.equal(asymmetric.synthetic, true);

  const equalOffsets = resolveExecutionQuote({ referencePrice: 100, buyOffset: 1, sellOffset: 1 }, CONFIG);
  assert.equal(equalOffsets.ask, 101);
  assert.equal(equalOffsets.bid, 100.8);
  assert.equal(equalOffsets.components.estimatedSpreadAppliedPerGram, 0.2);
});

test("execution ledger itemizes fee and slippage once per side", () => {
  const quote = resolveExecutionQuote({ quote: { buyPrice: 100, sellPrice: 95, source: "cmb" } }, CONFIG);
  const buy = accountExecution({ side: "buy", grams: 10, quote }, CONFIG);
  assert.equal(buy.cashFlowCny, -1015);
  assert.equal(buy.feeCny, 10);
  assert.equal(buy.slippageCny, 5);
  assert.equal(buy.effectivePrice, 101.5);
  assert.equal(buy.breakEvenBid, 104);

  const sell = accountExecution({ side: "sell", grams: 10, quote }, CONFIG);
  assert.equal(sell.cashFlowCny, 925);
  assert.equal(sell.feeCny, 20);
  assert.equal(sell.slippageCny, 5);
  assert.equal(sell.effectivePrice, 92.5);
});

test("position valuation triggers max loss on effective exit PnL, not an inverted fee threshold", () => {
  const exactStop = valuePosition(
    { grams: 10, avgCostPerGram: 100 },
    { bid: 102, synthetic: true, quality: "synthetic" },
    CONFIG,
  );
  assert.equal(exactStop.effectiveEntryPrice, 101.5);
  assert.equal(exactStop.effectiveExitPrice, 99.5);
  assert.equal(exactStop.effectivePnlPerGram, -2);
  assert.equal(exactStop.breakEvenBid, 104);
  assert.equal(exactStop.stopBid, 102);
  assert.equal(exactStop.stopTriggered, true);
  assert.equal(exactStop.pnlCny, -20);
});

test("position valuation can consume replay cost basis without charging entry costs twice", () => {
  const valuation = valuePosition(
    { grams: 10, avgCostPerGram: 101.5 },
    { bid: 102, synthetic: true, quality: "synthetic" },
    CONFIG,
    { entryCostsIncluded: true },
  );
  assert.equal(valuation.effectiveEntryPrice, 101.5);
  assert.equal(valuation.effectiveExitPrice, 99.5);
  assert.equal(valuation.effectivePnlPerGram, -2);
  assert.equal(valuation.costs.entryExplicitFeePerGram, 0);
  assert.equal(valuation.costs.entrySlippagePerGram, 0);
});

test("position valuation returns null with a reason when executable bid is missing", () => {
  const result = valuePosition({ grams: 5, avgCostPerGram: 100 }, { ask: 105 }, CONFIG);
  assert.equal(result.available, false);
  assert.equal(result.pnlCny, null);
  assert.equal(result.reasonCode, EXECUTION_BID_UNAVAILABLE);
});

test("execution bars distinguish persisted bid/ask from one-sided CMB proxies", () => {
  const real = resolveExecutionBar({
    lane: "cmb",
    bar: {
      o: 105, h: 106, l: 104, c: 105,
      executionSideComplete: true,
      executionSideSource: "cmb",
      askO: 105, askH: 106, askL: 104, askC: 105,
      bidO: 100, bidH: 101, bidL: 99, bidC: 100,
    },
  }, CONFIG);
  assert.equal(real.realBidAsk, true);
  assert.equal(real.bidBar.h, 101);

  const proxy = resolveExecutionBar({ lane: "cmb", cmbSpreadPerGram: 5, bar: { o: 105, h: 106, l: 104, c: 105 } }, CONFIG);
  assert.equal(proxy.realBidAsk, false);
  assert.equal(proxy.askBar.h, 106);
  assert.equal(proxy.bidBar.h, 101);
  assert.equal(proxy.quality, "proxy");
});
