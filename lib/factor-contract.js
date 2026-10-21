export const FACTOR_SCHEMA_VERSION = "goldboard-factor-v1";
export const FACTOR_STATUSES = Object.freeze(["available", "stale", "unknown"]);

function instant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function iso(value) {
  const ms = instant(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function unknownRecord(input, reasonCodes) {
  return {
    schemaVersion: FACTOR_SCHEMA_VERSION,
    factorId: cleanText(input?.factorId),
    instrument: cleanText(input?.instrument),
    value: input?.value === undefined ? null : structuredCloneSafe(input.value),
    unit: cleanText(input?.unit),
    observationPeriod: {
      from: iso(input?.observationPeriod?.from),
      to: iso(input?.observationPeriod?.to),
    },
    releaseTimestamp: iso(input?.releaseTimestamp),
    firstAvailableTimestamp: iso(input?.firstAvailableTimestamp),
    tradableAfter: iso(input?.tradableAfter),
    ingestedAt: iso(input?.ingestedAt),
    revision: cleanText(input?.revision),
    vintage: cleanText(input?.vintage),
    source: cleanText(input?.source),
    status: "unknown",
    reasonCodes: [...new Set(reasonCodes)],
  };
}

function structuredCloneSafe(value) {
  try {
    return structuredClone(value);
  } catch {
    return null;
  }
}

export function normalizeFactorRecord(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return unknownRecord({}, ["factor_record_invalid"]);
  const reasons = [];
  const observationFrom = instant(input.observationPeriod?.from);
  const observationTo = instant(input.observationPeriod?.to);
  const release = instant(input.releaseTimestamp);
  const firstAvailable = instant(input.firstAvailableTimestamp);
  const tradableAfter = instant(input.tradableAfter);
  const ingestedAt = instant(input.ingestedAt);
  if (!cleanText(input.factorId)) reasons.push("factor_id_missing");
  else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.factorId)) reasons.push("factor_id_invalid");
  if (observationFrom === null || observationTo === null) reasons.push("observation_period_invalid");
  else if (observationFrom > observationTo) reasons.push("observation_period_inverted");
  if (release === null) reasons.push("release_timestamp_invalid");
  if (observationTo !== null && release !== null && observationTo > release) reasons.push("observation_after_release");
  if (firstAvailable === null) reasons.push("first_available_timestamp_invalid");
  if (tradableAfter === null) reasons.push("tradable_after_invalid");
  if (ingestedAt === null) reasons.push("ingested_at_invalid");
  if (release !== null && firstAvailable !== null && firstAvailable < release) reasons.push("first_available_before_release");
  if (firstAvailable !== null && tradableAfter !== null && tradableAfter < firstAvailable) reasons.push("tradable_before_available");
  if (release !== null && ingestedAt !== null && ingestedAt < release) reasons.push("ingested_before_release");
  if (!cleanText(input.revision)) reasons.push("revision_missing");
  if (!cleanText(input.vintage)) reasons.push("vintage_missing");
  if (!cleanText(input.source)) reasons.push("source_missing");
  if (typeof input.value !== "number" || !Number.isFinite(input.value)) reasons.push("value_invalid");
  if (reasons.length) return unknownRecord(input, reasons);
  return {
    schemaVersion: FACTOR_SCHEMA_VERSION,
    factorId: cleanText(input.factorId),
    instrument: cleanText(input.instrument),
    value: structuredClone(input.value),
    unit: cleanText(input.unit),
    observationPeriod: { from: new Date(observationFrom).toISOString(), to: new Date(observationTo).toISOString() },
    releaseTimestamp: new Date(release).toISOString(),
    firstAvailableTimestamp: new Date(firstAvailable).toISOString(),
    tradableAfter: new Date(tradableAfter).toISOString(),
    ingestedAt: new Date(ingestedAt).toISOString(),
    revision: cleanText(input.revision),
    vintage: cleanText(input.vintage),
    source: cleanText(input.source),
    status: "available",
    reasonCodes: [],
  };
}

