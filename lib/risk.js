/**
 * Risk budget and buy-gate policy.
 *
 * This module only constrains advisory buy suggestions. It never blocks a sell
 * or mutates positions, and it treats the configured equity as a reference
 * value rather than an account balance.
 */

import { round2 } from "./shared.js";

export const RISK_CONFIG_VERSION = "goldboard-risk-config-v1";
export const RISK_POLICY_VERSION = "goldboard-risk-policy-v1";

const EPSILON = 1e-9;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegative(value) {
  return Math.max(0, finite(value, 0));
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function floorGrams(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor((value + EPSILON) * 100) / 100;
}

function roundRatio(value) {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : null;
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value !== ""))];
}

function lossFacts(summary = {}, unrealizedPnlCny) {
  const hasCurrentUnrealized = unrealizedPnlCny !== null && unrealizedPnlCny !== undefined && Number.isFinite(Number(unrealizedPnlCny));
  const openLoss = hasCurrentUnrealized
    ? Math.max(0, -Number(unrealizedPnlCny))
    : nonNegative(summary.unrealizedLossCny);
  if (summary.lossIncludesUnrealized === true && !hasCurrentUnrealized) {
    return {
      dailyLossCny: nonNegative(summary.dailyLossCny),
      weeklyLossCny: nonNegative(summary.weeklyLossCny),
      drawdownCny: nonNegative(summary.drawdownCny),
      unrealizedLossCny: openLoss,
    };
  }
  return {
    dailyLossCny: round2(nonNegative(summary.dailyRealizedLossCny ?? summary.dailyLossCny) + openLoss),
    weeklyLossCny: round2(nonNegative(summary.weeklyRealizedLossCny ?? summary.weeklyLossCny) + openLoss),
    drawdownCny: round2(nonNegative(summary.realizedDrawdownCny ?? summary.drawdownCny) + openLoss),
    unrealizedLossCny: round2(openLoss),
  };
}

function addBudgetConstraint(constraints, code, limit, used, riskPerGram) {
  if (!(limit > 0)) return null;
  const remaining = Math.max(0, limit - Math.max(0, used));
  const maxGrams = riskPerGram > 0 ? floorGrams(remaining / riskPerGram) : 0;
  const constraint = {
    code,
    enabled: true,
    limit: round2(limit),
    used: round2(Math.max(0, used)),
    remaining: round2(remaining),
    maxGrams,
    passed: remaining > EPSILON,
  };
  constraints.push(constraint);
  return constraint;
}

function addGramConstraint(constraints, code, limit, used, maxGrams) {
  const remaining = Math.max(0, maxGrams);
  const constraint = {
    code,
    enabled: true,
    limit: round2(limit),
    used: round2(Math.max(0, used)),
    remaining: round2(remaining),
    maxGrams: floorGrams(remaining),
    passed: remaining > EPSILON,
  };
  constraints.push(constraint);
  return constraint;
}

/** Build the period-loss gate shared by sizing and snapshot projection. */
export function inspectRiskGate(config = {}, ledgerSummary = {}, options = {}) {
  const risk = config?.risk ?? {};
  const losses = lossFacts(ledgerSummary, options.unrealizedPnlCny);
  const reasonCodes = [];
  if (ledgerSummary.integrity && ledgerSummary.integrity !== "ok") reasonCodes.push("ledger_unavailable");
  if (nonNegative(risk.maxDailyLossCny) > 0 && losses.dailyLossCny >= nonNegative(risk.maxDailyLossCny) - EPSILON) {
    reasonCodes.push("max_daily_loss");
  }
  if (nonNegative(risk.maxWeeklyLossCny) > 0 && losses.weeklyLossCny >= nonNegative(risk.maxWeeklyLossCny) - EPSILON) {
    reasonCodes.push("max_weekly_loss");
  }
  if (nonNegative(risk.maxDrawdownCny) > 0 && losses.drawdownCny >= nonNegative(risk.maxDrawdownCny) - EPSILON) {
    reasonCodes.push("max_drawdown");
  }
  return {
    riskPolicyVersion: RISK_POLICY_VERSION,
    riskConfigVersion: RISK_CONFIG_VERSION,
    mode: risk.mode === "budget" ? "budget" : "fixed_grams",
    referenceEquityCny: nonNegative(risk.referenceEquityCny),
    allowNewBuy: reasonCodes.length === 0,
    allowProtectiveExit: true,
    triggered: reasonCodes.length > 0,
    reasonCodes,
    losses,
    adds: {
      today: Math.max(0, Math.floor(finite(ledgerSummary.addsToday, 0))),
      activeSetup: Math.max(0, Math.floor(finite(ledgerSummary.activeSetupAdds, 0))),
      consecutiveLosses: Math.max(0, Math.floor(finite(ledgerSummary.consecutiveLosses, 0))),
    },
  };
}

