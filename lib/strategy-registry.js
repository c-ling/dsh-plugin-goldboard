import { defineStrategyDescriptor, isStrategyAdapter } from "./strategy-contract.js";

export const STRATEGY_REGISTRY_VERSION = "goldboard-strategy-registry-v1";

function registryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function publicDescriptor(descriptor) {
  return structuredClone(descriptor);
}

export class StrategyRegistry {
  #entries = new Map();

  register(descriptor, factory) {
    const normalized = defineStrategyDescriptor(descriptor);
    if ((normalized.strategyId === "control") !== (normalized.role === "control")) {
      throw registryError("CONTROL_STRATEGY_IDENTITY_INVALID", "only strategyId=control may hold the control role");
    }
    if (typeof factory !== "function") throw new TypeError("strategy factory must be a function");
    if (this.#entries.has(normalized.strategyId)) {
      throw registryError("STRATEGY_DUPLICATE", `strategy already registered: ${normalized.strategyId}`);
    }
    this.#entries.set(normalized.strategyId, { descriptor: normalized, factory });
    return publicDescriptor(normalized);
  }

  list({ enabledStrategyIds = [] } = {}) {
    const enabled = new Set(Array.isArray(enabledStrategyIds) ? enabledStrategyIds : []);
    return [...this.#entries.values()]
      .map((entry) => ({
        ...publicDescriptor(entry.descriptor),
        enabled: entry.descriptor.role === "control" || enabled.has(entry.descriptor.strategyId),
        live: entry.descriptor.role === "control",
        canDisable: entry.descriptor.role !== "control",
      }))
      .sort((left, right) => left.strategyId.localeCompare(right.strategyId));
  }

  get(strategyId) {
    const entry = this.#entries.get(String(strategyId));
    return entry ? publicDescriptor(entry.descriptor) : null;
  }

  create(strategyId, options = {}) {
    if (!this.#entries.has("control")) throw registryError("CONTROL_STRATEGY_REQUIRED", "control strategy must be registered");
    const id = String(strategyId);
    const entry = this.#entries.get(id);
    if (!entry) throw registryError("STRATEGY_NOT_FOUND", `unknown strategy: ${id}`);
    if (entry.descriptor.role !== "control") {
      const enabled = Array.isArray(options.enabledStrategyIds) ? options.enabledStrategyIds : [];
      if (!enabled.includes(id)) throw registryError("STRATEGY_DISABLED", `strategy is not enabled: ${id}`);
    }
    const createOptions = options.createOptions && typeof options.createOptions === "object"
      ? { ...options.createOptions } : {};
    const instance = entry.factory(createOptions);
    if (!isStrategyAdapter(instance) || typeof instance.evaluate !== "function") {
      throw registryError("STRATEGY_FACTORY_INVALID", `strategy factory returned an invalid adapter: ${id}`);
    }
    if (instance.strategyId !== entry.descriptor.strategyId
      || instance.strategyVersion !== entry.descriptor.strategyVersion
      || instance.descriptorFingerprint !== entry.descriptor.descriptorFingerprint) {
      throw registryError("STRATEGY_IDENTITY_MISMATCH", `strategy adapter identity does not match registry descriptor: ${id}`);
    }
    return instance;
  }
}

export function createStrategyRegistry(entries = []) {
  const registry = new StrategyRegistry();
  if (!Array.isArray(entries)) throw new TypeError("strategy registry entries must be an array");
  for (const entry of entries) registry.register(entry?.descriptor, entry?.factory);
  return registry;
}