function unavailableAt(record, asOfMs) {
  const checks = [
    [record?.observationPeriod?.to, "future_observation"],
    [record?.releaseTimestamp, "future_release"],
    [record?.firstAvailableTimestamp, "future_first_available"],
    [record?.tradableAfter, "future_tradable_after"],
    [record?.ingestedAt, "future_ingested_at"],
  ];
  return checks.filter(([value]) => instant(value) > asOfMs).map(([, reason]) => reason);
}

export function canonicalFactorRecordsAsOf(records, { asOf = null } = {}) {
  const asOfMs = asOf === null || asOf === undefined ? null : instant(asOf);
  if (asOf !== null && asOf !== undefined && asOfMs === null) return [];
  const normalized = (Array.isArray(records) ? records : [])
    .map(normalizeFactorRecord)
    .filter((record) => record.status === "available")
    .filter((record) => asOfMs === null || unavailableAt(record, asOfMs).length === 0);
  const byCanonicalValue = new Map();
  for (const record of normalized) {
    const key = JSON.stringify(record);
    if (!byCanonicalValue.has(key)) byCanonicalValue.set(key, record);
  }
  return [...byCanonicalValue.values()]
    .sort((left, right) => left.factorId.localeCompare(right.factorId)
      || instant(left.tradableAfter) - instant(right.tradableAfter)
      || instant(left.ingestedAt) - instant(right.ingestedAt)
      || left.revision.localeCompare(right.revision)
      || JSON.stringify(left).localeCompare(JSON.stringify(right)))
    .map((record) => structuredClone(record));
}

export function selectFactorVintage(records, { factorId, asOf, maxAgeMs = null } = {}) {
  const asOfMs = instant(asOf);
  if (asOfMs === null) return unknownRecord({ factorId }, ["as_of_invalid"]);
  const ageLimit = maxAgeMs === null || maxAgeMs === undefined ? null : Number(maxAgeMs);
  if (ageLimit !== null && (!Number.isFinite(ageLimit) || ageLimit < 0)) {
    return unknownRecord({ factorId }, ["factor_max_age_invalid"]);
  }
  const candidates = (Array.isArray(records) ? records : [])
    .map(normalizeFactorRecord)
    .filter((record) => record.factorId === factorId && record.status === "available")
    .filter((record) => unavailableAt(record, asOfMs).length === 0)
    .sort((left, right) => instant(right.tradableAfter) - instant(left.tradableAfter)
      || instant(right.ingestedAt) - instant(left.ingestedAt)
      || right.revision.localeCompare(left.revision));
  if (!candidates.length) return unknownRecord({ factorId }, ["factor_vintage_unavailable"]);
  const first = candidates[0];
  const tied = candidates.filter((record) => record.tradableAfter === first.tradableAfter
    && record.ingestedAt === first.ingestedAt && record.revision === first.revision);
  if (new Set(tied.map((record) => JSON.stringify(record))).size > 1) {
    return unknownRecord({ factorId }, ["conflicting_factor_vintage"]);
  }
  const selected = structuredClone(first);
  if (ageLimit !== null && asOfMs - instant(selected.observationPeriod.to) > ageLimit) {
    selected.status = "stale";
    selected.reasonCodes = ["factor_stale"];
  }
  return selected;
}

export function evaluateRequiredFactors({ requiredFactorIds = [], records = [], asOf, maxAgeMs = null } = {}) {
  if (!Array.isArray(requiredFactorIds)
    || requiredFactorIds.some((id) => typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) {
    return {
      decision: "hold",
      status: "unknown",
      factors: {},
      unavailableFactorIds: [],
      reasonCodes: ["required_factor_ids_invalid"],
    };
  }
  const ids = [...new Set(requiredFactorIds)];
  const factors = Object.fromEntries(ids.map((factorId) => [factorId, selectFactorVintage(records, { factorId, asOf, maxAgeMs })]));
  const unavailable = ids.filter((factorId) => factors[factorId].status !== "available");
  return {
    decision: unavailable.length ? "hold" : "proceed",
    status: unavailable.length ? "unknown" : "available",
    factors,
    unavailableFactorIds: unavailable,
    reasonCodes: unavailable.length ? ["required_factor_unavailable"] : [],
  };
}
