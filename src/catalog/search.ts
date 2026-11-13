import { buildInventory, type InventoryOptions } from "../inventory/build.js";
import { CliError } from "../core/errors.js";
import { searchInventory, validateCatalogFilters, type CatalogFilters, type CatalogSearchReport } from "./model.js";

export interface SearchOptions extends InventoryOptions, CatalogFilters { limit?: number }

export async function searchCatalog(options: SearchOptions = {}): Promise<CatalogSearchReport> {
  validateCatalogFilters(options);
  if(options.limit!==undefined&&(!Number.isInteger(options.limit)||options.limit<1||options.limit>1000))throw new CliError("INVALID_OPTIONS","Search limit must be between 1 and 1000.");
  return searchInventory(await buildInventory(options),options,options.limit);
}