/**
 * Evaluate one advisory buy candidate against every enabled constraint.
 * Positive limits participate in the minimum; zero disables that constraint.
 */
export function evaluateBuyRisk(config = {}, input = {}) {
  const risk = config?.risk ?? {};
  const strategy = config?.strategy ?? {};
  const limits = config?.limits ?? {};
  const mode = risk.mode === "budget" ? "budget" : "fixed_grams";
  const currentGrams = nonNegative(input.currentGrams ?? config?.position?.grams);
  const fixedGrams = floorGrams(nonNegative(input.fixedGrams));
  const ask = positive(input.executableAsk);
  const bid = positive(input.executableBid);
  const suggestedPrice = positive(input.suggestedPrice) ?? ask;
  const quotedSpread = ask !== null && bid !== null ? Math.max(0, ask - bid) : 0;
  const oneSideSlippage = nonNegative(strategy.slippagePerGram);
  const slippageBuffer = round2(oneSideSlippage * 2);
  const atrBuffer = nonNegative(risk.volatilityTarget) > 0 && positive(input.atrPerGram) !== null
    ? nonNegative(risk.volatilityTarget) * positive(input.atrPerGram)
    : 0;
  const stopDistancePerGram = round2(Math.max(atrBuffer, quotedSpread, slippageBuffer));
  // When the bid is constructed as ask − configured fee, that fee is already
  // part of quotedSpread; adding it again would double the execution cost.
  const sellFeeInSpread = config?.cmb?.deriveSellFromFee === true;
  const explicitFeesPerGram = round2(
    nonNegative(config?.fee?.buyPerGram)
    + (sellFeeInSpread ? 0 : nonNegative(config?.fee?.sellPerGram)),
  );
  const executionCostPerGram = round2(quotedSpread + explicitFeesPerGram + slippageBuffer);
  const riskPerGram = round2(stopDistancePerGram + executionCostPerGram);
  const ledgerSummary = input.ledgerSummary && typeof input.ledgerSummary === "object" ? input.ledgerSummary : {};
  const gate = inspectRiskGate(config, ledgerSummary, { unrealizedPnlCny: input.unrealizedPnlCny });
  const losses = gate.losses;
  const constraints = [];
  const reasonCodes = [...gate.reasonCodes];
  const caps = [];

  if (ask === null || suggestedPrice === null) reasonCodes.push("execution_ask_unavailable");
  const requiresRiskPerGram = mode === "budget" || [
    risk.maxRiskPerTradeCny,
    risk.maxDailyLossCny,
    risk.maxWeeklyLossCny,
    risk.maxDrawdownCny,
  ].some((value) => nonNegative(value) > 0);
  if (!(riskPerGram > 0) && requiresRiskPerGram) reasonCodes.push("risk_per_gram_unavailable");

  const maxGrams = nonNegative(limits.maxGrams);
  if (maxGrams > 0) {
    const constraint = addGramConstraint(constraints, "max_grams", maxGrams, currentGrams, maxGrams - currentGrams);
    caps.push(constraint.maxGrams);
    if (!constraint.passed) reasonCodes.push("position_limit");
  } else if (mode === "fixed_grams") {
    // Legacy fixed sizing uses maxGrams=0 as "no configured position budget".
    reasonCodes.push("no_budget");
  }

  // Use the more conservative executable/current ask for exposure even when a
  // lower limit is suggested, so total nominal value cannot exceed the cap.
  const nominalPrice = ask !== null && suggestedPrice !== null ? Math.max(ask, suggestedPrice) : suggestedPrice ?? ask;
  const currentNominalAmountCny = ask === null ? 0 : round2(currentGrams * ask);
  const maxAmountCny = nonNegative(risk.maxAmountCny);
  if (maxAmountCny > 0) {
    const remainingAmount = Math.max(0, maxAmountCny - currentNominalAmountCny);
    const maxAmountGrams = nominalPrice !== null ? floorGrams(remainingAmount / nominalPrice) : 0;
    const constraint = {
      code: "max_amount",
      enabled: true,
      limit: round2(maxAmountCny),
      used: currentNominalAmountCny,
      remaining: round2(remainingAmount),
      maxGrams: maxAmountGrams,
      passed: remainingAmount > EPSILON && maxAmountGrams > 0,
    };
    constraints.push(constraint);
    caps.push(maxAmountGrams);
    if (!constraint.passed && nominalPrice !== null) reasonCodes.push("max_amount_reached");
  }

  const riskBudgetConstraints = [];
  if (riskPerGram > 0) {
    const perTrade = addBudgetConstraint(constraints, "max_risk_per_trade", nonNegative(risk.maxRiskPerTradeCny), 0, riskPerGram);
    if (perTrade) {
      riskBudgetConstraints.push(perTrade);
      caps.push(perTrade.maxGrams);
      if (!perTrade.passed) reasonCodes.push("max_risk_per_trade");
    }
    const daily = addBudgetConstraint(constraints, "max_daily_loss", nonNegative(risk.maxDailyLossCny), losses.dailyLossCny, riskPerGram);
    if (daily) {
      riskBudgetConstraints.push(daily);
      caps.push(daily.maxGrams);
      if (!daily.passed) reasonCodes.push("max_daily_loss");
    }
    const weekly = addBudgetConstraint(constraints, "max_weekly_loss", nonNegative(risk.maxWeeklyLossCny), losses.weeklyLossCny, riskPerGram);
    if (weekly) {
      riskBudgetConstraints.push(weekly);
      caps.push(weekly.maxGrams);
      if (!weekly.passed) reasonCodes.push("max_weekly_loss");
    }
    const drawdown = addBudgetConstraint(constraints, "max_drawdown", nonNegative(risk.maxDrawdownCny), losses.drawdownCny, riskPerGram);
    if (drawdown) {
      riskBudgetConstraints.push(drawdown);
      caps.push(drawdown.maxGrams);
      if (!drawdown.passed) reasonCodes.push("max_drawdown");
    }
  }

  const liquidityCapGrams = nonNegative(risk.liquidityCapGrams);
  if (liquidityCapGrams > 0) {
    const constraint = addGramConstraint(constraints, "liquidity_cap", liquidityCapGrams, 0, liquidityCapGrams);
    caps.push(constraint.maxGrams);
  }

  const action = input.action === "add_position" ? "add_position" : "buy_setup";
  if (action === "add_position") {
    const setupAdds = Math.max(0, Math.floor(finite(ledgerSummary.activeSetupAdds, 0)));
    const maxAddsPerSetup = Math.max(0, Math.floor(nonNegative(risk.maxAddsPerSetup)));
    if (maxAddsPerSetup > 0) {
      const passed = setupAdds < maxAddsPerSetup;
      constraints.push({
        code: "max_adds_per_setup",
        enabled: true,
        limit: maxAddsPerSetup,
        used: setupAdds,
        remaining: Math.max(0, maxAddsPerSetup - setupAdds),
        maxGrams: passed ? null : 0,
        passed,
      });
      if (!passed) reasonCodes.push("max_adds_per_setup");
    }
    const addsToday = Math.max(0, Math.floor(finite(ledgerSummary.addsToday, 0)));
    const maxAddsPerDay = Math.max(0, Math.floor(nonNegative(risk.maxAddsPerDay)));
    if (maxAddsPerDay > 0) {
      const passed = addsToday < maxAddsPerDay;
      constraints.push({
        code: "max_adds_per_day",
        enabled: true,
        limit: maxAddsPerDay,
        used: addsToday,
        remaining: Math.max(0, maxAddsPerDay - addsToday),
        maxGrams: passed ? null : 0,
        passed,
      });
      if (!passed) reasonCodes.push("max_adds_per_day");
    }
    const improvement = nonNegative(risk.minAddPriceImprovementPerGram);
    const lastBuyPrice = positive(ledgerSummary.activeSetupLastBuyPrice);
    if (improvement > 0 && setupAdds > 0 && lastBuyPrice === null) {
      constraints.push({
        code: "min_add_price_improvement",
        enabled: true,
        limit: round2(improvement),
        used: null,
        remaining: null,
        maxGrams: 0,
        passed: false,
      });
      reasonCodes.push("min_add_price_unavailable");
    } else if (improvement > 0 && lastBuyPrice !== null && suggestedPrice !== null) {
      const actual = round2(lastBuyPrice - suggestedPrice);
      const passed = actual + EPSILON >= improvement;
      constraints.push({
        code: "min_add_price_improvement",
        enabled: true,
        limit: round2(improvement),
        used: actual,
        remaining: round2(Math.max(0, improvement - actual)),
        maxGrams: passed ? null : 0,
        passed,
      });
      if (!passed) reasonCodes.push("min_add_price_improvement");
    }
  }

  const cooldownMinutes = nonNegative(strategy.signalCooldownMinutes);
  const lastBuyFillMs = Date.parse(ledgerSummary.lastBuyFillAt ?? "");
  const asOfMs = new Date(input.asOf ?? Date.now()).getTime();
  if (cooldownMinutes > 0 && Number.isFinite(lastBuyFillMs) && Number.isFinite(asOfMs)) {
    const remainingMs = cooldownMinutes * 60_000 - (asOfMs - lastBuyFillMs);
    if (remainingMs > 0) {
      constraints.push({
        code: "post_fill_cooldown",
        enabled: true,
        limit: cooldownMinutes,
        used: round2(Math.max(0, (asOfMs - lastBuyFillMs) / 60_000)),
        remaining: round2(remainingMs / 60_000),
        maxGrams: 0,
        passed: false,
      });
      reasonCodes.push("post_fill_cooldown");
    }
  }

  let unconstrainedGrams;
  if (mode === "fixed_grams") {
    unconstrainedGrams = fixedGrams;
    caps.unshift(fixedGrams);
  } else {
    if (riskBudgetConstraints.length === 0) reasonCodes.push("risk_budget_unconfigured");
    unconstrainedGrams = caps.length > 0 ? Math.min(...caps.filter(Number.isFinite)) : 0;
  }

  let grams = caps.length > 0 ? floorGrams(Math.min(...caps.filter(Number.isFinite))) : floorGrams(unconstrainedGrams);
  const consecutiveLosses = Math.max(0, Math.floor(finite(ledgerSummary.consecutiveLosses, 0)));
  const deRiskThreshold = Math.max(0, Math.floor(nonNegative(risk.consecutiveLossDeRisk)));
  let deRiskFactor = 1;
  if (deRiskThreshold > 0 && consecutiveLosses >= deRiskThreshold && grams > 0) {
    const levels = Math.max(1, Math.floor(consecutiveLosses / deRiskThreshold));
    deRiskFactor = Math.max(0.125, Math.pow(0.5, levels));
    const before = grams;
    grams = floorGrams(grams * deRiskFactor);
    constraints.push({
      code: "consecutive_loss_derisk",
      enabled: true,
      limit: deRiskThreshold,
      used: consecutiveLosses,
      remaining: 0,
      maxGrams: grams,
      beforeGrams: before,
      factor: deRiskFactor,
      passed: true,
    });
  }

  const blockingCodes = unique(reasonCodes);
  if (blockingCodes.length === 0 && grams <= 0) blockingCodes.push("risk_budget_too_small");
  const allowed = blockingCodes.length === 0 && grams > 0;
  if (!allowed) grams = 0;
  const nominalAmountCny = allowed && nominalPrice !== null ? round2(grams * nominalPrice) : 0;
  const worstCaseLossCny = allowed ? round2(grams * riskPerGram) : 0;
  const referenceEquityCny = nonNegative(risk.referenceEquityCny);
  const riskBudgetRatio = referenceEquityCny > 0 ? roundRatio(worstCaseLossCny / referenceEquityCny) : null;
  const remainingBudgets = riskBudgetConstraints.map((constraint) => constraint.remaining).filter((value) => Number.isFinite(value));
  const availableRiskBudgetCny = remainingBudgets.length > 0 ? round2(Math.min(...remainingBudgets)) : null;
  const enabledCaps = constraints.filter((constraint) => Number.isFinite(constraint.maxGrams));
  const smallestCap = enabledCaps.length > 0 ? Math.min(...enabledCaps.map((constraint) => constraint.maxGrams)) : null;
  const bindingConstraints = unique(enabledCaps
    .filter((constraint) => smallestCap !== null && Math.abs(constraint.maxGrams - smallestCap) < 0.011)
    .map((constraint) => constraint.code));

  return {
    allowed,
    reasonCodes: blockingCodes,
    riskPolicyVersion: RISK_POLICY_VERSION,
    riskConfigVersion: RISK_CONFIG_VERSION,
    mode,
    referenceEquityCny,
    fixedGrams,
    suggestedGramsBeforeConstraints: mode === "fixed_grams" ? fixedGrams : null,
    suggestedGrams: grams,
    currentGrams: round2(currentGrams),
    currentNominalAmountCny,
    nominalAmountCny,
    executableAsk: ask,
    executableBid: bid,
    quotedSpreadPerGram: round2(quotedSpread),
    atrPerGram: positive(input.atrPerGram),
    volatilityTarget: nonNegative(risk.volatilityTarget),
    atrBufferPerGram: round2(atrBuffer),
    slippageBufferPerGram: slippageBuffer,
    stopDistancePerGram,
    explicitFeesPerGram,
    executionCostPerGram,
    riskPerGram,
    worstCaseLossCny,
    availableRiskBudgetCny,
    riskBudgetRatio,
    deRiskFactor,
    constraints,
    bindingConstraints,
    gate: {
      ...gate,
      allowNewBuy: allowed,
      triggered: !allowed,
      reasonCodes: blockingCodes,
    },
  };
}

/** Deep-module facade for host callers and plugin integrators. */
export class RiskPolicy {
  constructor(config = {}) {
    this.config = config;
    this.riskPolicyVersion = RISK_POLICY_VERSION;
  }

  inspect(ledgerSummary = {}, options = {}) {
    return inspectRiskGate(this.config, ledgerSummary, options);
  }

  evaluate(input = {}) {
    if (input.side === "sell") {
      return {
        allowed: true,
        reasonCodes: [],
        riskPolicyVersion: RISK_POLICY_VERSION,
        riskConfigVersion: RISK_CONFIG_VERSION,
        mode: this.config?.risk?.mode === "budget" ? "budget" : "fixed_grams",
        suggestedGrams: floorGrams(nonNegative(input.fixedGrams ?? input.grams)),
        gate: {
          ...inspectRiskGate(this.config, input.ledgerSummary, { unrealizedPnlCny: input.unrealizedPnlCny }),
          allowProtectiveExit: true,
        },
      };
    }
    return evaluateBuyRisk(this.config, input);
  }

  evaluateBuy(input = {}) {
    return evaluateBuyRisk(this.config, input);
  }
}

export function createRiskPolicy(config = {}) {
  return new RiskPolicy(config);
}
