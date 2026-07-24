import { listSpecs } from "./list.js";
import type { SpecInfo, SpecKitOptions } from "./utils.js";

export interface SpecStatus {
  total: number;
  active: number;
  specs: SpecInfo[];
}

export async function specStatus(options?: SpecKitOptions): Promise<SpecStatus> {
  const specs = await listSpecs(options);
  return {
    total: specs.length,
    active: specs.filter((spec) => spec.status !== "implemented").length,
    specs,
  };
}
